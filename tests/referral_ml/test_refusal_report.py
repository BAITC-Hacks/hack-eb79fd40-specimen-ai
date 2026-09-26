from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from scripts.referral_ml.compare_reports import semantic_report_sha256
from scripts.referral_ml.refusal_contracts import EXPECTED_SEMANTIC_REPORT_SHA256
from scripts.referral_ml.verify_refusal_report import (
    RefusalReportFailure,
    verify_refusal_report,
)

REPORT_PATH = Path("reports/referral-refusal-baseline-v0.json")
MODEL_PATH = Path("data/processed/referral-refusal-baseline-v0.joblib")


class RefusalReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))

    def test_accepts_published_aggregate_report(self) -> None:
        verify_refusal_report(copy.deepcopy(self.report), MODEL_PATH)

    def test_held_out_methods_publish_the_same_complete_metric_set(self) -> None:
        self.assertEqual(self.report["split"]["test"]["period"], "2025-03")
        self.assertEqual(self.report["split"]["test"]["rows"], 223_353)
        required_metrics = {
            "rows",
            "positives",
            "prevalence",
            "pr_auc",
            "roc_auc",
            "brier",
            "threshold",
            "predicted_positive",
            "precision",
            "recall",
            "f1",
        }
        for method in (
            "constant_baseline",
            "smoothed_pair_baseline",
            "one_hot_logistic_regression",
        ):
            evaluation = self.report["test"][method]
            self.assertEqual(set(evaluation["metrics"]), required_metrics)
            self.assertEqual(evaluation["metrics"]["rows"], 223_353)
            self.assertEqual(evaluation["calibration_deciles"]["requested_bins"], 10)

    def test_rejects_report_without_roc_auc_for_any_comparator(self) -> None:
        for method in (
            "constant_baseline",
            "smoothed_pair_baseline",
            "one_hot_logistic_regression",
        ):
            report = copy.deepcopy(self.report)
            del report["test"][method]["metrics"]["roc_auc"]
            with self.subTest(method=method), self.assertRaisesRegex(
                RefusalReportFailure, "invalid_keys:test"
            ):
                verify_refusal_report(report)

    def test_rejects_leaky_feature_contract(self) -> None:
        report = copy.deepcopy(self.report)
        report["features"]["included"].append("plan_lead_days")
        with self.assertRaisesRegex(RefusalReportFailure, "invalid_feature_contract"):
            verify_refusal_report(report)

    def test_rejects_raw_rows_even_when_privacy_flags_are_false(self) -> None:
        report = copy.deepcopy(self.report)
        report["raw_rows"] = [{"value": "must-not-be-here"}]
        with self.assertRaisesRegex(RefusalReportFailure, "sensitive_payload"):
            verify_refusal_report(report)

    def test_published_semantics_match_frozen_fingerprint(self) -> None:
        self.assertEqual(
            semantic_report_sha256(self.report), EXPECTED_SEMANTIC_REPORT_SHA256
        )

    def test_rejects_controlled_heldout_metric_mutations(self) -> None:
        for method in (
            "constant_baseline",
            "smoothed_pair_baseline",
            "one_hot_logistic_regression",
        ):
            for metric in ("pr_auc", "roc_auc", "brier"):
                report = copy.deepcopy(self.report)
                report["test"][method]["metrics"][metric] += 0.000001
                with self.subTest(method=method, metric=metric), self.assertRaisesRegex(
                    RefusalReportFailure, "semantic_report_fingerprint_mismatch"
                ):
                    verify_refusal_report(report)

    def test_rejects_controlled_validation_metric_mutations(self) -> None:
        for metric in ("pr_auc", "roc_auc", "brier"):
            report = copy.deepcopy(self.report)
            report["selection"]["constant_baseline"]["metrics"][metric] += 0.000001
            with self.subTest(metric=metric), self.assertRaisesRegex(
                RefusalReportFailure, "semantic_report_fingerprint_mismatch"
            ):
                verify_refusal_report(report)

    def test_rejects_decision_that_disagrees_with_validation_selection(self) -> None:
        report = copy.deepcopy(self.report)
        report["decision"]["selected_candidate"] = "smoothed_pair_baseline"
        with self.assertRaisesRegex(RefusalReportFailure, "invalid_decision"):
            verify_refusal_report(report)

    def test_rejects_final_family_selection_marked_as_test_based(self) -> None:
        report = copy.deepcopy(self.report)
        report["selection"]["final_comparator_selection"]["test_used"] = True
        with self.assertRaisesRegex(
            RefusalReportFailure, "final_candidate_selection_mismatch"
        ):
            verify_refusal_report(report)

    def test_duplicate_audit_is_frozen_and_label_agnostic(self) -> None:
        audit = self.report["cohort"]["duplicate_audit"]
        self.assertEqual(audit["unique_hospitalization_codes"], 765_161)
        self.assertEqual(audit["repeated_hospitalization_codes"], 1_969)
        self.assertEqual(audit["rows_with_repeated_hospitalization_code"], 3_938)
        self.assertEqual(audit["is_refused_conflicting_codes"], 6)
        self.assertEqual(audit["hospitalized_conflicting_codes"], 5)
        self.assertFalse(audit["selection_uses_target_or_timestamp"])

    def test_rejects_unverified_source_reported_as_verified(self) -> None:
        report = copy.deepcopy(self.report)
        report["source"]["license_status"] = "verified"
        with self.assertRaisesRegex(RefusalReportFailure, "invalid_source_provenance"):
            verify_refusal_report(report)

    def test_rejects_leakage_in_presentation_inputs(self) -> None:
        report = copy.deepcopy(self.report)
        report["presentation_contract"]["input_fields"].append("planned_date")
        with self.assertRaisesRegex(RefusalReportFailure, "invalid_presentation_contract"):
            verify_refusal_report(report)

    def test_rejects_unexpected_source_payload(self) -> None:
        report = copy.deepcopy(self.report)
        report["source"]["raw_dump"] = "hidden"
        with self.assertRaisesRegex(RefusalReportFailure, "sensitive_payload"):
            verify_refusal_report(report)

    def test_rejects_category_values_anywhere(self) -> None:
        report = copy.deepcopy(self.report)
        report["selection"]["category_values"] = ["hospital-1"]
        with self.assertRaisesRegex(RefusalReportFailure, "sensitive_payload"):
            verify_refusal_report(report)

    def test_rejects_unexpected_nested_field(self) -> None:
        report = copy.deepcopy(self.report)
        report["privacy"]["note"] = "unexpected"
        with self.assertRaisesRegex(RefusalReportFailure, "invalid_keys:privacy"):
            verify_refusal_report(report)

    def test_rejects_test_based_selection(self) -> None:
        report = copy.deepcopy(self.report)
        report["selection"]["primary_metric"] = "test_pr_auc"
        with self.assertRaisesRegex(
            RefusalReportFailure, "test_based_or_unknown_selection"
        ):
            verify_refusal_report(report)

    def test_rejects_nonconverged_selected_candidate(self) -> None:
        report = copy.deepcopy(self.report)
        selected_c = report["selection"]["selected_model"]["c"]
        selected = next(
            item
            for item in report["selection"]["model_candidates"]
            if item["c"] == selected_c
        )
        selected["optimization"]["iterations"] = selected["optimization"][
            "max_iterations"
        ]
        selected["optimization"]["converged"] = False
        with self.assertRaisesRegex(
            RefusalReportFailure, "model_candidate_selection_mismatch"
        ):
            verify_refusal_report(report)

    def test_rejects_test_partition_used_for_selection(self) -> None:
        report = copy.deepcopy(self.report)
        report["split"]["test"]["used_for_selection"] = True
        with self.assertRaisesRegex(RefusalReportFailure, "test_selection_leakage"):
            verify_refusal_report(report)

    def test_rejects_rounded_threshold_substitution(self) -> None:
        report = copy.deepcopy(self.report)
        report["test"]["one_hot_logistic_regression"]["metrics"]["threshold"] = round(
            report["test"]["one_hot_logistic_regression"]["metrics"]["threshold"],
            4,
        )
        with self.assertRaisesRegex(
            RefusalReportFailure, "model_threshold_not_from_validation"
        ):
            verify_refusal_report(report)

    def test_rejects_artifact_metadata_mismatch(self) -> None:
        report = copy.deepcopy(self.report)
        report["model_artifact"]["selected_c"] = 999.0
        with self.assertRaisesRegex(
            RefusalReportFailure, "invalid_artifact_policy_or_metadata"
        ):
            verify_refusal_report(report)


if __name__ == "__main__":
    unittest.main()
