"""Train the reproducible offline D1 wait-time benchmark."""

from __future__ import annotations

import argparse
import importlib.metadata
import os
import tempfile
from pathlib import Path
from typing import Any

import joblib  # type: ignore[import-untyped]
import numpy as np
import pandas as pd  # type: ignore[import-untyped]

from .audit import audit_parquet
from .contracts import (
    CATEGORICAL_FEATURES,
    EXCLUDED_FEATURES,
    HORIZON_DAYS,
    LIMITATIONS,
    MODEL_NAME,
    REPORT_STATUS,
)
from .io import write_json
from .io import sha256_file
from .wait_pipeline import (
    TemporalPartitions,
    WaitModelBundle,
    build_cohort,
    fit_model,
    fit_hist_gradient_model,
    global_median_predictions,
    hierarchical_median_predictions,
    regression_metrics,
    temporal_split,
)

ALPHAS = (1.0, 10.0, 100.0)
HIST_GRADIENT_CANDIDATES = (
    ("squared_error", 31),
    ("squared_error", 63),
    ("poisson", 31),
    ("poisson", 63),
)


def metrics_for(frame: pd.DataFrame, predictions: np.ndarray) -> dict[str, float | int]:
    return regression_metrics(frame["wait_days"].to_numpy(), predictions)


def fit_candidate(frame: pd.DataFrame, specification: dict[str, Any]) -> WaitModelBundle:
    if specification["family"] == "ridge_one_hot":
        return fit_model(frame, float(specification["alpha"]))
    if specification["family"] == "hist_gradient_ordinal_categorical":
        return fit_hist_gradient_model(
            frame,
            loss=str(specification["loss"]),
            max_leaf_nodes=int(specification["max_leaf_nodes"]),
        )
    raise ValueError("unknown_model_family")


def validate_model_output(path: Path) -> Path:
    resolved = path.resolve()
    private_directory = (Path.cwd() / "data" / "processed").resolve()
    temporary_directory = Path(tempfile.gettempdir()).resolve()
    if resolved.suffix != ".joblib":
        raise ValueError("model_output_must_be_joblib")
    if not (resolved.is_relative_to(private_directory) or resolved.is_relative_to(temporary_directory)):
        raise ValueError("model_output_must_be_private_or_temporary")
    return resolved


