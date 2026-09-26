"""Fail-closed verifier for a D2 benchmark or blocker report."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .contracts import BLOCKED_STATUS, LAG_WINDOW_DAYS, PARQUET_SHA256, TASK_NAME
from .io import read_json


class ReportFailure(RuntimeError):
    """Raised when the report implies evidence that the source cannot support."""


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise ReportFailure(code)


def _keys(value: Any, expected: set[str], label: str) -> None:
    _require(isinstance(value, dict), f"{label}_must_be_object")
    _require(set(value) == expected, f"{label}_keys_mismatch")


def _reject_sensitive_payload(value: Any) -> None:
    forbidden = {"patient_rows", "row_data", "hospitalization_code", "iin", "patient_id"}
    if isinstance(value, dict):
        _require(not (set(value) & forbidden), "sensitive_payload_key")
        for child in value.values():
            _reject_sensitive_payload(child)
    elif isinstance(value, list):
        for child in value:
            _reject_sensitive_payload(child)


def verify_report(report: dict[str, Any]) -> None:
    _reject_sensitive_payload(report)
    _keys(
        report,
        {
            "schema_version",
            "task",
            "status",
            "runtime_activation",
            "source",
            "target",
            "temporal_benchmark",
            "referral_flow_lag",
            "next_data_gate",
            "publication",
            "privacy",
        },
        "root",
    )
    _require(report.get("schema_version") == 1, "schema_version_mismatch")
    _require(report.get("task") == TASK_NAME, "task_mismatch")
    _require(report.get("status") == BLOCKED_STATUS, "status_mismatch")
    _require(report.get("runtime_activation") == "blocked", "runtime_must_be_blocked")

    source = report["source"]
    _keys(source, {
        "derived_parquet_sha256",
        "referral_rows",
        "region_distinct",
        "calendar_months",
        "laboratory_event_rows",
        "license_status",
        "raw_source_hashes_status",
    }, "source")
    _require(source["derived_parquet_sha256"] == PARQUET_SHA256, "source_hash_mismatch")
    _require(source["referral_rows"] == 767_130, "referral_count_mismatch")
    _require(source["laboratory_event_rows"] is None, "unsupported_laboratory_rows")
    _require(source["license_status"] == "not_verified", "license_claim_mismatch")

    target = report["target"]
    _require(target["available"] is False, "target_must_be_absent")
    _require(target["proxy_allowed"] is False, "synthetic_proxy_must_be_rejected")
    _require(set(target["missing_groups"]) == {
        "event_time",
        "examination_identity",
        "load_measure",
        "laboratory_identity",
    }, "missing_target_groups_mismatch")

    benchmark = report["temporal_benchmark"]
    _keys(benchmark, {
        "executed",
        "split",
        "seasonal_baseline",
        "candidate_model",
        "held_out_metrics",
        "future_metric_contract",
        "selection_or_test_peeking",
        "blocker",
    }, "temporal_benchmark")
    _require(benchmark["executed"] is False, "benchmark_must_not_claim_execution")
    _require(benchmark["split"] is None, "unsupported_split_claim")
    _require(benchmark["seasonal_baseline"] is None, "unsupported_baseline_claim")
    _require(benchmark["candidate_model"] is None, "unsupported_model_claim")
    _require(benchmark["held_out_metrics"] == {
        "mae": None,
        "rmse": None,
        "peak_recall": None,
    }, "unsupported_metric_claim")
    _require(benchmark["future_metric_contract"] == {
        "mae": "mean_absolute_error_on_untouched_test_buckets",
        "rmse": "root_mean_squared_error_on_untouched_test_buckets",
        "peak_definition": "observed_load_at_or_above_train_only_p90",
        "peak_recall": "test_peaks_predicted_at_or_above_train_only_p90_divided_by_test_peaks",
    }, "future_metric_contract_mismatch")
    _require(benchmark["selection_or_test_peeking"] is False, "test_peeking_claim_mismatch")

    lag = report["referral_flow_lag"]
    _require(lag["candidate_lag_window_days"] == list(LAG_WINDOW_DAYS), "lag_window_mismatch")
    _require(lag["correlation"] is None, "unsupported_correlation_claim")
    _require(lag["uplift"] is None, "unsupported_uplift_claim")
    _require(lag["sample_counts"] == {
        "referral_rows": 767_130,
        "laboratory_event_rows": None,
        "aligned_time_buckets": None,
    }, "lag_sample_counts_mismatch")

    publication = report["publication"]
    _require(publication["metrics_claim_allowed"] is False, "metric_publication_must_be_blocked")
    _require(report["privacy"] == {
        "contains_row_data": False,
        "contains_identifiers": False,
    }, "privacy_contract_mismatch")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    verify_report(read_json(args.report))
    print("LAB_LOAD_BLOCKER_OK")


if __name__ == "__main__":
    main()
