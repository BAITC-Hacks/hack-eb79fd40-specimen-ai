"""Fail-closed verifier for the D2 source-audit artifact."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .contracts import (
    ARCHIVE_SHA256,
    BLOCKED_STATUS,
    DOWNLOAD_BASE,
    EXPECTED_COLUMNS,
    EXPECTED_ROWS,
    LABORATORY_TARGET_REQUIRED_GROUPS,
    PARQUET_SHA256,
    PERIOD_FIELDS,
    REFERRAL_FLOW_FIELDS,
    REGION_FIELDS,
    SOURCE_DATASET_IDS,
    TASK_NAME,
)
from .io import read_json


class AuditReportFailure(RuntimeError):
    """Raised when a source audit makes an unsupported readiness claim."""


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise AuditReportFailure(code)


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


def verify_audit(report: dict[str, Any]) -> None:
    _reject_sensitive_payload(report)
    _keys(
        report,
        {
            "schema_version",
            "task",
            "status",
            "source",
            "coverage",
            "field_evidence",
            "decision",
            "minimum_source_contract",
            "privacy",
        },
        "root",
    )
    _require(report["schema_version"] == 1, "schema_version_mismatch")
    _require(report["task"] == TASK_NAME, "task_mismatch")
    _require(report["status"] == BLOCKED_STATUS, "status_mismatch")

    source = report["source"]
    _keys(
        source,
        {
            "handoff_label",
            "archive",
            "derived_parquet",
            "catalog",
            "download_base",
            "derived_by",
            "used_dataset_ids",
            "referenced_by_downloader_but_not_used_for_parquet",
            "raw_source_hashes_status",
            "license_status",
        },
        "source",
    )
    _require(source["download_base"] == DOWNLOAD_BASE, "download_base_mismatch")
    _require(source["derived_by"] == "analysis/05_build_features.py", "builder_lineage_mismatch")
    _require(source["archive"]["sha256"] == ARCHIVE_SHA256, "archive_hash_mismatch")
    _require(source["archive"]["license_file_present"] is False, "license_file_claim_mismatch")
    _require(source["derived_parquet"]["sha256"] == PARQUET_SHA256, "parquet_hash_mismatch")
    _require(source["derived_parquet"]["rows"] == EXPECTED_ROWS, "row_count_mismatch")
    _require(source["derived_parquet"]["columns"] == list(EXPECTED_COLUMNS), "columns_mismatch")
    _require(source["used_dataset_ids"] == list(SOURCE_DATASET_IDS), "dataset_lineage_mismatch")
    _require(source["referenced_by_downloader_but_not_used_for_parquet"] == ["mz_ersb_treated_cases_list"], "unused_lineage_mismatch")
    _require(source["raw_source_hashes_status"] == "unavailable_in_handoff", "raw_hash_claim_mismatch")
    _require(source["license_status"] == "not_verified", "license_claim_mismatch")

    coverage = report["coverage"]
    _require(coverage["registration_min"] == "2025-01-01T01:03:14.263000", "period_min_mismatch")
    _require(coverage["registration_max"] == "2025-03-31T23:58:54.163000", "period_max_mismatch")
    _require(coverage["calendar_months"] == ["2025-01", "2025-02", "2025-03"], "period_mismatch")
    _require(coverage["registration_rows"] == EXPECTED_ROWS, "registration_count_mismatch")
    _require(coverage["region_non_null_rows"] == EXPECTED_ROWS, "region_coverage_mismatch")
    _require(coverage["region_distinct"] == 20, "region_cardinality_mismatch")

    evidence = report["field_evidence"]
    for label, expected_fields in (
        ("region", REGION_FIELDS),
        ("period", PERIOD_FIELDS),
        ("referral_flow", REFERRAL_FLOW_FIELDS),
    ):
        _require(evidence[label]["required_fields"] == list(expected_fields), f"{label}_contract_mismatch")
        _require(evidence[label]["present_fields"] == list(expected_fields), f"{label}_fields_missing")
        _require(evidence[label]["available"] is True, f"{label}_availability_mismatch")

    laboratory = evidence["laboratory_demand"]
    _require(laboratory["available"] is False, "laboratory_target_must_be_absent")
    for group, candidates in LABORATORY_TARGET_REQUIRED_GROUPS.items():
        actual = laboratory["required_groups"][group]
        _require(actual["accepted_fields"] == list(candidates), f"{group}_contract_mismatch")
        _require(actual["present_fields"] == [], f"{group}_unsupported_field_claim")

    decision = report["decision"]
    _require(decision["target_constructible"] is False, "target_must_be_blocked")
    _require(decision["temporal_benchmark_allowed"] is False, "benchmark_must_be_blocked")
    _require(decision["referral_to_laboratory_lag_test_allowed"] is False, "lag_test_must_be_blocked")
    _require(decision["rejected_proxy"]["name"] == "appendix_5_requirements_expanded_per_referral", "proxy_guard_missing")

    privacy = report["privacy"]
    _require(privacy == {
        "row_data_emitted": False,
        "identifiers_emitted": False,
        "source_must_remain_untracked": True,
    }, "privacy_contract_mismatch")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    verify_audit(read_json(args.report))
    print("LAB_LOAD_AUDIT_OK")


if __name__ == "__main__":
    main()