def choose_candidate(
    partitions: TemporalPartitions,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    candidates: list[dict[str, Any]] = []
    for alpha in ALPHAS:
        specification = {"family": "ridge_one_hot", "alpha": alpha}
        model = fit_candidate(partitions.train, specification)
        validation_predictions = model.predict(partitions.validation)
        candidates.append(
            {
                **specification,
                "validation": metrics_for(partitions.validation, validation_predictions),
            }
        )
    for loss, max_leaf_nodes in HIST_GRADIENT_CANDIDATES:
        specification = {
            "family": "hist_gradient_ordinal_categorical",
            "loss": loss,
            "max_leaf_nodes": max_leaf_nodes,
        }
        model = fit_candidate(partitions.train, specification)
        validation_predictions = model.predict(partitions.validation)
        candidates.append(
            {
                **specification,
                "validation": metrics_for(partitions.validation, validation_predictions),
            }
        )
    chosen = min(
        candidates,
        key=lambda item: (item["validation"]["mae_days"], str(item)),
    )
    specification = {key: value for key, value in chosen.items() if key != "validation"}
    return specification, candidates


def train_and_report(input_path: Path, model_output: Path) -> dict[str, Any]:
    model_output = validate_model_output(model_output)
    audit = audit_parquet(input_path)
    source = pd.read_parquet(input_path)
    cohort = build_cohort(source)
    partitions = temporal_split(cohort.frame)
    selected_model, candidates = choose_candidate(partitions)

    development = pd.concat([partitions.train, partitions.validation], ignore_index=True)
    model = fit_candidate(development, selected_model)
    model_predictions = model.predict(partitions.test)
    global_predictions = global_median_predictions(development, partitions.test)
    hierarchical_predictions = hierarchical_median_predictions(development, partitions.test)

    test_metrics = metrics_for(partitions.test, model_predictions)
    global_metrics = metrics_for(partitions.test, global_predictions)
    hierarchical_metrics = metrics_for(partitions.test, hierarchical_predictions)
    model_mae = float(test_metrics["mae_days"])

    package_versions = {
        package: importlib.metadata.version(package)
        for package in ("joblib", "numpy", "pandas", "pyarrow", "scikit-learn", "scipy")
    }
    report: dict[str, Any] = {
        "schema_version": 1,
        "model_name": MODEL_NAME,
        "status": REPORT_STATUS,
        "runtime_activation": "blocked",
        "task": "D1_wait_time_research_benchmark",
        "source": audit["input"],
        "target": {
            "field": "wait_days",
            "definition": "registration_dt_to_hospitalization_dt_from_handoff",
            "prediction_time": "registration_dt",
            "prediction_time_semantics": "not_verified_as_waitlist_placement",
            "population": "hospitalized_only",
            "horizon_days": HORIZON_DAYS,
            "horizon_policy": "exclude_observed_wait_over_60_days",
        },
        "cohort": cohort.attrition,
        "features": {
            "included": list(CATEGORICAL_FEATURES),
            "excluded": {reason: list(fields) for reason, fields in EXCLUDED_FEATURES.items()},
            "candidate_encodings": [
                "train_partition_one_hot_min_frequency_20",
                "train_partition_ordinal_max_categories_255_min_frequency_20",
            ],
            "point_in_time_verified": False,
        },
        "split": {
            "strategy": "calendar_months",
            "train": {"period": "2025-01", "rows": len(partitions.train)},
            "validation": {"period": "2025-02", "rows": len(partitions.validation)},
            "test": {
                "period": "2025-03",
                "rows": len(partitions.test),
                "used_for_model_selection_in_this_pipeline": False,
                "previously_examined_in_source_handoff": True,
            },
        },
        "selection": {
            "criterion": "validation_mae_days",
            "candidates": candidates,
            "selected_model": selected_model,
        },
        "test": {
            "model": test_metrics,
            "global_median_baseline": global_metrics,
            "hierarchical_median_baseline": hierarchical_metrics,
            "mae_improvement_vs_global_days": round(
                float(global_metrics["mae_days"]) - model_mae, 6
            ),
            "mae_improvement_vs_hierarchical_days": round(
                float(hierarchical_metrics["mae_days"]) - model_mae, 6
            ),
        },
        "blocked_tasks": {
            "B3": "missing_refusal_reason_and_point_in_time_package_snapshot",
            "D2": "missing_laboratory_demand_target",
            "D4": "missing_attendance_target",
        },
        "limitations": list(LIMITATIONS),
        "reproducibility": {
            "python": "3.12",
            "packages": package_versions,
            "random_seed": 20250919,
            "deterministic_metrics_and_semantic_report": True,
            "joblib_serializer_byte_stable": False,
        },
        "privacy": {
            "contains_row_data": False,
            "contains_identifiers": False,
            "model_binary_contains_source_categories": True,
            "model_binary_git_tracking": "forbidden",
        },
    }

    model_output.parent.mkdir(parents=True, exist_ok=True)
    temporary = model_output.with_suffix(model_output.suffix + ".tmp")
    joblib.dump(
        {
            "model": model,
            "model_name": MODEL_NAME,
            "input_sha256": audit["input"]["sha256"],
            "selected_model": selected_model,
        },
        temporary,
    )
    os.replace(temporary, model_output)
    report["model_artifact"] = {
        "sha256": sha256_file(model_output),
        "bytes": model_output.stat().st_size,
        "path_policy": "data_processed_or_system_temp",
        "tracked_in_git": False,
        "serializer_byte_stable": False,
    }
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--model-output", required=True, type=Path)
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = train_and_report(args.input, args.model_output)
    write_json(args.report, report)
    if not args.quiet:
        print("WAIT_TIME_BASELINE_OK")


if __name__ == "__main__":
    main()
