"""Shared validation and metric helpers for the offline red-flag benchmark."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


TRIGGERS = {
    "chest_pain",
    "stroke",
    "bleeding",
    "thunderclap_headache",
    "consciousness",
    "dyspnea_rest",
    "suicidal",
    "meningeal",
}


def load_json(path: str | Path) -> dict[str, Any]:
    with Path(path).open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return value


def sha256_file(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def confusion(
    expected: list[bool], predicted: list[bool]
) -> dict[str, int | float]:
    tp = sum(want and got for want, got in zip(expected, predicted, strict=True))
    fp = sum(not want and got for want, got in zip(expected, predicted, strict=True))
    tn = sum(not want and not got for want, got in zip(expected, predicted, strict=True))
    fn = sum(want and not got for want, got in zip(expected, predicted, strict=True))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    false_positive_rate = fp / (fp + tn) if fp + tn else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "tn": tn,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "false_positive_rate": false_positive_rate,
    }


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * quantile))))
    return ordered[index]
