"""Frozen contracts for the offline B3 referral-refusal benchmark."""

from __future__ import annotations

from typing import Final

from .contracts import EXPECTED_COLUMNS, INPUT_SHA256

MODEL_NAME: Final = "referral-refusal-baseline-v0"
REPORT_STATUS: Final = "experimental_not_runtime_ready"
EXPECTED_ROWS: Final = 767_130
EXPECTED_REFUSED: Final = 84_081
EXPECTED_COHORT_ATTRITION: Final[dict[str, int]] = {
    "input_rows": 767_130,
    "mature_rows": 763_167,
    "refused_only": 84_080,
    "hospitalized_only": 679_087,
    "censored_neither": 3_962,
    "conflicting_both": 1,
}
EXPECTED_MONTHLY_ATTRITION: Final[dict[str, dict[str, int]]] = {
    "2025-01": {
        "input_rows": 275_605,
        "mature_rows": 274_466,
        "refused_only": 29_917,
        "hospitalized_only": 244_549,
        "censored_neither": 1_138,
        "conflicting_both": 1,
    },
    "2025-02": {
        "input_rows": 265_462,
        "mature_rows": 264_040,
        "refused_only": 29_603,
        "hospitalized_only": 234_437,
        "censored_neither": 1_422,
        "conflicting_both": 0,
    },
    "2025-03": {
        "input_rows": 226_063,
        "mature_rows": 224_661,
        "refused_only": 24_560,
        "hospitalized_only": 200_101,
        "censored_neither": 1_402,
        "conflicting_both": 0,
    },
}
RANDOM_SEED: Final = 20250921

# Ardan's ClickUp task explicitly limits B3 to fields available when the
# referral is registered. Derived calendar fields are deliberately omitted.
CATEGORICAL_FEATURES: Final[tuple[str, ...]] = (
    "bed_profile",
    "icd10_ref_diag_code",
    "referring_mo",
    "hospital_mo",
    "territorial_type",
    "finance_source",
    "referral_purpose",
)

EXCLUDED_FEATURES: Final[dict[str, tuple[str, ...]]] = {
    "identifier": ("hospitalization_code",),
    "split_axis_only": ("registration_dt",),
    "target_or_outcome": (
        "is_refused",
        "refusal_dt",
        "hospitalized",
        "hospitalization_dt",
        "wait_days",
    ),
    "planned_or_polyclinic_timing": (
        "planned_dt",
        "polyclinic_dt",
        "plan_lead_days",
        "polyclinic_lag_days",
        "has_polyclinic",
    ),
    "operation_semantics_not_authorized": (
        "operation_code",
        "operation_name",
        "has_operation",
    ),
    "derived_calendar_not_in_task_contract": ("reg_month", "reg_dow"),
    "ambiguous_waitlist_join": ("region_code", "profile_code"),
    "free_text_not_in_handoff": ("diagnosis_name",),
}

AVAILABLE_EXCLUDED_COLUMNS: Final[tuple[str, ...]] = tuple(
    column for column in EXPECTED_COLUMNS if column not in CATEGORICAL_FEATURES
)

LIMITATIONS: Final[tuple[str, ...]] = (
    "target_is_any_refusal_not_reason_specific",
    "refusal_reason_absent",
    "point_in_time_semantics_authorized_by_task_not_source_owner_verified",
    "bed_profile_has_substantial_missingness",
    "source_license_not_verified",
    "raw_source_hashes_unavailable_in_handoff",
    "national_2025_q1_not_pilot_hospital",
    "march_previously_examined_in_source_handoff",
    "patient_group_leakage_not_measurable",
    "no_runtime_parity_or_activation",
)

__all__ = [
    "AVAILABLE_EXCLUDED_COLUMNS",
    "CATEGORICAL_FEATURES",
    "EXPECTED_COLUMNS",
    "EXPECTED_COHORT_ATTRITION",
    "EXPECTED_MONTHLY_ATTRITION",
    "EXPECTED_REFUSED",
    "EXPECTED_ROWS",
    "EXCLUDED_FEATURES",
    "INPUT_SHA256",
    "LIMITATIONS",
    "MODEL_NAME",
    "RANDOM_SEED",
    "REPORT_STATUS",
]
