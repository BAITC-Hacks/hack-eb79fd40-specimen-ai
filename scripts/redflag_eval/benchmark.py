"""Run rules and local Ollama candidates on one frozen corpus.

This is offline research tooling. It writes artifacts under eval/redflags and
reports/redflags and never imports a classifier into the application runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .common import confusion, load_json, percentile, sha256_file
from .verify_corpus import verify as verify_corpus


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CORPUS = ROOT / "tests/fixtures/redflags-eval.json"
DEFAULT_REPORT = ROOT / "reports/redflags/redflags-benchmark-v1.json"
PREDICTIONS_DIR = ROOT / "eval/redflags"
OLLAMA_URL = "http://127.0.0.1:11434"
LOCAL_MODELS = ("qwen2.5:7b", "qwen2.5:14b")
JEV_ARTIFACT = PREDICTIONS_DIR / "jev-1.13-v1.json"

PROMPT_TEMPLATE = """You are evaluating a research safety classifier for a patient intake chat.
Return emergency=true only when the PATIENT currently reports one of these eight trigger groups:
1 chest pain; 2 sudden worst-ever headache; 3 stroke signs; 4 active serious bleeding;
5 loss/alteration of consciousness or seizures; 6 breathlessness at rest;
7 self-harm intent/thoughts; 8 neck stiffness or light sensitivity suggesting a meningeal warning.

Important: return false for explicit denial, a fully resolved past episode, a symptom belonging to
someone else, quotation/metaphor, or an assistant question without patient confirmation.
RU and KK text are both expected. The JSON array below contains exactly {item_count} patient reports.
Classify every array element independently and preserve its input order. Return exactly {item_count}
characters: character i classifies array element i. The eight trigger groups define the positive
condition; do not output one bit per trigger group. Example for three reports: {{"bits":"010"}}.
Use 1 for emergency and 0 for not emergency. Output only {{"bits":"..."}}.

