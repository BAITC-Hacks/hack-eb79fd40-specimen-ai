"""Add before/after deterministic-rule results without rerunning local models."""

from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime
from typing import Any

from .benchmark import PREDICTIONS_DIR, ROOT, candidate_result, write_json
from .common import load_json, sha256_file


CORPUS_PATH = ROOT / "tests/fixtures/redflags-eval.json"
REPORT_PATH = ROOT / "reports/redflags/redflags-benchmark-v1.json"
MISSES_PATH = ROOT / "reports/redflags/rules-misses-before-hardening-v1.json"


def keyed(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {row["id"]: row for row in rows}


def misses(
    items: list[dict[str, Any]], rows: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    predictions = keyed(rows)
    false_negatives: list[dict[str, Any]] = []
    false_positives: list[dict[str, Any]] = []
    for item in items:
        prediction = predictions[item["id"]]
        predicted = prediction["emergency"]
        expected = item["expected_emergency"]
        if expected == predicted:
            continue
        entry = {
            "id": item["id"],
            "language": item["language"],
            "target_trigger": item["target_trigger"],
            "messages": item["messages"],
            "expected_emergency": expected,
            "predicted_emergency": predicted,
            "predicted_codes": prediction.get("codes", []),
            "provenance": item["provenance"],
        }
        (false_negatives if expected else false_positives).append(entry)
    return false_negatives, false_positives


def run_current_rules() -> list[dict[str, Any]]:
    completed = subprocess.run(
        [
            str(ROOT / "node_modules/.bin/tsx"),
            str(ROOT / "scripts/redflag_eval/rules_runner.ts"),
            str(CORPUS_PATH),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    rows = payload.get("predictions")
    if not isinstance(rows, list):
        raise ValueError("rules runner did not return predictions")
    return rows


def main() -> None:
    report = load_json(REPORT_PATH)
    corpus = load_json(CORPUS_PATH)
    items = corpus["items"]
    candidates = report["candidates"]
    baseline_candidate = next(
        (
            candidate
            for candidate in candidates
            if candidate["id"] == "rules_baseline"
        ),
        None,
    )
    if baseline_candidate is None:
        baseline_candidate = next(
            candidate for candidate in candidates if candidate["id"] == "rules"
        )
    baseline_payload = load_json(ROOT / baseline_candidate["predictions_artifact"])
    baseline_rows = baseline_payload["predictions"]
    baseline_path = PREDICTIONS_DIR / "rules-baseline-v1.json"
    if not baseline_path.is_file():
        write_json(
            baseline_path,
            {"candidate": "rules_baseline", "predictions": baseline_rows},
        )
    baseline_candidate["id"] = "rules_baseline"
    baseline_candidate["kind"] = "deterministic_rules_baseline"
    baseline_candidate["predictions_artifact"] = str(baseline_path.relative_to(ROOT))
    baseline_candidate["development_stage"] = "before corpus-guided hardening"

    current_rows = run_current_rules()
    current_path = PREDICTIONS_DIR / "rules-v1.json"
    write_json(current_path, {"candidate": "rules", "predictions": current_rows})
    current_predictions = {row["id"]: row["emergency"] for row in current_rows}
    current_candidate = candidate_result(
        candidate_id="rules",
        kind="deterministic_rules",
        model="lib/redflags.ts",
        version=sha256_file(ROOT / "lib/redflags.ts"),
        items=items,
        predictions=current_predictions,
        latencies=[float(row["latency_ms"]) for row in current_rows],
        latency_unit="per_item_wall_clock",
        request_count=len(current_rows),
        prediction_path=current_path,
    )
    current_candidate["development_stage"] = "after corpus-guided hardening"

    before_fn, before_fp = misses(items, baseline_rows)
    after_fn, after_fp = misses(items, current_rows)
    write_json(
        MISSES_PATH,
        {
            "schema_version": "redflags-rule-misses-v1",
            "research_only": True,
            "clinician_review_status": "pending",
            "corpus_sha256": sha256_file(CORPUS_PATH),
            "baseline": {
                "false_negative_count": len(before_fn),
                "false_positive_count": len(before_fp),
                "false_negatives": before_fn,
                "false_positives": before_fp,
            },
            "after_hardening": {
                "false_negative_count": len(after_fn),
                "false_positive_count": len(after_fp),
                "false_negatives": after_fn,
                "false_positives": after_fp,
            },
        },
    )

    other_candidates = [
        candidate
        for candidate in candidates
        if candidate["id"] not in {"rules", "rules_baseline"}
    ]
    logical_batch_count = len(items) // int(report["method"]["ollama_batch_size"])
    for candidate in other_candidates:
        if candidate.get("kind") != "local_ollama":
            continue
        accepted_requests = int(candidate["latency_ms"]["request_count"])
        candidate["structured_output"] = {
            "logical_batch_count": logical_batch_count,
            "accepted_request_count": accepted_requests,
            "rejected_malformed_response_count": (
                accepted_requests - logical_batch_count
            ),
        }
        candidate["latency_ms"]["scope"] = (
            "accepted structurally complete requests only; rejected malformed-response "
            "request time was not retained by benchmark v1 instrumentation"
        )
    report["generated_at"] = datetime.now(UTC).isoformat()
    report["benchmark_title"] = "Synthetic RU/KK emergency regression benchmark"
    report["evaluation_design"] = {
        "split_role": "development regression corpus",
        "rules_developed_against_this_corpus": True,
        "unseen_generalization_claim": False,
        "local_models_frozen_before_rule_hardening": True,
        "baseline_rules_preserved": True,
        "independent_adversarial_review_cases_in_corpus": False,
        "independent_adversarial_review_test": (
            "tests/unit/redflags.production-20260926.test.ts"
        ),
        "misses_artifact": str(MISSES_PATH.relative_to(ROOT)),
    }
    report["owner_decision"] = (
        "Keep hardened deterministic rules as the only runtime emergency detector. "
        "Classifier candidates remain research-only and are not integrated."
    )
    report["limitations"] = list(
        dict.fromkeys([
        *report.get("limitations", []),
        "The hardened rules were developed against this exact corpus; their after score is in-sample regression coverage, not unseen generalization.",
        "All labels await clinician review.",
        "Post-benchmark adversarial review cases are held outside the developed corpus and are regression-tested separately.",
        "Local-model latency excludes rejected malformed-response request time; accepted-request latency and exact rejected-response counts are retained.",
        ])
    )
    report["candidates"] = [baseline_candidate, current_candidate, *other_candidates]
    write_json(REPORT_PATH, report)
    print(
        "REDFLAG_HARDENING_FINALIZED "
        f"before_fn={len(before_fn)} before_fp={len(before_fp)} "
        f"after_fn={len(after_fn)} after_fp={len(after_fp)}"
    )


if __name__ == "__main__":
    main()
