import { readFileSync } from "node:fs";

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { sanitizeEvidenceOutput } from "../../lib/extract";
import type { MessageCreatePort } from "../../lib/llm";
import { buildVector, loadArtifact, predict } from "../../lib/model";
import {
  analyze,
  createProductionLlm,
  shouldAbstain,
} from "../../lib/triage";
import type {
  Anamnesis,
  ChatMessage,
  TriageResult,
} from "../../lib/types";

interface DemoCase {
  id: "chest-rich" | "rhinitis" | "low-back" | "isolated-dizziness";
  messages: ChatMessage[];
  anamnesis: Anamnesis;
  rawEvidences: readonly Record<string, unknown>[];
  unmapped: string[];
  expectedSource: TriageResult["source"];
  expectedTop: string;
  expectedAbstain?: "low_confidence" | "out_of_label_space";
}

const DEMOS: readonly DemoCase[] = [
  {
    id: "chest-rich",
    messages: [
      { role: "assistant", content: "Что вас беспокоит?" },
      {
        role: "user",
        content:
          "Мне 58 лет, я мужчина. Давящая боль в груди даже в покое, выраженная одышка, при нагрузке хуже, в покое легче и сильно потею.",
      },
    ],
    anamnesis: {
      chief_complaint: "боль в груди и одышка",
      symptom: {
        onset: "сегодня",
        location: "грудь",
        quality: "давящая",
        severity: 8,
        modifiers: "при нагрузке хуже, в покое легче",
        associated: ["одышка", "потоотделение"],
      },
      past_history: [],
      chronic: [],
      allergies: [],
      medications: [],
      context: {
        age: 58,
        sex: "m",
        pregnancy: "na",
        risk_factors: [],
      },
    },
    rawEvidences: [
      { code: "E_53" },
      { code: "E_14" },
      { code: "E_66" },
      { code: "E_218" },
      { code: "E_50" },
    ],
    unmapped: [],
    expectedSource: "model",
    expectedTop: "Unstable angina",
  },
  {
    id: "rhinitis",
    messages: [
      { role: "assistant", content: "Что вас беспокоит?" },
      {
        role: "user",
        content: "Мне 30 лет, я женщина. Со вчера заложен нос и прозрачные выделения.",
      },
    ],
    anamnesis: {
      chief_complaint: "заложенность носа и прозрачные выделения",
      symptom: {
        onset: "со вчера",
        location: "нос",
        quality: "заложенность и прозрачные выделения",
        severity: 2,
        modifiers: "",
        associated: [],
      },
      past_history: [],
      chronic: [],
      allergies: [],
      medications: [],
      context: {
        age: 30,
        sex: "f",
        pregnancy: "no",
        risk_factors: [],
      },
    },
    rawEvidences: [{ code: "E_181" }],
    unmapped: [],
    expectedSource: "llm_fallback",
    expectedTop: "Allergic sinusitis",
    expectedAbstain: "out_of_label_space",
  },
  {
    id: "low-back",
    messages: [
      { role: "assistant", content: "Что вас беспокоит?" },
      {
        role: "user",
        content: "Мне 34 года, я женщина. Две недели болит поясница.",
      },
    ],
    anamnesis: {
      chief_complaint: "боль в пояснице две недели",
      symptom: {
        onset: "две недели назад",
        location: "поясница",
        quality: "боль",
        severity: 4,
        modifiers: "",
        associated: [],
      },
      past_history: [],
      chronic: [],
      allergies: [],
      medications: [],
      context: {
        age: 34,
        sex: "f",
        pregnancy: "no",
        risk_factors: [],
      },
    },
    rawEvidences: [{ code: "E_55", value: "V_40" }],
    unmapped: [],
    expectedSource: "llm_fallback",
    expectedTop: "Guillain-Barré syndrome",
    expectedAbstain: "out_of_label_space",
  },
  {
    id: "isolated-dizziness",
    messages: [
      { role: "assistant", content: "Что вас беспокоит?" },
      {
        role: "user",
        content: "Мне 45 лет, я женщина. Немного кружится голова и бывает предобморочное ощущение.",
      },
    ],
    anamnesis: {
      chief_complaint: "головокружение и предобморочное ощущение",
      symptom: {
        onset: "сегодня",
        location: "голова",
        quality: "головокружение",
        severity: 3,
        modifiers: "",
        associated: ["предобморочное ощущение"],
      },
      past_history: [],
      chronic: [],
      allergies: [],
      medications: [],
      context: {
        age: 45,
        sex: "f",
        pregnancy: "no",
        risk_factors: [],
      },
    },
    rawEvidences: [{ code: "E_76" }, { code: "E_82" }],
    unmapped: [],
    expectedSource: "llm_fallback",
    expectedTop: "PSVT",
    expectedAbstain: "low_confidence",
  },
];

