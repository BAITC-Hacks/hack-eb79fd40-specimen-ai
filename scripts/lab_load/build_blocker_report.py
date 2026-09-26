"""Build the D2 blocker report from a verified source audit."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .contracts import BLOCKED_STATUS, LAG_WINDOW_DAYS, PARQUET_SHA256, TASK_NAME
from .io import read_json, write_json
from .verify_audit import verify_audit


def build_report(audit: dict[str, Any]) -> dict[str, Any]:
    verify_audit(audit)
    return {
        "schema_version": 1,
        "task": TASK_NAME,
        "status": BLOCKED_STATUS,
        "runtime_activation": "blocked",
        "source": {
            "derived_parquet_sha256": PARQUET_SHA256,
            "referral_rows": audit["coverage"]["registration_rows"],
            "region_distinct": audit["coverage"]["region_distinct"],
            "calendar_months": audit["coverage"]["calendar_months"],
            "laboratory_event_rows": None,
            "license_status": audit["source"]["license_status"],
            "raw_source_hashes_status": audit["source"]["raw_source_hashes_status"],
        },
        "target": {
            "available": False,
            "definition": "observed_laboratory_units_by_time_region_and_examination",
            "missing_groups": [
                "event_time",
                "examination_identity",
                "load_measure",
                "laboratory_identity",
            ],
            "proxy_allowed": False,
            "proxy_rejection": "appendix_5_requirements_are_normative_not_observed_demand",
        },
        "temporal_benchmark": {
            "executed": False,
            "split": None,
            "seasonal_baseline": None,
            "candidate_model": None,
            "held_out_metrics": {
                "mae": None,
                "rmse": None,
                "peak_recall": None,
            },
            "future_metric_contract": {
                "mae": "mean_absolute_error_on_untouched_test_buckets",
                "rmse": "root_mean_squared_error_on_untouched_test_buckets",
                "peak_definition": "observed_load_at_or_above_train_only_p90",
                "peak_recall": "test_peaks_predicted_at_or_above_train_only_p90_divided_by_test_peaks",
            },
            "selection_or_test_peeking": False,
            "blocker": "no_observed_laboratory_target",
        },
        "referral_flow_lag": {
            "hypothesis": "referral_registrations_precede_observed_laboratory_units",
            "status": "not_testable_without_laboratory_events",
            "candidate_lag_window_days": list(LAG_WINDOW_DAYS),
            "correlation": None,
            "uplift": None,
            "sample_counts": {
                "referral_rows": audit["coverage"]["registration_rows"],
                "laboratory_event_rows": None,
                "aligned_time_buckets": None,
            },
            "limitations": [
                "no_observed_laboratory_target",
                "no_privacy_preserving_referral_to_laboratory_join_key",
                "three_month_referral_window_cannot_measure_annual_seasonality",
                "source_license_not_verified",
            ],
        },
        "next_data_gate": {
            "required_fields": audit["minimum_source_contract"]["required"],
            "minimum_history": audit["minimum_source_contract"]["minimum_history"],
            "preferred_history": audit["minimum_source_contract"]["preferred_history"],
            "acceptance": [
                "chronological_train_validation_test_split",
                "same_weekday_previous_week_or_train_only_seasonal_baseline",
                "peak_threshold_fitted_on_train_only",
                "held_out_mae_rmse_and_peak_recall",
                "lag_selection_on_train_validation_only",
                "final_lag_evidence_on_untouched_test_period",
            ],
        },
        "publication": {
            "metrics_claim_allowed": False,
            "allowed_statement": "D2_is_blocked_until_observed_laboratory_events_are_provided",
        },
        "privacy": {
            "contains_row_data": False,
            "contains_identifiers": False,
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    write_json(args.output, build_report(read_json(args.audit)))
    print("LAB_LOAD_BLOCKER_GENERATED")


if __name__ == "__main__":
    main()
