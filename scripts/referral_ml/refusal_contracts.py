"""Frozen contracts for the offline B3 referral-refusal benchmark."""

from __future__ import annotations

from typing import Final

from .contracts import EXPECTED_COLUMNS, INPUT_SHA256

MODEL_NAME: Final = "referral-refusal-baseline-v0"
REPORT_STATUS: Final = "experimental_not_runtime_ready"
EXPECTED_SEMANTIC_REPORT_SHA256: Final = (
    "8f0810cfa937d38817ed0caf8b1971d81093d6dd125b120b203a0a096c5a4f91"
)
EXPECTED_ROWS: Final = 767_130
EXPECTED_REFUSED: Final = 84_081
EXPECTED_COHORT_ATTRITION: Final[dict[str, int]] = {
    "input_rows": 763_192,
    "mature_rows": 759_232,
    "refused_only": 83_798,
    "hospitalized_only": 675_434,
    "censored_neither": 3_959,
    "conflicting_both": 1,
}
EXPECTED_MONTHLY_ATTRITION: Final[dict[str, dict[str, int]]] = {
    "2025-01": {
        "input_rows": 274_307,
        "mature_rows": 273_169,
        "refused_only": 29_831,
        "hospitalized_only": 243_338,
        "censored_neither": 1_137,
        "conflicting_both": 1,
    },
    "2025-02": {
        "input_rows": 264_130,
        "mature_rows": 262_710,
        "refused_only": 29_498,
        "hospitalized_only": 233_212,
        "censored_neither": 1_420,
        "conflicting_both": 0,
    },
    "2025-03": {
        "input_rows": 224_755,
        "mature_rows": 223_353,
        "refused_only": 24_469,
        "hospitalized_only": 198_884,
        "censored_neither": 1_402,
        "conflicting_both": 0,
    },
}
EXPECTED_DUPLICATE_AUDIT: Final[dict[str, int | bool | str]] = {
    "policy": "exclude_all_rows_for_repeated_hospitalization_code_before_temporal_split",
    "unique_hospitalization_codes": 765_161,
    "repeated_hospitalization_codes": 1_969,
    "rows_with_repeated_hospitalization_code": 3_938,
    "is_refused_conflicting_codes": 6,
    "hospitalized_conflicting_codes": 5,
    "cross_month_codes": 0,
    "selection_uses_target_or_timestamp": False,
    "rows_after_policy": 763_192,
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
    "all_rows_for_repeated_identifiers_excluded_before_temporal_split",
    "patient_group_leakage_not_measurable",
    "no_runtime_parity_or_activation",
)

__all__ = [
    "AVAILABLE_EXCLUDED_COLUMNS",
    "CATEGORICAL_FEATURES",
    "EXPECTED_COLUMNS",
    "EXPECTED_COHORT_ATTRITION",
    "EXPECTED_DUPLICATE_AUDIT",
    "EXPECTED_MONTHLY_ATTRITION",
    "EXPECTED_REFUSED",
    "EXPECTED_ROWS",
    "EXPECTED_SEMANTIC_REPORT_SHA256",
    "EXCLUDED_FEATURES",
    "INPUT_SHA256",
    "LIMITATIONS",
    "MODEL_NAME",
    "RANDOM_SEED",
    "REPORT_STATUS",
]
