"""Fail closed when a D1 research report omits a required caveat or metric."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from .contracts import (
    CATEGORICAL_FEATURES,
    EXCLUDED_FEATURES,
    EXPECTED_COLUMNS,
    INPUT_SHA256,
    LIMITATIONS,
    MODEL_NAME,
    REPORT_STATUS,
)
from .io import sha256_file


class ReportFailure(RuntimeError):
    """Raised for an unsafe or incomplete report."""


def _object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ReportFailure(f"missing_object:{name}")
    return value


def _exact_keys(value: dict[str, Any], expected: set[str], name: str) -> None:
    if set(value) != expected:
        raise ReportFailure(f"invalid_keys:{name}")


def _finite_number(value: Any, name: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ReportFailure(f"invalid_number:{name}")
    number = float(value)
    if minimum is not None and number < minimum:
        raise ReportFailure(f"number_below_minimum:{name}")
    return number


def _row_count(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ReportFailure(f"invalid_row_count:{name}")
    return value


def _nonnegative_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ReportFailure(f"invalid_nonnegative_integer:{name}")
    return value


def _reject_sensitive_payload(value: Any, path: str = "report") -> None:
    denied = {
        "hospitalization_code",
        "patient_rows",
        "raw_rows",
        "records",
        "row_data",
        "rows_data",
    }
    if isinstance(value, dict):
        for key, child in value.items():
            if key in denied:
                raise ReportFailure(f"sensitive_payload:{path}.{key}")
            _reject_sensitive_payload(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_sensitive_payload(child, f"{path}[{index}]")
    elif isinstance(value, float) and not math.isfinite(value):
        raise ReportFailure(f"non_finite_value:{path}")


def _verify_metrics(value: Any, name: str, expected_rows: int) -> dict[str, Any]:
    metrics = _object(value, name)
    expected_keys = {
        "rows",
        "mae_days",
        "median_absolute_error_days",
        "p90_absolute_error_days",
        "rmse_days",
        "mean_error_days",
        "within_3_days_fraction",
        "within_7_days_fraction",
    }
    if set(metrics) != expected_keys:
        raise ReportFailure(f"invalid_metric_keys:{name}")
    if _row_count(metrics["rows"], f"{name}.rows") != expected_rows:
        raise ReportFailure(f"metric_row_mismatch:{name}")
    for metric in ("mae_days", "median_absolute_error_days", "p90_absolute_error_days", "rmse_days"):
        _finite_number(metrics[metric], f"{name}.{metric}", minimum=0)
    _finite_number(metrics["mean_error_days"], f"{name}.mean_error_days")
    for metric in ("within_3_days_fraction", "within_7_days_fraction"):
        fraction = _finite_number(metrics[metric], f"{name}.{metric}", minimum=0)
        if fraction > 1:
            raise ReportFailure(f"fraction_above_one:{name}.{metric}")
    return metrics


def verify_report(value: Any, model_path: Path | None = None) -> None:
    report = _object(value, "report")
    _reject_sensitive_payload(report)
    expected_top_level = {
        "schema_version",
        "model_name",
        "status",
        "runtime_activation",
        "task",
        "source",
        "target",
        "cohort",
        "features",
        "split",
        "selection",
        "test",
        "blocked_tasks",
        "limitations",
        "reproducibility",
        "privacy",
        "model_artifact",
    }
    if set(report) != expected_top_level:
        raise ReportFailure("invalid_top_level_keys")
    if report.get("schema_version") != 1 or report.get("task") != "D1_wait_time_research_benchmark":
        raise ReportFailure("invalid_schema_or_task")
    if report.get("model_name") != MODEL_NAME or report.get("status") != REPORT_STATUS:
        raise ReportFailure("invalid_identity_or_status")
    if report.get("runtime_activation") != "blocked":
        raise ReportFailure("runtime_must_be_blocked")
    source = _object(report.get("source"), "source")
    _exact_keys(
        source,
        {
            "sha256",
            "bytes",
            "rows",
            "columns",
            "column_count",
            "period",
            "license_status",
            "raw_source_hashes_status",
        },
        "source",
    )
    if source.get("sha256") != INPUT_SHA256 or source.get("license_status") != "not_verified":
        raise ReportFailure("invalid_provenance")
    if source.get("columns") != list(EXPECTED_COLUMNS) or source.get("column_count") != len(EXPECTED_COLUMNS):
        raise ReportFailure("invalid_source_schema")
    source_rows = _row_count(source.get("rows"), "source.rows")
    _row_count(source.get("bytes"), "source.bytes")
    period = _object(source.get("period"), "source.period")
    _exact_keys(period, {"registration_min", "registration_max"}, "source.period")
    if period != {"registration_min": "2025-01-01", "registration_max": "2025-03-31"}:
        raise ReportFailure("invalid_source_period")
    if source.get("raw_source_hashes_status") != "unavailable_in_handoff":
        raise ReportFailure("invalid_raw_provenance_status")
    target = _object(report.get("target"), "target")
    _exact_keys(
        target,
        {
            "field",
            "definition",
            "prediction_time",
            "prediction_time_semantics",
            "population",
            "horizon_days",
            "horizon_policy",
        },
        "target",
    )
    if (
        target.get("field") != "wait_days"
        or target.get("definition") != "registration_dt_to_hospitalization_dt_from_handoff"
        or target.get("prediction_time") != "registration_dt"
        or target.get("prediction_time_semantics") != "not_verified_as_waitlist_placement"
        or target.get("horizon_days") != 60
        or target.get("population") != "hospitalized_only"
        or target.get("horizon_policy") != "exclude_observed_wait_over_60_days"
    ):
        raise ReportFailure("invalid_target_policy")
    features = _object(report.get("features"), "features")
    _exact_keys(
        features,
        {"included", "excluded", "candidate_encodings", "point_in_time_verified"},
        "features",
    )
    if (
        features.get("included") != list(CATEGORICAL_FEATURES)
        or features.get("excluded")
        != {reason: list(fields) for reason, fields in EXCLUDED_FEATURES.items()}
        or features.get("candidate_encodings")
        != [
            "train_partition_one_hot_min_frequency_20",
            "train_partition_ordinal_max_categories_255_min_frequency_20",
        ]
        or features.get("point_in_time_verified") is not False
    ):
        raise ReportFailure("invalid_feature_contract")
    split = _object(report.get("split"), "split")
    _exact_keys(split, {"strategy", "train", "validation", "test"}, "split")
    if split.get("strategy") != "calendar_months":
        raise ReportFailure("invalid_split_strategy")
    train_split = _object(split.get("train"), "split.train")
    validation_split = _object(split.get("validation"), "split.validation")
    test_split = _object(split.get("test"), "split.test")
    _exact_keys(train_split, {"period", "rows"}, "split.train")
    _exact_keys(validation_split, {"period", "rows"}, "split.validation")
    _exact_keys(
        test_split,
        {"period", "rows", "used_for_model_selection_in_this_pipeline", "previously_examined_in_source_handoff"},
        "split.test",
    )
    if (
        train_split.get("period") != "2025-01"
        or validation_split.get("period") != "2025-02"
        or test_split.get("period") != "2025-03"
        or test_split.get("previously_examined_in_source_handoff") is not True
    ):
        raise ReportFailure("invalid_split_periods")
    train_rows = _row_count(train_split.get("rows"), "split.train.rows")
    validation_rows = _row_count(
        validation_split.get("rows"),
        "split.validation.rows",
    )
    test_rows = _row_count(test_split.get("rows"), "split.test.rows")
    if test_split.get("used_for_model_selection_in_this_pipeline") is not False:
        raise ReportFailure("test_used_for_selection")
    cohort = _object(report.get("cohort"), "cohort")
    _exact_keys(
        cohort,
        {
            "input_rows",
            "both_hospitalized_and_refused",
            "refused_only",
            "unresolved",
            "hospitalized_only",
            "missing_wait_days",
            "negative_wait_days",
            "over_60_wait_days",
            "invalid_registration_dt",
            "eligible_rows",
            "eligible_fraction",
        },
        "cohort",
    )
    if _row_count(cohort.get("eligible_rows"), "cohort.eligible_rows") != train_rows + validation_rows + test_rows:
        raise ReportFailure("cohort_split_row_mismatch")
    input_rows = _row_count(cohort.get("input_rows"), "cohort.input_rows")
    if input_rows != source_rows:
        raise ReportFailure("source_cohort_row_mismatch")
    for key in (
        "both_hospitalized_and_refused",
        "refused_only",
        "unresolved",
        "hospitalized_only",
        "missing_wait_days",
        "negative_wait_days",
        "over_60_wait_days",
        "invalid_registration_dt",
    ):
        _nonnegative_int(cohort.get(key), f"cohort.{key}")
    eligible_fraction = _finite_number(
        cohort.get("eligible_fraction"), "cohort.eligible_fraction", minimum=0
    )
    if eligible_fraction > 1:
        raise ReportFailure("invalid_eligible_fraction")
    outcome_total = sum(
        int(cohort[key])
        for key in (
            "both_hospitalized_and_refused",
            "refused_only",
            "unresolved",
            "hospitalized_only",
        )
    )
    if outcome_total != input_rows:
        raise ReportFailure("outcome_attrition_mismatch")
    hospitalized_total = sum(
        int(cohort[key])
        for key in (
            "missing_wait_days",
            "negative_wait_days",
            "over_60_wait_days",
            "invalid_registration_dt",
            "eligible_rows",
        )
    )
    if hospitalized_total != cohort["hospitalized_only"]:
        raise ReportFailure("hospitalized_attrition_mismatch")
    if abs(eligible_fraction - round(int(cohort["eligible_rows"]) / input_rows, 8)) > 1e-12:
        raise ReportFailure("eligible_fraction_mismatch")
    selection = _object(report.get("selection"), "selection")
    _exact_keys(selection, {"criterion", "candidates", "selected_model"}, "selection")
    if selection.get("criterion") != "validation_mae_days":
        raise ReportFailure("invalid_selection_criterion")
    candidates = selection.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ReportFailure("missing_candidates")
    candidate_maes: list[float] = []
    for index, candidate in enumerate(candidates):
        candidate_object = _object(candidate, f"selection.candidates[{index}]")
        family = candidate_object.get("family")
        expected_candidate_keys = (
            {"family", "alpha", "validation"}
            if family == "ridge_one_hot"
            else {"family", "loss", "max_leaf_nodes", "validation"}
        )
        _exact_keys(candidate_object, expected_candidate_keys, f"selection.candidates[{index}]")
        if family not in {"ridge_one_hot", "hist_gradient_ordinal_categorical"}:
            raise ReportFailure("invalid_candidate_family")
        validation = _object(candidate_object.get("validation"), "candidate.validation")
        _verify_metrics(validation, "candidate.validation", validation_rows)
        candidate_maes.append(float(validation["mae_days"]))
    selected = _object(selection.get("selected_model"), "selection.selected_model")
    selected_candidates = [
        item
        for item in candidates
        if {key: value for key, value in item.items() if key != "validation"} == selected
    ]
    if len(selected_candidates) != 1:
        raise ReportFailure("selected_model_missing_or_ambiguous")
    selected_mae = float(selected_candidates[0]["validation"]["mae_days"])
    if selected_mae != min(candidate_maes):
        raise ReportFailure("selected_model_not_best_validation_mae")
    test = _object(report.get("test"), "test")
    expected_test_keys = {
        "model",
        "global_median_baseline",
        "hierarchical_median_baseline",
        "mae_improvement_vs_global_days",
        "mae_improvement_vs_hierarchical_days",
    }
    if set(test) != expected_test_keys:
        raise ReportFailure("invalid_test_keys")
    model_metrics = _verify_metrics(test.get("model"), "test.model", test_rows)
    global_metrics = _verify_metrics(
        test.get("global_median_baseline"), "test.global_median_baseline", test_rows
    )
    hierarchical_metrics = _verify_metrics(
        test.get("hierarchical_median_baseline"),
        "test.hierarchical_median_baseline",
        test_rows,
    )
    improvements = (
        (
            "mae_improvement_vs_global_days",
            float(global_metrics["mae_days"]) - float(model_metrics["mae_days"]),
        ),
        (
            "mae_improvement_vs_hierarchical_days",
            float(hierarchical_metrics["mae_days"]) - float(model_metrics["mae_days"]),
        ),
    )
    for key, expected in improvements:
        actual = _finite_number(test.get(key), f"test.{key}")
        if abs(actual - expected) > 1e-6:
            raise ReportFailure(f"invalid_improvement:{key}")
    if report.get("limitations") != list(LIMITATIONS):
        raise ReportFailure("limitations_incomplete")
    blocked = _object(report.get("blocked_tasks"), "blocked_tasks")
    if set(blocked) != {"B3", "D2", "D4"}:
        raise ReportFailure("blocked_tasks_incomplete")
    if blocked != {
        "B3": "missing_refusal_reason_and_point_in_time_package_snapshot",
        "D2": "missing_laboratory_demand_target",
        "D4": "missing_attendance_target",
    }:
        raise ReportFailure("invalid_blocked_task_reasons")
    privacy = _object(report.get("privacy"), "privacy")
    if set(privacy) != {
        "contains_row_data",
        "contains_identifiers",
        "model_binary_contains_source_categories",
        "model_binary_git_tracking",
    }:
        raise ReportFailure("invalid_privacy_keys")
    if (
        privacy.get("contains_row_data") is not False
        or privacy.get("contains_identifiers") is not False
        or privacy.get("model_binary_contains_source_categories") is not True
        or privacy.get("model_binary_git_tracking") != "forbidden"
    ):
        raise ReportFailure("unsafe_report_content")
    reproducibility = _object(report.get("reproducibility"), "reproducibility")
    _exact_keys(
        reproducibility,
        {
            "python",
            "packages",
            "random_seed",
            "deterministic_metrics_and_semantic_report",
            "joblib_serializer_byte_stable",
        },
        "reproducibility",
    )
    packages = _object(reproducibility.get("packages"), "reproducibility.packages")
    _exact_keys(
        packages,
        {"joblib", "numpy", "pandas", "pyarrow", "scikit-learn", "scipy"},
        "reproducibility.packages",
    )
    if any(not isinstance(version, str) or not version.strip() for version in packages.values()):
        raise ReportFailure("invalid_package_version")
    if (
        reproducibility.get("python") != "3.12"
        or reproducibility.get("random_seed") != 20250919
        or reproducibility.get("deterministic_metrics_and_semantic_report") is not True
        or reproducibility.get("joblib_serializer_byte_stable") is not False
    ):
        raise ReportFailure("invalid_reproducibility_claim")
    artifact = _object(report.get("model_artifact"), "model_artifact")
    if (
        set(artifact)
        != {"sha256", "bytes", "path_policy", "tracked_in_git", "serializer_byte_stable"}
        or not isinstance(artifact.get("sha256"), str)
        or len(artifact["sha256"]) != 64
        or any(character not in "0123456789abcdef" for character in artifact["sha256"])
        or _row_count(artifact.get("bytes"), "model_artifact.bytes") <= 0
        or artifact.get("path_policy") != "data_processed_or_system_temp"
        or artifact.get("tracked_in_git") is not False
        or artifact.get("serializer_byte_stable") is not False
    ):
        raise ReportFailure("invalid_model_artifact")
    if model_path is not None:
        if not model_path.is_file():
            raise ReportFailure("model_artifact_missing")
        if (
            model_path.stat().st_size != artifact["bytes"]
            or sha256_file(model_path) != artifact["sha256"]
        ):
            raise ReportFailure("model_artifact_hash_mismatch")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--model", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    verify_report(json.loads(args.report.read_text(encoding="utf-8")), args.model)
    print("REFERRAL_REPORT_OK")


if __name__ == "__main__":
    main()
