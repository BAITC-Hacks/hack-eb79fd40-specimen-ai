"""Privacy-preserving audit of Ardan's derived referral parquet."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import pandas as pd  # type: ignore[import-untyped]
import pyarrow.parquet as pq  # type: ignore[import-untyped]

from .contracts import EXPECTED_COLUMNS, INPUT_SHA256
from .io import sha256_file, write_json


class AuditFailure(RuntimeError):
    """Raised when the handoff does not match its frozen structural contract."""


def audit_parquet(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise AuditFailure("input_missing")
    input_hash = sha256_file(path)
    if input_hash != INPUT_SHA256:
        raise AuditFailure("input_sha256_mismatch")

    parquet = pq.ParquetFile(path)
    columns = tuple(parquet.schema_arrow.names)
    if columns != EXPECTED_COLUMNS:
        raise AuditFailure("input_schema_mismatch")

    frame = pd.read_parquet(path)
    registrations = pd.to_datetime(frame["registration_dt"], errors="coerce")
    hospitalized = frame["hospitalized"].fillna(False).astype(bool)
    refused = frame["is_refused"].fillna(0).astype(int).eq(1)
    wait = pd.to_numeric(frame["wait_days"], errors="coerce")
    duplicate_registration_rows = int(frame.duplicated("registration_dt", keep=False).sum())

    missing_counts = {column: int(frame[column].isna().sum()) for column in columns}
    cardinalities = {
        column: int(frame[column].nunique(dropna=True))
        for column in columns
        if column not in {"hospitalization_code", "registration_dt"}
    }
    report: dict[str, Any] = {
        "schema_version": 1,
        "status": "needs_semantic_review",
        "input": {
            "sha256": input_hash,
            "bytes": path.stat().st_size,
            "rows": int(len(frame)),
            "columns": list(columns),
            "column_count": len(columns),
            "period": {
                "registration_min": registrations.min().date().isoformat(),
                "registration_max": registrations.max().date().isoformat(),
            },
            "license_status": "not_verified",
            "raw_source_hashes_status": "unavailable_in_handoff",
        },
        "quality": {
            "missing_counts": missing_counts,
            "cardinalities": cardinalities,
            "unique_hospitalization_codes": int(frame["hospitalization_code"].nunique()),
            "unique_registration_timestamps": int(frame["registration_dt"].nunique()),
            "rows_in_duplicate_registration_groups": duplicate_registration_rows,
            "outcomes": {
                "hospitalized": int(hospitalized.sum()),
                "refused": int(refused.sum()),
                "both": int((hospitalized & refused).sum()),
                "neither": int((~hospitalized & ~refused).sum()),
            },
            "wait_days": {
                "negative_hospitalized": int((hospitalized & wait.lt(0)).sum()),
                "over_60_hospitalized": int((hospitalized & wait.gt(60)).sum()),
                "over_365_hospitalized": int((hospitalized & wait.gt(365)).sum()),
            },
        },
        "decisions": {
            "D1": "research_only_needs_target_semantics_review",
            "B3": "blocked_missing_refusal_reason_and_point_in_time_package",
            "D2": "blocked_missing_laboratory_demand_target",
            "D4": "blocked_missing_attendance_target",
        },
        "privacy": {
            "row_data_emitted": False,
            "identifiers_emitted": False,
            "input_must_remain_untracked": True,
        },
    }
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    write_json(args.output, audit_parquet(args.input))
    print("REFERRAL_DATA_AUDIT_OK")


if __name__ == "__main__":
    main()
