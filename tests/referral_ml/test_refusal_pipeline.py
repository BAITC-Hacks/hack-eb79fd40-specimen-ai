from __future__ import annotations

import unittest
from itertools import count
from pathlib import Path

import numpy as np
import pandas as pd  # type: ignore[import-untyped]

from scripts.referral_ml.refusal_contracts import CATEGORICAL_FEATURES
from scripts.referral_ml.refusal_pipeline import (
    build_cohort,
    calibration_deciles,
    classification_metrics,
    fit_logistic_model,
    fit_smoothed_pair_baseline,
    select_f1_threshold,
    temporal_split,
)
from scripts.referral_ml.train_refusal import validate_model_output

ROW_IDS = count()


def row(
    registration_dt: str,
    refused: int,
    *,
    hospital: str = "hospital-a",
    profile: str | None = "profile-a",
    hospitalized: int | None = None,
    hospitalization_code: str | None = None,
) -> dict[str, object]:
    if hospitalization_code is None:
        hospitalization_code = f"test-code-{next(ROW_IDS)}"
    return {
        "hospitalization_code": hospitalization_code,
        "registration_dt": registration_dt,
        "is_refused": refused,
        "hospitalized": 1 - int(refused) if hospitalized is None else hospitalized,
        "bed_profile": profile,
        "icd10_ref_diag_code": "J00",
        "referring_mo": "sender-a",
        "hospital_mo": hospital,
        "territorial_type": "urban",
        "finance_source": "budget",
        "referral_purpose": "planned",
    }


class CohortAndSplitTests(unittest.TestCase):
    def test_uses_january_february_and_march_without_overlap(self) -> None:
        frame = pd.DataFrame(
            [
                row("2025-01-31 23:59:59", 0),
                row("2025-02-01", 1),
                row("2025-02-28 23:59:59", 0),
                row("2025-03-01", 1),
            ]
        )
        split = temporal_split(build_cohort(frame).frame)
        self.assertEqual(split.train["is_refused"].tolist(), [0])
        self.assertEqual(split.validation["is_refused"].tolist(), [1, 0])
        self.assertEqual(split.test["is_refused"].tolist(), [1])

    def test_rejects_missing_or_non_binary_target(self) -> None:
        missing = pd.DataFrame([row("2025-01-01", 0)])
        missing.loc[0, "is_refused"] = None
        with self.assertRaisesRegex(ValueError, "invalid_binary_target"):
            build_cohort(missing)

        invalid = pd.DataFrame([row("2025-01-01", 2)])
        with self.assertRaisesRegex(ValueError, "invalid_binary_target"):
            build_cohort(invalid)

    def test_excludes_censored_and_conflicting_outcomes_with_attrition(self) -> None:
        frame = pd.DataFrame(
            [
                row("2025-01-01", 1, hospitalized=0),
                row("2025-01-02", 0, hospitalized=1),
                row("2025-01-03", 0, hospitalized=0),
                row("2025-01-04", 1, hospitalized=1),
            ]
        )
        cohort = build_cohort(frame)
        self.assertEqual(cohort.frame["is_refused"].tolist(), [1, 0])
        self.assertEqual(cohort.attrition["mature_rows"], 2)
        self.assertEqual(cohort.attrition["censored_neither"], 1)
        self.assertEqual(cohort.attrition["conflicting_both"], 1)
        self.assertEqual(
            cohort.attrition["policy"],
            "exclude_all_rows_for_repeated_hospitalization_code_before_temporal_split_then_exclude_censored_neither_and_conflicting_both",
        )

    def test_excludes_every_row_for_a_repeated_identifier_without_using_outcome(self) -> None:
        frame = pd.DataFrame(
            [
                row("2025-01-01", 1, hospitalization_code="duplicate"),
                row("2025-01-02", 0, hospitalization_code="duplicate"),
                row("2025-01-03", 1, hospitalization_code="unique"),
            ]
        )
        cohort = build_cohort(frame)
        self.assertEqual(cohort.frame["is_refused"].tolist(), [1])
        self.assertEqual(
            cohort.attrition["duplicate_audit"],
            {
                "policy": "exclude_all_rows_for_repeated_hospitalization_code_before_temporal_split",
                "unique_hospitalization_codes": 2,
                "repeated_hospitalization_codes": 1,
                "rows_with_repeated_hospitalization_code": 2,
                "is_refused_conflicting_codes": 1,
                "hospitalized_conflicting_codes": 1,
                "cross_month_codes": 0,
                "selection_uses_target_or_timestamp": False,
                "rows_after_policy": 1,
            },
        )

    def test_fails_closed_when_a_repeated_identifier_crosses_months(self) -> None:
        frame = pd.DataFrame(
            [
                row("2025-01-31", 1, hospitalization_code="cross-month"),
                row("2025-02-01", 1, hospitalization_code="cross-month"),
            ]
        )
        with self.assertRaisesRegex(
            ValueError, "duplicate_identifier_crosses_temporal_partition"
        ):
            build_cohort(frame)

    def test_rejects_dates_outside_exact_first_quarter_boundaries(self) -> None:
        frame = pd.DataFrame(
            [
                row("2024-12-31", 0),
                row("2025-01-01", 0),
                row("2025-02-01", 0),
                row("2025-03-01", 0),
            ]
        )
        with self.assertRaisesRegex(ValueError, "outside_supported_period"):
            temporal_split(build_cohort(frame).frame)

        frame.loc[0, "registration_dt"] = "2025-04-01"
        with self.assertRaisesRegex(ValueError, "outside_supported_period"):
            temporal_split(build_cohort(frame).frame)


