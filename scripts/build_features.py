#!/usr/bin/env python3
"""Build the sole train-time DDXPlus one-hot representation used by Demeu."""

from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import json
import math
import sys
from collections import Counter
from collections.abc import Iterable, Iterator, Mapping, Set
from pathlib import Path
from typing import Any

import numpy as np
from scipy import sparse

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW = ROOT / "data" / "raw"
DEFAULT_PROCESSED = ROOT / "data" / "processed"
PREPROCESSING = {
    "age_divisor": 100,
    "age_missing": 0.5,
    "sex_unknown_value": 0.5,
}
MIN_AGE = 18
MAX_AGE = 120
MIN_CLASS_ROWS = 50


def age_norm(age: float | None) -> float:
    divisor = float(PREPROCESSING["age_divisor"])
    if age is None or math.isnan(age):
        return float(PREPROCESSING["age_missing"])
    return min(max(age, 0.0), divisor) / divisor


def build_feature_order(evidences: dict[str, dict[str, Any]]) -> list[str]:
    columns = ["age_norm", "sex_m", "sex_f"]
    for code in sorted(evidences):
        metadata = evidences[code]
        if metadata.get("data_type") == "B":
            columns.append(code)
        else:
            for value in sorted(map(str, metadata.get("possible-values") or [])):
                columns.append(f"{code}@{value}")
    if len(columns) != len(set(columns)):
        raise ValueError("feature_order contains duplicates")
    return columns


def parse_evidences(raw: str) -> list[tuple[str, str | None]]:
    parsed = ast.literal_eval(raw)
    if not isinstance(parsed, list):
        raise ValueError("EVIDENCES must be a list")
    result: list[tuple[str, str | None]] = []
    for token in parsed:
        text = str(token)
        if "_@_" in text:
            code, value = text.split("_@_", 1)
            result.append((code, value))
        else:
            result.append((text, None))
    return result


def clean_row(row: dict[str, str]) -> tuple[int, str, str, str] | None:
    try:
        age = int(row["AGE"])
        sex = row["SEX"].upper()
        pathology = row["PATHOLOGY"]
        evidences = row["EVIDENCES"]
    except (KeyError, TypeError, ValueError):
        return None
    if not MIN_AGE <= age <= MAX_AGE or sex not in {"M", "F"} or not pathology:
        return None
    return age, sex, pathology, evidences


def row_digest(row: tuple[int, str, str, str]) -> bytes:
    payload = "\x1f".join(map(str, row)).encode("utf-8")
    return hashlib.blake2b(payload, digest_size=16).digest()


def iter_clean_unique(
    path: Path,
    excluded_digests: Set[bytes] = frozenset(),
) -> Iterator[tuple[int, str, str, str]]:
    csv.field_size_limit(sys.maxsize)
    seen: set[bytes] = set()
    with path.open(encoding="utf-8", newline="") as source:
        for raw_row in csv.DictReader(source):
            row = clean_row(raw_row)
            if row is None:
                continue
            digest = row_digest(row)
            if digest in seen or digest in excluded_digests:
                continue
            seen.add(digest)
            yield row


def class_counts(path: Path) -> Counter[str]:
    return Counter(row[2] for row in iter_clean_unique(path))


def model_row_digests(path: Path, class_order: Set[str]) -> set[bytes]:
    return {
        row_digest(row)
        for row in iter_clean_unique(path)
        if row[2] in class_order
    }


def decontaminate_digest_sets(
    split_digests: Mapping[str, set[bytes]],
) -> tuple[dict[str, set[bytes]], dict[str, Any]]:
    """Remove cross-split duplicates with deterministic train/validate/test precedence."""
    required = ("train", "validate", "test")
    if set(split_digests) != set(required):
        raise ValueError("split digests must contain exactly train, validate, and test")
    before = {name: set(split_digests[name]) for name in required}
    accepted = {
        "train": before["train"],
        "validate": before["validate"] - before["train"],
    }
    accepted["test"] = before["test"] - accepted["train"] - accepted["validate"]

    def overlaps(values: Mapping[str, set[bytes]]) -> dict[str, int]:
        return {
            "train_validate": len(values["train"] & values["validate"]),
            "train_test": len(values["train"] & values["test"]),
            "validate_test": len(values["validate"] & values["test"]),
        }

    report: dict[str, Any] = {
        "strategy": "precedence_train_validate_test",
        "key": ["AGE", "SEX", "PATHOLOGY", "EVIDENCES"],
        "before_rows": {name: len(before[name]) for name in required},
        "removed_rows": {
            name: len(before[name]) - len(accepted[name]) for name in required
        },
        "after_rows": {name: len(accepted[name]) for name in required},
        "pairwise_overlap_before": overlaps(before),
        "pairwise_overlap_after": overlaps(accepted),
    }
    if any(report["pairwise_overlap_after"].values()):
        raise AssertionError("cross-split decontamination left overlapping rows")
    return accepted, report


