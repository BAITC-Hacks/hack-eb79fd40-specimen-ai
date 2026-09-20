from __future__ import annotations

import unittest

import numpy as np
import pandas as pd  # type: ignore[import-untyped]

from scripts.referral_ml.contracts import CATEGORICAL_FEATURES, EXCLUDED_FEATURES
from scripts.referral_ml.wait_pipeline import (
    build_cohort,
    feature_matrix,
    fit_hist_gradient_model,
    fit_model,
    hierarchical_median_predictions,
    regression_metrics,
    temporal_split,
)


def row(date: str, wait: int, **patch: object) -> dict[str, object]:
    value: dict[str, object] = {
        "registration_dt": date,
        "wait_days": wait,
        "hospitalized": True,
        "is_refused": 0,
        "referring_mo": "sender",
        "hospital_mo": "receiver",
        "icd10_ref_diag_code": "A00",
        "bed_profile": "profile",
        "territorial_type": "type",
        "referral_purpose": "purpose",
        "finance_source": "finance",
        "reg_month": 1,
        "reg_dow": 1,
    }
    value.update(patch)
    return value


class CohortTests(unittest.TestCase):
    def test_reports_every_exclusion_and_keeps_zero_and_60(self) -> None:
        frame = pd.DataFrame(
            [
                row("2025-01-01", 0),
                row("2025-01-02", 60),
                row("2025-01-03", 61),
                row("2025-01-04", -1),
                row("2025-01-05", 2, hospitalized=False, is_refused=1),
                row("2025-01-06", 2, hospitalized=False),
                row("2025-01-07", 2, is_refused=1),
                row("invalid-date", 2),
            ]
        )
        cohort = build_cohort(frame)
        self.assertEqual(cohort.frame["wait_days"].tolist(), [0, 60])
        self.assertEqual(
            cohort.attrition,
            {
                "input_rows": 8,
                "both_hospitalized_and_refused": 1,
                "refused_only": 1,
                "unresolved": 1,
                "hospitalized_only": 5,
                "missing_wait_days": 0,
                "negative_wait_days": 1,
                "over_60_wait_days": 1,
                "invalid_registration_dt": 1,
                "eligible_rows": 2,
                "eligible_fraction": 0.25,
            },
        )

    def test_feature_allowlist_is_disjoint_from_every_exclusion(self) -> None:
        excluded = {field for fields in EXCLUDED_FEATURES.values() for field in fields}
        self.assertTrue(set(CATEGORICAL_FEATURES).isdisjoint(excluded))
        self.assertNotIn("plan_lead_days", CATEGORICAL_FEATURES)
        self.assertNotIn("operation_code", CATEGORICAL_FEATURES)


class TemporalSplitTests(unittest.TestCase):
    def test_uses_january_for_train_february_for_validation_and_march_for_test(self) -> None:
        frame = pd.DataFrame(
            [
                row("2025-01-31 23:59:59", 1),
                row("2025-02-01", 2),
                row("2025-02-28 23:59:59", 3),
                row("2025-03-01", 4),
            ]
        )
        partitions = temporal_split(build_cohort(frame).frame)
        self.assertEqual(partitions.train["wait_days"].tolist(), [1])
        self.assertEqual(partitions.validation["wait_days"].tolist(), [2, 3])
        self.assertEqual(partitions.test["wait_days"].tolist(), [4])

    def test_feature_encoding_is_independent_of_target_values(self) -> None:
        first = pd.DataFrame([row("2025-01-01", 1), row("2025-01-02", 2)])
        changed = first.copy()
        changed.loc[0, "wait_days"] = 55
        pd.testing.assert_frame_equal(feature_matrix(first), feature_matrix(changed))


class ModelAndMetricTests(unittest.TestCase):
    def test_unseen_categories_produce_finite_clipped_prediction(self) -> None:
        train = pd.DataFrame(
            [row(f"2025-01-{day:02d}", day % 10, referring_mo=f"sender-{day % 2}") for day in range(1, 25)]
        )
        model = fit_model(build_cohort(train).frame, alpha=10.0)
        unseen = pd.DataFrame([row("2025-02-01", 1, referring_mo="never-seen")])
        prediction = model.predict(unseen)
        self.assertTrue(np.isfinite(prediction).all())
        self.assertGreaterEqual(prediction[0], 0)
        self.assertLessEqual(prediction[0], 60)

        tree_model = fit_hist_gradient_model(
            build_cohort(train).frame, loss="poisson", max_leaf_nodes=31
        )
        tree_prediction = tree_model.predict(unseen)
        self.assertTrue(np.isfinite(tree_prediction).all())
        self.assertGreaterEqual(tree_prediction[0], 0)
        self.assertLessEqual(tree_prediction[0], 60)

    def test_metrics_match_small_manual_example(self) -> None:
        metrics = regression_metrics(np.array([0, 10, 20]), np.array([0, 13, 10]))
        self.assertEqual(metrics["mae_days"], 4.333333)
        self.assertEqual(metrics["median_absolute_error_days"], 3.0)
        self.assertEqual(metrics["p90_absolute_error_days"], 8.6)
        self.assertEqual(metrics["within_3_days_fraction"], 0.666667)

    def test_hierarchical_baseline_groups_missing_profiles_with_sentinel(self) -> None:
        train = pd.DataFrame(
            [
                row("2025-01-01", 10, hospital_mo="A", bed_profile=None),
                row("2025-01-02", 20, hospital_mo="A", bed_profile=None),
            ]
            * 50
        )
        target = pd.DataFrame([row("2025-02-01", 1, hospital_mo="A", bed_profile=None)])
        prediction = hierarchical_median_predictions(train, target)
        self.assertEqual(prediction.tolist(), [15.0])


if __name__ == "__main__":
    unittest.main()
