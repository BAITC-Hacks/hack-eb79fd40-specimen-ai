"""Recompute benchmark metrics and reject incomplete or invented reports."""

from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Any

from .common import confusion, load_json, percentile, sha256_file
from .verify_corpus import verify as verify_corpus


ROOT = Path(__file__).resolve().parents[2]


def fail(message: str) -> None:
    raise SystemExit(f"REDFLAG_BENCHMARK_INVALID: {message}")


def close(left: float, right: float) -> bool:
    return math.isclose(left, right, rel_tol=1e-9, abs_tol=1e-9)


def verify_candidate(
    candidate: dict[str, Any], items: list[dict[str, Any]], report_path: Path
) -> None:
    candidate_id = candidate.get("id")
    if candidate.get("availability") != "measured":
        return
    if candidate.get("research_only") is not True:
        fail(f"{candidate_id}: research_only must be true")
    if candidate.get("item_count") != len(items):
        fail(f"{candidate_id}: wrong item_count")
    artifact = candidate.get("predictions_artifact")
    if not isinstance(artifact, str):
        fail(f"{candidate_id}: missing predictions artifact")
    artifact_path = ROOT / artifact
    if not artifact_path.is_file():
        fail(f"{candidate_id}: predictions artifact does not exist")
    rows = load_json(artifact_path).get("predictions")
    if not isinstance(rows, list) or len(rows) != len(items):
        fail(f"{candidate_id}: incomplete predictions")
    predictions = {row.get("id"): row.get("emergency") for row in rows}
    expected_ids = {item["id"] for item in items}
    if set(predictions) != expected_ids or not all(
        isinstance(value, bool) for value in predictions.values()
    ):
        fail(f"{candidate_id}: invalid prediction ids or values")
    recalculated = confusion(
        [item["expected_emergency"] for item in items],
        [predictions[item["id"]] for item in items],
    )
    recorded = candidate.get("metrics")
    if not isinstance(recorded, dict):
        fail(f"{candidate_id}: missing metrics")
    for key, value in recalculated.items():
        if key not in recorded or not close(float(recorded[key]), float(value)):
            fail(f"{candidate_id}: incorrect metric {key}")
    latency = candidate.get("latency_ms")
    required_latency = {"measurement_unit", "request_count", "total", "mean", "p50", "p95"}
    if not isinstance(latency, dict) or not required_latency <= set(latency):
        fail(f"{candidate_id}: incomplete latency")
    if any(float(latency[key]) < 0 for key in ("total", "mean", "p50", "p95")):
        fail(f"{candidate_id}: negative latency")
    cost = candidate.get("cost")
    if not isinstance(cost, dict) or not {
        "currency",
        "amount",
        "basis",
    } <= set(cost):
        fail(f"{candidate_id}: incomplete cost")
    if not str(report_path):
        fail("unreachable report path guard")

    if candidate_id == "jev":
        if candidate.get("provider") != "Convex" or candidate.get("endpoint") != "/alpha/decisions":
            fail("jev: provider or endpoint mismatch")
        threshold = candidate.get("threshold")
        if not isinstance(threshold, (int, float)) or not 0 <= float(threshold) <= 1:
            fail("jev: invalid threshold")
        artifact_payload = load_json(artifact_path)
        if artifact_payload.get("schema_version") != "jev-predictions-v1":
            fail("jev: wrong predictions schema")
        if artifact_payload.get("model_requested") != candidate.get("model"):
            fail("jev: requested model mismatch")
        if artifact_payload.get("model_returned") != candidate.get("version"):
            fail("jev: returned model mismatch")
        if artifact_payload.get("corpus_sha256") != sha256_file(
            ROOT / "tests/fixtures/redflags-eval.json"
        ):
            fail("jev: corpus hash mismatch")
        if artifact_payload.get("question_spec_id") != "redflags-eight-trigger-v1":
            fail("jev: wrong question specification")
        if candidate.get("question_spec_id") != artifact_payload.get(
            "question_spec_id"
        ):
            fail("jev: report question specification mismatch")
        for row in rows:
            probability = row.get("noul_probability")
            if not isinstance(probability, (int, float)) or not math.isfinite(
                float(probability)
            ) or not 0 <= float(probability) <= 1:
                fail(f"jev: invalid probability for {row.get('id')}")
            if row.get("threshold") != threshold:
                fail(f"jev: threshold mismatch for {row.get('id')}")
            if row.get("emergency") is not (float(probability) >= float(threshold)):
                fail(f"jev: decision mismatch for {row.get('id')}")
        latencies = artifact_payload.get("wall_latency_ms_by_batch")
        if not isinstance(latencies, list) or not latencies:
            fail("jev: missing batch latencies")
        measured_latencies = [float(value) for value in latencies]
        expected_latency = {
            "request_count": len(measured_latencies),
            "total": sum(measured_latencies),
            "mean": sum(measured_latencies) / len(measured_latencies),
            "p50": percentile(measured_latencies, 0.50),
            "p95": percentile(measured_latencies, 0.95),
        }
        for key, value in expected_latency.items():
            if key not in latency or not close(float(latency[key]), float(value)):
                fail(f"jev: incorrect latency {key}")
        usage = artifact_payload.get("usage")
        if not isinstance(usage, dict) or usage.get("cost_coverage") != 1:
            fail("jev: incomplete cost coverage")
        if not close(float(cost.get("amount", -1)), float(usage.get("cost_usd", -2))):
            fail("jev: cost mismatch")
        structured = candidate.get("structured_output")
        if not isinstance(structured, dict):
            fail("jev: structured output metadata missing")
        if structured.get("accepted_request_count") != len(measured_latencies):
            fail("jev: accepted request count mismatch")
        if structured.get("input_tokens") != usage.get("input_tokens") or structured.get(
            "output_tokens"
        ) != usage.get("output_tokens"):
            fail("jev: token usage mismatch")


def verify(report_path: Path, corpus_path: Path) -> None:
    verify_corpus(corpus_path)
    report = load_json(report_path)
    corpus = load_json(corpus_path)
    items = corpus["items"]
    if report.get("schema_version") != "redflags-benchmark-v1":
        fail("unexpected schema_version")
    if report.get("research_only") is not True:
        fail("report must be research-only")
    if report.get("runtime_integration") != "none":
        fail("runtime integration must be none")
    report_corpus = report.get("corpus")
    if not isinstance(report_corpus, dict):
        fail("missing corpus metadata")
    if report_corpus.get("sha256") != sha256_file(corpus_path):
        fail("corpus hash mismatch")
    if report_corpus.get("item_count") != len(items):
        fail("corpus item count mismatch")
    candidates = report.get("candidates")
    if not isinstance(candidates, list):
        fail("missing candidates")
    measured = [candidate for candidate in candidates if candidate.get("availability") == "measured"]
    local = [candidate for candidate in measured if candidate.get("kind") == "local_ollama"]
    if len(local) < 2 or not any(candidate.get("id") == "rules" for candidate in measured):
        fail("rules and at least two local models must be measured")
    for candidate in candidates:
        verify_candidate(candidate, items, report_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("--corpus", type=Path, required=True)
    args = parser.parse_args()
    verify(args.report, args.corpus)
    print("REDFLAG_BENCHMARK_OK")


if __name__ == "__main__":
    main()
