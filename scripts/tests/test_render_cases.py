from __future__ import annotations

import ast
import csv
import hashlib
import json
import re
import sys
import unittest
from collections import Counter
from pathlib import Path

from scripts.build_features import clean_row, parse_evidences, row_digest
from scripts.render_cases import (
    canonical_json,
    file_sha256,
    source_row_hash,
    validate_phrase_source,
)

ROOT = Path(__file__).resolve().parents[2]
CASES_PATH = ROOT / "eval" / "cases.jsonl"
MANIFEST_PATH = ROOT / "eval" / "manifest.json"


def load_cases() -> list[dict]:
    return [
        json.loads(line) for line in CASES_PATH.read_text(encoding="utf-8").splitlines()
    ]


class RenderCasesTest(unittest.TestCase):
    def test_committed_set_has_canonical_composition_and_provenance(self) -> None:
        cases = load_cases()
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        artifact = json.loads(
            (ROOT / "models" / "triage-lr-v1.json").read_text(encoding="utf-8")
        )
        ddx = [case for case in cases if case["kind"] in {"flat", "dialog"}]

        self.assertEqual(len(cases), 48)
        self.assertEqual(
            Counter(case["kind"] for case in cases),
            {"flat": 28, "dialog": 12, "redflag": 8},
        )
        self.assertEqual(len(ddx), 40)
        self.assertEqual(len({case["gold"]["pathology"] for case in ddx}), 40)
        self.assertTrue(
            {case["gold"]["pathology"] for case in ddx}.issubset(
                set(artifact["class_order"])
            )
        )
        redflag = [case for case in cases if case["kind"] == "redflag"]
        self.assertEqual(
            Counter(case["gold"]["emergency_expected"] for case in redflag),
            {True: 5, False: 3},
        )
        self.assertEqual(len({case["id"] for case in cases}), 48)
        self.assertEqual(
            len({case["provenance"]["identity_digest_blake2b16"] for case in ddx}),
            40,
        )
        self.assertEqual(manifest["artifact"]["path"], "eval/cases.jsonl")
        self.assertEqual(manifest["artifact"]["sha256"], file_sha256(CASES_PATH))
        self.assertEqual(manifest["selection"]["count"], 48)
        self.assertEqual(manifest["coverage"]["class_count"], 40)
        self.assertEqual(manifest["coverage"]["model_label_space_count"], 47)
        self.assertEqual(manifest["coverage"]["evidence_types"], ["B", "C", "M"])
        self.assertEqual(manifest["sets"]["P"]["count"], 5)
        self.assertEqual(manifest["sets"]["N"]["count"], 3)
        self.assertFalse(manifest["sets"]["F"]["included_in_cases"])
        phrase_dependency = manifest["dependencies"]["evidence_phrases"]
        self.assertEqual(
            phrase_dependency["sha256"],
            file_sha256(ROOT / phrase_dependency["path"]),
        )
        self.assertEqual(
            sum(phrase_dependency["source_counts"].values()),
            phrase_dependency["selected_key_count"],
        )
        self.assertGreater(phrase_dependency["source_counts"]["manual_reviewed"], 0)
        self.assertGreater(
            phrase_dependency["source_counts"]["deterministic_generator"], 0
        )
        self.assertEqual(
            manifest["source"]["input_sha256"],
            {
                split: file_sha256(
                    ROOT / "data" / "raw" / f"release_{split}_patients.csv"
                )
                for split in ("train", "validate", "test")
            },
        )
        self.assertFalse(manifest["methodology"]["llm_used_for_generation_or_labeling"])
        self.assertTrue(manifest["methodology"]["manual_case_labeling"])
        self.assertEqual(
            manifest["methodology"]["manual_case_labeling_scope"],
            "five positive and three negative safety cards only",
        )
        self.assertEqual(manifest["methodology"]["pii_fields"], [])
        self.assertFalse((ROOT / "scripts" / "make_eval.py").exists())
        self.assertFalse((ROOT / "data" / "eval").exists())

    def test_cards_copy_exact_source_gold_and_do_not_overlap_train_or_validate(
        self,
    ) -> None:
        cases = load_cases()
        ddx = [case for case in cases if case["kind"] in {"flat", "dialog"}]
        by_raw_index = {case["provenance"]["raw_row_index"]: case for case in ddx}
        selected_digests = {
            bytes.fromhex(case["provenance"]["identity_digest_blake2b16"])
            for case in ddx
        }
        found: set[int] = set()
        csv.field_size_limit(sys.maxsize)
        with (ROOT / "data" / "raw" / "release_test_patients.csv").open(
            encoding="utf-8", newline=""
        ) as source:
            for raw_index, raw in enumerate(csv.DictReader(source)):
                case = by_raw_index.get(raw_index)
                if case is None:
                    continue
                cleaned = clean_row(raw)
                self.assertIsNotNone(cleaned)
                assert cleaned is not None
                gold = case["gold"]
                self.assertEqual(
                    row_digest(cleaned).hex(),
                    case["provenance"]["identity_digest_blake2b16"],
                )
                self.assertEqual(
                    source_row_hash(raw), case["provenance"]["source_row_sha256"]
                )
                self.assertEqual(cleaned[0], gold["age"])
                self.assertEqual("m" if cleaned[1] == "M" else "f", gold["sex"])
                self.assertEqual(cleaned[2], gold["pathology"])
                expected_evidences = [
                    {"code": code} if value is None else {"code": code, "value": value}
                    for code, value in parse_evidences(cleaned[3])
                ]
                self.assertEqual(expected_evidences, gold["evidences"])
                differential = ast.literal_eval(raw["DIFFERENTIAL_DIAGNOSIS"])
                self.assertEqual(
                    [item[0] for item in differential], gold["differential"]
                )
                self.assertEqual(raw["INITIAL_EVIDENCE"], gold["initial_evidence"])
                found.add(raw_index)
        self.assertEqual(found, set(by_raw_index))

        class_order = set(
            json.loads(
                (ROOT / "models" / "triage-lr-v1.json").read_text(encoding="utf-8")
            )["class_order"]
        )
        for split in ("train", "validate"):
            with (ROOT / "data" / "raw" / f"release_{split}_patients.csv").open(
                encoding="utf-8", newline=""
            ) as source:
                for raw in csv.DictReader(source):
                    cleaned = clean_row(raw)
                    if cleaned is None or cleaned[2] not in class_order:
                        continue
                    self.assertNotIn(row_digest(cleaned), selected_digests)

    def test_russian_text_comes_from_frozen_selected_phrases(self) -> None:
        cases = [case for case in load_cases() if case["kind"] in {"flat", "dialog"}]
        phrase_source = json.loads(
            (ROOT / "data" / "evidence_phrases_ru.json").read_text(encoding="utf-8")
        )
        phrases = phrase_source["phrases"]
        for case in cases:
            with self.subTest(case=case["id"]):
                user_text = " ".join(
                    message["content"]
                    for message in case["messages"]
                    if message["role"] == "user"
                )
                self.assertRegex(user_text, re.compile(r"[А-Яа-яЁё]"))
                self.assertNotIn(case["gold"]["pathology"], user_text)
                for item in case["gold"]["evidences"]:
                    key = item["code"]
                    if "value" in item:
                        key = f"{key}@{item['value']}"
                    self.assertIn(phrases[key]["text"], user_text)
                self.assertEqual(
                    case["gold"]["origins"]["pathology_map_unvalidated"],
                    ["specialty_set", "urgency", "emergency_expected"],
                )

    def test_selected_phrase_source_fails_loud(self) -> None:
        required = {"E_1", "E_2@V_1"}
        metadata = {
            "frozen": True,
            "selected_key_count": 2,
            "source_counts": {"deterministic_generator": 1, "manual_reviewed": 1},
            "generation": {"deterministic": True},
            "manual_review": {"status": "partial"},
        }
        valid = {
            "_meta": metadata,
            "phrases": {
                "E_1": {"text": "Фраза", "source": "manual_reviewed"},
                "E_2@V_1": {
                    "text": "Значение",
                    "source": "deterministic_generator",
                },
            },
        }
        self.assertEqual(set(validate_phrase_source(valid, required)[0]), required)

        for phrases in (
            {"E_1": {"text": "Фраза", "source": "manual_reviewed"}},
            {
                **valid["phrases"],
                "E_UNKNOWN": {
                    "text": "Лишнее",
                    "source": "deterministic_generator",
                },
            },
        ):
            with self.subTest(keys=sorted(phrases)):
                with self.assertRaises(KeyError):
                    validate_phrase_source(
                        {"_meta": metadata, "phrases": phrases}, required
                    )
        with self.assertRaises(ValueError):
            validate_phrase_source(
                {
                    "_meta": metadata,
                    "phrases": {
                        **valid["phrases"],
                        "E_1": {"text": "", "source": "manual_reviewed"},
                    },
                },
                required,
            )

    def test_jsonl_is_canonical_and_manifest_tracks_renderer(self) -> None:
        cases = load_cases()
        expected = "\n".join(canonical_json(case) for case in cases) + "\n"
        self.assertEqual(CASES_PATH.read_text(encoding="utf-8"), expected)
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            manifest["dependencies"]["renderer"]["sha256"],
            hashlib.sha256(
                (ROOT / "scripts" / "render_cases.py").read_bytes()
            ).hexdigest(),
        )


if __name__ == "__main__":
    unittest.main()
