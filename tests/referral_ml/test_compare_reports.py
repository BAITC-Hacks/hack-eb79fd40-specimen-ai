from __future__ import annotations

import unittest

from scripts.referral_ml.compare_reports import ComparisonFailure, semantic_report


class SemanticReportTests(unittest.TestCase):
    def test_ignores_only_per_artifact_serializer_hash(self) -> None:
        first = {"metric": 1.2, "model_artifact": {"sha256": "a", "bytes": 10}}
        second = {"metric": 1.2, "model_artifact": {"sha256": "b", "bytes": 10}}
        self.assertEqual(semantic_report(first), semantic_report(second))
        second["model_artifact"]["bytes"] = 11  # type: ignore[index]
        self.assertEqual(semantic_report(first), semantic_report(second))
        second["metric"] = 1.3
        self.assertNotEqual(semantic_report(first), semantic_report(second))

    def test_requires_artifact_hash(self) -> None:
        with self.assertRaisesRegex(ComparisonFailure, "missing_model_artifact_hash"):
            semantic_report({"metric": 1.2})


if __name__ == "__main__":
    unittest.main()
