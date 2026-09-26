"""Audit the frozen referral handoff for a measurable laboratory-load target."""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path
from typing import Any

import pandas as pd  # type: ignore[import-untyped]
import pyarrow.parquet as pq  # type: ignore[import-untyped]

from .contracts import (
    ARCHIVE_BYTES,
    ARCHIVE_SHA256,
    BLOCKED_STATUS,
    DOWNLOAD_BASE,
    EXPECTED_COLUMNS,
    EXPECTED_ROWS,
    LABORATORY_TARGET_REQUIRED_GROUPS,
    PARQUET_BYTES,
    PARQUET_SHA256,
    PERIOD_FIELDS,
    REFERRAL_FLOW_FIELDS,
    REGION_FIELDS,
    SOURCE_DATASET_IDS,
    TASK_NAME,
    UNUSED_HANDOFF_DATASET_IDS,
)
from .io import sha256_file, write_json


class AuditFailure(RuntimeError):
    """Raised when source bytes do not match the reviewed handoff."""


def _require_snapshot(path: Path, expected_sha256: str, expected_bytes: int, label: str) -> None:
    if not path.is_file():
        raise AuditFailure(f"{label}_missing")
    if path.stat().st_size != expected_bytes:
        raise AuditFailure(f"{label}_size_mismatch")
    if sha256_file(path) != expected_sha256:
        raise AuditFailure(f"{label}_sha256_mismatch")


def classify_columns(columns: tuple[str, ...]) -> dict[str, Any]:
    """Return explicit field-group evidence without accepting fuzzy aliases."""

    available = set(columns)
    laboratory_groups = {
        group: {
            "accepted_fields": list(candidates),
            "present_fields": [field for field in candidates if field in available],
        }
        for group, candidates in LABORATORY_TARGET_REQUIRED_GROUPS.items()
    }
    return {
        "region": {
            "required_fields": list(REGION_FIELDS),
            "present_fields": [field for field in REGION_FIELDS if field in available],
            "available": all(field in available for field in REGION_FIELDS),
        },
        "period": {
            "required_fields": list(PERIOD_FIELDS),
            "present_fields": [field for field in PERIOD_FIELDS if field in available],
            "available": all(field in available for field in PERIOD_FIELDS),
        },
        "referral_flow": {
            "required_fields": list(REFERRAL_FLOW_FIELDS),
            "present_fields": [field for field in REFERRAL_FLOW_FIELDS if field in available],
            "available": all(field in available for field in REFERRAL_FLOW_FIELDS),
        },
        "laboratory_demand": {
            "required_groups": laboratory_groups,
            "available": all(group["present_fields"] for group in laboratory_groups.values()),
        },
    }


