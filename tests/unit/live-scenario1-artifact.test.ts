import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPORT_PATH = "reports/live-e2e/scenario1-structured-telegram.json";
const hasLiveEvidence = existsSync(REPORT_PATH);

interface LiveArtifact {
  schema_version: number;
  verdict: string;
  started_at: string;
  finished_at: string;
  cost_cap: {
    max_anthropic_calls: number;
    actual_anthropic_calls: number;
    sdk_retries: number;
    application_retries: number;
    usage: Record<string, number>;
  };
  timeout_layers: {
    chat_ms: number;
    structured_ms: number;
    outer_guard_ms: number;
  };
  timings_ms: { chat: number; structured: number };
  result: {
    source: string;
    model_version: string | null;
    abstained: boolean | null;
    abstain_reason: string | null;
    urgency: string;
    redflag_codes: string[];
    quote_evidence_verified: boolean;
    disclaimer_verified: boolean;
  };
  delivery: {
    status: string;
    notified_at_present: boolean;
    pdf_bytes: number;
    telegram: Array<{
      method: string;
      http_status: number;
      ok: boolean;
      message_id?: number;
      document_file_id?: string;
    }>;
  };
  patient_content_in_artifact: boolean;
}

function artifact(): { raw: string; value: LiveArtifact } {
  const raw = readFileSync(REPORT_PATH, "utf8");
  return { raw, value: JSON.parse(raw) as LiveArtifact };
}

// This suite verifies a local paid-run record, not a fixture required by checkout.
// Missing evidence is an explicit skip; a present but invalid record still fails.
describe.skipIf(!hasLiveEvidence)(
  hasLiveEvidence
    ? "one-shot live scenario artifact (read-only)"
    : `one-shot live scenario artifact (skipped: local evidence absent at ${REPORT_PATH})`,
  () => {
  it("is private, final, and time-coherent", () => {
    const { value } = artifact();
    const mode = statSync(REPORT_PATH).mode & 0o777;
    const wall = Date.parse(value.finished_at) - Date.parse(value.started_at);

    expect(mode).toBe(0o600);
    expect(value.schema_version).toBe(1);
    expect(value.verdict).toBe("full_success");
    expect(wall).toBeGreaterThanOrEqual(
      value.timings_ms.chat + value.timings_ms.structured,
    );
    expect(wall).toBeLessThan(value.timeout_layers.outer_guard_ms);
    expect(value.timeout_layers.outer_guard_ms).toBeGreaterThan(
      value.timeout_layers.chat_ms + value.timeout_layers.structured_ms,
    );
  });

  it("records the bounded live result without disguising an abstain", () => {
    const { value } = artifact();

    expect(value.cost_cap).toMatchObject({
      max_anthropic_calls: 3,
      actual_anthropic_calls: 2,
      sdk_retries: 0,
      application_retries: 0,
    });
    expect(value.cost_cap.actual_anthropic_calls).toBeLessThanOrEqual(
      value.cost_cap.max_anthropic_calls,
    );
    expect(value.cost_cap.usage).toMatchObject({
      input_tokens: 43_302,
      output_tokens: 337,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(value.result).toMatchObject({
      source: "llm_fallback",
      model_version: "lr-v1",
      abstained: true,
      abstain_reason: "low_confidence",
      urgency: "emergency",
      quote_evidence_verified: true,
      disclaimer_verified: true,
    });
    expect(value.result.redflag_codes).toContain("chest_pain");
  });

  it("proves Bot API acceptance of one summary and one PDF, not a read receipt", () => {
    const { value } = artifact();

    expect(value.delivery.status).toBe("sent");
    expect(value.delivery.notified_at_present).toBe(true);
    expect(value.delivery.pdf_bytes).toBeGreaterThan(0);
    expect(value.delivery.telegram).toHaveLength(2);
    expect(value.delivery.telegram[0]).toMatchObject({
      method: "sendMessage",
      http_status: 200,
      ok: true,
      message_id: 3,
    });
    expect(value.delivery.telegram[1]).toMatchObject({
      method: "sendDocument",
      http_status: 200,
      ok: true,
      message_id: 4,
    });
    expect(value.delivery.telegram[1].document_file_id).toEqual(
      expect.any(String),
    );
    expect(value.delivery.telegram.some(({ method }) => method === "sendAbortedNotice"))
      .toBe(false);
  });

  it("contains no credential, session, doctor, transcript, prompt, or patient phrase", () => {
    const { raw, value } = artifact();

    expect(value.patient_content_in_artifact).toBe(false);
    for (const forbidden of [
      /sk-ant-/iu,
      /bot[0-9]{8,}:/iu,
      /anthropic_api_key/iu,
      /telegram_(?:bot_token|doctor_chat_id)/iu,
      /doctor_?token/iu,
      /session_?id/iu,
      /chat_id/iu,
      /transcript/iu,
      /prompt/iu,
      /давит\s+в\s+груди/iu,
      /тяжело\s+дышать/iu,
    ]) {
      expect(raw).not.toMatch(forbidden);
    }
  });
  },
);
