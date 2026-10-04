"""Recompute benchmark metrics and reject incomplete or invented reports."""

from __future__ import annotations

import argparse
import math
import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from .common import confusion, load_json, percentile, sha256_file
from .verify_corpus import verify as verify_corpus
from .benchmark import metric_slices


ROOT = Path(__file__).resolve().parents[2]
# Frozen 2026-09 measurements. A new measurement requires a new artifact/version,
# never relabels these candidates during an offline rules refresh.
FROZEN_CANDIDATES = {
    "rules_baseline": ("b73acc5c65b7e1b498b15ecdd57b3b9f80e381386b4fc0cc738ca6d1fd1b4768", "c0dcd8318ee4168c304cb0d8c0da2fe86a359e4c0be50b33f6d43be7808bddad"),
    "qwen2.5:7b": ("c7ff5db2aa94b9895d79cdebd8d7695a5e3640e0bb2df2e4c638f0b9c8ac1fe4", "650c7545b44f130db21130aea7e64bea6ade536d633e0be80f894aa2b27c52e8"),
    "qwen2.5:14b": ("fdcbd4ab44c37d3e9d74b77da8191acd61642ec90d04955fd30c19c0efcd00d3", "2aa93c3245dbb2851478617ed8532013c2df212e18b465cb7cfbdca1d471bc76"),
    "jev": ("5b63d15afa66a151aa62e7ab6f22adbcb02079e821c1b4a7c9161c185ab2d543", "d8416af78b9b792f5bcf379889ef375549a7b9c93c8ddcb6df1390390d6b9f27"),
}



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
    if candidate_id in FROZEN_CANDIDATES:
        expected_metadata, expected_artifact = FROZEN_CANDIDATES[candidate_id]
        encoded = json.dumps(candidate, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        if hashlib.sha256(encoded).hexdigest() != expected_metadata or sha256_file(artifact_path) != expected_artifact:
            fail(f"{candidate_id}: frozen historical metadata or predictions changed")

    if candidate_id == "rules":
        provenance = candidate.get("provenance")
        expected_hashes = {
            "source_sha256": sha256_file(ROOT / "lib/redflags.ts"),
            "runner_sha256": sha256_file(ROOT / "scripts/redflag_eval/rules_runner.ts"),
            "corpus_sha256": sha256_file(ROOT / "tests/fixtures/redflags-eval.json"),
            "predictions_sha256": sha256_file(artifact_path),
        }
        if candidate.get("version") != expected_hashes["source_sha256"]:
            fail("rules: stale runtime source version")
        if not isinstance(provenance, dict) or set(provenance) != {*expected_hashes, "execution"} or provenance.get("execution") != "offline deterministic TypeScript only; historical candidates unchanged" or any(
            provenance.get(key) != value for key, value in expected_hashes.items()
        ):
            fail("rules: source/runner/corpus/predictions provenance mismatch")
        if not isinstance(candidate.get("measured_at"), str):
            fail("rules: missing separate refresh timestamp")
    rows = load_json(artifact_path).get("predictions")
    if not isinstance(rows, list) or len(rows) != len(items):
        fail(f"{candidate_id}: incomplete predictions")
    if candidate_id == "rules":
        payload = load_json(artifact_path)
        if set(payload) != {"candidate", "predictions"} or payload["candidate"] != "rules":
            fail("rules: unexpected artifact keys")
        if any(not isinstance(row, dict) or set(row) != {"id", "emergency", "codes", "latency_ms"}
               or not isinstance(row["codes"], list) or not all(isinstance(code, str) for code in row["codes"])
               or not isinstance(row["latency_ms"], (int, float)) or isinstance(row["latency_ms"], bool)
               or not math.isfinite(row["latency_ms"]) or row["latency_ms"] < 0 for row in rows):
            fail("rules: malformed prediction row")
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
    if candidate_id == "rules" and (recorded != recalculated or candidate.get("slices") != metric_slices(items, predictions)):
        fail("rules: metric shape or slice claims mismatch")
    for key, value in recalculated.items():
        if key not in recorded or not close(float(recorded[key]), float(value)):
            fail(f"{candidate_id}: incorrect metric {key}")
    latency = candidate.get("latency_ms")
    required_latency = {"measurement_unit", "request_count", "total", "mean", "p50", "p95"}
    if not isinstance(latency, dict) or not required_latency <= set(latency):
        fail(f"{candidate_id}: incomplete latency")
    if any(not math.isfinite(float(latency[key])) or float(latency[key]) < 0 for key in ("total", "mean", "p50", "p95")):
        fail(f"{candidate_id}: negative latency")
    cost = candidate.get("cost")
    if not isinstance(cost, dict) or not {
        "currency",
        "amount",
        "basis",
    } <= set(cost):
        fail(f"{candidate_id}: incomplete cost")
    if not math.isfinite(float(cost["amount"])) or float(cost["amount"]) < 0:
        fail(f"{candidate_id}: invalid cost")
    if candidate_id == "rules":
        values = [float(row["latency_ms"]) for row in rows]
        expected_latency = {"request_count": len(values), "total": sum(values), "mean": sum(values) / len(values),
                            "p50": percentile(values, 0.50), "p95": percentile(values, 0.95)}
        if latency.get("measurement_unit") != "per_item_wall_clock" or any(
            not close(float(latency.get(key, -1)), value) for key, value in expected_latency.items()
        ):
            fail("rules: artifact latency mismatch")
        if cost["amount"] != 0 or cost["currency"] != "USD":
            fail("rules: invented remote cost")
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
    if report.get("generated_at") != '2026-09-26T15:38:49.603Z':
        fail("historical measurement date changed")
    if set(report) != {"benchmark_title", "candidates", "corpus", "evaluation_design", "generated_at", "limitations", "method", "owner_decision", "research_only", "rules_refreshed_at", "runtime_integration", "schema_version"}:
        fail("unexpected report keys")
    frozen_metadata = {key: value for key, value in report.items() if key not in {"candidates", "rules_refreshed_at"}}
    encoded = json.dumps(frozen_metadata, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    if hashlib.sha256(encoded).hexdigest() != '5ab268179139dc6fd9543c58189591c034abcce13b54eb87ebc7985517a162d1':
        fail("frozen historical methodology/corpus/evaluation metadata changed")
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
    current = next((candidate for candidate in candidates if candidate.get("id") == "rules"), {})
    if set(current) != {"availability", "cost", "development_stage", "id", "item_count", "kind", "latency_ms", "measured_at", "metrics", "model", "predictions_artifact", "provenance", "research_only", "slices", "version"}:
        fail("unexpected current rules keys")
    if {candidate.get("id") for candidate in candidates} != {*FROZEN_CANDIDATES, "rules"}:
        fail("unexpected candidate set")
    if report.get("rules_refreshed_at") != current.get("measured_at"):
        fail("current refresh timestamp mismatch")
    try:
        measured = datetime.fromisoformat(current["measured_at"])
        if measured.tzinfo is None:
            fail("refresh timestamp lacks timezone")
    except (ValueError, TypeError):
        fail("invalid refresh timestamp")
    if len({candidate.get("id") for candidate in candidates}) != len(candidates):
        fail("duplicate candidate id")
    if set(FROZEN_CANDIDATES) - {candidate.get("id") for candidate in candidates}:
        fail("missing frozen candidate")
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