def audit_sources(parquet_path: Path, archive_path: Path) -> dict[str, Any]:
    _require_snapshot(parquet_path, PARQUET_SHA256, PARQUET_BYTES, "parquet")
    _require_snapshot(archive_path, ARCHIVE_SHA256, ARCHIVE_BYTES, "archive")

    parquet = pq.ParquetFile(parquet_path)
    columns = tuple(parquet.schema_arrow.names)
    if columns != EXPECTED_COLUMNS:
        raise AuditFailure("parquet_schema_mismatch")
    if parquet.metadata.num_rows != EXPECTED_ROWS:
        raise AuditFailure("parquet_row_count_mismatch")
    if parquet.schema_arrow.metadata:
        raise AuditFailure("unexpected_embedded_source_metadata")

    with zipfile.ZipFile(archive_path) as archive:
        members = tuple(archive.namelist())
        if "README.md" not in members or "download_data.sh" not in members:
            raise AuditFailure("archive_provenance_files_missing")
        license_members = [
            name
            for name in members
            if Path(name).name.lower().startswith(("license", "licence", "copying"))
        ]
        downloader = archive.read("download_data.sh").decode("utf-8")
        builder = archive.read("analysis/05_build_features.py").decode("utf-8")

    if DOWNLOAD_BASE not in downloader:
        raise AuditFailure("archive_download_base_mismatch")
    if not all(dataset_id in downloader for dataset_id in (*SOURCE_DATASET_IDS, *UNUSED_HANDOFF_DATASET_IDS)):
        raise AuditFailure("archive_dataset_lineage_mismatch")
    if not all(name in builder for name in ("referrals_features.parquet", "region_code", "registration_dt")):
        raise AuditFailure("archive_builder_lineage_mismatch")

    frame = pd.read_parquet(
        parquet_path,
        columns=[
            "registration_dt",
            "region_code",
            "hospital_mo",
            "referring_mo",
            "hospitalized",
            "is_refused",
            "wait_days",
        ],
    )
    registrations = pd.to_datetime(frame["registration_dt"], errors="coerce")
    months = sorted(registrations.dropna().dt.to_period("M").astype(str).unique().tolist())
    field_evidence = classify_columns(columns)

    return {
        "schema_version": 1,
        "task": TASK_NAME,
        "status": BLOCKED_STATUS,
        "source": {
            "handoff_label": "demeu-data-handoff-2026-09-19",
            "archive": {
                "sha256": ARCHIVE_SHA256,
                "bytes": ARCHIVE_BYTES,
                "member_count": len(members),
                "license_file_present": bool(license_members),
            },
            "derived_parquet": {
                "sha256": PARQUET_SHA256,
                "bytes": PARQUET_BYTES,
                "rows": EXPECTED_ROWS,
                "columns": list(columns),
                "column_count": len(columns),
                "embedded_metadata_present": False,
            },
            "catalog": "Ashyq Data / data.gov.kz",
            "download_base": DOWNLOAD_BASE,
            "derived_by": "analysis/05_build_features.py",
            "used_dataset_ids": list(SOURCE_DATASET_IDS),
            "referenced_by_downloader_but_not_used_for_parquet": list(UNUSED_HANDOFF_DATASET_IDS),
            "raw_source_hashes_status": "unavailable_in_handoff",
            "license_status": "not_verified",
        },
        "coverage": {
            "registration_min": registrations.min().isoformat(),
            "registration_max": registrations.max().isoformat(),
            "calendar_months": months,
            "month_count": len(months),
            "registration_rows": int(registrations.notna().sum()),
            "region_non_null_rows": int(frame["region_code"].notna().sum()),
            "region_distinct": int(frame["region_code"].nunique(dropna=True)),
            "receiving_organization_distinct": int(frame["hospital_mo"].nunique(dropna=True)),
            "referring_organization_distinct": int(frame["referring_mo"].nunique(dropna=True)),
        },
        "field_evidence": field_evidence,
        "decision": {
            "target_constructible": False,
            "temporal_benchmark_allowed": False,
            "referral_to_laboratory_lag_test_allowed": False,
            "reason": "no_observed_laboratory_event_identity_time_or_load_measure",
            "rejected_proxy": {
                "name": "appendix_5_requirements_expanded_per_referral",
                "reason": "normative_requirements_are_not_observed_orders_specimens_or_results",
            },
        },
        "minimum_source_contract": {
            "required": [
                "event_timestamp",
                "region_or_performing_organization",
                "examination_code",
                "observed_unit_count_or_one_row_per_event",
                "event_status_or_stage",
            ],
            "recommended": [
                "referral_id_or_privacy_preserving_join_key",
                "ordered_at",
                "specimen_collected_at",
                "resulted_at",
                "laboratory_id",
            ],
            "minimum_history": "at_least_26_contiguous_weeks_for_weekly_seasonality",
            "preferred_history": "at_least_24_months_for_annual_seasonality",
            "license_and_provenance": "source_terms_raw_hashes_and_snapshot_date_required",
        },
        "privacy": {
            "row_data_emitted": False,
            "identifiers_emitted": False,
            "source_must_remain_untracked": True,
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    write_json(args.output, audit_sources(args.input, args.archive))
    print("LAB_LOAD_AUDIT_GENERATED")


if __name__ == "__main__":
    main()
