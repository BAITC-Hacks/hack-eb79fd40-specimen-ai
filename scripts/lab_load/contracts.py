"""Frozen contracts for the D2 laboratory-load source audit."""

from __future__ import annotations

from typing import Final

PARQUET_SHA256: Final = "c9386df30d37f3035aa653772abb74f648348a17b7de5497e9306b088bc01798"
PARQUET_BYTES: Final = 13_791_102
ARCHIVE_SHA256: Final = "3db524ccc2a4256443a0369e99bdada590f3494f32be3d01a926147738edfef8"
ARCHIVE_BYTES: Final = 10_113_357
EXPECTED_ROWS: Final = 767_130

EXPECTED_COLUMNS: Final[tuple[str, ...]] = (
    "hospitalization_code",
    "registration_dt",
    "referring_mo",
    "hospital_mo",
    "icd10_ref_diag_code",
    "bed_profile",
    "territorial_type",
    "referral_purpose",
    "finance_source",
    "region_code",
    "profile_code",
    "operation_code",
    "has_operation",
    "plan_lead_days",
    "polyclinic_lag_days",
    "has_polyclinic",
    "reg_month",
    "reg_dow",
    "is_refused",
    "wait_days",
    "hospitalized",
)

SOURCE_DATASET_IDS: Final[tuple[str, ...]] = (
    "mz_bg_planned_hospitalization_referrals",
    "mz_bg_awaiting_planned_hospitalization",
)

UNUSED_HANDOFF_DATASET_IDS: Final[tuple[str, ...]] = (
    "mz_ersb_treated_cases_list",
)

REGION_FIELDS: Final[tuple[str, ...]] = ("region_code",)
PERIOD_FIELDS: Final[tuple[str, ...]] = ("registration_dt", "reg_month", "reg_dow")
REFERRAL_FLOW_FIELDS: Final[tuple[str, ...]] = (
    "registration_dt",
    "hospitalized",
    "is_refused",
    "wait_days",
    "hospital_mo",
    "referring_mo",
    "bed_profile",
    "profile_code",
)

# None of these semantic groups is represented by a field in the frozen parquet.
# The groups are deliberately explicit so a future source can be audited without
# accepting a similarly named but semantically different column by accident.
LABORATORY_TARGET_REQUIRED_GROUPS: Final[dict[str, tuple[str, ...]]] = {
    "event_time": (
        "laboratory_event_dt",
        "ordered_at",
        "specimen_collected_at",
        "resulted_at",
    ),
    "examination_identity": (
        "examination_code",
        "laboratory_test_code",
        "analyte_code",
    ),
    "load_measure": (
        "examination_count",
        "specimen_count",
        "result_count",
        "unit_count",
    ),
    "laboratory_identity": (
        "laboratory_id",
        "performing_organization",
    ),
}

BLOCKED_STATUS: Final = "blocked_missing_laboratory_demand_target"
TASK_NAME: Final = "D2_laboratory_load_forecast"
LAG_WINDOW_DAYS: Final[tuple[int, int]] = (0, 28)
DOWNLOAD_BASE: Final = "https://magda-minio-web.data.gov.kz/magda-datasets"
