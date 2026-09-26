"""Verify required measured candidates and the conditional Jev slot."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .common import load_json


def fail(message: str) -> None:
    raise SystemExit(f"REDFLAG_CANDIDATES_INVALID: {message}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("--required", action="append", default=[])
    parser.add_argument("--conditional", action="append", default=[])
    args = parser.parse_args()
    report = load_json(args.report)
    raw_candidates = report.get("candidates")
    if not isinstance(raw_candidates, list):
        fail("missing candidates")
    candidates: dict[str, dict[str, Any]] = {
        candidate["id"]: candidate
        for candidate in raw_candidates
        if isinstance(candidate, dict) and isinstance(candidate.get("id"), str)
    }
    for candidate_id in args.required:
        candidate = candidates.get(candidate_id)
        if not candidate or candidate.get("availability") != "measured":
            fail(f"required candidate {candidate_id} was not measured")
        if not candidate.get("model") or not candidate.get("version"):
            fail(f"required candidate {candidate_id} lacks model/version")
        if not isinstance(candidate.get("metrics"), dict):
            fail(f"required candidate {candidate_id} lacks metrics")
        if candidate_id == "jev":
            if candidate.get("provider") != "Convex":
                fail("jev: wrong provider")
            if candidate.get("endpoint") != "/alpha/decisions":
                fail("jev: wrong endpoint")
            if not candidate.get("provenance") or not candidate.get("predictions_artifact"):
                fail("jev: provenance or predictions artifact missing")
            threshold = candidate.get("threshold")
            if not isinstance(threshold, (int, float)) or not 0 <= float(threshold) <= 1:
                fail("jev: invalid threshold")
            latency = candidate.get("latency_ms")
            cost = candidate.get("cost")
            structured = candidate.get("structured_output")
            if not isinstance(latency, dict) or not isinstance(cost, dict):
                fail("jev: latency or cost missing")
            if cost.get("coverage") != 1:
                fail("jev: incomplete cost coverage")
            if not isinstance(structured, dict) or not structured.get("accepted_request_count"):
                fail("jev: request provenance missing")
    for candidate_id in args.conditional:
        candidate = candidates.get(candidate_id)
        if not candidate:
            fail(f"conditional candidate {candidate_id} is missing")
        availability = candidate.get("availability")
        if availability == "measured":
            if not candidate.get("model") or not candidate.get("version"):
                fail(f"{candidate_id}: measured candidate lacks model/version")
            if not candidate.get("provenance") or not isinstance(
                candidate.get("metrics"), dict
            ):
                fail(f"{candidate_id}: measured candidate lacks provenance/metrics")
        elif availability == "unavailable":
            if not candidate.get("unavailable_reason"):
                fail(f"{candidate_id}: unavailable reason is missing")
            if any(
                candidate.get(field) is not None
                for field in ("metrics", "slices", "latency_ms", "cost", "predictions_artifact")
            ):
                fail(f"{candidate_id}: unavailable candidate has invented measurements")
        else:
            fail(f"{candidate_id}: invalid availability")
    print("REDFLAG_CANDIDATES_OK")


if __name__ == "__main__":
    main()
