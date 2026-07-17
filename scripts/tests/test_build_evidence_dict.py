from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.build_evidence_dict import (
    CURATED_BASE,
    CURATED_VALUES,
    build_dictionary,
    evidence_feature_keys,
    stable_json,
    validate_source,
    validate_dictionary,
)


class EvidenceDictionaryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.evidences = {
            code: {
                "name": code,
                "question_en": curated.question_en,
                "data_type": "B",
                "possible-values": [],
                "value_meaning": {},
            }
            for code, curated in CURATED_BASE.items()
        }
        self.evidences["E_300"] = {
            "name": "E_300",
            "question_en": "Which option applies?",
            "data_type": "C",
            "possible-values": [0, "V_2"],
            "value_meaning": {"V_2": {"en": "second"}},
        }
        self.feature_order = [
            "age_norm",
            "sex_m",
            "sex_f",
            *CURATED_BASE,
            "E_300@0",
            "E_300@V_2",
        ]

    def test_builds_union_of_base_codes_and_feature_keys(self) -> None:
        dictionary = build_dictionary(
            self.evidences, self.feature_order, "raw-hash", "model-hash"
        )
        report = validate_dictionary(dictionary, self.evidences, self.feature_order)

        expected = set(self.evidences) | {"E_300@0", "E_300@V_2"}
        self.assertEqual(set(dictionary) - {"_meta"}, expected)
        self.assertEqual(report["dictionary_entry_count"], len(expected))
        self.assertEqual(report["source_codes_missing"], [])
        self.assertEqual(report["feature_keys_missing"], [])
        for key in expected:
            with self.subTest(key=key):
                self.assertTrue(dictionary[key]["label_ru"])
                self.assertTrue(dictionary[key]["question_ru"])
                self.assertIn("data_type", dictionary[key])
                self.assertIn("possible_values", dictionary[key])

    def test_preserves_source_fields_and_marks_mechanical_entries(self) -> None:
        dictionary = build_dictionary(
            self.evidences, self.feature_order, "raw-hash", "model-hash"
        )

        entry = dictionary["E_300@V_2"]
        self.assertEqual(entry["name"], "E_300")
        self.assertEqual(entry["question_en"], "Which option applies?")
        self.assertEqual(entry["data_type"], "C")
        self.assertEqual(entry["possible_values"], [0, "V_2"])
        self.assertEqual(entry["feature_value"], "V_2")
        self.assertEqual(entry["value_en"], "second")
        self.assertEqual(entry["translation_status"], "mechanical_neutral")
        self.assertNotIn("Which option applies", entry["question_ru"])
        self.assertNotIn("second", entry["label_ru"])

    def test_rejects_unknown_evidence_feature(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown evidence"):
            evidence_feature_keys(
                ["age_norm", "sex_m", "sex_f", "E_999"], self.evidences
            )

    def test_rejects_unknown_possible_value(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown possible value"):
            evidence_feature_keys(
                ["age_norm", "sex_m", "sex_f", "E_300@V_999"], self.evidences
            )

    def test_rejects_missing_demographic_feature(self) -> None:
        with self.assertRaisesRegex(ValueError, "demographics differ"):
            evidence_feature_keys(["age_norm", "sex_m", *CURATED_BASE], self.evidences)

    def test_curated_translations_are_pinned_to_the_checked_in_release(self) -> None:
        release_path = (
            Path(__file__).resolve().parents[2]
            / "data"
            / "raw"
            / "release_evidences.json"
        )
        release = json.loads(release_path.read_text(encoding="utf-8"))

        validate_source(release)
        for code, curated in CURATED_BASE.items():
            with self.subTest(code=code):
                self.assertEqual(release[code]["question_en"], curated.question_en)
        for feature, curated in CURATED_VALUES.items():
            code, value = feature.split("@", 1)
            with self.subTest(feature=feature):
                self.assertEqual(
                    release[code]["value_meaning"][value]["en"],
                    curated.value_en,
                )

    def test_rejects_stale_curated_question_and_value_meaning(self) -> None:
        release_path = (
            Path(__file__).resolve().parents[2]
            / "data"
            / "raw"
            / "release_evidences.json"
        )
        release = json.loads(release_path.read_text(encoding="utf-8"))
        stale_question = json.loads(json.dumps(release))
        stale_question["E_218"]["question_en"] = "Changed upstream question"
        with self.assertRaisesRegex(ValueError, "curated translation is stale"):
            validate_source(stale_question)

        stale_value = json.loads(json.dumps(release))
        stale_value["E_54"]["value_meaning"]["V_183"]["en"] = "changed"
        with self.assertRaisesRegex(ValueError, "curated value is stale"):
            build_dictionary(
                stale_value,
                json.loads(
                    (
                        Path(__file__).resolve().parents[2]
                        / "models"
                        / "triage-lr-v1.json"
                    ).read_text(encoding="utf-8")
                )["feature_order"],
                "raw-hash",
                "model-hash",
            )

    def test_output_is_stable_and_utf8(self) -> None:
        first = build_dictionary(
            self.evidences, self.feature_order, "raw-hash", "model-hash"
        )
        second = build_dictionary(
            self.evidences, list(self.feature_order), "raw-hash", "model-hash"
        )

        self.assertEqual(stable_json(first), stable_json(second))
        self.assertIn("боль в груди", stable_json(first))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dictionary.json"
            path.write_text(stable_json(first), encoding="utf-8")
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), first)


if __name__ == "__main__":
    unittest.main()
