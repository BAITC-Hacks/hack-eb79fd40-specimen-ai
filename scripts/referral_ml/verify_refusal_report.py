"""Fail closed when the offline B3 report is incomplete, leaky or inconsistent."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import joblib  # type: ignore[import-untyped]

from .io import sha256_file
from .refusal_contracts import (
    AVAILABLE_EXCLUDED_COLUMNS,
    CATEGORICAL_FEATURES,
    EXPECTED_COLUMNS,
    EXPECTED_COHORT_ATTRITION,
    EXPECTED_MONTHLY_ATTRITION,
    EXPECTED_REFUSED,
    EXPECTED_ROWS,
    EXCLUDED_FEATURES,
    INPUT_SHA256,
    LIMITATIONS,
    MODEL_NAME,
    RANDOM_SEED,
    REPORT_STATUS,
)
from .train_refusal import FREQUENCY_SMOOTHING_CANDIDATES, LOGISTIC_C_VALUES


class RefusalReportFailure(RuntimeError):
    """Raised when a B3 report violates its frozen safety contract."""


def _object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RefusalReportFailure(f"missing_object:{name}")
    return value


def _exact_keys(value: dict[str, Any], expected: set[str], name: str) -> None:
    if set(value) != expected:
        raise RefusalReportFailure(f"invalid_keys:{name}")


def _number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RefusalReportFailure(f"invalid_number:{name}")
    number = float(value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise RefusalReportFailure(f"number_out_of_range:{name}")
    return number


def _nonnegative_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RefusalReportFailure(f"invalid_nonnegative_integer:{name}")
    return value


def _positive_int(value: Any, name: str) -> int:
    result = _nonnegative_int(value, name)
    if result == 0:
        raise RefusalReportFailure(f"invalid_positive_integer:{name}")
    return result


def _reject_sensitive_payload(value: Any, path: str = "report") -> None:
    denied_keys = {
        "patient_rows",
        "raw_rows",
        "records",
        "row_data",
        "rows_data",
        "identifiers",
        "category_values",
        "raw_dump",
    }
    if isinstance(value, dict):
        for key, child in value.items():
            if key in denied_keys:
                raise RefusalReportFailure(f"sensitive_payload:{path}.{key}")
            _reject_sensitive_payload(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_sensitive_payload(child, f"{path}[{index}]")
    elif isinstance(value, float) and not math.isfinite(value):
        raise RefusalReportFailure(f"non_finite_value:{path}")


def _verify_metrics(value: Any, name: str, rows: int, positives: int) -> dict[str, Any]:
    metrics = _object(value, name)
    _exact_keys(
        metrics,
        {
            "rows",
            "positives",
            "prevalence",
            "pr_auc",
            "brier",
            "threshold",
            "predicted_positive",
            "precision",
            "recall",
            "f1",
        },
        name,
    )
    if metrics.get("rows") != rows or metrics.get("positives") != positives:
        raise RefusalReportFailure(f"metric_population_mismatch:{name}")
    if metrics.get("prevalence") != round(positives / rows, 8):
        raise RefusalReportFailure(f"metric_prevalence_mismatch:{name}")
    for key in (
        "prevalence",
        "pr_auc",
        "brier",
        "threshold",
        "precision",
        "recall",
        "f1",
    ):
        _number(metrics.get(key), f"{name}.{key}", 0.0, 1.0)
    predicted = _nonnegative_int(
        metrics.get("predicted_positive"), f"{name}.predicted_positive"
    )
    if predicted > rows:
        raise RefusalReportFailure(f"invalid_predicted_positive:{name}")
    expected_f1 = (
        2 * metrics["precision"] * metrics["recall"]
        / (metrics["precision"] + metrics["recall"])
        if metrics["precision"] + metrics["recall"]
        else 0.0
    )
    if abs(metrics["f1"] - expected_f1) > 2e-8:
        raise RefusalReportFailure(f"inconsistent_f1:{name}")
    return metrics


def _verify_calibration(value: Any, name: str, rows: int) -> None:
    calibration = _object(value, name)
    _exact_keys(calibration, {"requested_bins", "actual_bins", "bins"}, name)
    if calibration.get("requested_bins") != 10:
        raise RefusalReportFailure(f"invalid_requested_bins:{name}")
    bins = calibration.get("bins")
    if not isinstance(bins, list) or not bins or len(bins) != calibration.get("actual_bins"):
        raise RefusalReportFailure(f"invalid_bins:{name}")
    if not 1 <= len(bins) <= 10:
        raise RefusalReportFailure(f"invalid_bin_count:{name}")
    total = 0
    previous_max = -math.inf
    for index, item in enumerate(bins, start=1):
        bucket = _object(item, f"{name}.bins[{index}]")
        _exact_keys(
            bucket,
            {
                "bin",
                "rows",
                "score_min",
                "score_max",
                "mean_predicted",
                "observed_rate",
            },
            f"{name}.bins[{index}]",
        )
        if bucket.get("bin") != index:
            raise RefusalReportFailure(f"invalid_bin_index:{name}")
        total += _positive_int(bucket.get("rows"), f"{name}.bins[{index}].rows")
        lower = _number(bucket.get("score_min"), f"{name}.score_min", 0.0, 1.0)
        upper = _number(bucket.get("score_max"), f"{name}.score_max", 0.0, 1.0)
        if lower > upper or lower < previous_max:
            raise RefusalReportFailure(f"invalid_bin_bounds:{name}")
        _number(bucket.get("mean_predicted"), f"{name}.mean_predicted", lower, upper)
        _number(bucket.get("observed_rate"), f"{name}.observed_rate", 0.0, 1.0)
        previous_max = upper
    if total != rows:
        raise RefusalReportFailure(f"calibration_row_mismatch:{name}")


def _verify_prediction_sources(value: Any, name: str, rows: int) -> None:
    source_map = _object(value, name)
    _exact_keys(
        source_map,
        {"pair", "hospital_profile_blend", "hospital", "profile", "global"},
        name,
    )
    counts = [
        _nonnegative_int(count, f"{name}.{key}")
        for key, count in source_map.items()
    ]
    if sum(counts) != rows:
        raise RefusalReportFailure(f"prediction_source_row_mismatch:{name}")


def _verify_evaluation(
    value: Any,
    name: str,
    rows: int,
    positives: int,
    *,
    require_sources: bool,
) -> dict[str, Any]:
    evaluation = _object(value, name)
    expected = {"metrics", "calibration_deciles"}
    if require_sources:
        expected.add("prediction_sources")
    _exact_keys(evaluation, expected, name)
    metrics = _verify_metrics(
        evaluation.get("metrics"), f"{name}.metrics", rows, positives
    )
    _verify_calibration(
        evaluation.get("calibration_deciles"), f"{name}.calibration", rows
    )
    if require_sources:
        _verify_prediction_sources(
            evaluation.get("prediction_sources"),
            f"{name}.prediction_sources",
            rows,
        )
    return metrics


def _verify_source(value: Any) -> None:
    source = _object(value, "source")
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
    period = _object(source.get("period"), "source.period")
    _exact_keys(period, {"registration_min", "registration_max"}, "source.period")
    if (
        source.get("sha256") != INPUT_SHA256
        or source.get("rows") != EXPECTED_ROWS
        or source.get("columns") != list(EXPECTED_COLUMNS)
        or source.get("column_count") != len(EXPECTED_COLUMNS)
        or source.get("license_status") != "not_verified"
        or source.get("raw_source_hashes_status") != "unavailable_in_handoff"
        or period
        != {"registration_min": "2025-01-01", "registration_max": "2025-03-31"}
    ):
        raise RefusalReportFailure("invalid_source_provenance")
    _positive_int(source.get("bytes"), "source.bytes")


def _verify_outcome_summary(value: Any, name: str) -> dict[str, int]:
    summary = _object(value, name)
    keys = {
        "input_rows",
        "mature_rows",
        "refused_only",
        "hospitalized_only",
        "censored_neither",
        "conflicting_both",
    }
    _exact_keys(summary, keys, name)
    result = {
        key: _nonnegative_int(summary.get(key), f"{name}.{key}") for key in keys
    }
    if result["mature_rows"] != result["refused_only"] + result["hospitalized_only"]:
        raise RefusalReportFailure(f"mature_outcome_mismatch:{name}")
    if result["input_rows"] != (
        result["mature_rows"]
        + result["censored_neither"]
        + result["conflicting_both"]
    ):
        raise RefusalReportFailure(f"outcome_partition_mismatch:{name}")
    return result


def _verify_cohort(value: Any) -> dict[str, int]:
    cohort = _object(value, "cohort")
    summary_keys = {
        "input_rows",
        "mature_rows",
        "refused_only",
        "hospitalized_only",
        "censored_neither",
        "conflicting_both",
    }
    _exact_keys(cohort, summary_keys | {"by_month", "policy"}, "cohort")
    overall = _verify_outcome_summary(
        {key: cohort[key] for key in summary_keys}, "cohort.overall"
    )
    if (
        overall != EXPECTED_COHORT_ATTRITION
        or overall["refused_only"] + overall["conflicting_both"] != EXPECTED_REFUSED
        or cohort.get("policy") != "exclude_censored_neither_and_conflicting_both"
    ):
        raise RefusalReportFailure("invalid_cohort_policy")
    by_month = _object(cohort.get("by_month"), "cohort.by_month")
    _exact_keys(by_month, {"2025-01", "2025-02", "2025-03"}, "cohort.by_month")
    monthly = {
        month: _verify_outcome_summary(month_value, f"cohort.by_month.{month}")
        for month, month_value in by_month.items()
    }
    if monthly != EXPECTED_MONTHLY_ATTRITION:
        raise RefusalReportFailure("invalid_monthly_attrition")
    for key in summary_keys:
        if sum(month[key] for month in monthly.values()) != overall[key]:
            raise RefusalReportFailure(f"monthly_attrition_mismatch:{key}")
    return overall


def _verify_features(value: Any) -> None:
    features = _object(value, "features")
    _exact_keys(
        features,
        {
            "included",
            "authorization",
            "excluded",
            "available_excluded_columns",
            "encoding",
            "missing_value_policy",
        },
        "features",
    )
    if (
        features.get("included") != list(CATEGORICAL_FEATURES)
        or features.get("authorization")
        != "ClickUp_z8udzk8t1g_registration_time_contract"
        or features.get("excluded")
        != {reason: list(fields) for reason, fields in EXCLUDED_FEATURES.items()}
        or features.get("available_excluded_columns") != list(AVAILABLE_EXCLUDED_COLUMNS)
        or features.get("encoding") != "train_partition_one_hot_min_frequency_20"
        or features.get("missing_value_policy") != "explicit_sentinel"
    ):
        raise RefusalReportFailure("invalid_feature_contract")
    if set(features["included"]) | set(features["available_excluded_columns"]) != set(
        EXPECTED_COLUMNS
    ):
        raise RefusalReportFailure("incomplete_feature_partition")


def _verify_split(value: Any, cohort: dict[str, int]) -> dict[str, tuple[int, int]]:
    split = _object(value, "split")
    _exact_keys(split, {"strategy", "train", "validation", "test"}, "split")
    if split.get("strategy") != "calendar_months":
        raise RefusalReportFailure("invalid_split_strategy")
    populations: dict[str, tuple[int, int]] = {}
    for key, period in (
        ("train", "2025-01"),
        ("validation", "2025-02"),
        ("test", "2025-03"),
    ):
        partition = _object(split.get(key), f"split.{key}")
        expected_keys = {"period", "rows", "positives", "prevalence"}
        if key == "validation":
            expected_keys.add("used_for")
        elif key == "test":
            expected_keys |= {
                "used_for_selection",
                "evaluated_after_selection",
                "previously_examined_in_source_handoff",
            }
        _exact_keys(partition, expected_keys, f"split.{key}")
        rows = _positive_int(partition.get("rows"), f"split.{key}.rows")
        positives = _positive_int(partition.get("positives"), f"split.{key}.positives")
        if partition.get("period") != period or partition.get("prevalence") != round(
            positives / rows, 8
        ):
            raise RefusalReportFailure(f"invalid_split_population:{key}")
        populations[key] = (rows, positives)
    validation = _object(split.get("validation"), "split.validation")
    test = _object(split.get("test"), "split.test")
    if validation.get("used_for") != "model_and_threshold_selection":
        raise RefusalReportFailure("invalid_validation_usage")
    if (
        test.get("used_for_selection") is not False
        or test.get("evaluated_after_selection") is not True
        or test.get("previously_examined_in_source_handoff") is not True
    ):
        raise RefusalReportFailure("test_selection_leakage")
    if sum(rows for rows, _ in populations.values()) != cohort["mature_rows"]:
        raise RefusalReportFailure("split_row_mismatch")
    if sum(positives for _, positives in populations.values()) != cohort["refused_only"]:
        raise RefusalReportFailure("split_positive_mismatch")
    return populations


def _verify_selection(
    value: Any, validation_rows: int, validation_positives: int
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    selection = _object(value, "selection")
    _exact_keys(
        selection,
        {
            "primary_metric",
            "tie_breaker",
            "threshold_criterion",
            "constant_baseline",
            "smoothed_pair_baseline",
            "model_candidates",
            "selected_model",
        },
        "selection",
    )
    if (
        selection.get("primary_metric") != "validation_pr_auc"
        or selection.get("tie_breaker") != "validation_brier_then_lower_c"
        or selection.get("threshold_criterion") != "validation_max_f1_per_method"
    ):
        raise RefusalReportFailure("test_based_or_unknown_selection")
    constant = _verify_evaluation(
        selection.get("constant_baseline"),
        "selection.constant_baseline",
        validation_rows,
        validation_positives,
        require_sources=False,
    )

    pair = _object(selection.get("smoothed_pair_baseline"), "selection.pair")
    _exact_keys(
        pair,
        {
            "definition",
            "primary_metric",
            "tie_breaker",
            "fallback_order",
            "candidates",
            "selected",
        },
        "selection.pair",
    )
    if (
        pair.get("definition")
        != "hospital_mo_plus_bed_profile_smoothed_to_hospital_profile_priors"
        or pair.get("primary_metric") != "validation_pr_auc"
        or pair.get("tie_breaker")
        != "validation_brier_then_lower_smoothing_strength"
        or pair.get("fallback_order")
        != ["hospital_profile_blend", "hospital", "profile", "global"]
    ):
        raise RefusalReportFailure("invalid_pair_selection_contract")
    pair_candidates = pair.get("candidates")
    if not isinstance(pair_candidates, list) or len(pair_candidates) != len(
        FREQUENCY_SMOOTHING_CANDIDATES
    ):
        raise RefusalReportFailure("invalid_pair_candidates")
    pair_by_alpha: dict[float, dict[str, Any]] = {}
    for index, candidate_value in enumerate(pair_candidates):
        candidate = _object(candidate_value, f"selection.pair.candidates[{index}]")
        _exact_keys(
            candidate,
            {"smoothing_strength", "threshold_selection", "validation"},
            f"selection.pair.candidates[{index}]",
        )
        alpha = _number(
            candidate.get("smoothing_strength"),
            f"selection.pair.candidates[{index}].smoothing_strength",
            0.0,
            math.inf,
        )
        if candidate.get("threshold_selection") != "validation_max_f1":
            raise RefusalReportFailure("invalid_pair_threshold_selection")
        metrics = _verify_evaluation(
            candidate.get("validation"),
            f"selection.pair.candidates[{index}].validation",
            validation_rows,
            validation_positives,
            require_sources=True,
        )
        pair_by_alpha[alpha] = metrics
    if tuple(pair_by_alpha) != FREQUENCY_SMOOTHING_CANDIDATES:
        raise RefusalReportFailure("unexpected_pair_candidate_values")
    selected_pair = _object(pair.get("selected"), "selection.pair.selected")
    _exact_keys(
        selected_pair,
        {"smoothing_strength", "threshold"},
        "selection.pair.selected",
    )
    chosen_alpha = max(
        pair_by_alpha,
        key=lambda alpha: (
            pair_by_alpha[alpha]["pr_auc"],
            -pair_by_alpha[alpha]["brier"],
            -alpha,
        ),
    )
    if (
        selected_pair.get("smoothing_strength") != chosen_alpha
        or selected_pair.get("threshold") != pair_by_alpha[chosen_alpha]["threshold"]
    ):
        raise RefusalReportFailure("pair_candidate_selection_mismatch")

    candidates = selection.get("model_candidates")
    if not isinstance(candidates, list) or len(candidates) != len(LOGISTIC_C_VALUES):
        raise RefusalReportFailure("invalid_model_candidates")
    model_by_c: dict[float, tuple[dict[str, Any], bool]] = {}
    for index, candidate_value in enumerate(candidates):
        candidate = _object(candidate_value, f"selection.model_candidates[{index}]")
        _exact_keys(
            candidate,
            {"family", "c", "optimization", "threshold_selection", "validation"},
            f"selection.model_candidates[{index}]",
        )
        c_value = _number(
            candidate.get("c"),
            f"selection.model_candidates[{index}].c",
            0.0,
            math.inf,
        )
        optimization = _object(
            candidate.get("optimization"),
            f"selection.model_candidates[{index}].optimization",
        )
        _exact_keys(
            optimization,
            {"solver", "tolerance", "iterations", "max_iterations", "converged"},
            f"selection.model_candidates[{index}].optimization",
        )
        if (
            candidate.get("family") != "one_hot_logistic_regression"
            or candidate.get("threshold_selection") != "validation_max_f1"
            or optimization.get("solver") != "liblinear"
            or optimization.get("tolerance") != 0.0001
        ):
            raise RefusalReportFailure("invalid_model_candidate_contract")
        iterations = _positive_int(
            optimization.get("iterations"),
            f"selection.model_candidates[{index}].iterations",
        )
        maximum = _positive_int(
            optimization.get("max_iterations"),
            f"selection.model_candidates[{index}].max_iterations",
        )
        converged = optimization.get("converged")
        if not isinstance(converged, bool) or converged is not (iterations < maximum):
            raise RefusalReportFailure("invalid_convergence_claim")
        metrics = _verify_evaluation(
            candidate.get("validation"),
            f"selection.model_candidates[{index}].validation",
            validation_rows,
            validation_positives,
            require_sources=False,
        )
        model_by_c[c_value] = (metrics, converged)
    if tuple(model_by_c) != LOGISTIC_C_VALUES:
        raise RefusalReportFailure("unexpected_model_candidate_values")
    selected_model = _object(selection.get("selected_model"), "selection.selected_model")
    _exact_keys(
        selected_model,
        {"family", "c", "threshold"},
        "selection.selected_model",
    )
    converged_candidates = {
        c_value: metrics
        for c_value, (metrics, converged) in model_by_c.items()
        if converged
    }
    if not converged_candidates:
        raise RefusalReportFailure("no_converged_model_candidate")
    chosen_c = max(
        converged_candidates,
        key=lambda c_value: (
            converged_candidates[c_value]["pr_auc"],
            -converged_candidates[c_value]["brier"],
            -c_value,
        ),
    )
    if (
        selected_model.get("family") != "one_hot_logistic_regression"
        or selected_model.get("c") != chosen_c
        or selected_model.get("threshold")
        != converged_candidates[chosen_c]["threshold"]
        or model_by_c[chosen_c][1] is not True
    ):
        raise RefusalReportFailure("model_candidate_selection_mismatch")
    return constant, selected_pair, selected_model


def _verify_test(
    value: Any,
    rows: int,
    positives: int,
    constant_threshold: float,
    pair_threshold: float,
    model_threshold: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    test = _object(value, "test")
    _exact_keys(
        test,
        {"constant_baseline", "smoothed_pair_baseline", "one_hot_logistic_regression"},
        "test",
    )
    constant = _verify_evaluation(
        test.get("constant_baseline"),
        "test.constant",
        rows,
        positives,
        require_sources=False,
    )
    pair = _verify_evaluation(
        test.get("smoothed_pair_baseline"),
        "test.pair",
        rows,
        positives,
        require_sources=True,
    )
    model = _verify_evaluation(
        test.get("one_hot_logistic_regression"),
        "test.model",
        rows,
        positives,
        require_sources=False,
    )
    if constant["threshold"] != constant_threshold:
        raise RefusalReportFailure("constant_threshold_not_from_validation")
    if pair["threshold"] != pair_threshold:
        raise RefusalReportFailure("pair_threshold_not_from_validation")
    if model["threshold"] != model_threshold:
        raise RefusalReportFailure("model_threshold_not_from_validation")
    return pair, model


def _verify_presentation(value: Any) -> None:
    presentation = _object(value, "presentation_contract")
    _exact_keys(
        presentation,
        {"input_fields", "output_fields", "risk_band_definition", "paragraph"},
        "presentation_contract",
    )
    bands = _object(
        presentation.get("risk_band_definition"),
        "presentation_contract.risk_band_definition",
    )
    _exact_keys(
        bands,
        {"below_working_threshold", "at_or_above_working_threshold"},
        "presentation_contract.risk_band_definition",
    )
    if (
        presentation.get("input_fields") != list(CATEGORICAL_FEATURES)
        or presentation.get("output_fields")
        != [
            "refusal_probability_among_mature_outcomes",
            "working_threshold",
            "risk_band",
            "method",
            "model_version",
            "limitations_label",
        ]
        or bands
        != {
            "below_working_threshold": "probability < working_threshold",
            "at_or_above_working_threshold": "probability >= working_threshold",
        }
        or presentation.get("paragraph")
        != (
            "The card supplies only registration-time bed profile, ICD-10, "
            "referring and receiving organizations, territory, finance source, "
            "and referral purpose; scoring returns the observed refusal probability "
            "among mature non-conflicting outcomes, the validation-selected working "
            "threshold, a two-band comparison to that threshold, method and version, "
            "plus an experimental limitations label."
        )
    ):
        raise RefusalReportFailure("invalid_presentation_contract")


def _verify_reproducibility(value: Any) -> None:
    reproducibility = _object(value, "reproducibility")
    _exact_keys(
        reproducibility,
        {
            "python",
            "packages",
            "random_seed",
            "input_sha256_verified",
            "test_partition_evaluated_after_all_selection",
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
    if not all(isinstance(version, str) and version for version in packages.values()):
        raise RefusalReportFailure("invalid_package_versions")
    if (
        reproducibility.get("python") != "3.12"
        or reproducibility.get("random_seed") != RANDOM_SEED
        or reproducibility.get("input_sha256_verified") is not True
        or reproducibility.get("test_partition_evaluated_after_all_selection") is not True
        or reproducibility.get("joblib_serializer_byte_stable") is not False
    ):
        raise RefusalReportFailure("invalid_reproducibility_contract")


def _verify_privacy(value: Any) -> None:
    privacy = _object(value, "privacy")
    expected = {
        "contains_row_data": False,
        "contains_identifiers": False,
        "contains_category_values": False,
        "model_binary_contains_source_categories": True,
        "model_binary_git_tracking": "forbidden",
    }
    _exact_keys(privacy, set(expected), "privacy")
    if privacy != expected:
        raise RefusalReportFailure("privacy_contract_violation")


def _verify_artifact(
    value: Any,
    constant: dict[str, Any],
    selected_model: dict[str, Any],
    selected_pair: dict[str, Any],
    model_path: Path | None,
) -> None:
    artifact = _object(value, "model_artifact")
    _exact_keys(
        artifact,
        {
            "sha256",
            "bytes",
            "path_policy",
            "tracked_in_git",
            "serializer_byte_stable",
            "selected_c",
            "exact_threshold",
            "feature_order",
        },
        "model_artifact",
    )
    if (
        artifact.get("tracked_in_git") is not False
        or artifact.get("path_policy") != "data_processed_or_system_temp"
        or artifact.get("serializer_byte_stable") is not False
        or artifact.get("selected_c") != selected_model["c"]
        or artifact.get("exact_threshold") != selected_model["threshold"]
        or artifact.get("feature_order") != list(CATEGORICAL_FEATURES)
    ):
        raise RefusalReportFailure("invalid_artifact_policy_or_metadata")
    _positive_int(artifact.get("bytes"), "model_artifact.bytes")
    if not isinstance(artifact.get("sha256"), str) or len(artifact["sha256"]) != 64:
        raise RefusalReportFailure("invalid_artifact_sha256")
    if model_path is None:
        return
    if not model_path.is_file():
        raise RefusalReportFailure("model_artifact_missing")
    if artifact["sha256"] != sha256_file(model_path):
        raise RefusalReportFailure("model_artifact_sha256_mismatch")
    if artifact["bytes"] != model_path.stat().st_size:
        raise RefusalReportFailure("model_artifact_size_mismatch")
    binary = _object(joblib.load(model_path), "model_binary")
    _exact_keys(
        binary,
        {
            "model",
            "frequency_baseline",
            "model_name",
            "input_sha256",
            "selected_model",
            "selected_frequency_baseline",
            "feature_order",
            "thresholds",
        },
        "model_binary",
    )
    thresholds = _object(binary.get("thresholds"), "model_binary.thresholds")
    _exact_keys(thresholds, {"constant", "smoothed_pair", "model"}, "model_binary.thresholds")
    model_bundle = binary.get("model")
    frequency_bundle = binary.get("frequency_baseline")
    classifier = getattr(getattr(model_bundle, "pipeline", None), "named_steps", {}).get(
        "classifier"
    )
    if (
        binary.get("model_name") != MODEL_NAME
        or binary.get("input_sha256") != INPUT_SHA256
        or binary.get("selected_model") != selected_model
        or binary.get("selected_frequency_baseline") != selected_pair
        or binary.get("feature_order") != list(CATEGORICAL_FEATURES)
        or thresholds.get("smoothed_pair") != selected_pair["threshold"]
        or thresholds.get("model") != selected_model["threshold"]
        or thresholds.get("constant") != constant["threshold"]
        or getattr(model_bundle, "feature_order", None) != CATEGORICAL_FEATURES
        or getattr(classifier, "C", None) != selected_model["c"]
        or getattr(frequency_bundle, "smoothing_strength", None)
        != selected_pair["smoothing_strength"]
    ):
        raise RefusalReportFailure("model_binary_metadata_mismatch")


def verify_refusal_report(value: Any, model_path: Path | None = None) -> None:
    report = _object(value, "report")
    _reject_sensitive_payload(report)
    _exact_keys(
        report,
        {
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
            "decision",
            "presentation_contract",
            "limitations",
            "reproducibility",
            "privacy",
            "model_artifact",
        },
        "report",
    )
    if (
        report.get("schema_version") != 1
        or report.get("model_name") != MODEL_NAME
        or report.get("status") != REPORT_STATUS
        or report.get("task") != "B3_referral_refusal_offline_benchmark"
        or report.get("runtime_activation")
        != "blocked_pending_product_decision_and_runtime_parity"
    ):
        raise RefusalReportFailure("invalid_identity_or_runtime_status")
    _verify_source(report.get("source"))
    cohort = _verify_cohort(report.get("cohort"))
    target = _object(report.get("target"), "target")
    _exact_keys(
        target,
        {
            "field",
            "definition",
            "prediction_time",
            "positive_rows",
            "negative_rows",
            "evaluation_population",
        },
        "target",
    )
    expected_target = {
        "field": "is_refused",
        "definition": "refusal_dt_present_among_mature_non_conflicting_outcomes",
        "prediction_time": "registration_dt",
        "positive_rows": cohort["refused_only"],
        "negative_rows": cohort["hospitalized_only"],
        "evaluation_population": "mature_outcomes_only",
    }
    if target != expected_target:
        raise RefusalReportFailure("invalid_target")
    _verify_features(report.get("features"))
    populations = _verify_split(report.get("split"), cohort)
    validation_rows, validation_positives = populations["validation"]
    constant, selected_pair, selected_model = _verify_selection(
        report.get("selection"), validation_rows, validation_positives
    )
    test_rows, test_positives = populations["test"]
    pair_metrics, model_metrics = _verify_test(
        report.get("test"),
        test_rows,
        test_positives,
        constant["threshold"],
        selected_pair["threshold"],
        selected_model["threshold"],
    )
    decision = _object(report.get("decision"), "decision")
    _exact_keys(
        decision,
        {
            "rule",
            "model_pr_auc_minus_pair",
            "model_beats_pair_baseline",
            "recommended_candidate_for_future_runtime",
            "runtime_changed_by_this_task",
        },
        "decision",
    )
    beats = float(model_metrics["pr_auc"]) > float(pair_metrics["pr_auc"])
    recommendation = (
        "one_hot_logistic_regression" if beats else "smoothed_pair_baseline"
    )
    delta = round(float(model_metrics["pr_auc"]) - float(pair_metrics["pr_auc"]), 8)
    expected_decision = {
        "rule": "model_test_pr_auc_must_strictly_exceed_pair_baseline",
        "model_pr_auc_minus_pair": delta,
        "model_beats_pair_baseline": beats,
        "recommended_candidate_for_future_runtime": recommendation,
        "runtime_changed_by_this_task": False,
    }
    if decision != expected_decision:
        raise RefusalReportFailure("invalid_decision")
    _verify_presentation(report.get("presentation_contract"))
    if report.get("limitations") != list(LIMITATIONS):
        raise RefusalReportFailure("limitations_incomplete")
    _verify_reproducibility(report.get("reproducibility"))
    _verify_privacy(report.get("privacy"))
    _verify_artifact(
        report.get("model_artifact"),
        constant,
        selected_model,
        selected_pair,
        model_path,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--model", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    value = json.loads(args.report.read_text(encoding="utf-8"))
    verify_refusal_report(value, args.model)
    print("REFERRAL_REFUSAL_REPORT_OK")


if __name__ == "__main__":
    main()
