from __future__ import annotations

import json
import math
import os
import unittest
from pathlib import Path

from scripts.referral_ml.export_referral_risk import (
    EXPECTED_INPUT_SHA256,
    EXPECTED_JOBLIB_SHA256,
    EXPECTED_REPORT_SHA256,
    export_artifact,
)
from scripts.referral_ml.io import sha256_file

ROOT = Path(__file__).resolve().parents[2]
MODEL = Path(
    os.environ.get(
        "DEMEU_REFERRAL_RISK_JOBLIB",
        ROOT / "data/processed/referral-refusal-baseline-v0.joblib",
    )
)
REPORT = ROOT / "reports/referral-refusal-baseline-v0.json"
ARTIFACT = ROOT / "models/referral-risk-v1.json"
PARITY = ROOT / "reports/referral-risk-parity.json"
FIXTURE = ROOT / "tests/fixtures/referral-risk-v1.json"


class ReferralRiskExportTests(unittest.TestCase):
    @unittest.skipUnless(
        MODEL.is_file(),
        "trusted source joblib unavailable; set DEMEU_REFERRAL_RISK_JOBLIB",
    )
    def test_trusted_source_reproduces_runtime_contract(self) -> None:
        self.assertEqual(sha256_file(MODEL), EXPECTED_JOBLIB_SHA256)
        self.assertEqual(sha256_file(REPORT), EXPECTED_REPORT_SHA256)
        expected = export_artifact(MODEL, REPORT)
        tracked = json.loads(ARTIFACT.read_text(encoding="utf-8"))
        self.assertEqual(expected, tracked)

    def test_tracked_artifact_is_exact_and_privacy_safe(self) -> None:
        tracked = json.loads(ARTIFACT.read_text(encoding="utf-8"))
        self.assertEqual(tracked["provenance"]["inputSha256"], EXPECTED_INPUT_SHA256)
        self.assertEqual(
            [len(field["frequent"]) for field in tracked["classifier"]["fields"]],
            [91, 896, 897, 1074, 2, 3, 10],
        )
        self.assertEqual(
            sum(len(field["frequent"]) for field in tracked["classifier"]["fields"]),
            2973,
        )
        self.assertEqual(len(tracked["oracle"]["cases"]), 17)
        self.assertEqual(
            tracked["privacy"],
            {
                "containsRowData": False,
                "containsIdentifiers": False,
                "containsCategoryValues": False,
                "categoryRepresentation": "sha256_dictionary_matchable_tokens",
            },
        )
        serialized = ARTIFACT.read_text(encoding="utf-8")
        self.assertNotIn("hospitalization_code", serialized)
        self.assertNotIn('"category":', serialized)

    def test_oracle_is_finite_and_covers_every_runtime_fallback(self) -> None:
        artifact = json.loads(ARTIFACT.read_text(encoding="utf-8"))
        cases = artifact["oracle"]["cases"]
        self.assertTrue(
            all(
                math.isfinite(case["expected"][key])
                for case in cases
                for key in ("logit", "probability")
            )
        )
        names = {case["name"] for case in cases}
        self.assertEqual(len([name for name in names if name.startswith("frequent_")]), 7)
        self.assertEqual(len([name for name in names if name.startswith("infrequent_")]), 4)
        self.assertEqual(len([name for name in names if name.startswith("zero_")]), 3)
        self.assertIn("missing_bed_profile", names)
        self.assertEqual(
            {case["expected"]["riskBand"] for case in cases},
            {"below_working_threshold", "at_or_above_working_threshold"},
        )

    def test_tracked_proofs_bind_same_artifact_and_real_ts_scorer(self) -> None:
        parity = json.loads(PARITY.read_text(encoding="utf-8"))
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        artifact_sha = sha256_file(ARTIFACT)
        self.assertEqual(parity["artifactSha256"], artifact_sha)
        self.assertEqual(fixture["artifactSha256"], artifact_sha)
        self.assertEqual(parity["pythonTsRuntimeParity"]["rows"], 223353)
        self.assertLessEqual(
            parity["pythonTsRuntimeParity"]["maximumAbsoluteProbabilityDelta"],
            1e-12,
        )
        self.assertEqual(parity["pythonTsRuntimeParity"]["riskBandMismatches"], 0)
        self.assertTrue(parity["pythonTsRuntimeParity"]["passed"])
        self.assertFalse(parity["source"]["containsRowData"])
        self.assertFalse(parity["source"]["containsIdentifiers"])
        self.assertFalse(parity["source"]["containsCategoryValues"])


if __name__ == "__main__":
    unittest.main()
