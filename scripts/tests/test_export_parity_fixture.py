from __future__ import annotations

import json
import unittest
from pathlib import Path

from scripts.export_parity_fixture import DEFAULT_OUTPUT, MIN_CASES, json_line

ROOT = Path(__file__).resolve().parents[2]


class ExportParityFixtureTest(unittest.TestCase):
    def test_committed_fixture_has_manifest_and_required_coverage(self) -> None:
        lines = DEFAULT_OUTPUT.read_text(encoding="utf-8").strip().splitlines()
        manifest = json.loads(lines[0])
        cases = [json.loads(line) for line in lines[1:]]

        self.assertEqual(manifest["kind"], "manifest")
        self.assertEqual(manifest["split"], "decontaminated_test")
        self.assertGreaterEqual(len(cases), MIN_CASES)
        self.assertEqual(len(cases), manifest["selection"]["count"])
        self.assertEqual(manifest["coverage"]["class_count"], 47)
        self.assertEqual(len(manifest["coverage"]["ground_truth"]), 47)
        self.assertEqual(len(manifest["coverage"]["argmax"]), 47)
        self.assertEqual(manifest["coverage"]["sex"], ["f", "m"])
        self.assertTrue({"B", "C", "M"}.issubset(manifest["coverage"]["evidence_types"]))
        self.assertTrue(
            all(
                case["provenance"]["selection_seed"]
                == manifest["selection"]["seed"]
                for case in cases
            )
        )

    def test_json_line_is_canonical_and_byte_deterministic(self) -> None:
        value = {"z": "тест", "a": [1.0, 2]}
        first = json_line(value)
        second = json_line(value)

        self.assertEqual(first, second)
        self.assertEqual(first, '{"a":[1.0,2],"z":"тест"}')


if __name__ == "__main__":
    unittest.main()
