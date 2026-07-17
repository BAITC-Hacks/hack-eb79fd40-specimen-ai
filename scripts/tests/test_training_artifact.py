from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import sys
import unittest
from pathlib import Path

import joblib
import numpy as np
from scipy import sparse

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT_PATH = ROOT / "models" / "triage-lr-v1.json"
REPORT_PATH = ROOT / "reports" / "training_report.json"
PROCESSED = ROOT / "data" / "processed"
RAW = ROOT / "data" / "raw"
EXPECTED_SCHEMA = {
    "schema_version",
    "model_version",
    "trained_at",
    "dataset_name",
    "dataset_sha256",
    "license",
    "n_train_rows",
    "feature_order",
    "class_order",
    "weights",
    "bias",
    "preprocessing",
    "abstain_threshold",
    "train_metrics",
}
EXPECTED_SEMANTIC_EVIDENCE_SHA256 = (
    "595dfef6bf77f82d3d597d4e746fbf684f3a53764dd58a11bf2d549318a93ba5"
)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def independent_split_identities(
    path: Path, class_order: set[str]
) -> tuple[set[bytes], int, int]:
    csv.field_size_limit(sys.maxsize)
    identities: set[bytes] = set()
    raw_rows = 0
    eligible_rows = 0
    with path.open(encoding="utf-8", newline="") as source:
        for row in csv.DictReader(source):
            raw_rows += 1
            try:
                age = int(row["AGE"])
            except (KeyError, TypeError, ValueError):
                continue
            sex = row.get("SEX", "").upper()
            pathology = row.get("PATHOLOGY", "")
            evidences = row.get("EVIDENCES", "")
            if not (
                18 <= age <= 120
                and sex in {"M", "F"}
                and pathology in class_order
            ):
                continue
            eligible_rows += 1
            payload = json.dumps(
                [age, sex, pathology, evidences],
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            identities.add(hashlib.sha256(payload).digest())
    return identities, raw_rows, eligible_rows


class FinalTrainingArtifactTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.artifact = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
        cls.report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
        cls.specification = json.loads(
            (PROCESSED / "feature_spec.json").read_text(encoding="utf-8")
        )
        cls.provenance = json.loads(
            (RAW / "PROVENANCE.json").read_text(encoding="utf-8")
        )
        cls.classifier = joblib.load(PROCESSED / "clf-lr-v1.joblib")

    def test_frozen_schema_dimensions_and_provenance(self) -> None:
        artifact = self.artifact
        report = self.report
        specification = self.specification
        provenance = self.provenance

        self.assertEqual(set(artifact), EXPECTED_SCHEMA)
        self.assertNotIn("metrics", artifact)
        self.assertEqual(artifact["schema_version"], 1)
        self.assertEqual(artifact["model_version"], "lr-v1")
        trained_at = dt.datetime.fromisoformat(artifact["trained_at"])
        self.assertIsNotNone(trained_at.tzinfo)
        self.assertEqual(artifact["dataset_name"], "DDXPlus")
        self.assertEqual(
            artifact["dataset_sha256"],
            file_sha256(RAW / "release_train_patients.csv"),
        )
        self.assertEqual(artifact["dataset_sha256"], report["dataset_provenance"]["dataset_sha256"])
        self.assertEqual(provenance["license"]["source"], "figshare_article_metadata")
        self.assertIs(provenance["license_file_in_release"], False)
        self.assertEqual(artifact["license"], provenance["license"]["name"])
        self.assertEqual(artifact["feature_order"], specification["feature_order"])
        self.assertEqual(artifact["class_order"], specification["class_order"])
        self.assertEqual(len(artifact["feature_order"]), 975)
        self.assertEqual(len(set(artifact["feature_order"])), 975)
        self.assertIn("sex_m", artifact["feature_order"])
        self.assertIn("sex_f", artifact["feature_order"])
        self.assertEqual(len(artifact["class_order"]), 47)
        self.assertEqual(
            artifact["preprocessing"],
            {"age_divisor": 100, "age_missing": 0.5, "sex_unknown_value": 0.5},
        )
        self.assertEqual(artifact["n_train_rows"], 814_240)
        self.assertEqual(artifact["n_train_rows"], specification["n_train_rows"])
        self.assertEqual(report["sampling"]["available_rows"], 814_240)
        self.assertEqual(report["sampling"]["used_rows"], 814_240)
        self.assertIs(report["sampling"]["applied"], False)
        self.assertIsNone(report["sampling"]["requested_limit"])
        self.assertEqual(report["sampling"]["reason"], "full_train")
        self.assertEqual(report["sampling"]["seed"], 42)
        self.assertGreater(artifact["abstain_threshold"], 0.0)
        self.assertLess(artifact["abstain_threshold"], 1.0)
        self.assertEqual(
            artifact["abstain_threshold"], report["abstain"]["selected"]["threshold"]
        )
        self.assertEqual(file_sha256(ARTIFACT_PATH), report["artifact"]["sha256"])

        weights = np.asarray(artifact["weights"], dtype=np.float64)
        bias = np.asarray(artifact["bias"], dtype=np.float64)
        self.assertEqual(weights.shape, (47, 975))
        self.assertEqual(bias.shape, (47,))
        self.assertTrue(np.isfinite(weights).all())
        self.assertTrue(np.isfinite(bias).all())

    def test_cross_split_decontamination_from_raw_identities(self) -> None:
        classes = set(self.artifact["class_order"])
        independent: dict[str, set[bytes]] = {}
        raw_counts: dict[str, int] = {}
        eligible_counts: dict[str, int] = {}
        for split in ("train", "validate", "test"):
            identities, raw_rows, eligible_rows = independent_split_identities(
                RAW / f"release_{split}_patients.csv", classes
            )
            independent[split] = identities
            raw_counts[split] = raw_rows
            eligible_counts[split] = eligible_rows

        self.assertEqual(
            raw_counts, {"train": 1_025_602, "validate": 132_448, "test": 134_529}
        )
        self.assertEqual(
            eligible_counts,
            {"train": 837_465, "validate": 108_372, "test": 109_938},
        )
        before = {name: len(values) for name, values in independent.items()}
        self.assertEqual(
            before, {"train": 814_240, "validate": 108_199, "test": 109_732}
        )
        pairwise = {
            "train_validate": len(independent["train"] & independent["validate"]),
            "train_test": len(independent["train"] & independent["test"]),
            "validate_test": len(independent["validate"] & independent["test"]),
        }
        triple = len(
            independent["train"]
            & independent["validate"]
            & independent["test"]
        )
        self.assertEqual(
            pairwise,
            {"train_validate": 3_429, "train_test": 3_726, "validate_test": 391},
        )
        self.assertEqual(triple, 108)

        accepted_train = independent["train"]
        accepted_validate = independent["validate"] - accepted_train
        accepted_test = independent["test"] - accepted_train - accepted_validate
        accepted = {
            "train": accepted_train,
            "validate": accepted_validate,
            "test": accepted_test,
        }
        after = {name: len(values) for name, values in accepted.items()}
        removed = {name: before[name] - after[name] for name in before}
        self.assertEqual(
            removed, {"train": 0, "validate": 3_429, "test": 4_009}
        )
        self.assertEqual(
            after, {"train": 814_240, "validate": 104_770, "test": 105_723}
        )
        self.assertEqual(pairwise["train_test"] + pairwise["validate_test"] - triple, 4_009)
        self.assertFalse(accepted_train & accepted_validate)
        self.assertFalse(accepted_train & accepted_test)
        self.assertFalse(accepted_validate & accepted_test)
        self.assertEqual(self.report["decontamination"]["before_rows"], before)
        self.assertEqual(self.report["decontamination"]["removed_rows"], removed)
        self.assertEqual(self.report["decontamination"]["after_rows"], after)
        self.assertEqual(
            self.report["decontamination"]["pairwise_overlap_before"], pairwise
        )
        self.assertEqual(
            self.report["decontamination"]["pairwise_overlap_after"],
            {"train_validate": 0, "train_test": 0, "validate_test": 0},
        )

    def test_saved_classifier_metrics_threshold_and_serialized_scorer(self) -> None:
        test_matrix = sparse.load_npz(PROCESSED / "X_test.npz").tocsr()
        test_labels = np.load(PROCESSED / "y_test.npy")
        validation_matrix = sparse.load_npz(PROCESSED / "X_validate.npz").tocsr()
        validation_labels = np.load(PROCESSED / "y_validate.npy")
        self.assertEqual(test_matrix.shape, (105_723, 975))
        self.assertEqual(validation_matrix.shape, (104_770, 975))
        self.assertEqual(self.classifier.n_iter_.tolist(), [71])
        self.assertEqual(self.classifier.random_state, 42)
        self.assertEqual(self.classifier.solver, "saga")
        self.assertEqual(self.classifier.max_iter, 200)
        self.assertEqual(self.report["training"]["n_iter"], [71])
        self.assertTrue(self.report["training"]["converged"])
        self.assertEqual(self.report["training"]["convergence_messages"], [])

        reference = self.classifier.predict_proba(test_matrix)
        top1 = float(np.mean(reference.argmax(axis=1) == test_labels))
        top3 = float(
            np.mean(
                np.any(
                    np.argpartition(-reference, kth=2, axis=1)[:, :3]
                    == test_labels[:, None],
                    axis=1,
                )
            )
        )
        recomputed_metrics = {
            "top1": top1,
            "top3": top3,
            "n_test": len(test_labels),
        }
        self.assertEqual(recomputed_metrics, self.artifact["train_metrics"])
        self.assertEqual(recomputed_metrics, self.report["train_metrics"])

        weights = np.asarray(self.artifact["weights"], dtype=np.float64)
        bias = np.asarray(self.artifact["bias"], dtype=np.float64)
        logits = np.asarray(test_matrix @ weights.T) + bias
        logits -= logits.max(axis=1, keepdims=True)
        serialized = np.exp(logits)
        serialized /= serialized.sum(axis=1, keepdims=True)
        self.assertTrue(np.isfinite(serialized).all())
        np.testing.assert_allclose(serialized.sum(axis=1), 1.0, atol=1e-12)
        max_delta = float(np.max(np.abs(serialized - reference)))
        argmax_flips = int(
            np.sum(serialized.argmax(axis=1) != reference.argmax(axis=1))
        )
        self.assertLessEqual(max_delta, 1e-5)
        self.assertEqual(argmax_flips, 0)

        validation_probabilities = self.classifier.predict_proba(validation_matrix)
        confidence = validation_probabilities.max(axis=1)
        correct = validation_probabilities.argmax(axis=1) == validation_labels
        candidates = sorted(
            set(np.quantile(confidence, np.linspace(0.0, 0.9, 91)).tolist())
        )
        curve: list[dict[str, float]] = []
        for threshold in candidates:
            keep = confidence >= threshold
            curve.append(
                {
                    "threshold": float(threshold),
                    "coverage": float(keep.mean()),
                    "accuracy": float(correct[keep].mean()),
                }
            )
        eligible = [
            point
            for point in curve
            if point["coverage"] >= 0.5 and point["accuracy"] >= 0.85
        ]
        selected = min(eligible, key=lambda point: point["threshold"])
        self.assertEqual(curve, self.report["abstain"]["curve"])
        self.assertEqual(selected, self.report["abstain"]["selected"])
        self.assertEqual(selected["threshold"], self.artifact["abstain_threshold"])

    def test_evidence_dictionary_semantics_are_frozen(self) -> None:
        dictionary = json.loads(
            (ROOT / "data" / "evidences_ru.json").read_text(encoding="utf-8")
        )
        entries = {key: value for key, value in dictionary.items() if key != "_meta"}
        semantic_payload = json.dumps(
            entries,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        self.assertEqual(len(entries), 987)
        self.assertEqual(
            hashlib.sha256(semantic_payload).hexdigest(),
            EXPECTED_SEMANTIC_EVIDENCE_SHA256,
        )
        self.assertEqual(
            dictionary["_meta"]["feature_order_source"],
            f"triage-lr-v1.json sha256:{file_sha256(ARTIFACT_PATH)}",
        )


if __name__ == "__main__":
    unittest.main()
