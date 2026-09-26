import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface CorpusItem {
  id: string;
  language: "ru" | "kk";
  expected_emergency: boolean;
  target_trigger: string;
  trap: string | null;
  messages: { role: string; content: string }[];
}

interface BlindCaseCard {
  id: string;
  language: "ru" | "kk";
  text: string;
}

interface CaseTrace {
  id: string;
  trigger: string;
  corpus_label: "emergency" | "no_emergency";
  trap: string | null;
}

interface Packet {
  status: string;
  source_snapshots: {
    corpus: { sha256: string; clinician_review_status: string };
    benchmark: {
      sha256: string;
      interpretation: string;
      rules_candidate_version: string;
    };
  };
  blind_case_cards: BlindCaseCard[];
  internal_case_trace_do_not_show_before_judgment: CaseTrace[];
  flow_review: { flow: string[]; questions: string[] };
  interview: { case_response_options: { wording: string[] } };
  summary_review: {
    synthetic_only: boolean;
    questions: string[];
  };
  privacy_review: { questions: string[]; prohibited_inputs: string[] };
}

interface FeedbackTemplate {
  status: string;
  records: unknown[];
  completion_rule: {
    minimum_real_records: number;
    clinical_validation_claim_allowed_before_completion: boolean;
  };
  record_contract: {
    required_fields: string[];
  };
}

interface TraceabilityTemplate {
  status: string;
  items: unknown[];
  item_contract: {
    disposition_enum: string[];
    required_fields: string[];
  };
}

const readJson = <T,>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const packet = readJson<Packet>("reports/clinical-validation/packet-v1.json");
const feedback = readJson<FeedbackTemplate>(
  "reports/clinical-validation/feedback-template-v1.json",
);
const traceability = readJson<TraceabilityTemplate>(
  "reports/clinical-validation/traceability-v1.json",
);
const corpus = readJson<{ items: CorpusItem[] }>(
  "tests/fixtures/redflags-eval.json",
);
const benchmark = readJson<{
  candidates: { id: string; version: string }[];
}>("reports/redflags/redflags-benchmark-v1.json");

const triggerCodes = [
  "chest_pain",
  "stroke",
  "bleeding",
  "thunderclap_headache",
  "consciousness",
  "dyspnea_rest",
  "suicidal",
  "meningeal",
];

describe("pending clinical validation packet", () => {
  it("pins the final red-flag corpus and benchmark without claiming clinical validation", () => {
    expect(packet.status).toBe("pending_clinician_feedback");
    expect(packet.source_snapshots.corpus.sha256).toBe(
      sha256("tests/fixtures/redflags-eval.json"),
    );
    expect(packet.source_snapshots.benchmark.sha256).toBe(
      sha256("reports/redflags/redflags-benchmark-v1.json"),
    );
    expect(packet.source_snapshots.corpus.clinician_review_status).toBe(
      "pending",
    );
    expect(packet.source_snapshots.benchmark.interpretation).toContain(
      "not independent clinical validation",
    );
    expect(packet.source_snapshots.benchmark.interpretation).toContain(
      "adversarial cases",
    );
    expect(packet.source_snapshots.benchmark.rules_candidate_version).toBe(
      benchmark.candidates.find((candidate) => candidate.id === "rules")
        ?.version,
    );
  });

  it("uses exact blind corpus phrases and covers every family in RU and KK with a positive and a trap", () => {
    const source = new Map(corpus.items.map((item) => [item.id, item]));
    expect(packet.blind_case_cards).toHaveLength(16);
    expect(new Set(packet.blind_case_cards.map((item) => item.id)).size).toBe(16);

    for (const card of packet.blind_case_cards) {
      const original = source.get(card.id);
      expect(original, card.id).toBeDefined();
      expect(card.language).toBe(original?.language);
      expect(card.text).toBe(original?.messages.at(-1)?.content);
      expect(card).not.toHaveProperty("corpus_label");
      expect(card).not.toHaveProperty("expected_emergency");
    }

    const traces = packet.internal_case_trace_do_not_show_before_judgment;
    expect(new Set(traces.map((item) => item.trigger))).toEqual(
      new Set(triggerCodes),
    );
    for (const trigger of triggerCodes) {
      const pair = traces.filter((item) => item.trigger === trigger);
      expect(pair).toHaveLength(2);
      expect(new Set(pair.map((item) => source.get(item.id)?.language))).toEqual(
        new Set(["ru", "kk"]),
      );
      expect(new Set(pair.map((item) => item.corpus_label))).toEqual(
        new Set(["emergency", "no_emergency"]),
      );
      for (const item of pair) {
        const original = source.get(item.id);
        expect(item.corpus_label === "emergency").toBe(
          original?.expected_emergency,
        );
        expect(item.trap === null).toBe(original?.trap === null);
      }
    }
  });

  it("covers flow realism, patient wording, summary usefulness and privacy", () => {
    expect(packet.flow_review.flow).toHaveLength(5);
    expect(packet.flow_review.questions.join(" ")).toMatch(/реалистичен|задержка|врача/iu);
    expect(packet.interview.case_response_options.wording).toContain(
      "language_not_reviewed",
    );
    expect(packet.summary_review.synthetic_only).toBe(true);
    expect(packet.summary_review.questions.join(" ")).toMatch(/10 секунд|полезны|безопаснее/iu);
    expect(packet.privacy_review.questions.join(" ")).toMatch(/не нужно|пересылки/iu);
    expect(packet.privacy_review.prohibited_inputs).toEqual(
      expect.arrayContaining(["real patient name", "IIN", "phone number"]),
    );
  });

  it("keeps feedback empty until a real clinician responds and requires traceable dispositions", () => {
    expect(feedback.status).toBe("pending");
    expect(feedback.records).toEqual([]);
    expect(feedback.completion_rule.minimum_real_records).toBe(1);
    expect(feedback.completion_rule.clinical_validation_claim_allowed_before_completion).toBe(false);
    expect(feedback.record_contract.required_fields).toEqual(
      expect.arrayContaining([
        "reviewer_role",
        "specialty",
        "reviewed_at",
        "reviewed_case_ids",
        "findings",
      ]),
    );
    expect(feedback.record_contract.required_fields).not.toContain(
      "reviewer_name",
    );

    expect(traceability.status).toBe("pending_feedback");
    expect(traceability.items).toEqual([]);
    expect(traceability.item_contract.disposition_enum).toEqual(
      expect.arrayContaining([
        "accepted_code_change",
        "accepted_test_or_copy_change",
        "no_change_with_clinical_rationale",
        "needs_second_clinician_review",
      ]),
    );
    expect(traceability.item_contract.required_fields).toEqual(
      expect.arrayContaining(["code_paths", "test_paths", "rationale"]),
    );
  });

  it("provides a blind ready-to-forward questionnaire with every selected case", () => {
    const questionnaire = readFileSync(
      "reports/clinical-validation/doctor-questionnaire-ru.md",
      "utf8",
    );
    for (const card of packet.blind_case_cards) {
      expect(questionnaire).toContain(card.id);
      expect(questionnaire).toContain(card.text);
    }
    expect(questionnaire).toContain("Сообщение 1 из 2");
    expect(questionnaire).toContain("Сообщение 2 из 2");
    expect(questionnaire).not.toContain("corpus_label");
    expect(questionnaire).not.toContain("expected_emergency");
    expect(questionnaire).not.toContain("internal_case_trace");
  });
});
