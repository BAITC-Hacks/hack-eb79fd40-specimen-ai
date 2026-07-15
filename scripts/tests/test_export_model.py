from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from scripts.export_model import export_artifact


class FakeClassifier:
    coef_ = np.asarray([[0.2, -0.1, 0.3], [-0.2, 0.1, -0.3]])
    intercept_ = np.asarray([0.05, -0.05])
    classes_ = np.asarray([0, 1])


class ExportModelTest(unittest.TestCase):
    def test_exports_frozen_schema_from_real_files(self) -> None:
        specification = {
            "feature_order": ["age_norm", "sex_m", "sex_f"],
            "class_order": ["A", "B"],
            "preprocessing": {
                "age_divisor": 100,
                "age_missing": 0.5,
                "sex_unknown_value": 0.5,
            },
        }
        provenance = {
            "license": {
                "name": "CC BY 4.0",
                "source": "figshare_article_metadata",
            },
            "license_file_in_release": False,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset = root / "train.csv"
            dataset.write_bytes(b"actual dataset bytes")
            provenance_path = root / "PROVENANCE.json"
            provenance_path.write_text(json.dumps(provenance), encoding="utf-8")
            output = root / "artifact.json"

            export_artifact(
                classifier=FakeClassifier(),
                specification=specification,
                train_metrics={"top1": 0.5, "top3": 1.0, "n_test": 2},
                abstain_threshold=0.4,
                model_version="lr-test",
                output_path=output,
                dataset_path=dataset,
                provenance_path=provenance_path,
                n_train_rows=10,
            )
            artifact = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(artifact["schema_version"], 1)
        self.assertEqual(artifact["feature_order"], ["age_norm", "sex_m", "sex_f"])
        self.assertEqual(artifact["class_order"], ["A", "B"])
        self.assertEqual(np.asarray(artifact["weights"]).shape, (2, 3))
        self.assertEqual(artifact["license"], "CC BY 4.0")
        self.assertEqual(artifact["n_train_rows"], 10)
        self.assertEqual(
            artifact["dataset_sha256"],
            hashlib.sha256(b"actual dataset bytes").hexdigest(),
        )
        self.assertNotEqual(artifact["abstain_threshold"], 0.0)
        self.assertEqual(
            set(artifact),
            {
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
            },
        )

    def test_rejects_unverified_license_source(self) -> None:
        specification = {
            "feature_order": ["age_norm", "sex_m", "sex_f"],
            "class_order": ["A", "B"],
            "preprocessing": {},
        }
        provenance = {
            "license": {"name": "CC BY 4.0", "source": "memory"},
            "license_file_in_release": False,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset = root / "train.csv"
            dataset.write_text("x", encoding="utf-8")
            provenance_path = root / "PROVENANCE.json"
            provenance_path.write_text(json.dumps(provenance), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "verified Figshare"):
                export_artifact(
                    classifier=FakeClassifier(),
                    specification=specification,
                    train_metrics={"top1": 0.5, "top3": 1.0, "n_test": 2},
                    abstain_threshold=0.4,
                    model_version="lr-test",
                    output_path=root / "artifact.json",
                    dataset_path=dataset,
                    provenance_path=provenance_path,
                    n_train_rows=10,
                )


if __name__ == "__main__":
    unittest.main()
