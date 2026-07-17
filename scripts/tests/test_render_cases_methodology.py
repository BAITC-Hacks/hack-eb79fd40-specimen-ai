from __future__ import annotations

import hashlib
import json
import unittest
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CASES_PATH = ROOT / "eval" / "cases.jsonl"
MANIFEST_PATH = ROOT / "eval" / "manifest.json"


def load_cases() -> list[dict]:
    return [
        json.loads(line)
        for line in CASES_PATH.read_text(encoding="utf-8").splitlines()
    ]


class RenderCasesMethodologyTest(unittest.TestCase):
    def test_only_the_forty_ddx_cards_use_held_out_native_gold(self) -> None:
        cases = load_cases()
        ddx = [case for case in cases if case["kind"] in {"flat", "dialog"}]

        self.assertEqual(len(ddx), 40)
        self.assertEqual(Counter(case["kind"] for case in ddx), {"flat": 28, "dialog": 12})
        self.assertGreaterEqual(len({case["gold"]["pathology"] for case in ddx}), 40)
        self.assertTrue(
            all(case["provenance"]["dataset"] == "DDXPlus" for case in ddx)
        )
        self.assertTrue(
            all(case["provenance"]["split"] == "decontaminated_test" for case in ddx)
        )
        self.assertTrue(all(case["gold"]["pathology"] is not None for case in ddx))

    def test_redflag_cards_are_eight_handwritten_fixtures_not_relabelled_ddx_rows(self) -> None:
        redflags = [case for case in load_cases() if case["kind"] == "redflag"]

        self.assertEqual(len(redflags), 8)
        self.assertEqual(len({case["id"] for case in redflags}), 8)
        for case in redflags:
            with self.subTest(case=case["id"]):
                self.assertIsNone(case["gold"]["pathology"])
                self.assertNotIn("raw_row_index", case["provenance"])
                provenance = json.dumps(
                    case["provenance"], ensure_ascii=False
                ).lower()
                self.assertTrue(
                    "manual" in provenance
                    or "handwritten" in provenance
                    or "рукопис" in provenance
                )

    def test_manual_p_and_n_have_concrete_expected_codes_and_exact_negative_families(self) -> None:
        redflags = [case for case in load_cases() if case["kind"] == "redflag"]
        positives = [
            case for case in redflags if case["gold"]["emergency_expected"] is True
        ]
        negatives = [
            case for case in redflags if case["gold"]["emergency_expected"] is False
        ]

        self.assertEqual(len(positives), 5)
        self.assertEqual(len(negatives), 3)
        self.assertTrue(
            all(
                isinstance(case["gold"].get("red_flag_codes"), list)
                and case["gold"]["red_flag_codes"]
                for case in positives
            )
        )
        self.assertTrue(
            all(case["gold"].get("red_flag_codes") == [] for case in negatives)
        )

        user_texts = [
            " ".join(
                message["content"].lower()
                for message in case["messages"]
                if message["role"] == "user"
            )
            for case in negatives
        ]
        self.assertTrue(
            any("не болит" in text and "одышки нет" in text for text in user_texts)
        )
        self.assertTrue(
            any("волнен" in text and "боли нет" in text for text in user_texts)
        )
        self.assertTrue(
            any(
                any(
                    message["role"] == "assistant"
                    and "болит ли груд" in message["content"].lower()
                    for message in case["messages"]
                )
                and all(
                    "болит" not in message["content"].lower()
                    for message in case["messages"]
                    if message["role"] == "user"
                )
                for case in negatives
            )
        )

    def test_manifest_separates_manual_p_n_from_unit_f_and_tracks_phrase_source(self) -> None:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        phrase_dependency = manifest["dependencies"].get("evidence_phrases")

        self.assertEqual(manifest["sets"]["P"]["count"], 5)
        self.assertEqual(manifest["sets"]["N"]["count"], 3)
        self.assertTrue(
            manifest["sets"]["P"]["label_source"].startswith("manual")
        )
        self.assertTrue(
            manifest["sets"]["N"]["label_source"].startswith("manual")
        )
        self.assertFalse(manifest["sets"]["F"]["included_in_cases"])
        self.assertIsInstance(phrase_dependency, dict)
        self.assertEqual(
            phrase_dependency["path"], "data/evidence_phrases_ru.json"
        )
        self.assertTrue((ROOT / phrase_dependency["path"]).is_file())

    def test_selected_phrase_source_exactly_matches_native_selected_evidences(self) -> None:
        ddx = [
            case
            for case in load_cases()
            if case["kind"] in {"flat", "dialog"}
        ]
        required = {
            item["code"]
            if "value" not in item
            else f"{item['code']}@{item['value']}"
            for case in ddx
            for item in case["gold"]["evidences"]
        }
        phrase_path = ROOT / "data" / "evidence_phrases_ru.json"
        phrase_source = json.loads(phrase_path.read_text(encoding="utf-8"))
        phrases = phrase_source["phrases"]
        dictionary = json.loads(
            (ROOT / "data" / "evidences_ru.json").read_text(encoding="utf-8")
        )
        dictionary_meta = dictionary["_meta"]
        curated_base = set(dictionary_meta["curated_base_codes"])
        curated_features = set(dictionary_meta["curated_feature_keys"])

        self.assertEqual(len(required), 321)
        self.assertEqual(set(phrases), required)
        self.assertEqual(
            Counter(entry["source"] for entry in phrases.values()),
            {"manual_reviewed": 33, "deterministic_generator": 288},
        )
        for key, entry in phrases.items():
            with self.subTest(key=key):
                self.assertIsInstance(entry["text"], str)
                self.assertTrue(entry["text"].strip())
                expected_source = (
                    "manual_reviewed"
                    if key in curated_features
                    or ("@" not in key and key in curated_base)
                    else "deterministic_generator"
                )
                self.assertEqual(entry["source"], expected_source)

        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        dependency = manifest["dependencies"]["evidence_phrases"]
        self.assertEqual(dependency["selected_key_count"], 321)
        self.assertEqual(
            dependency["source_counts"],
            {"manual_reviewed": 33, "deterministic_generator": 288},
        )
        self.assertEqual(
            dependency["sha256"], hashlib.sha256(phrase_path.read_bytes()).hexdigest()
        )


if __name__ == "__main__":
    unittest.main()
