"""Recompute benchmark metrics and reject incomplete or invented reports."""

from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Any

from .common import confusion, load_json, sha256_file
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
