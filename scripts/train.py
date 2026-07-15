#!/usr/bin/env python3
"""Train multinomial LR and export the runtime JSON artifact in the same process."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
import warnings
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from scipy import sparse
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedShuffleSplit

try:
    from scripts.export_model import export_artifact
except ModuleNotFoundError:  # Direct `python scripts/train.py` execution.
    from export_model import export_artifact

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROCESSED = ROOT / "data" / "processed"
DEFAULT_MODEL = ROOT / "models" / "triage-lr-v1.json"
DEFAULT_REPORT = ROOT / "reports" / "training_report.json"
DEFAULT_EVAL_NOTES = ROOT / "reports" / "eval.md"
FALLBACK_TRAIN_ROWS = 300_000


def load_split(processed: Path, split: str) -> tuple[sparse.csr_matrix, np.ndarray]:
    return (
        sparse.load_npz(processed / f"X_{split}.npz").tocsr(),
        np.load(processed / f"y_{split}.npy"),
    )


def topk_accuracy(probabilities: np.ndarray, labels: np.ndarray, k: int) -> float:
    top = np.argpartition(-probabilities, kth=k - 1, axis=1)[:, :k]
    return float(np.mean(np.any(top == labels[:, None], axis=1)))


def stratified_subsample(
    matrix: sparse.csr_matrix,
    labels: np.ndarray,
    limit: int | None,
    seed: int,
) -> tuple[sparse.csr_matrix, np.ndarray]:
    if limit is None or len(labels) <= limit:
        return matrix, labels
    if limit < len(np.unique(labels)):
        raise ValueError("sample limit must be at least the number of classes")
    splitter = StratifiedShuffleSplit(n_splits=1, train_size=limit, random_state=seed)
    indices, _ = next(splitter.split(np.zeros(len(labels)), labels))
    indices = np.sort(indices)
    return matrix[indices], labels[indices]


def pick_abstain_threshold(
    probabilities: np.ndarray,
    labels: np.ndarray,
    min_accuracy: float = 0.85,
    min_coverage: float = 0.50,
) -> tuple[float, list[dict[str, float]], dict[str, float]]:
    confidence = probabilities.max(axis=1)
    correct = probabilities.argmax(axis=1) == labels
    candidates = sorted(set(np.quantile(confidence, np.linspace(0.0, 0.9, 91)).tolist()))
    curve: list[dict[str, float]] = []
    for threshold in candidates:
        keep = confidence >= threshold
        coverage = float(keep.mean())
        accuracy = float(correct[keep].mean()) if keep.any() else 0.0
        curve.append(
            {
                "threshold": float(threshold),
                "coverage": coverage,
                "accuracy": accuracy,
            }
        )
    eligible = [
        point
        for point in curve
        if point["coverage"] >= min_coverage and point["accuracy"] >= min_accuracy
    ]
    if eligible:
        selected = min(eligible, key=lambda point: point["threshold"])
    else:
        viable = [point for point in curve if point["coverage"] >= min_coverage]
        selected = max(
            viable,
            key=lambda point: (
                point["accuracy"],
                point["coverage"],
                -point["threshold"],
            ),
        )
        print(
            f"WARNING: validation did not reach accuracy={min_accuracy:.2f} at "
            f"coverage={min_coverage:.2f}; selected best measured operating point"
        )
    threshold = max(
        float(selected["threshold"]),
        float(np.finfo(np.float32).eps),
    )
    selected = {**selected, "threshold": threshold}
    print(
        f"abstain operating point: threshold={threshold:.6f}, "
        f"coverage={selected['coverage']:.3f}, accuracy={selected['accuracy']:.3f}"
    )
    return threshold, curve, selected


def validate_decontamination(specification: dict[str, Any]) -> dict[str, Any]:
    decontamination = specification.get("decontamination")
    if not isinstance(decontamination, dict):
        raise ValueError("feature specification lacks cross-split decontamination")
    overlaps = decontamination.get("pairwise_overlap_after")
    if not isinstance(overlaps, dict) or set(overlaps) != {
        "train_validate",
        "train_test",
        "validate_test",
    }:
        raise ValueError("feature specification has invalid post-clean overlap report")
    if any(value != 0 for value in overlaps.values()):
        raise ValueError("training is forbidden while cross-split overlap remains")
    return decontamination


def validate_split_shapes(
    specification: dict[str, Any],
    splits: dict[str, tuple[sparse.csr_matrix, np.ndarray]],
) -> None:
    expected_rows = specification["decontamination"]["after_rows"]
    expected_features = len(specification["feature_order"])
    class_count = len(specification["class_order"])
    for name, (matrix, labels) in splits.items():
        if matrix.shape != (expected_rows[name], expected_features):
            raise ValueError(
                f"{name} matrix shape {matrix.shape} differs from decontaminated spec"
            )
        if len(labels) != expected_rows[name]:
            raise ValueError(f"{name} labels differ from decontaminated spec")
        if labels.size and (labels.min() < 0 or labels.max() >= class_count):
            raise ValueError(f"{name} labels are outside class_order")


def fit_classifier(
    matrix: sparse.csr_matrix,
    labels: np.ndarray,
    *,
    max_iter: int,
    seed: int,
) -> tuple[LogisticRegression, float, bool, list[str]]:
    classifier = LogisticRegression(
        solver="saga",
        multi_class="multinomial",
        penalty="l2",
        C=1.0,
        max_iter=max_iter,
        tol=1e-3,
        class_weight="balanced",
        n_jobs=-1,
        random_state=seed,
        verbose=1,
    )
    started = time.monotonic()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        classifier.fit(matrix, labels)
    elapsed = time.monotonic() - started
    convergence_messages = [
        str(item.message)
        for item in caught
        if issubclass(item.category, ConvergenceWarning)
    ]
    return classifier, elapsed, not convergence_messages, convergence_messages


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_reports(
    *,
    report_path: Path,
    eval_notes_path: Path,
    report: dict[str, Any],
) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    decontamination = report["decontamination"]
    metrics = report["train_metrics"]
    sampling = report["sampling"]
    provenance = report["dataset_provenance"]
    lines = [
        "# Финальное обучение LR — фактический отчёт",
        "",
        "Эти числа получены Python/sklearn и не используются как метрики продукта в README.",
        "",
        "## Decontamination",
        f"- До очистки: `{decontamination['before_rows']}`.",
        f"- Удалено: `{decontamination['removed_rows']}`.",
        f"- После очистки: `{decontamination['after_rows']}`.",
        f"- Pairwise overlap после очистки: `{decontamination['pairwise_overlap_after']}`.",
        "",
        "## Обучение",
        f"- Использовано train-строк: **{sampling['used_rows']}** из {sampling['available_rows']}.",
        f"- Стратифицированная подвыборка: **{sampling['applied']}**; причина: `{sampling['reason']}`; seed: `{sampling['seed']}`.",
        f"- Solver: `saga`, multinomial; elapsed: **{report['training']['elapsed_seconds']:.3f} s**; converged: **{report['training']['converged']}**.",
        f"- Abstain threshold: **{report['abstain']['selected']['threshold']:.9f}**, validation coverage: **{report['abstain']['selected']['coverage']:.6f}**, accuracy: **{report['abstain']['selected']['accuracy']:.6f}**.",
        f"- Held-out test: top1 **{metrics['top1']:.9f}**, top3 **{metrics['top3']:.9f}**, N **{metrics['n_test']}**.",
        "",
        "## Provenance",
        f"- Dataset: `{provenance['dataset_name']}` v{provenance['version']}; `{provenance['doi']}`.",
        f"- Source: `{provenance['article_url']}`.",
        f"- Dataset SHA256: `{provenance['dataset_sha256']}`.",
        f"- License: `{provenance['license']}` from `{provenance['license_source']}`.",
        f"- Standalone LICENSE in release: `{provenance['license_file_in_release']}`.",
    ]
    eval_notes_path.parent.mkdir(parents=True, exist_ok=True)
    eval_notes_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def assert_artifact_matches_sklearn(
    path: Path,
    classifier: Any,
    matrix: sparse.csr_matrix,
    tolerance: float = 1e-5,
) -> None:
    artifact = json.loads(path.read_text(encoding="utf-8"))
    weights = np.asarray(artifact["weights"], dtype=np.float64)
    bias = np.asarray(artifact["bias"], dtype=np.float64)
    logits = np.asarray(matrix @ weights.T) + bias
    logits -= logits.max(axis=1, keepdims=True)
    probabilities = np.exp(logits)
    probabilities /= probabilities.sum(axis=1, keepdims=True)
    reference = classifier.predict_proba(matrix)
    max_delta = float(np.abs(probabilities - reference).max())
    flips = int(np.sum(probabilities.argmax(axis=1) != reference.argmax(axis=1)))
    print(f"artifact vs sklearn: max_delta={max_delta:.2e}, argmax_flips={flips}/{len(reference)}")
    if flips or not np.allclose(probabilities, reference, atol=tolerance):
        raise AssertionError("serialized artifact does not match fitted sklearn model")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--processed-dir", type=Path, default=DEFAULT_PROCESSED)
    parser.add_argument("--output", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--eval-notes", type=Path, default=DEFAULT_EVAL_NOTES)
    parser.add_argument("--max-train-rows", type=int)
    parser.add_argument("--max-iter", type=int, default=200)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--model-version", default="lr-v1")
    args = parser.parse_args()
    processed = args.processed_dir.resolve()
    specification = json.loads((processed / "feature_spec.json").read_text(encoding="utf-8"))
    decontamination = validate_decontamination(specification)
    train_matrix, train_labels = load_split(processed, "train")
    validation_matrix, validation_labels = load_split(processed, "validate")
    test_matrix, test_labels = load_split(processed, "test")
    validate_split_shapes(
        specification,
        {
            "train": (train_matrix, train_labels),
            "validate": (validation_matrix, validation_labels),
            "test": (test_matrix, test_labels),
        },
    )
    available_train_rows = len(train_labels)
    train_matrix, train_labels = stratified_subsample(
        train_matrix,
        train_labels,
        args.max_train_rows,
        args.seed,
    )
    print(f"training rows used: {len(train_labels)}")
    classifier, elapsed, converged, convergence_messages = fit_classifier(
        train_matrix,
        train_labels,
        max_iter=args.max_iter,
        seed=args.seed,
    )
    sampling_reason = "explicit_max_train_rows" if args.max_train_rows else "full_train"
    if not converged and args.max_train_rows is None and len(train_labels) > FALLBACK_TRAIN_ROWS:
        print(
            "WARNING: full train did not converge; retrying with deterministic "
            f"stratified sample of {FALLBACK_TRAIN_ROWS} rows"
        )
        train_matrix, train_labels = stratified_subsample(
            train_matrix,
            train_labels,
            FALLBACK_TRAIN_ROWS,
            args.seed,
        )
        classifier, retry_elapsed, converged, retry_messages = fit_classifier(
            train_matrix,
            train_labels,
            max_iter=args.max_iter,
            seed=args.seed,
        )
        elapsed += retry_elapsed
        convergence_messages.extend(retry_messages)
        sampling_reason = "full_train_did_not_converge"
    if not converged:
        raise RuntimeError("final logistic regression fit did not converge")
    print(f"training elapsed: {elapsed:.1f}s; n_iter={classifier.n_iter_.tolist()}")

    validation_probabilities = classifier.predict_proba(validation_matrix)
    threshold, threshold_curve, selected_threshold = pick_abstain_threshold(
        validation_probabilities,
        validation_labels,
    )
    test_probabilities = classifier.predict_proba(test_matrix)
    train_metrics: dict[str, float | int] = {
        "top1": topk_accuracy(test_probabilities, test_labels, 1),
        "top3": topk_accuracy(test_probabilities, test_labels, 3),
        "n_test": int(len(test_labels)),
    }
    print(f"train_metrics (not README metrics): {train_metrics}")

    artifact_path = export_artifact(
        classifier=classifier,
        specification=specification,
        train_metrics=train_metrics,
        abstain_threshold=threshold,
        model_version=args.model_version,
        output_path=args.output.resolve(),
        dataset_path=ROOT / "data" / "raw" / "release_train_patients.csv",
        provenance_path=ROOT / "data" / "raw" / "PROVENANCE.json",
        n_train_rows=len(train_labels),
    )
    assert_artifact_matches_sklearn(
        artifact_path,
        classifier,
        test_matrix[: min(2000, test_matrix.shape[0])],
    )
    joblib.dump(classifier, processed / f"clf-{args.model_version}.joblib")
    provenance = json.loads(
        (ROOT / "data" / "raw" / "PROVENANCE.json").read_text(encoding="utf-8")
    )
    dataset_path = ROOT / "data" / "raw" / "release_train_patients.csv"
    report: dict[str, Any] = {
        "status": "valid",
        "model_version": args.model_version,
        "decontamination": decontamination,
        "sampling": {
            "available_rows": available_train_rows,
            "used_rows": len(train_labels),
            "applied": len(train_labels) != available_train_rows,
            "requested_limit": args.max_train_rows,
            "reason": sampling_reason,
            "seed": args.seed,
        },
        "training": {
            "solver": "saga",
            "multi_class": "multinomial",
            "max_iter": args.max_iter,
            "n_iter": classifier.n_iter_.tolist(),
            "elapsed_seconds": elapsed,
            "converged": converged,
            "convergence_messages": convergence_messages,
        },
        "abstain": {
            "selected": selected_threshold,
            "curve": threshold_curve,
            "validation_rows": len(validation_labels),
        },
        "train_metrics": train_metrics,
        "dataset_provenance": {
            "dataset_name": "DDXPlus",
            "dataset_sha256": file_hash(dataset_path),
            "article_url": provenance["article_url"],
            "doi": provenance["doi"],
            "version": provenance["version"],
            "license": provenance["license"]["name"],
            "license_source": provenance["license"]["source"],
            "license_file_in_release": provenance["license_file_in_release"],
        },
        "artifact": {
            "path": str(artifact_path.relative_to(ROOT)),
            "sha256": file_hash(artifact_path),
            "weights_shape": [
                len(specification["class_order"]),
                len(specification["feature_order"]),
            ],
        },
    }
    write_reports(
        report_path=args.report.resolve(),
        eval_notes_path=args.eval_notes.resolve(),
        report=report,
    )
    print(f"-> {args.report.resolve()}")
    print(f"-> {args.eval_notes.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
