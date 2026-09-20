from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.referral_ml.train_wait import validate_model_output


class ModelOutputPolicyTests(unittest.TestCase):
    def test_allows_ignored_data_processed_and_system_temp(self) -> None:
        private = Path.cwd() / "data" / "processed" / "model.joblib"
        self.assertEqual(validate_model_output(private), private.resolve())
        temporary = Path(tempfile.gettempdir()) / "model.joblib"
        self.assertEqual(validate_model_output(temporary), temporary.resolve())

    def test_rejects_trackable_or_wrong_suffix_output(self) -> None:
        with self.assertRaisesRegex(ValueError, "private_or_temporary"):
            validate_model_output(Path.cwd() / "reports" / "model.joblib")
        with self.assertRaisesRegex(ValueError, "must_be_joblib"):
            validate_model_output(Path(tempfile.gettempdir()) / "model.json")


if __name__ == "__main__":
    unittest.main()
