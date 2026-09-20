from __future__ import annotations

import unittest

from scripts.referral_ml.contracts import (
    CATEGORICAL_FEATURES,
    EXCLUDED_FEATURES,
    EXPECTED_COLUMNS,
    INPUT_SHA256,
    LIMITATIONS,
    MODEL_NAME,
    REPORT_STATUS,
)
from scripts.referral_ml.verify_report import ReportFailure, verify_report


def valid_report() -> dict[str, object]:
    metrics = {
        "rows": 3,
        "mae_days": 1.0,
        "median_absolute_error_days": 1.0,
        "p90_absolute_error_days": 2.0,
        "rmse_days": 1.5,
        "mean_error_days": 0.0,
        "within_3_days_fraction": 1.0,
        "within_7_days_fraction": 1.0,
    }
    return {
        "schema_version": 1,
        "model_name": MODEL_NAME,
        "status": REPORT_STATUS,
        "runtime_activation": "blocked",
        "task": "D1_wait_time_research_benchmark",
        "source": {
            "sha256": INPUT_SHA256,
            "bytes": 10,
            "rows": 3,
            "columns": list(EXPECTED_COLUMNS),
            "column_count": len(EXPECTED_COLUMNS),
            "period": {"registration_min": "2025-01-01", "registration_max": "2025-03-31"},
            "license_status": "not_verified",
            "raw_source_hashes_status": "unavailable_in_handoff",
        },
        "target": {
            "field": "wait_days",
            "definition": "registration_dt_to_hospitalization_dt_from_handoff",
            "prediction_time": "registration_dt",
            "prediction_time_semantics": "not_verified_as_waitlist_placement",
            "population": "hospitalized_only",
            "horizon_days": 60,
            "horizon_policy": "exclude_observed_wait_over_60_days",
        },
        "cohort": {
            "input_rows": 3,
            "both_hospitalized_and_refused": 0,
            "refused_only": 0,
            "unresolved": 0,
            "hospitalized_only": 3,
            "missing_wait_days": 0,
            "negative_wait_days": 0,
            "over_60_wait_days": 0,
            "invalid_registration_dt": 0,
            "eligible_rows": 3,
            "eligible_fraction": 1.0,
        },
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
            "train": {"period": "2025-01", "rows": 1},
            "validation": {"period": "2025-02", "rows": 1},
            "test": {
                "period": "2025-03",
                "rows": 1,
                "used_for_model_selection_in_this_pipeline": False,
                "previously_examined_in_source_handoff": True,
            },
        },
        "selection": {
            "criterion": "validation_mae_days",
            "candidates": [
                {
                    "family": "ridge_one_hot",
                    "alpha": 1.0,
                    "validation": {**metrics, "rows": 1},
                }
            ],
            "selected_model": {"family": "ridge_one_hot", "alpha": 1.0},
        },
        "test": {
            "model": {**metrics, "rows": 1},
            "global_median_baseline": {**metrics, "rows": 1},
            "hierarchical_median_baseline": {**metrics, "rows": 1},
            "mae_improvement_vs_global_days": 0.0,
            "mae_improvement_vs_hierarchical_days": 0.0,
        },
        "limitations": list(LIMITATIONS),
        "blocked_tasks": {
            "B3": "missing_refusal_reason_and_point_in_time_package_snapshot",
            "D2": "missing_laboratory_demand_target",
            "D4": "missing_attendance_target",
        },
        "reproducibility": {
            "python": "3.12",
            "packages": {
                "joblib": "x",
                "numpy": "x",
                "pandas": "x",
                "pyarrow": "x",
                "scikit-learn": "x",
                "scipy": "x",
            },
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
        "model_artifact": {
            "sha256": "0" * 64,
            "bytes": 1,
            "path_policy": "data_processed_or_system_temp",
            "tracked_in_git": False,
            "serializer_byte_stable": False,
        },
    }


class ReportTests(unittest.TestCase):
    def test_accepts_complete_blocked_research_report(self) -> None:
        verify_report(valid_report())

    def test_rejects_runtime_activation(self) -> None:
        report = valid_report()
        report["runtime_activation"] = "enabled"
        with self.assertRaisesRegex(ReportFailure, "runtime_must_be_blocked"):
            verify_report(report)

    def test_rejects_missing_limitation(self) -> None:
        report = valid_report()
        report["limitations"] = list(LIMITATIONS[:-1])
        with self.assertRaisesRegex(ReportFailure, "limitations_incomplete"):
            verify_report(report)

    def test_rejects_invalid_metrics_and_non_finite_values(self) -> None:
        for metric, value in (
            ("mae_days", -1),
            ("median_absolute_error_days", float("nan")),
            ("within_3_days_fraction", 999),
            ("within_7_days_fraction", -1),
        ):
            report = valid_report()
            report["test"]["model"][metric] = value  # type: ignore[index]
            with self.assertRaises(ReportFailure):
                verify_report(report)

    def test_rejects_extra_row_payload_even_when_privacy_flags_are_false(self) -> None:
        report = valid_report()
        report["patient_rows"] = [{"hospitalization_code": "private"}]
        with self.assertRaises(ReportFailure):
            verify_report(report)

        nested = valid_report()
        nested["features"]["patients"] = [{"iin": "123456789012"}]  # type: ignore[index]
        with self.assertRaisesRegex(ReportFailure, "invalid_keys:features"):
            verify_report(nested)

    def test_rejects_inconsistent_attrition(self) -> None:
        report = valid_report()
        report["cohort"]["refused_only"] = 1  # type: ignore[index]
        with self.assertRaisesRegex(ReportFailure, "outcome_attrition_mismatch"):
            verify_report(report)

        report = valid_report()
        report["cohort"]["eligible_fraction"] = 0.1  # type: ignore[index]
        with self.assertRaisesRegex(ReportFailure, "eligible_fraction_mismatch"):
            verify_report(report)


if __name__ == "__main__":
    unittest.main()
