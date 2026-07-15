import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { extractAll } from "@/lib/extract";
import type { MessageCreatePort } from "@/lib/llm";
import type { Anamnesis, ChatMessage } from "@/lib/types";

function response(text: string): Anthropic.Message {
  return {
    id: "msg_extract_adversarial",
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
      input_tokens: 1,
      output_tokens: 1,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

const EMPTY_ANAMNESIS: Anamnesis = {
  chief_complaint: "",
  symptom: {
    onset: "",
    location: "",
    quality: "",
    severity: 0,
    modifiers: "",
    associated: [],
  },
  past_history: [],
  chronic: [],
  allergies: [],
  medications: [],
  context: {
    age: null,
    sex: "unknown",
    pregnancy: "na",
    risk_factors: [],
  },
};

function extraction(evidences: unknown[], unmapped: unknown[] = []): unknown {
  return {
    anamnesis: EMPTY_ANAMNESIS,
    evidence: { evidences, age: null, sex: "unknown" },
    unmapped,
  };
}

describe("EvidenceVector adapter adversarial boundary", () => {
  it("keeps assistant questions as context and an explicit patient negation absent", async () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Есть выраженная одышка?" },
      { role: "user", content: "Нет, одышки нет." },
    ];
    const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const createMessage: MessageCreatePort = async (params) => {
      requests.push(params);
      return response(JSON.stringify(extraction([])));
    };

    const result = await extractAll(messages, {
      createMessage,
      log: () => undefined,
      warn: () => undefined,
    });

    expect(result.extraction_ok).toBe(true);
    expect(result.evidence.evidences).toEqual([]);
    expect(requests[0]?.messages[0]).toEqual({
      role: "user",
      content: "[0] АССИСТЕНТ: Есть выраженная одышка?\n[1] ПАЦИЕНТ: Нет, одышки нет.",
    });
    expect(requests[0]?.system).toContain(
      "Вопрос ассистента сам по себе не является признаком",
    );
    expect(requests[0]?.system).toContain("Отрицание означает отсутствие");
  });

  it("keeps raw output provenance in audit indexes without logging patient PII", async () => {
    const pii = "+7 777 123 45 67";
    const warnings: Array<{ message: string; metadata: Readonly<Record<string, unknown>> }> = [];
    let observedAudit: unknown;
    const createMessage: MessageCreatePort = async () =>
      response(
        JSON.stringify(
          extraction(
            [
              { code: "E_14" },
              { code: "E_14" },
              { code: "E_999999" },
            ],
            [pii],
          ),
        ),
      );

    const result = await extractAll(
      [{ role: "user", content: `Мой телефон ${pii}; болит в груди.` }],
      {
        createMessage,
        log: () => undefined,
        warn: (message, metadata) => warnings.push({ message, metadata }),
        onAudit: (audit) => {
          observedAudit = audit;
        },
      },
    );

    expect(result.audit.accepted).toEqual([{ raw_index: 0, code: "E_14" }]);
    expect(result.audit.rejected).toEqual([
      { raw_index: 1, reason: "duplicate", code: "E_14" },
      { raw_index: 2, reason: "unknown_code", code: "E_999999" },
    ]);
    expect(observedAudit).toEqual(result.audit);
    expect(JSON.stringify(warnings)).not.toContain(pii);
    expect(JSON.stringify(warnings)).not.toContain("болит в груди");
    expect(warnings).toEqual([
      {
        message: "[extract] rejected untrusted output entries",
        metadata: {
          reasons: { duplicate: 1, unknown_code: 1 },
          unmapped_rejected: 0,
        },
      },
    ]);
  });

  it("fails closed after the bounded malformed-JSON retries", async () => {
    let calls = 0;
    const createMessage: MessageCreatePort = async () => {
      calls += 1;
      return response("{malformed");
    };

    const result = await extractAll(
      [{ role: "user", content: "Мне нехорошо" }],
      {
        createMessage,
        sleep: async () => undefined,
        log: () => undefined,
        warn: () => undefined,
      },
    );

    expect(calls).toBe(4);
    expect(result.extraction_ok).toBe(false);
    expect(result.audit.failure).toBe("llm_error");
    expect(result.evidence).toEqual({ evidences: [], age: null, sex: "unknown" });
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("abstained");
  });
});
