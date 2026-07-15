from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from scripts.build_features import (
    decontaminate_digest_sets,
    iter_clean_unique,
    row_digest,
)


class BuildFeaturesDecontaminationTest(unittest.TestCase):
    def test_precedence_removes_every_pairwise_overlap(self) -> None:
        train = {b"train", b"shared-all", b"shared-train-test"}
        validate = {b"validate", b"shared-all", b"shared-validate-test"}
        test = {
            b"test",
            b"shared-all",
            b"shared-train-test",
            b"shared-validate-test",
        }

        accepted, report = decontaminate_digest_sets(
            {"train": train, "validate": validate, "test": test}
        )

        self.assertEqual(accepted["train"], train)
        self.assertEqual(accepted["validate"], {b"validate", b"shared-validate-test"})
        self.assertEqual(accepted["test"], {b"test"})
        self.assertEqual(
            report["removed_rows"],
            {"train": 0, "validate": 1, "test": 3},
        )
        self.assertEqual(
            report["pairwise_overlap_after"],
            {"train_validate": 0, "train_test": 0, "validate_test": 0},
        )

    def test_decontamination_is_deterministic(self) -> None:
        source = {
            "train": {b"a", b"b"},
            "validate": {b"b", b"c"},
            "test": {b"a", b"c", b"d"},
        }
        first = decontaminate_digest_sets(source)
        second = decontaminate_digest_sets(source)
        self.assertEqual(first, second)

    def test_csv_iterator_deduplicates_and_applies_exclusion(self) -> None:
        fieldnames = ["AGE", "SEX", "PATHOLOGY", "EVIDENCES"]
        rows = [
            {
                "AGE": "42",
                "SEX": "F",
                "PATHOLOGY": "A",
                "EVIDENCES": "['E_1']",
            },
            {
                "AGE": "42",
                "SEX": "F",
                "PATHOLOGY": "A",
                "EVIDENCES": "['E_1']",
            },
            {
                "AGE": "43",
                "SEX": "M",
                "PATHOLOGY": "B",
                "EVIDENCES": "['E_2']",
            },
        ]
        excluded_row = (42, "F", "A", "['E_1']")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "split.csv"
            with path.open("w", encoding="utf-8", newline="") as target:
                writer = csv.DictWriter(target, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)

            result = list(iter_clean_unique(path, {row_digest(excluded_row)}))

        self.assertEqual(result, [(43, "M", "B", "['E_2']")])


if __name__ == "__main__":
    unittest.main()
