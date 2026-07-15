from __future__ import annotations

import unittest

import numpy as np
from scipy import sparse

from scripts.train import (
    pick_abstain_threshold,
    stratified_subsample,
    validate_decontamination,
    validate_split_shapes,
)


class TrainPipelineTest(unittest.TestCase):
    def test_stratified_sample_is_exact_and_deterministic(self) -> None:
        labels = np.repeat(np.arange(4, dtype=np.int32), 25)
        matrix = sparse.csr_matrix(np.arange(100, dtype=np.float64)[:, None])

        first_matrix, first_labels = stratified_subsample(matrix, labels, 40, 42)
        second_matrix, second_labels = stratified_subsample(matrix, labels, 40, 42)

        self.assertEqual(len(first_labels), 40)
        np.testing.assert_array_equal(first_labels, second_labels)
        np.testing.assert_array_equal(first_matrix.toarray(), second_matrix.toarray())
        np.testing.assert_array_equal(np.bincount(first_labels), [10, 10, 10, 10])

    def test_threshold_is_nonzero_and_comes_from_validation_curve(self) -> None:
        probabilities = np.asarray(
            [
                [0.95, 0.05],
                [0.90, 0.10],
                [0.55, 0.45],
                [0.51, 0.49],
            ]
        )
        labels = np.asarray([0, 0, 1, 1])

        threshold, curve, selected = pick_abstain_threshold(
            probabilities,
            labels,
            min_accuracy=1.0,
            min_coverage=0.5,
        )

        self.assertGreater(threshold, 0.0)
        self.assertEqual(threshold, selected["threshold"])
        self.assertGreaterEqual(selected["coverage"], 0.5)
        self.assertEqual(selected["accuracy"], 1.0)
        self.assertIn(selected, curve)

    def test_training_rejects_contaminated_or_missing_spec(self) -> None:
        with self.assertRaisesRegex(ValueError, "lacks"):
            validate_decontamination({})
        with self.assertRaisesRegex(ValueError, "forbidden"):
            validate_decontamination(
                {
                    "decontamination": {
                        "pairwise_overlap_after": {
                            "train_validate": 1,
                            "train_test": 0,
                            "validate_test": 0,
                        }
                    }
                }
            )

    def test_training_rejects_stale_processed_shape(self) -> None:
        specification = {
            "feature_order": ["x"],
            "class_order": ["A", "B"],
            "decontamination": {
                "after_rows": {"train": 2, "validate": 1, "test": 1}
            },
        }
        splits = {
            "train": (sparse.csr_matrix((1, 1)), np.asarray([0])),
            "validate": (sparse.csr_matrix((1, 1)), np.asarray([0])),
            "test": (sparse.csr_matrix((1, 1)), np.asarray([1])),
        }
        with self.assertRaisesRegex(ValueError, "differs"):
            validate_split_shapes(specification, splits)


if __name__ == "__main__":
    unittest.main()
