"""Offline negative controls: no model/provider requests and no tracked mutations."""
from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from .common import load_json
from .finalize_hardened import REPORT_PATH, ROOT, CORPUS_PATH
from .verify_report import verify, verify_candidate
from .verify_corpus import verify as verify_corpus
from .benchmark import write_json


class VerificationTests(unittest.TestCase):
    def test_report_rejects_current_and_historical_tamper(self) -> None:
        original = load_json(REPORT_PATH)
        mutations = [
            lambda r: r.update(generated_at="2099-01-01T00:00:00Z"),
            lambda r: r.update(hidden=True),
            lambda r: r["method"].update(external_calls_made=False),
            lambda r: r["corpus"].update(path="invented.json"),
            lambda r: r["evaluation_design"].update(unseen_generalization_claim=True),
            lambda r: next(c for c in r["candidates"] if c["id"] == "rules")["slices"].update(invented=True),
            lambda r: r["candidates"].append({"id": "invented", "availability": "unavailable"}),
            lambda r: r.update(rules_refreshed_at="2099-01-01T00:00:00Z"),
        ]
        for identifier in ("rules_baseline", "qwen2.5:7b", "qwen2.5:14b", "jev", "rules"):
            mutations.append(lambda r, identifier=identifier: next(c for c in r["candidates"] if c["id"] == identifier).update(version="tampered"))
        for field in ("source_sha256", "runner_sha256", "corpus_sha256", "predictions_sha256", "execution", "hidden"):
            mutations.append(lambda r, field=field: next(c for c in r["candidates"] if c["id"] == "rules")["provenance"].update({field: "tampered"}))
        mutations.append(lambda r: next(c for c in r["candidates"] if c["id"] == "rules")["latency_ms"].update(total=999999))
        mutations.append(lambda r: next(c for c in r["candidates"] if c["id"] == "rules")["latency_ms"].update(mean=float("nan")))
        mutations.append(lambda r: next(c for c in r["candidates"] if c["id"] == "rules")["cost"].update(amount=float("nan")))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            for mutation in mutations:
                with self.subTest(mutation=mutation):
                    value = copy.deepcopy(original)
                    mutation(value)
                    write_json(path, value)
                    with self.assertRaises(SystemExit):
                        verify(path, CORPUS_PATH)

    def test_frozen_prediction_bytes_cannot_be_changed(self) -> None:
        candidates = load_json(REPORT_PATH)["candidates"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for candidate in candidates:
                if candidate["id"] == "rules":
                    continue
                relative = Path(candidate["predictions_artifact"])
                artifact = root / relative
                artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_bytes((ROOT / relative).read_bytes() + b"\n")
                with self.subTest(candidate=candidate["id"]), patch("scripts.redflag_eval.verify_report.ROOT", root):
                    with self.assertRaises(SystemExit):
                        verify_candidate(candidate, load_json(CORPUS_PATH)["items"], REPORT_PATH)

    def test_closed_corpus_and_provenance_keys(self) -> None:
        original = load_json(CORPUS_PATH)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "corpus.json"
            mutations = [lambda r: r.update(hidden=True), lambda r: r["items"][0].update(hidden=True),
                         lambda r: r["items"][0]["provenance"].update(hidden=True),
                         lambda r: r["items"][0]["messages"][0].update(hidden=True)]
            for mutation in mutations:
                value = copy.deepcopy(original)
                mutation(value)
                write_json(path, value)
                with self.assertRaises(SystemExit):
                    verify_corpus(path)

    def test_original_report_and_corpus_pass(self) -> None:
        verify(REPORT_PATH, CORPUS_PATH)


if __name__ == "__main__":
    unittest.main()