function rawExtraction(current: DemoCase): Record<string, unknown> {
  return {
    anamnesis: current.anamnesis,
    evidence: {
      evidences: current.rawEvidences,
      age: current.anamnesis.context.age,
      sex: current.anamnesis.context.sex,
    },
    unmapped: current.unmapped,
  };
}

function response(raw: unknown): Anthropic.Message {
  return {
    id: "msg_t1_offline",
    container: null,
    content: [{ type: "text", text: JSON.stringify(raw), citations: null }],
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
      input_tokens: 1,
      output_tokens: 1,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

function fakeStructured(
  raw: unknown,
  counter?: { calls: number },
): MessageCreatePort {
  return async () => {
    if (counter) counter.calls += 1;
    return response(raw);
  };
}

function sanitize(current: DemoCase): ReturnType<typeof sanitizeEvidenceOutput> {
  return sanitizeEvidenceOutput(
    {
      evidences: current.rawEvidences,
      age: current.anamnesis.context.age,
      sex: current.anamnesis.context.sex,
    },
    current.unmapped,
  );
}

describe("T1 production extraction-to-model demo matrix", () => {
  const artifact = loadArtifact();

  it("records aggregate mapped/vector/top-5 facts against the unchanged threshold", () => {
    const diagnostics = DEMOS.map((current) => {
      const sanitized = sanitize(current);
      const vector = buildVector(sanitized.evidence, artifact);
      const prediction = predict(vector, artifact);
      return {
        id: current.id,
        extracted: current.rawEvidences.length,
        mapped: sanitized.accepted.length,
        unknown: sanitized.rejected.length,
        nonzero: [...vector].filter((value) => value !== 0).length,
        top5: prediction.pathologies.map(({ code }) => code),
        topProbability: prediction.pathologies[0]?.prob ?? 0,
        abstain: shouldAbstain(
          sanitized.evidence,
          sanitized.unmapped,
          prediction,
          artifact.abstain_threshold,
        ),
      };
    });

    expect(artifact.abstain_threshold).toBeCloseTo(0.503698, 6);
    expect(
      diagnostics.map((item) => ({
        ...item,
        topProbability: Number(item.topProbability.toFixed(6)),
      })),
    ).toEqual([
      {
        id: "chest-rich",
        extracted: 5,
        mapped: 5,
        unknown: 0,
        nonzero: 7,
        top5: [
          "Unstable angina",
          "Spontaneous pneumothorax",
          "Myocarditis",
          "Atrial fibrillation",
          "Acute pulmonary edema",
        ],
        topProbability: 0.966944,
        abstain: undefined,
      },
      {
        id: "rhinitis",
        extracted: 1,
        mapped: 1,
        unknown: 0,
        nonzero: 3,
        top5: [
          "Allergic sinusitis",
          "Viral pharyngitis",
          "URTI",
          "Acute otitis media",
          "Guillain-Barré syndrome",
        ],
        topProbability: 0.695843,
        abstain: "out_of_label_space",
      },
      {
        id: "low-back",
        extracted: 1,
        mapped: 1,
        unknown: 0,
        nonzero: 3,
        top5: [
          "Guillain-Barré syndrome",
          "Whooping cough",
          "Larygospasm",
          "Myasthenia gravis",
          "Acute dystonic reactions",
        ],
        topProbability: 0.07887,
        abstain: "out_of_label_space",
      },
      {
        id: "isolated-dizziness",
        extracted: 2,
        mapped: 2,
        unknown: 0,
        nonzero: 4,
        top5: [
          "PSVT",
          "Anemia",
          "Atrial fibrillation",
          "Whooping cough",
          "Guillain-Barré syndrome",
        ],
        topProbability: 0.278324,
        abstain: "low_confidence",
      },
    ]);
    expect(diagnostics[0].topProbability).toBeGreaterThan(0.9);
    expect(diagnostics[0].abstain).toBeUndefined();
    expect(diagnostics[1].topProbability).toBeGreaterThan(artifact.abstain_threshold);
    expect(diagnostics[1].abstain).toBe("out_of_label_space");
    expect(diagnostics[2].topProbability).toBeLessThan(0.1);
    expect(diagnostics[2].abstain).toBe("out_of_label_space");
    expect(diagnostics[3].topProbability).toBeGreaterThan(0.25);
    expect(diagnostics[3].topProbability).toBeLessThan(artifact.abstain_threshold);
    expect(diagnostics[3].abstain).toBe("low_confidence");
  });

  it.each(DEMOS)(
    "runs $id through extractAll, sanitizer, the default scorer and analyze",
    async (current) => {
      const structuredCalls = { calls: 0 };
      const result = await analyze(current.messages, {
        llm: createProductionLlm({
          createMessage: fakeStructured(rawExtraction(current), structuredCalls),
          sleep: async () => undefined,
          log: () => undefined,
          warn: () => undefined,
        }),
      });

      expect(structuredCalls.calls).toBe(1);
      expect(result.source).toBe(current.expectedSource);
      expect(result.model?.model_version).toBe(artifact.model_version);
      if (current.expectedSource === "model") {
        expect(result.model).toMatchObject({
          abstained: false,
        });
        expect(result.model?.pathologies[0]?.code).toBe(current.expectedTop);
        expect(result.model?.top_contributions.length).toBeGreaterThan(0);
        expect(
          result.model?.top_contributions.some(
            ({ feature }) => !["age_norm", "sex_m", "sex_f"].includes(feature),
          ),
        ).toBe(true);
        expect(result.routing.length).toBeGreaterThan(0);
        expect(result.routing.length).toBeLessThanOrEqual(3);
        expect(
          new Set(result.routing.map(({ specialty }) => specialty)).size,
        ).toBe(result.routing.length);
        expect(
          result.routing.every(
            (route, index) =>
              index === 0 ||
              result.routing[index - 1].confidence >= route.confidence,
          ),
        ).toBe(true);

        const rows = JSON.parse(
          readFileSync("data/pathology_map.json", "utf8"),
        ) as { pathology: string; specialty: string }[];
        const byPathology = new Map(
          rows.map((row) => [row.pathology, row.specialty]),
        );
        const aggregate = new Map<string, number>();
        for (const pathology of result.model!.pathologies) {
          const specialty = byPathology.get(pathology.code);
          expect(specialty).toBeDefined();
          aggregate.set(
            specialty!,
            (aggregate.get(specialty!) ?? 0) + pathology.prob,
          );
        }
        const expectedRouting = [...aggregate]
          .map(([specialty, confidence]) => ({ specialty, confidence }))
          .sort(
            (left, right) =>
              right.confidence - left.confidence ||
              left.specialty.localeCompare(right.specialty, "ru"),
          )
          .slice(0, 3);
        expect(result.routing).toHaveLength(expectedRouting.length);
        expectedRouting.forEach((route, index) => {
          expect(result.routing[index].specialty).toBe(route.specialty);
          expect(result.routing[index].confidence).toBeCloseTo(
            route.confidence,
            12,
          );
        });
      } else {
        expect(result.model).toMatchObject({
          abstained: true,
          abstain_reason: current.expectedAbstain,
          pathologies: [],
          top_contributions: [],
        });
      }
    },
  );

  it("keeps invented and out-of-range codes outside the model vector", () => {
    const sanitized = sanitizeEvidenceOutput(
      {
        age: 40,
        sex: "unknown",
        evidences: [
          { code: "E_999999" },
          { code: "E_55", value: "V_NOT_REAL" },
        ],
      },
      [],
    );
    const vector = buildVector(sanitized.evidence, artifact);
    const prediction = predict(vector, artifact);

    expect(sanitized.accepted).toEqual([]);
    expect(sanitized.rejected.map(({ reason }) => reason)).toEqual([
      "unknown_code",
      "unknown_value",
    ]);
    expect([...vector].filter((value) => value !== 0)).toHaveLength(3);
    expect(
      shouldAbstain(
        sanitized.evidence,
        sanitized.unmapped,
        prediction,
        artifact.abstain_threshold,
      ),
    ).toBe("out_of_label_space");
  });
});
