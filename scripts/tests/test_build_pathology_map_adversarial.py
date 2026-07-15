from __future__ import annotations

import copy
import json
import unittest
from collections import Counter
from pathlib import Path

from scripts.build_pathology_map import build_rows, validate_rows

ROOT = Path(__file__).resolve().parents[2]


class PathologyMapAdversarialTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.model = json.loads(
            (ROOT / "models" / "triage-lr-v1.json").read_text(encoding="utf-8")
        )
        cls.class_order = cls.model["class_order"]
        cls.conditions = json.loads(
            (ROOT / "data" / "raw" / "release_conditions.json").read_text(
                encoding="utf-8"
            )
        )
        cls.rows = json.loads(
            (ROOT / "data" / "pathology_map.json").read_text(encoding="utf-8")
        )
        cls.report = json.loads(
            (ROOT / "reports" / "pathology_map_validation.json").read_text(
                encoding="utf-8"
            )
        )

    def test_runtime_schema_has_no_extra_fields(self) -> None:
        required = {
            "pathology",
            "label_ru",
            "specialty",
            "specialty_alt",
            "urgency",
            "validated",
        }
        allowed = required | {"icd10"}

        for row in self.rows:
            with self.subTest(pathology=row["pathology"]):
                self.assertTrue(required.issubset(row))
                self.assertEqual(set(row), allowed)
                self.assertNotIn("_meta", row)

    def test_rejects_class_and_source_drift(self) -> None:
        duplicate_class_order = [*self.class_order, self.class_order[0]]
        with self.assertRaisesRegex(ValueError, "class_order contains duplicates"):
            build_rows(duplicate_class_order, self.conditions)

        unknown_class_order = ["Invented pathology", *self.class_order[1:]]
        with self.assertRaisesRegex(ValueError, "route specs differ from class_order"):
            build_rows(unknown_class_order, self.conditions)

        duplicate_conditions = copy.deepcopy(self.conditions)
        duplicate_conditions["duplicate source row"] = copy.deepcopy(
            next(iter(self.conditions.values()))
        )
        with self.assertRaisesRegex(ValueError, "duplicate cond-name-eng"):
            build_rows(self.class_order, duplicate_conditions)

    def test_rejects_order_schema_and_alternative_route_drift(self) -> None:
        cases = []

        reordered = copy.deepcopy(self.rows)
        reordered[0], reordered[1] = reordered[1], reordered[0]
        cases.append((reordered, "exactly match class_order"))

        extra_field = copy.deepcopy(self.rows)
        extra_field[0]["_meta"] = {"review": "pending"}
        cases.append((extra_field, "schema mismatch"))

        unknown_alternative = copy.deepcopy(self.rows)
        unknown_alternative[0]["specialty_alt"] = ["онкология"]
        cases.append((unknown_alternative, "unknown value"))

        duplicated_alternative = copy.deepcopy(self.rows)
        duplicated_alternative[0]["specialty_alt"] = ["терапевт", "терапевт"]
        cases.append((duplicated_alternative, "contains duplicates"))

        main_as_alternative = copy.deepcopy(self.rows)
        main_as_alternative[0]["specialty_alt"] = [
            main_as_alternative[0]["specialty"]
        ]
        cases.append((main_as_alternative, "main specialty is duplicated"))

        omitted_icd10 = copy.deepcopy(self.rows)
        del omitted_icd10[0]["icd10"]
        cases.append((omitted_icd10, "source icd10-id was omitted"))

        for rows, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    validate_rows(rows, self.class_order, self.conditions)

    def test_report_distributions_and_unreviewed_limitations_match_rows(self) -> None:
        self.assertEqual(
            self.report["specialty_distribution"],
            dict(sorted(Counter(row["specialty"] for row in self.rows).items())),
        )
        self.assertEqual(
            self.report["urgency_distribution"],
            dict(sorted(Counter(row["urgency"] for row in self.rows).items())),
        )
        limitations = " ".join(self.report["limitations"])
        self.assertIn("validated=false", limitations)
        self.assertIn("не заявляются", limitations)
        self.assertIn("abstain", limitations)

    def test_emergency_rows_are_confined_to_source_severity_one_or_two(self) -> None:
        source_by_pathology = {
            value["cond-name-eng"]: value for value in self.conditions.values()
        }
        emergencies = [row for row in self.rows if row["urgency"] == "emergency"]

        self.assertEqual(len(emergencies), 10)
        self.assertTrue(
            all(source_by_pathology[row["pathology"]]["severity"] <= 2 for row in emergencies)
        )
        severity_one = {
            pathology
            for pathology in self.class_order
            if source_by_pathology[pathology]["severity"] == 1
        }
        emergency_pathologies = {row["pathology"] for row in emergencies}
        self.assertTrue(severity_one.issubset(emergency_pathologies))


if __name__ == "__main__":
    unittest.main()
