from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from scripts.build_pathology_map import (
    CARDIAC_CHEST_CLASSES,
    ROUTE_SPECS,
    ROUTING_AGGREGATION,
    SPECIALTIES,
    URGENCIES,
    build_rows,
    validate_rows,
)

ROOT = Path(__file__).resolve().parents[2]


class PathologyMapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        model = json.loads(
            (ROOT / "models" / "triage-lr-v1.json").read_text(encoding="utf-8")
        )
        cls.class_order = model["class_order"]
        cls.conditions = json.loads(
            (ROOT / "data" / "raw" / "release_conditions.json").read_text(
                encoding="utf-8"
            )
        )
        cls.rows = build_rows(cls.class_order, cls.conditions)
        cls.artifact_rows = json.loads(
            (ROOT / "data" / "pathology_map.json").read_text(encoding="utf-8")
        )

    def test_rows_exactly_match_adult_class_order(self) -> None:
        self.assertEqual(len(self.class_order), 47)
        self.assertEqual(len(ROUTE_SPECS), 47)
        self.assertEqual([row["pathology"] for row in self.rows], self.class_order)
        self.assertEqual(self.artifact_rows, self.rows)
        self.assertNotIn("Croup", {row["pathology"] for row in self.rows})
        self.assertNotIn("Bronchiolitis", {row["pathology"] for row in self.rows})

    def test_schema_closed_values_and_unreviewed_state(self) -> None:
        report = validate_rows(self.rows, self.class_order, self.conditions)

        self.assertEqual(report["row_count"], 47)
        self.assertTrue(report["all_validated_false"])
        self.assertEqual(report["routing_aggregation"], ROUTING_AGGREGATION)
        self.assertEqual(report["routing_aggregation"], "sum")
        for row in self.rows:
            with self.subTest(pathology=row["pathology"]):
                self.assertTrue(row["label_ru"].strip())
                self.assertIn(row["specialty"], SPECIALTIES)
                self.assertIn(row["urgency"], URGENCIES)
                self.assertIs(row["validated"], False)
                self.assertNotIn(row["specialty"], row["specialty_alt"])
                self.assertEqual(len(row["specialty_alt"]), len(set(row["specialty_alt"])))

    def test_all_icd10_values_are_exact_source_copies(self) -> None:
        report = validate_rows(self.rows, self.class_order, self.conditions)

        self.assertEqual(report["icd10_count"], 47)
        source_by_pathology = {
            value["cond-name-eng"]: value["icd10-id"]
            for value in self.conditions.values()
        }
        for row in self.rows:
            with self.subTest(pathology=row["pathology"]):
                self.assertEqual(row["icd10"], source_by_pathology[row["pathology"]])

    def test_cardiac_chest_routes_are_urgent_or_emergency(self) -> None:
        by_pathology = {row["pathology"]: row for row in self.rows}

        for pathology in CARDIAC_CHEST_CLASSES:
            with self.subTest(pathology=pathology):
                row = by_pathology[pathology]
                routes = {row["specialty"], *row["specialty_alt"]}
                self.assertTrue(routes & {"кардиология", "скорая/приёмный покой"})
                self.assertIn(row["urgency"], {"urgent", "emergency"})

    def test_low_back_is_honestly_outside_class_order(self) -> None:
        report = validate_rows(self.rows, self.class_order, self.conditions)

        self.assertEqual(report["low_back_classes"], [])
        self.assertTrue(
            any("abstain" in limitation for limitation in report["limitations"])
        )

    def test_rejects_invented_icd10(self) -> None:
        rows = copy.deepcopy(self.rows)
        rows[0]["icd10"] = "INVENTED"

        with self.assertRaisesRegex(ValueError, "byte-for-byte source copy"):
            validate_rows(rows, self.class_order, self.conditions)

    def test_rejects_doctor_validation_claim(self) -> None:
        rows = copy.deepcopy(self.rows)
        rows[0]["validated"] = True

        with self.assertRaisesRegex(ValueError, "validated must remain false"):
            validate_rows(rows, self.class_order, self.conditions)

    def test_rejects_unknown_specialty_and_urgency(self) -> None:
        for field, value, message in (
            ("specialty", "онкология", "unknown specialty"),
            ("urgency", "soon", "invalid urgency"),
        ):
            with self.subTest(field=field):
                rows = copy.deepcopy(self.rows)
                rows[0][field] = value
                with self.assertRaisesRegex(ValueError, message):
                    validate_rows(rows, self.class_order, self.conditions)


if __name__ == "__main__":
    unittest.main()
