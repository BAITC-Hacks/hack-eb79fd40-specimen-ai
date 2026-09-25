"""Train and report the reproducible offline B3 refusal benchmark."""

from __future__ import annotations

import argparse
import importlib.metadata
import os
import tempfile
from pathlib import Path
from typing import Any

import joblib  # type: ignore[import-untyped]
import pandas as pd  # type: ignore[import-untyped]

from .audit import audit_parquet
from .io import sha256_file, write_json
from .refusal_contracts import (
    AVAILABLE_EXCLUDED_COLUMNS,
    CATEGORICAL_FEATURES,
    EXPECTED_REFUSED,
    EXPECTED_ROWS,
    EXCLUDED_FEATURES,
    LIMITATIONS,
    MODEL_NAME,
    RANDOM_SEED,
    REPORT_STATUS,
)
from .refusal_pipeline import (
    LogisticModelBundle,
    SmoothedPairBaseline,
    TemporalPartitions,
    calibration_deciles,
    classification_metrics,
    constant_predictions,
    fit_logistic_model,
    fit_smoothed_pair_baseline,
    select_f1_threshold,
    temporal_split,
    build_cohort,
)

LOGISTIC_C_VALUES = (0.1, 1.0, 10.0)
FREQUENCY_SMOOTHING_CANDIDATES = (1.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0)


def validate_model_output(path: Path) -> Path:
    resolved = path.resolve()
    private_directory = (Path.cwd() / "data" / "processed").resolve()
    temporary_directory = Path(tempfile.gettempdir()).resolve()
    if resolved.suffix != ".joblib":
        raise ValueError("model_output_must_be_joblib")
    if not (
        resolved.is_relative_to(private_directory)
        or resolved.is_relative_to(temporary_directory)
    ):
        raise ValueError("model_output_must_be_private_or_temporary")
    return resolved


def _split_summary(frame: pd.DataFrame, period: str) -> dict[str, int | float | str]:
    positives = int(frame["is_refused"].sum())
    return {
        "period": period,
        "rows": int(len(frame)),
        "positives": positives,
        "prevalence": round(positives / len(frame), 8),
    }


def _method_evaluation(
    frame: pd.DataFrame,
    probabilities: Any,
    threshold: float,
    *,
    prediction_sources: dict[str, int] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "metrics": classification_metrics(
            frame["is_refused"].to_numpy(), probabilities, threshold
        ),
        "calibration_deciles": calibration_deciles(
            frame["is_refused"].to_numpy(), probabilities
        ),
    }
    if prediction_sources is not None:
        result["prediction_sources"] = prediction_sources
    return result


def _choose_model(
    partitions: TemporalPartitions,
) -> tuple[LogisticModelBundle, dict[str, float], list[dict[str, Any]]]:
    candidates: list[dict[str, Any]] = []
    fitted: list[LogisticModelBundle] = []
    for c_value in LOGISTIC_C_VALUES:
        model = fit_logistic_model(partitions.train, c_value)
        validation_probabilities = model.predict_proba(partitions.validation)
        threshold = select_f1_threshold(
            partitions.validation["is_refused"].to_numpy(),
            validation_probabilities,
        )
        evaluation = _method_evaluation(
            partitions.validation,
            validation_probabilities,
            threshold.threshold,
        )
        candidates.append(
            {
                "family": "one_hot_logistic_regression",
                "c": c_value,
                "optimization": {
                    "solver": "liblinear",
                    "tolerance": 0.0001,
                    "iterations": model.iterations,
                    "max_iterations": model.max_iterations,
                    "converged": model.converged,
                },
                "threshold_selection": "validation_max_f1",
                "validation": evaluation,
            }
        )
        fitted.append(model)
    converged_indexes = [
        index for index, candidate in enumerate(candidates) if candidate["optimization"]["converged"]
    ]
    if not converged_indexes:
        raise RuntimeError("no_converged_logistic_candidate")
    chosen_index = max(
        converged_indexes,
        key=lambda index: (
            candidates[index]["validation"]["metrics"]["pr_auc"],
            -candidates[index]["validation"]["metrics"]["brier"],
            -candidates[index]["c"],
        ),
    )
    chosen = candidates[chosen_index]
    specification = {
        "family": "one_hot_logistic_regression",
        "c": float(chosen["c"]),
        "threshold": float(chosen["validation"]["metrics"]["threshold"]),
    }
    return fitted[chosen_index], specification, candidates


