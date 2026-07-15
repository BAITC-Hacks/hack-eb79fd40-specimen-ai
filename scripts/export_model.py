#!/usr/bin/env python3
"""Export a fitted LR model to the frozen SPINE model-artifact schema."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export_artifact(
    *,
    classifier: Any,
    specification: dict[str, Any],
    train_metrics: dict[str, float | int],
    abstain_threshold: float,
    model_version: str,
    output_path: Path,
    dataset_path: Path,
    provenance_path: Path,
    n_train_rows: int,
) -> Path:
    weights = np.asarray(classifier.coef_, dtype=np.float64)
    bias = np.asarray(classifier.intercept_, dtype=np.float64)
    feature_order = specification["feature_order"]
    class_order = specification["class_order"]
    if weights.shape != (len(class_order), len(feature_order)):
        raise ValueError(
            f"weights {weights.shape} do not match "
            f"classes={len(class_order)}, features={len(feature_order)}"
        )
    if bias.shape != (len(class_order),):
        raise ValueError(f"bias {bias.shape} does not match classes={len(class_order)}")
    if list(classifier.classes_) != list(range(len(class_order))):
        raise ValueError("classifier classes do not match class_order row indices")
    if not 0.0 < abstain_threshold < 1.0:
        raise ValueError("abstain_threshold must be empirically selected inside (0, 1)")
    if not np.isfinite(weights).all() or not np.isfinite(bias).all():
        raise ValueError("model parameters must contain only finite numbers")
    for name, value in train_metrics.items():
        if not isinstance(value, (int, float)) or not np.isfinite(value):
            raise ValueError(f"train_metrics.{name} must be finite")
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    license_metadata = provenance.get("license")
    if not isinstance(license_metadata, dict):
        raise ValueError("provenance license metadata is missing")
    license_name = license_metadata.get("name")
    license_source = license_metadata.get("source")
    if not isinstance(license_name, str) or not license_name.strip():
        raise ValueError("provenance license name is empty")
    if license_source != "figshare_article_metadata":
        raise ValueError("license must come from verified Figshare article metadata")
    if provenance.get("license_file_in_release") is not False:
        raise ValueError("provenance must explicitly record the absent release LICENSE")

    artifact = {
        "schema_version": 1,
        "model_version": model_version,
        "trained_at": dt.datetime.now(dt.UTC).isoformat(),
        "dataset_name": "DDXPlus",
        "dataset_sha256": file_hash(dataset_path),
        "license": license_name.strip(),
        "n_train_rows": int(n_train_rows),
        "feature_order": feature_order,
        "class_order": class_order,
        "weights": [[round(float(value), 6) for value in row] for row in weights],
        "bias": [round(float(value), 6) for value in bias],
        "preprocessing": specification["preprocessing"],
        "abstain_threshold": float(abstain_threshold),
        "train_metrics": train_metrics,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(artifact, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(
        f"-> {output_path} ({output_path.stat().st_size / 1e6:.1f} MB, "
        f"{len(class_order)}x{len(feature_order)} weights)"
    )
    return output_path