def vectorize_rows(
    rows: Iterable[tuple[int, str, str, str]],
    feature_index: dict[str, int],
    class_index: dict[str, int],
) -> tuple[sparse.csr_matrix, np.ndarray, dict[str, int]]:
    chunk_size = 25_000
    chunks: list[sparse.csr_matrix] = []
    matrix_rows: list[int] = []
    matrix_columns: list[int] = []
    values: list[float] = []
    labels: list[int] = []
    stats = {"unknown_evidence_tokens": 0, "excluded_class_rows": 0}

    def flush_chunk(row_count: int) -> None:
        nonlocal matrix_rows, matrix_columns, values
        if row_count == 0:
            return
        chunk = sparse.csr_matrix(
            (values, (matrix_rows, matrix_columns)),
            shape=(row_count, len(feature_index)),
            dtype=np.float32,
        )
        chunk.sum_duplicates()
        chunk.data[:] = np.minimum(chunk.data, 1.0)
        chunks.append(chunk)
        matrix_rows, matrix_columns, values = [], [], []

    chunk_row = 0
    for age, sex, pathology, raw_evidences in rows:
        if pathology not in class_index:
            stats["excluded_class_rows"] += 1
            continue
        labels.append(class_index[pathology])
        matrix_rows.append(chunk_row)
        matrix_columns.append(feature_index["age_norm"])
        values.append(age_norm(float(age)))
        sex_feature = "sex_m" if sex == "M" else "sex_f"
        matrix_rows.append(chunk_row)
        matrix_columns.append(feature_index[sex_feature])
        values.append(1.0)
        for code, value in parse_evidences(raw_evidences):
            feature = code if value is None else f"{code}@{value}"
            column = feature_index.get(feature)
            if column is None:
                stats["unknown_evidence_tokens"] += 1
                continue
            matrix_rows.append(chunk_row)
            matrix_columns.append(column)
            values.append(1.0)
        chunk_row += 1
        if chunk_row == chunk_size:
            flush_chunk(chunk_row)
            chunk_row = 0

    flush_chunk(chunk_row)
    matrix = sparse.vstack(chunks, format="csr") if chunks else sparse.csr_matrix(
        (0, len(feature_index)), dtype=np.float32
    )
    return matrix, np.asarray(labels, dtype=np.int32), stats


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--processed-dir", type=Path, default=DEFAULT_PROCESSED)
    args = parser.parse_args()
    raw = args.raw_dir.resolve()
    processed = args.processed_dir.resolve()
    evidences: dict[str, dict[str, Any]] = json.loads(
        (raw / "release_evidences.json").read_text(encoding="utf-8")
    )
    feature_order = build_feature_order(evidences)
    feature_index = {name: index for index, name in enumerate(feature_order)}

    train_counts = class_counts(raw / "release_train_patients.csv")
    class_order = sorted(
        pathology for pathology, count in train_counts.items() if count >= MIN_CLASS_ROWS
    )
    if not class_order:
        raise RuntimeError("no train classes remain after cleaning")
    class_index = {name: index for index, name in enumerate(class_order)}
    print(f"ФАКТ: len(feature_order) = {len(feature_order)}")
    print(
        f"ФАКТ: train classes = {len(class_order)} "
        f"({len(train_counts) - len(class_order)} excluded below {MIN_CLASS_ROWS} rows)"
    )

    processed.mkdir(parents=True, exist_ok=True)
    class_set = set(class_order)
    source_digests = {
        split: model_row_digests(
            raw / f"release_{split}_patients.csv",
            class_set,
        )
        for split in ("train", "validate", "test")
    }
    accepted_digests, decontamination = decontaminate_digest_sets(source_digests)
    print(
        "ФАКТ: cross-split removed = "
        f"{decontamination['removed_rows']}; "
        f"post-clean overlap = {decontamination['pairwise_overlap_after']}"
    )

    split_rows: dict[str, int] = {}
    for split in ("train", "validate", "test"):
        path = raw / f"release_{split}_patients.csv"
        excluded = source_digests[split] - accepted_digests[split]
        matrix, labels, stats = vectorize_rows(
            iter_clean_unique(path, excluded), feature_index, class_index
        )
        sparse.save_npz(processed / f"X_{split}.npz", matrix)
        np.save(processed / f"y_{split}.npy", labels)
        split_rows[split] = matrix.shape[0]
        print(
            f"ФАКТ: {split}: X={matrix.shape}, nnz={matrix.nnz}, "
            f"excluded_class_rows={stats['excluded_class_rows']}, "
            f"unknown_tokens={stats['unknown_evidence_tokens']}"
        )

    specification = {
        "feature_order": feature_order,
        "class_order": class_order,
        "preprocessing": PREPROCESSING,
        "cleaning": {
            "deduplicate": ["AGE", "SEX", "PATHOLOGY", "EVIDENCES"],
            "age_min": MIN_AGE,
            "age_max": MAX_AGE,
            "allowed_sex": ["M", "F"],
            "min_class_rows": MIN_CLASS_ROWS,
        },
        "split_rows": split_rows,
        "n_train_rows": split_rows["train"],
        "decontamination": decontamination,
    }
    (processed / "feature_spec.json").write_text(
        json.dumps(specification, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"-> {processed / 'feature_spec.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
