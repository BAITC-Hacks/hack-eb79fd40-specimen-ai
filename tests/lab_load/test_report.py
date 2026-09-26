from __future__ import annotations

import copy
import unittest
from pathlib import Path
from typing import Any, ClassVar

from scripts.lab_load.build_blocker_report import build_report
from scripts.lab_load.io import read_json
from scripts.lab_load.verify_report import ReportFailure, verify_report


class BlockerReportTests(unittest.TestCase):
    valid: ClassVar[dict[str, Any]]
    audit: ClassVar[dict[str, Any]]

    @classmethod
    def setUpClass(cls) -> None:
        cls.valid = read_json(Path("reports/lab-load-v1.json"))
        cls.audit = read_json(Path("reports/lab-load-data-audit.json"))

    def test_builder_preserves_measured_referral_count_and_unknown_lab_count(self) -> None:
        report = build_report(self.audit)
        self.assertEqual(report["source"]["referral_rows"], 767_130)
        self.assertIsNone(report["source"]["laboratory_event_rows"])
        self.assertIsNone(report["temporal_benchmark"]["held_out_metrics"]["mae"])

    def test_accepts_honest_blocker(self) -> None:
        verify_report(self.valid)

    def test_rejects_fabricated_metric(self) -> None:
        report = copy.deepcopy(self.valid)
        report["temporal_benchmark"]["held_out_metrics"]["mae"] = 1.0
        with self.assertRaisesRegex(ReportFailure, "unsupported_metric_claim"):
            verify_report(report)

    def test_rejects_fabricated_lag(self) -> None:
        report = copy.deepcopy(self.valid)
        report["referral_flow_lag"]["correlation"] = 0.75
        with self.assertRaisesRegex(ReportFailure, "unsupported_correlation_claim"):
            verify_report(report)

    def test_rejects_runtime_activation(self) -> None:
        report = copy.deepcopy(self.valid)
        report["runtime_activation"] = "enabled"
        with self.assertRaisesRegex(ReportFailure, "runtime_must_be_blocked"):
            verify_report(report)

    def test_rejects_normative_proxy_as_observed_target(self) -> None:
        report = copy.deepcopy(self.valid)
        report["target"]["proxy_allowed"] = True
        with self.assertRaisesRegex(ReportFailure, "synthetic_proxy_must_be_rejected"):
            verify_report(report)

    def test_rejects_nested_sensitive_payload(self) -> None:
        report = copy.deepcopy(self.valid)
        report["target"]["row_data"] = [{"hospitalization_code": "must-not-appear"}]
        with self.assertRaisesRegex(ReportFailure, "sensitive_payload_key"):
            verify_report(report)


if __name__ == "__main__":
    unittest.main()
