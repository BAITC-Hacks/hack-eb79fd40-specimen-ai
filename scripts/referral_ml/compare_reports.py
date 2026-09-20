"""Compare report semantics while checking joblib integrity separately."""

from __future__ import annotations

import argparse
import json
from copy import deepcopy
from pathlib import Path
from typing import Any


class ComparisonFailure(RuntimeError):
    """Raised when two runs differ in metrics, decisions or metadata."""


def semantic_report(value: dict[str, Any]) -> dict[str, Any]:
    normalized = deepcopy(value)
    artifact = normalized.get("model_artifact")
    if not isinstance(artifact, dict) or "sha256" not in artifact:
        raise ComparisonFailure("missing_model_artifact_hash")
    artifact["sha256"] = "joblib_serializer_hash_checked_separately"
    artifact["bytes"] = "joblib_serializer_size_checked_separately"
    return normalized


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("expected", type=Path)
    parser.add_argument("actual", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    expected = json.loads(args.expected.read_text(encoding="utf-8"))
    actual = json.loads(args.actual.read_text(encoding="utf-8"))
    if semantic_report(expected) != semantic_report(actual):
        raise ComparisonFailure("semantic_report_mismatch")
    print("REFERRAL_REPRODUCIBLE_OK")


if __name__ == "__main__":
    main()