def _validation_constant(partitions: TemporalPartitions) -> dict[str, Any]:
    actual = partitions.validation["is_refused"].to_numpy()
    constant = constant_predictions(partitions.train, partitions.validation)
    constant_threshold = select_f1_threshold(actual, constant)
    # Every constant score is tied. Keep the persisted threshold just below the
    # score so decimal serialization cannot flip the intended all-positive rule.
    constant_working_threshold = max(0.0, constant_threshold.threshold - 1e-8)
    constant_evaluation = _method_evaluation(
        partitions.validation, constant, constant_working_threshold
    )

    return constant_evaluation


def _choose_frequency_baseline(
    partitions: TemporalPartitions,
) -> tuple[SmoothedPairBaseline, dict[str, float], list[dict[str, Any]]]:
    candidates: list[dict[str, Any]] = []
    fitted: list[SmoothedPairBaseline] = []
    actual = partitions.validation["is_refused"].to_numpy()
    for smoothing_strength in FREQUENCY_SMOOTHING_CANDIDATES:
        baseline = fit_smoothed_pair_baseline(
            partitions.train,
            smoothing_strength=smoothing_strength,
        )
        prediction = baseline.predict(partitions.validation)
        threshold = select_f1_threshold(actual, prediction.probabilities)
        candidates.append(
            {
                "smoothing_strength": smoothing_strength,
                "threshold_selection": "validation_max_f1",
                "validation": _method_evaluation(
                    partitions.validation,
                    prediction.probabilities,
                    threshold.threshold,
                    prediction_sources=prediction.source_counts,
                ),
            }
        )
        fitted.append(baseline)
    chosen_index = max(
        range(len(candidates)),
        key=lambda index: (
            candidates[index]["validation"]["metrics"]["pr_auc"],
            -candidates[index]["validation"]["metrics"]["brier"],
            -candidates[index]["smoothing_strength"],
        ),
    )
    chosen = candidates[chosen_index]
    specification = {
        "smoothing_strength": float(chosen["smoothing_strength"]),
        "threshold": float(chosen["validation"]["metrics"]["threshold"]),
    }
    return fitted[chosen_index], specification, candidates


