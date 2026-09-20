"""Frozen input and reporting contracts for the referral handoff."""

from __future__ import annotations

from typing import Final

MODEL_NAME: Final = "wait-time-baseline-v0"
REPORT_STATUS: Final = "experimental_not_runtime_ready"
INPUT_SHA256: Final = "c9386df30d37f3035aa653772abb74f648348a17b7de5497e9306b088bc01798"
HORIZON_DAYS: Final = 60

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

# Only fields plausibly available on the referral itself at registration are used.
# Point-in-time availability still needs confirmation from the source data owner.
CATEGORICAL_FEATURES: Final[tuple[str, ...]] = (
    "referring_mo",
    "hospital_mo",
    "icd10_ref_diag_code",
    "bed_profile",
    "territorial_type",
    "referral_purpose",
    "finance_source",
    "reg_month",
    "reg_dow",
)

EXCLUDED_FEATURES: Final[dict[str, tuple[str, ...]]] = {
    "identifier_or_time_axis": ("hospitalization_code", "registration_dt"),
    "target_or_outcome": ("is_refused", "wait_days", "hospitalized"),
    "post_registration_leakage": (
        "plan_lead_days",
        "polyclinic_lag_days",
        "has_polyclinic",
    ),
    "ambiguous_waitlist_join": (
        "region_code",
        "profile_code",
        "operation_code",
        "has_operation",
    ),
}

LIMITATIONS: Final[tuple[str, ...]] = (
    "registration_semantics_unverified",
    "conditional_on_hospitalization_within_60_days",
    "march_previously_examined_in_handoff",
    "point_in_time_feature_availability_unverified",
    "national_2025_q1_not_pilot_hospital",
    "ambiguous_waitlist_join_fields_excluded",
    "source_license_not_verified",
    "patient_group_leakage_not_measurable",
    "no_runtime_parity_or_activation",
    "metrics_not_from_production_typescript_path",
)