class BaselineAndModelTests(unittest.TestCase):
    def test_smoothed_pair_uses_pair_then_safe_fallbacks(self) -> None:
        train = pd.DataFrame(
            [row("2025-01-01", index % 3 == 0, hospital="h1", profile="p1") for index in range(60)]
            + [row("2025-01-02", index % 4 == 0, hospital="h2", profile="p2") for index in range(60)]
        )
        baseline = fit_smoothed_pair_baseline(
            build_cohort(train).frame, smoothing_strength=10
        )
        target = pd.DataFrame(
            [
                row("2025-02-01", 0, hospital="h1", profile="p1"),
                row("2025-02-01", 0, hospital="h1", profile="new-profile"),
                row("2025-02-01", 0, hospital="new-hospital", profile="p2"),
                row("2025-02-01", 0, hospital="new-hospital", profile="new-profile"),
            ]
        )
        prediction = baseline.predict(build_cohort(target).frame)
        self.assertEqual(
            prediction.source_counts,
            {
                "pair": 1,
                "hospital_profile_blend": 0,
                "hospital": 1,
                "profile": 1,
                "global": 1,
            },
        )
        self.assertTrue(np.isfinite(prediction.probabilities).all())

    def test_model_uses_only_the_seven_authorized_features(self) -> None:
        self.assertEqual(
            CATEGORICAL_FEATURES,
            (
                "bed_profile",
                "icd10_ref_diag_code",
                "referring_mo",
                "hospital_mo",
                "territorial_type",
                "finance_source",
                "referral_purpose",
            ),
        )
        frame = pd.DataFrame(
            [
                row(
                    f"2025-01-{index + 1:02d}",
                    index % 2,
                    hospital=f"h{index % 3}",
                    profile=f"p{index % 2}",
                )
                for index in range(24)
            ]
        )
        model = fit_logistic_model(build_cohort(frame).frame, c_value=1.0)
        prediction = model.predict_proba(build_cohort(frame.iloc[:3].copy()).frame)
        self.assertEqual(model.feature_order, CATEGORICAL_FEATURES)
        self.assertEqual(prediction.shape, (3,))
        self.assertTrue(((prediction >= 0) & (prediction <= 1)).all())


class MetricsTests(unittest.TestCase):
    def test_threshold_metrics_and_calibration_are_aggregate_only(self) -> None:
        actual = np.array([0, 0, 1, 1], dtype=np.int8)
        probabilities = np.array([0.1, 0.4, 0.35, 0.8])
        selected = select_f1_threshold(actual, probabilities)
        metrics = classification_metrics(actual, probabilities, selected.threshold)
        calibration = calibration_deciles(actual, probabilities)
        self.assertEqual(metrics["rows"], 4)
        self.assertEqual(metrics["positives"], 2)
        self.assertGreater(metrics["pr_auc"], 0)
        self.assertEqual(metrics["roc_auc"], 0.75)
        self.assertEqual(
            sum(bucket["rows"] for bucket in calibration["bins"]),  # type: ignore[index]
            4,
        )

    def test_constant_scores_emit_one_honest_calibration_bin(self) -> None:
        actual = np.array([0, 1, 0, 0], dtype=np.int8)
        probabilities = np.full(4, 0.25)
        metrics = classification_metrics(actual, probabilities, threshold=0.25)
        calibration = calibration_deciles(actual, probabilities)
        self.assertEqual(metrics["roc_auc"], 0.5)
        self.assertEqual(calibration["actual_bins"], 1)
        self.assertEqual(calibration["bins"][0]["observed_rate"], 0.25)  # type: ignore[index]

    def test_roc_auc_fails_closed_when_a_partition_has_one_class(self) -> None:
        with self.assertRaisesRegex(ValueError, "metrics_require_both_classes"):
            classification_metrics(
                np.array([0, 0], dtype=np.int8),
                np.array([0.1, 0.2]),
                threshold=0.15,
            )


class ArtifactPolicyTests(unittest.TestCase):
    def test_binary_output_is_limited_to_private_or_temporary_paths(self) -> None:
        private = validate_model_output(
            Path("data/processed/referral-refusal-baseline-v0.joblib")
        )
        self.assertTrue(private.is_absolute())
        with self.assertRaisesRegex(ValueError, "model_output_must_be_private_or_temporary"):
            validate_model_output(Path("reports/referral-refusal-baseline-v0.joblib"))
        with self.assertRaisesRegex(ValueError, "model_output_must_be_joblib"):
            validate_model_output(Path("data/processed/referral-refusal-baseline-v0.json"))


if __name__ == "__main__":
    unittest.main()
