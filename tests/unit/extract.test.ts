import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractAll,
  type EvidenceRejectionReason,
} from "@/lib/extract";
import {
  EVIDENCE_DICTIONARY,
  validateEvidenceDictionary,
} from "@/lib/evidence-dictionary";
import { LlmError, type MessageCreatePort } from "@/lib/llm";
import type { ChatMessage, TriageResult } from "@/lib/types";

interface MockFixture {
  provenance: "mock";
  live_verified: false;
  messages: ChatMessage[];
  result: TriageResult;
}

type ScenarioId =
  | "scenario-1-chest-pain"
  | "scenario-2-back-pain"
  | "scenario-3-rhinitis";

function fixture(id: ScenarioId): MockFixture {
  return JSON.parse(
    readFileSync(resolve(`tests/fixtures/transcripts/${id}.mock.json`), "utf8"),
  ) as MockFixture;
}

function message(text: string): Anthropic.Message {
  return {
    id: "msg_extract_test",
    container: null,
    content: [{ type: "text", text, citations: null }],
    model: "claude-sonnet-5",
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 7,
      output_tokens: 4,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

function capture(raw: unknown): {
  createMessage: MessageCreatePort;
  requests: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    createMessage: async (params) => {
      requests.push(params);
      return message(JSON.stringify(raw));
    },
  };
}

function rawExtraction(
  current: MockFixture,
  evidences: unknown[],
  unmapped: unknown[] = [],
): Record<string, unknown> {
  return {
    anamnesis: current.result.anamnesis,
    evidence: {
      evidences,
      age: current.result.anamnesis.context.age,
      sex: current.result.anamnesis.context.sex,
    },
    unmapped,
  };
}

function rawExtractionWithSeverity(
  current: MockFixture,
  severity: unknown,
): Record<string, unknown> {
  return {
    anamnesis: {
      ...current.result.anamnesis,
      symptom: {
        ...current.result.anamnesis.symptom,
        severity,
      },
    },
    evidence: {
      evidences: [],
      age: current.result.anamnesis.context.age,
      sex: current.result.anamnesis.context.sex,
    },
    unmapped: [],
  };
}

const DEMO_CASES = [
  {
    id: "scenario-1-chest-pain" as const,
    evidences: [{ code: "E_14" }, { code: "E_66" }],
    expected: [{ code: "E_14" }, { code: "E_66" }],
    unmapped: [],
  },
  {
    id: "scenario-2-back-pain" as const,
    evidences: [{ code: "E_55", value: "V_40" }],
    expected: [{ code: "E_55", value: "V_40" }],
    unmapped: [],
  },
  {
    id: "scenario-3-rhinitis" as const,
    evidences: [{ code: "E_181" }],
    expected: [{ code: "E_181" }],
    unmapped: ["немного чихаю"],
  },
] as const;

describe("Russian transcript to EvidenceVector adapter", () => {
  it.each(DEMO_CASES)(
    "sanitizes the exact mock transcript for $id",
    async ({ id, evidences, expected, unmapped }) => {
      const current = fixture(id);
      const fake = capture(rawExtraction(current, [...evidences], [...unmapped]));
      const result = await extractAll(current.messages, {
        ...fake,
        sleep: async () => undefined,
        log: () => undefined,
        warn: () => undefined,
      });

      expect(current.provenance).toBe("mock");
      expect(current.live_verified).toBe(false);
      expect(result.extraction_ok).toBe(true);
      expect(result.evidence.evidences).toEqual(expected);
      expect(result.evidence.age).toBe(current.result.anamnesis.context.age);
      expect(result.evidence.sex).toBe(current.result.anamnesis.context.sex);
      expect(result.unmapped).toEqual(unmapped);
      expect(result.audit.rejected).toEqual([]);
      expect(result.audit.accepted).toHaveLength(expected.length);
      if (id !== "scenario-1-chest-pain") {
        expect(result.evidence.evidences).not.toEqual(
          expect.arrayContaining([{ code: "E_14" }, { code: "E_66" }]),
        );
      }
    },
  );

  it("uses one user-first structured request with the closed dictionary and exact transcript", async () => {
    const current = fixture("scenario-1-chest-pain");
    const fake = capture(
      rawExtraction(current, [{ code: "E_14" }, { code: "E_66" }]),
    );

    await extractAll(current.messages, {
      ...fake,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0];
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe("user");
    expect(request.messages[0]?.content).toContain("[0] АССИСТЕНТ:");
    expect(request.messages[0]?.content).toContain("[1] ПАЦИЕНТ:");
    expect(request.system).toContain("E_14 | B | боль в груди в покое");
    expect(request.system).toContain("E_55 | M | локализация боли");
    expect(request.system).toContain("V_40=локализация боли: поясничный отдел позвоночника");
    expect(request.system).toContain("E_66 | B | выраженная одышка");
    expect(request.system).toContain("E_181 | B | заложенность носа");
    expect(request.system).toContain("E_218 | B | усиление симптомов при нагрузке");
    expect(request.system).toContain("КАЖДЫЙ поддерживаемый подтверждённый признак");
    expect(request.system).toContain("Наличие unmapped не отменяет поддерживаемые признаки");
    expect(request.system).toContain("слово «ангина» без контекста");
    expect(request.system).toContain(
      "Не заменяй неподдерживаемый симптом ближайшим или похожим кодом",
    );
    expect(request.system).toContain(
      "Если силу симптома пациент не называл, верни null",
    );
    expect(request.output_config).toMatchObject({
      format: {
        type: "json_schema",
        schema: {
          additionalProperties: false,
          required: ["anamnesis", "evidence", "unmapped"],
        },
      },
    });
    const schema = (
      request.output_config?.format as { schema?: { properties?: Record<string, unknown> } }
    ).schema;
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      "anamnesis",
      "evidence",
      "unmapped",
    ]);
    const anamnesisSchema = schema?.properties?.anamnesis as {
      properties?: {
        symptom?: {
          required?: string[];
          properties?: {
            severity?: Record<string, unknown>;
          };
        };
      };
    };
    expect(
      anamnesisSchema.properties?.symptom?.properties?.severity,
    ).toEqual({
      type: ["integer", "null"],
    });
    expect(
      anamnesisSchema.properties?.symptom?.required,
    ).toContain("severity");
  });

  it.each([
    ["patient did not state intensity", null],
    ["explicit zero", 0],
    ["maximum ten", 10],
  ])("accepts severity for %s", async (_label, severity) => {
    const current = fixture("scenario-1-chest-pain");
    const fake = capture(rawExtractionWithSeverity(current, severity));

    const result = await extractAll(current.messages, {
      ...fake,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(result.extraction_ok).toBe(true);
    expect(result.anamnesis.symptom.severity).toBe(severity);
  });

  it.each([
    ["missing field", undefined],
    ["string", "7"],
    ["fraction", 7.5],
    ["below range", -1],
    ["above range", 11],
  ])("rejects invalid severity: %s", async (_label, severity) => {
    const current = fixture("scenario-1-chest-pain");
    const fake = capture(rawExtractionWithSeverity(current, severity));

    const result = await extractAll(current.messages, {
      ...fake,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(result.extraction_ok).toBe(false);
    expect(result.audit.failure).toBe("invalid_output");
    expect(result.anamnesis.symptom.severity).toBeNull();
  });

  it("records and rejects malformed, unknown, incorrectly typed, and duplicate evidence entries", async () => {
    const current = fixture("scenario-2-back-pain");
    const rawItems: unknown[] = [
      { code: "E_14" },
      { code: "E_14" },
      { code: "E_999999" },
      { code: "E_55" },
      { code: "E_55", value: "V_UNKNOWN" },
      { code: "E_55", value: "V_40" },
      { code: "E_55", value: "V_40" },
      { code: "E_14", value: "V_40" },
      { code: "E_55@V_40" },
      { code: "" },
      {},
      null,
      { code: "E_55", value: true },
      { code: "E_14", extra: "not allowed" },
      { code: "E_55", value: "" },
      { code: 55 },
    ];
    const fake = capture(
      rawExtraction(current, rawItems, ["симптом вне словаря", "", 42]),
    );

    const result = await extractAll(current.messages, {
      ...fake,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(result.extraction_ok).toBe(true);
    expect(result.evidence.evidences).toEqual([
      { code: "E_14" },
      { code: "E_55", value: "V_40" },
    ]);
    expect(result.audit.accepted.map(({ raw_index }) => raw_index)).toEqual([0, 5]);
    expect(result.audit.rejected).toHaveLength(14);
    expect(result.audit.unmapped_rejected_indexes).toEqual([1, 2]);
    const reasons = new Set<EvidenceRejectionReason>(
      result.audit.rejected.map(({ reason }) => reason),
    );
    expect(reasons).toEqual(
      new Set<EvidenceRejectionReason>([
        "duplicate",
        "unknown_code",
        "missing_value",
        "unknown_value",
        "unexpected_value",
        "compound_code",
        "empty_code",
        "invalid_code_type",
        "invalid_entry",
        "invalid_value_type",
        "unexpected_fields",
        "empty_value",
      ]),
    );
    expect(result.unmapped[0]).toBe("симптом вне словаря");
    expect(result.unmapped).toEqual(
      expect.arrayContaining([
        "непринятый признак E_999999",
        "непринятый признак E_55=V_UNKNOWN",
      ]),
    );
  });

  it("rejects conflicting categorical values but permits distinct multi-select values", async () => {
    const current = fixture("scenario-2-back-pain");
    const fake = capture(
      rawExtraction(current, [
        { code: "E_132", value: 1 },
        { code: "E_132", value: 2 },
        { code: "E_55", value: "V_40" },
        { code: "E_55", value: "V_101" },
      ]),
    );

    const result = await extractAll(current.messages, {
      ...fake,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(result.evidence.evidences).toEqual([
      { code: "E_132", value: 1 },
      { code: "E_55", value: "V_40" },
      { code: "E_55", value: "V_101" },
    ]);
    expect(result.audit.rejected).toEqual([
      { raw_index: 1, reason: "duplicate", code: "E_132", value: 2 },
    ]);
  });

  it.each([
    null,
    {},
    { anamnesis: {}, evidence: {}, unmapped: [] },
    {
      ...rawExtraction(fixture("scenario-1-chest-pain"), []),
      extra: true,
    },
    {
      ...rawExtraction(fixture("scenario-1-chest-pain"), []),
      evidence: { evidences: [], age: 59, sex: "m" },
    },
  ])("fails closed on malformed structured output: %#", async (raw) => {
    const current = fixture("scenario-1-chest-pain");
    const fake = capture(raw);

    const result = await extractAll(current.messages, {
      ...fake,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(result.extraction_ok).toBe(false);
    expect(result.audit.failure).toBe("invalid_output");
    expect(result.evidence).toEqual({ evidences: [], age: null, sex: "unknown" });
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("abstained");
  });

  it("turns an adapter failure into extraction_ok false without a model abstain", async () => {
    const current = fixture("scenario-1-chest-pain");
    let calls = 0;
    const createMessage: MessageCreatePort = async () => {
      calls += 1;
      throw new LlmError("offline", "llm_unavailable", false);
    };

    const result = await extractAll(current.messages, {
      createMessage,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(calls).toBe(1);
    expect(result.extraction_ok).toBe(false);
    expect(result.audit.failure).toBe("llm_error");
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("abstained");
  });

  it("does not call the LLM when the transcript has no patient message", async () => {
    let calls = 0;
    const createMessage: MessageCreatePort = async () => {
      calls += 1;
      return message("{}");
    };

    const result = await extractAll(
      [{ role: "assistant", content: "Что вас беспокоит?" }],
      { createMessage, warn: () => undefined },
    );

    expect(calls).toBe(0);
    expect(result.extraction_ok).toBe(false);
    expect(result.audit.failure).toBe("no_patient_messages");
  });
});

describe("accepted evidence dictionary runtime validation", () => {
  const binaryEntry = {
    name: "E_1",
    question_en: "Source question",
    label_ru: "проверяемый признак",
    question_ru: "Есть ли проверяемый признак?",
    data_type: "B",
    possible_values: [],
    translation_status: "curated",
  };

  it("accepts a minimal frozen closed dictionary", () => {
    const dictionary = validateEvidenceDictionary({
      _meta: { frozen: true },
      E_1: binaryEntry,
    });

    expect(dictionary.baseEntries.map(({ code }) => code)).toEqual(["E_1"]);
    expect(dictionary.prompt).toContain("E_1 | B | проверяемый признак");
  });

  it("loads the accepted 3.1 artifact with source-backed feature values", () => {
    expect(EVIDENCE_DICTIONARY.baseEntries).toHaveLength(223);
    expect(EVIDENCE_DICTIONARY.entries.size).toBe(987);
    expect(EVIDENCE_DICTIONARY.prompt).toContain(
      "V_40=локализация боли: поясничный отдел позвоночника [source: lumbar spine]",
    );
  });

  it.each([
    [{ E_1: binaryEntry }, "frozen _meta"],
    [
      { _meta: { frozen: true }, BAD: binaryEntry },
      "invalid dictionary key",
    ],
    [
      {
        _meta: { frozen: true },
        E_1: { ...binaryEntry, possible_values: ["V_1"] },
      },
      "binary evidence cannot define values",
    ],
    [
      {
        _meta: { frozen: true },
        E_2: { ...binaryEntry, name: "E_2", data_type: "C", possible_values: ["V_1"] },
      },
      "missing dictionary feature E_2@V_1",
    ],
  ])("rejects dictionary drift: %s", (raw, message) => {
    expect(() => validateEvidenceDictionary(raw)).toThrow(String(message));
  });
});