Items:
{items_json}
"""

def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def tags() -> dict[str, str]:
    with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=10) as response:
        payload = json.load(response)
    return {
        entry["name"]: entry.get("digest", "unknown")
        for entry in payload.get("models", [])
        if isinstance(entry, dict) and isinstance(entry.get("name"), str)
    }


def ollama_batch(model: str, items: list[dict[str, Any]]) -> tuple[dict[str, bool], float, float]:
    compact = [
        " ".join(
            message["content"]
            for message in item["messages"]
            if message["role"] == "user"
        )
        for item in items
    ]
    prompt = PROMPT_TEMPLATE.format(
        item_count=len(items),
        items_json=json.dumps(compact, ensure_ascii=False, separators=(",", ":")),
    )
    request = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps(
            {
                "model": model,
                "prompt": prompt,
                "stream": False,
                "format": {
                    "type": "object",
                    "properties": {
                        "bits": {
                            "type": "string",
                            "minLength": len(items),
                            "maxLength": len(items),
                            "pattern": "^[01]+$",
                        }
                    },
                    "required": ["bits"],
                },
                "keep_alive": "15m",
                "options": {
                    "temperature": 0,
                    "seed": 20260926,
                    "num_ctx": 8192,
                    "num_predict": 256,
                },
            }
        ).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=1200) as response:
        payload = json.load(response)
    wall_ms = (time.perf_counter() - started) * 1000
    engine_ms = float(payload.get("total_duration", 0)) / 1_000_000
    decoded = json.loads(payload["response"])
    bits = decoded.get("bits")
    if (
        not isinstance(bits, str)
        or len(bits) != len(items)
        or any(bit not in "01" for bit in bits)
    ):
        raise ValueError(
            f"{model}: expected {len(items)} binary decisions, got {bits!r}"
        )
    result = {
        item["id"]: bit == "1" for item, bit in zip(items, bits, strict=True)
    }
    return result, wall_ms, engine_ms


def ollama_resilient(
    model: str, items: list[dict[str, Any]]
) -> tuple[dict[str, bool], list[float], list[float]]:
    """Split a malformed batch without accepting or inventing missing decisions."""
    try:
        result, wall_ms, engine_ms = ollama_batch(model, items)
        return result, [wall_ms], [engine_ms]
    except ValueError:
        if len(items) == 1:
            raise
        midpoint = len(items) // 2
        left, left_wall, left_engine = ollama_resilient(model, items[:midpoint])
        right, right_wall, right_engine = ollama_resilient(model, items[midpoint:])
        return (
            {**left, **right},
            [*left_wall, *right_wall],
            [*left_engine, *right_engine],
        )


def metric_slices(
    items: list[dict[str, Any]], predictions: dict[str, bool]
) -> dict[str, dict[str, int | float]]:
    slices: dict[str, dict[str, int | float]] = {}
    for language in ("ru", "kk"):
        selected = [item for item in items if item["language"] == language]
        slices[f"language:{language}"] = confusion(
            [item["expected_emergency"] for item in selected],
            [predictions[item["id"]] for item in selected],
        )
    for trigger in sorted({item["target_trigger"] for item in items}):
        selected = [item for item in items if item["target_trigger"] == trigger]
        slices[f"trigger:{trigger}"] = confusion(
            [item["expected_emergency"] for item in selected],
            [predictions[item["id"]] for item in selected],
        )
    return slices


def candidate_result(
    *,
    candidate_id: str,
    kind: str,
    model: str,
    version: str,
    items: list[dict[str, Any]],
    predictions: dict[str, bool],
    latencies: list[float],
    latency_unit: str,
    request_count: int,
    prediction_path: Path,
) -> dict[str, Any]:
    metrics = confusion(
        [item["expected_emergency"] for item in items],
        [predictions[item["id"]] for item in items],
    )
    return {
        "id": candidate_id,
        "kind": kind,
        "model": model,
        "version": version,
        "availability": "measured",
        "research_only": True,
        "item_count": len(items),
        "metrics": metrics,
        "slices": metric_slices(items, predictions),
        "latency_ms": {
            "measurement_unit": latency_unit,
            "request_count": request_count,
            "total": sum(latencies),
            "mean": sum(latencies) / len(latencies),
            "p50": percentile(latencies, 0.50),
            "p95": percentile(latencies, 0.95),
        },
        "cost": {
            "currency": "USD",
            "amount": 0.0,
            "basis": "local execution; hardware, electricity and operator time excluded",
        },
        "predictions_artifact": str(prediction_path.relative_to(ROOT)),
    }


def run_rules(corpus_path: Path, items: list[dict[str, Any]]) -> dict[str, Any]:
    command = [
        str(ROOT / "node_modules/.bin/tsx"),
        str(ROOT / "scripts/redflag_eval/rules_runner.ts"),
        str(corpus_path),
    ]
    completed = subprocess.run(
        command,
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    rows = payload["predictions"]
    predictions = {row["id"]: row["emergency"] for row in rows}
    path = PREDICTIONS_DIR / "rules-v1.json"
    write_json(path, {"candidate": "rules", "predictions": rows})
    return candidate_result(
        candidate_id="rules",
        kind="deterministic_rules",
        model="lib/redflags.ts",
        version=sha256_file(ROOT / "lib/redflags.ts"),
        items=items,
        predictions=predictions,
        latencies=[float(row["latency_ms"]) for row in rows],
        latency_unit="per_item_wall_clock",
        request_count=len(rows),
        prediction_path=path,
    )


def run_ollama(
    model: str,
    digest: str,
    items: list[dict[str, Any]],
    batch_size: int,
    corpus_sha256: str,
) -> dict[str, Any]:
    checkpoint_path = PREDICTIONS_DIR / f"{model.replace(':', '-')}-checkpoint.json"
    checkpoint_key = {
        "model": model,
        "version": digest,
        "corpus_sha256": corpus_sha256,
        "batch_size": batch_size,
        "prompt_template_sha256": hashlib.sha256(PROMPT_TEMPLATE.encode()).hexdigest(),
    }
    predictions: dict[str, bool] = {}
    wall_latencies: list[float] = []
    engine_latencies: list[float] = []
    if checkpoint_path.is_file():
        checkpoint = load_json(checkpoint_path)
        if checkpoint.get("key") == checkpoint_key:
            saved = checkpoint.get("predictions")
            saved_wall = checkpoint.get("wall_latency_ms_by_batch")
            saved_engine = checkpoint.get("engine_latency_ms_by_batch")
            if (
                isinstance(saved, dict)
                and all(isinstance(value, bool) for value in saved.values())
                and isinstance(saved_wall, list)
                and isinstance(saved_engine, list)
            ):
                predictions = saved
                wall_latencies = [float(value) for value in saved_wall]
                engine_latencies = [float(value) for value in saved_engine]
    ordered_ids = [item["id"] for item in items]
    completed = len(predictions)
    if list(predictions) != ordered_ids[:completed] or completed % batch_size != 0:
        raise ValueError(f"{model}: invalid checkpoint ordering")
    for start in range(completed, len(items), batch_size):
        batch = items[start : start + batch_size]
        result, batch_wall, batch_engine = ollama_resilient(model, batch)
        predictions.update(result)
        wall_latencies.extend(batch_wall)
        engine_latencies.extend(batch_engine)
        write_json(
            checkpoint_path,
            {
                "key": checkpoint_key,
                "predictions": predictions,
                "wall_latency_ms_by_batch": wall_latencies,
                "engine_latency_ms_by_batch": engine_latencies,
            },
        )
        print(
            f"{model}: {min(start + batch_size, len(items))}/{len(items)} "
            f"({sum(batch_wall):.0f} ms across {len(batch_wall)} request(s))",
            flush=True,
        )
    rows = [
        {
            "id": item["id"],
            "emergency": predictions[item["id"]],
        }
        for item in items
    ]
    path = PREDICTIONS_DIR / f"{model.replace(':', '-')}-v1.json"
    write_json(
        path,
        {
            "candidate": model,
            "batch_size": batch_size,
            "predictions": rows,
            "engine_latency_ms_by_batch": engine_latencies,
        },
    )
    return candidate_result(
        candidate_id=model,
        kind="local_ollama",
        model=model,
        version=digest,
        items=items,
        predictions=predictions,
        latencies=wall_latencies,
        latency_unit=f"wall_clock_per_batch_of_up_to_{batch_size}",
        request_count=len(wall_latencies),
        prediction_path=path,
    )


def load_jev_candidate(items: list[dict[str, Any]], corpus_path: Path) -> dict[str, Any]:
    """Load the separately measured Convex Decisions result without another paid call."""
    if not JEV_ARTIFACT.is_file():
        return {
            "id": "jev",
            "kind": "external_candidate",
            "provider": "Convex",
            "model": "typesafe/jev-1.13",
            "version": "1.13",
            "endpoint": "/alpha/decisions",
            "availability": "unavailable",
            "unavailable_reason": (
                "No verified Jev predictions artifact is available. Convex documents "
                "AI Gateway as paid-plan only and /alpha/decisions as alpha."
            ),
            "provenance": "user-specified research candidate",
            "research_only": True,
            "item_count": len(items),
            "metrics": None,
            "slices": None,
            "latency_ms": None,
            "cost": None,
            "predictions_artifact": None,
        }

    artifact = load_json(JEV_ARTIFACT)
    if artifact.get("schema_version") != "jev-predictions-v1":
        raise ValueError("Jev artifact has an unsupported schema")
    if artifact.get("corpus_sha256") != sha256_file(corpus_path):
        raise ValueError("Jev artifact corpus hash mismatch")
    if artifact.get("research_only") is not True:
        raise ValueError("Jev artifact must remain research-only")
    if artifact.get("question_spec_id") != "redflags-eight-trigger-v1":
        raise ValueError("Jev artifact question specification mismatch")
    threshold = artifact.get("threshold")
    rows = artifact.get("predictions")
    latencies = artifact.get("wall_latency_ms_by_batch")
    usage = artifact.get("usage")
    if not isinstance(threshold, (int, float)) or not 0 <= float(threshold) <= 1:
        raise ValueError("Jev artifact threshold is invalid")
    if not isinstance(rows, list) or len(rows) != len(items):
        raise ValueError("Jev artifact does not cover the frozen corpus")
    if not isinstance(latencies, list) or not latencies:
        raise ValueError("Jev artifact latency is missing")
    if not isinstance(usage, dict) or usage.get("cost_coverage") != 1:
        raise ValueError("Jev artifact cost coverage is incomplete")

    predictions: dict[str, bool] = {}
    for item, row in zip(items, rows, strict=True):
        probability = row.get("noul_probability")
        if row.get("id") != item["id"]:
            raise ValueError("Jev artifact prediction order mismatch")
        if not isinstance(probability, (int, float)) or not 0 <= float(probability) <= 1:
            raise ValueError(f"Jev artifact probability is invalid for {item['id']}")
        expected_decision = float(probability) >= float(threshold)
        if row.get("emergency") is not expected_decision:
            raise ValueError(f"Jev artifact threshold decision mismatch for {item['id']}")
        predictions[item["id"]] = expected_decision

    measured_latencies = [float(value) for value in latencies]
    return {
        "id": "jev",
        "kind": "external_candidate",
        "provider": "Convex",
        "model": artifact.get("model_requested"),
        "version": artifact.get("model_returned"),
        "endpoint": "/alpha/decisions",
        "availability": "measured",
        "provenance": (
            "Convex AI Gateway paid Starter run on the frozen synthetic corpus with the "
            "same eight-trigger taxonomy as rules/Qwen; official Decisions alpha endpoint; "
            "2026-09-26."
        ),
        "research_only": True,
        "clinician_validated": artifact.get("clinician_validated") is True,
        "item_count": len(items),
        "threshold": float(threshold),
        "question_spec_id": artifact.get("question_spec_id"),
        "metrics": confusion(
            [item["expected_emergency"] for item in items],
            [predictions[item["id"]] for item in items],
        ),
        "slices": metric_slices(items, predictions),
        "latency_ms": {
            "measurement_unit": "wall_clock_per_batch_of_up_to_10",
            "request_count": len(measured_latencies),
            "total": sum(measured_latencies),
            "mean": sum(measured_latencies) / len(measured_latencies),
            "p50": percentile(measured_latencies, 0.50),
            "p95": percentile(measured_latencies, 0.95),
            "scope": (
                "Convex action wall-clock around accepted Decisions requests; "
                "deployment invocation overhead excluded."
            ),
        },
        "cost": {
            "currency": "USD",
            "amount": float(usage["cost_usd"]),
            "basis": (
                "usage.cost returned by Convex AI Gateway for all accepted requests; "
                "Convex action platform usage excluded."
            ),
            "coverage": usage["cost_coverage"],
        },
        "predictions_artifact": str(JEV_ARTIFACT.relative_to(ROOT)),
        "structured_output": {
            "logical_batch_count": len(measured_latencies),
            "accepted_request_count": len(measured_latencies),
            "rejected_response_count": 0,
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--batch-size", type=int, default=10)
    args = parser.parse_args()
    verify_corpus(args.corpus)
    corpus = load_json(args.corpus)
    items = corpus["items"]
    if not isinstance(items, list):
        raise ValueError("corpus items must be an array")
    installed = tags()
    missing = [model for model in LOCAL_MODELS if model not in installed]
    if missing:
        raise SystemExit(f"required local Ollama models are absent: {missing}")

    candidates = [run_rules(args.corpus, items)]
    for model in LOCAL_MODELS:
        candidates.append(
            run_ollama(
                model,
                installed[model],
                items,
                args.batch_size,
                sha256_file(args.corpus),
            )
        )
    candidates.append(load_jev_candidate(items, args.corpus))

    prompt_hash = hashlib.sha256(PROMPT_TEMPLATE.encode()).hexdigest()
    report = {
        "schema_version": "redflags-benchmark-v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "research_only": True,
        "runtime_integration": "none",
        "owner_decision": (
            "Keep deterministic rules as the only runtime emergency detector. "
            "Local classifiers remain research-only pending clinician validation and a separate owner decision."
        ),
        "corpus": {
            "path": str(args.corpus.resolve().relative_to(ROOT)),
            "sha256": sha256_file(args.corpus),
            "item_count": len(items),
            "frozen_on": corpus.get("frozen_on"),
        },
        "method": {
            "same_frozen_split": True,
            "binary_positive": "at least one of the eight emergency trigger groups",
            "ollama_url": OLLAMA_URL,
            "ollama_batch_size": args.batch_size,
            "ollama_temperature": 0,
            "ollama_seed": 20260926,
            "prompt_template_sha256": prompt_hash,
            "external_calls_made": sum(
                int(candidate.get("structured_output", {}).get("accepted_request_count", 0))
                for candidate in candidates
                if candidate.get("kind") == "external_candidate"
            ),
        },
        "limitations": [
            *corpus.get("limitations", []),
            *(
                [
                    "Jev was measured once through Convex AI Gateway alpha; no repeated-run "
                    "variance or deterministic seed is available."
                ]
                if any(candidate.get("id") == "jev" and candidate.get("availability") == "measured" for candidate in candidates)
                else []
            ),
        ],
        "candidates": candidates,
    }
    write_json(args.report, report)
    print(f"wrote {args.report}")


if __name__ == "__main__":
    main()