def train_and_report(input_path: Path, model_output: Path) -> dict[str, Any]:
    model_output = validate_model_output(model_output)
    audit = audit_parquet(input_path)
    source = pd.read_parquet(input_path)
    if len(source) != EXPECTED_ROWS:
        raise ValueError("unexpected_input_rows")
    refused = int(pd.to_numeric(source["is_refused"], errors="raise").sum())
    if refused != EXPECTED_REFUSED:
        raise ValueError("unexpected_positive_count")

    cohort = build_cohort(source)
    partitions = temporal_split(cohort.frame)
    validation_constant = _validation_constant(partitions)
    frequency, selected_frequency, frequency_candidates = (
        _choose_frequency_baseline(partitions)
    )
    selected_model, selected_specification, model_candidates = _choose_model(
        partitions
    )

    constant_test_probabilities = constant_predictions(partitions.train, partitions.test)
    pair_test_prediction = frequency.predict(partitions.test)
    model_test_probabilities = selected_model.predict_proba(partitions.test)
    test_constant = _method_evaluation(
        partitions.test,
        constant_test_probabilities,
        float(validation_constant["metrics"]["threshold"]),
    )
    test_pair = _method_evaluation(
        partitions.test,
        pair_test_prediction.probabilities,
        selected_frequency["threshold"],
        prediction_sources=pair_test_prediction.source_counts,
    )
    test_model = _method_evaluation(
        partitions.test,
        model_test_probabilities,
        float(selected_specification["threshold"]),
    )

    model_pr_auc = float(test_model["metrics"]["pr_auc"])
    pair_pr_auc = float(test_pair["metrics"]["pr_auc"])
    model_beats_pair = model_pr_auc > pair_pr_auc
    recommended = (
        "one_hot_logistic_regression" if model_beats_pair else "smoothed_pair_baseline"
    )

    package_versions = {
        package: importlib.metadata.version(package)
        for package in ("joblib", "numpy", "pandas", "pyarrow", "scikit-learn", "scipy")
    }
    report: dict[str, Any] = {
        "schema_version": 1,
        "model_name": MODEL_NAME,
        "status": REPORT_STATUS,
        "runtime_activation": "blocked_pending_product_decision_and_runtime_parity",
        "task": "B3_referral_refusal_offline_benchmark",
        "source": audit["input"],
        "target": {
            "field": "is_refused",
            "definition": "refusal_dt_present_among_mature_non_conflicting_outcomes",
            "prediction_time": "registration_dt",
            "positive_rows": cohort.attrition["refused_only"],
            "negative_rows": cohort.attrition["hospitalized_only"],
            "evaluation_population": "mature_outcomes_only",
        },
        "cohort": cohort.attrition,
        "features": {
            "included": list(CATEGORICAL_FEATURES),
            "authorization": "ClickUp_z8udzk8t1g_registration_time_contract",
            "excluded": {
                reason: list(fields) for reason, fields in EXCLUDED_FEATURES.items()
            },
            "available_excluded_columns": list(AVAILABLE_EXCLUDED_COLUMNS),
            "encoding": "train_partition_one_hot_min_frequency_20",
            "missing_value_policy": "explicit_sentinel",
        },
        "split": {
            "strategy": "calendar_months",
            "train": _split_summary(partitions.train, "2025-01"),
            "validation": {
                **_split_summary(partitions.validation, "2025-02"),
                "used_for": "model_and_threshold_selection",
            },
            "test": {
                **_split_summary(partitions.test, "2025-03"),
                "used_for_selection": False,
                "evaluated_after_selection": True,
                "previously_examined_in_source_handoff": True,
            },
        },
        "selection": {
            "primary_metric": "validation_pr_auc",
            "tie_breaker": "validation_brier_then_lower_c",
            "threshold_criterion": "validation_max_f1_per_method",
            "constant_baseline": validation_constant,
            "smoothed_pair_baseline": {
                "definition": "hospital_mo_plus_bed_profile_smoothed_to_hospital_profile_priors",
                "primary_metric": "validation_pr_auc",
                "tie_breaker": "validation_brier_then_lower_smoothing_strength",
                "fallback_order": [
                    "hospital_profile_blend",
                    "hospital",
                    "profile",
                    "global",
                ],
                "candidates": frequency_candidates,
                "selected": selected_frequency,
            },
            "model_candidates": model_candidates,
            "selected_model": selected_specification,
        },
        "test": {
            "constant_baseline": test_constant,
            "smoothed_pair_baseline": test_pair,
            "one_hot_logistic_regression": test_model,
        },
        "decision": {
            "rule": "model_test_pr_auc_must_strictly_exceed_pair_baseline",
            "model_pr_auc_minus_pair": round(model_pr_auc - pair_pr_auc, 8),
            "model_beats_pair_baseline": model_beats_pair,
            "recommended_candidate_for_future_runtime": recommended,
            "runtime_changed_by_this_task": False,
        },
        "presentation_contract": {
            "input_fields": list(CATEGORICAL_FEATURES),
            "output_fields": [
                "refusal_probability_among_mature_outcomes",
                "working_threshold",
                "risk_band",
                "method",
                "model_version",
                "limitations_label",
            ],
            "risk_band_definition": {
                "below_working_threshold": "probability < working_threshold",
                "at_or_above_working_threshold": "probability >= working_threshold",
            },
            "paragraph": (
                "The card supplies only registration-time bed profile, ICD-10, "
                "referring and receiving organizations, territory, finance source, "
                "and referral purpose; scoring returns the observed refusal probability "
                "among mature non-conflicting outcomes, the validation-selected working "
                "threshold, a two-band comparison to that threshold, method and version, "
                "plus an experimental limitations label."
            ),
        },
        "limitations": list(LIMITATIONS),
        "reproducibility": {
            "python": "3.12",
            "packages": package_versions,
            "random_seed": RANDOM_SEED,
            "input_sha256_verified": True,
            "test_partition_evaluated_after_all_selection": True,
            "joblib_serializer_byte_stable": False,
        },
        "privacy": {
            "contains_row_data": False,
            "contains_identifiers": False,
            "contains_category_values": False,
            "model_binary_contains_source_categories": True,
            "model_binary_git_tracking": "forbidden",
        },
    }

    model_output.parent.mkdir(parents=True, exist_ok=True)
    temporary = model_output.with_suffix(model_output.suffix + ".tmp")
    joblib.dump(
        {
            "model": selected_model,
            "frequency_baseline": frequency,
            "model_name": MODEL_NAME,
            "input_sha256": audit["input"]["sha256"],
            "selected_model": selected_specification,
            "selected_frequency_baseline": selected_frequency,
            "feature_order": list(CATEGORICAL_FEATURES),
            "thresholds": {
                "constant": validation_constant["metrics"]["threshold"],
                "smoothed_pair": selected_frequency["threshold"],
                "model": selected_specification["threshold"],
            },
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
        "selected_c": selected_specification["c"],
        "exact_threshold": selected_specification["threshold"],
        "feature_order": list(CATEGORICAL_FEATURES),
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
        print("REFERRAL_REFUSAL_BENCHMARK_OK")


if __name__ == "__main__":
    main()
