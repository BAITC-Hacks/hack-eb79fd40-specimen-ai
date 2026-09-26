from __future__ import annotations

import copy
import unittest
from pathlib import Path
from typing import Any, ClassVar

from scripts.lab_load.audit import classify_columns
from scripts.lab_load.contracts import EXPECTED_COLUMNS
from scripts.lab_load.io import read_json
from scripts.lab_load.verify_audit import AuditReportFailure, verify_audit


class FieldClassificationTests(unittest.TestCase):
    def test_frozen_referral_schema_has_context_but_no_lab_target(self) -> None:
        evidence = classify_columns(EXPECTED_COLUMNS)
        self.assertTrue(evidence["region"]["available"])
        self.assertTrue(evidence["period"]["available"])
        self.assertTrue(evidence["referral_flow"]["available"])
        self.assertFalse(evidence["laboratory_demand"]["available"])
        for group in evidence["laboratory_demand"]["required_groups"].values():
            self.assertEqual(group["present_fields"], [])

    def test_similar_but_ambiguous_names_do_not_unlock_target(self) -> None:
        evidence = classify_columns((*EXPECTED_COLUMNS, "analysis", "date", "count"))
        self.assertFalse(evidence["laboratory_demand"]["available"])


class AuditVerifierTests(unittest.TestCase):
    valid: ClassVar[dict[str, Any]]

    @classmethod
    def setUpClass(cls) -> None:
        cls.valid = read_json(Path("reports/lab-load-data-audit.json"))

    def test_accepts_committed_audit(self) -> None:
        verify_audit(self.valid)

    def test_rejects_invented_lab_availability(self) -> None:
        report = copy.deepcopy(self.valid)
        report["field_evidence"]["laboratory_demand"]["available"] = True
        with self.assertRaisesRegex(AuditReportFailure, "laboratory_target_must_be_absent"):
            verify_audit(report)

    def test_rejects_claimed_license(self) -> None:
        report = copy.deepcopy(self.valid)
        report["source"]["license_status"] = "open"
        with self.assertRaisesRegex(AuditReportFailure, "license_claim_mismatch"):
            verify_audit(report)

    def test_rejects_nested_sensitive_payload(self) -> None:
        report = copy.deepcopy(self.valid)
        report["coverage"]["patient_rows"] = [{"patient_id": "must-not-appear"}]
        with self.assertRaisesRegex(AuditReportFailure, "sensitive_payload_key"):
            verify_audit(report)


if __name__ == "__main__":
    unittest.main()
