from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import pandas as pd  # type: ignore[import-untyped]

from scripts.referral_ml.audit import AuditFailure, audit_parquet


class AuditTests(unittest.TestCase):
    def test_rejects_unknown_file_hash_before_reporting_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "unknown.parquet"
            pd.DataFrame({"private": ["must-not-appear"]}).to_parquet(path)
            with self.assertRaisesRegex(AuditFailure, "input_sha256_mismatch"):
                audit_parquet(path)

    def test_rejects_missing_input_with_safe_code(self) -> None:
        with self.assertRaisesRegex(AuditFailure, "input_missing"):
            audit_parquet(Path("/definitely/missing/referrals.parquet"))


if __name__ == "__main__":
    unittest.main()
