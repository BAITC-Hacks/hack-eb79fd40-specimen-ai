#!/usr/bin/env python3
"""Export the deterministic Python train-time -> TypeScript parity fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
from scipy import sparse

try:
    from scripts.build_features import (
        decontaminate_digest_sets,
        iter_clean_unique,
        model_row_digests,
        parse_evidences,
        row_digest,
    )
except ModuleNotFoundError:  # Direct `python scripts/export_parity_fixture.py` execution.
    from build_features import (  # type: ignore[no-redef]
        decontaminate_digest_sets,
        iter_clean_unique,
        model_row_digests,
        parse_evidences,
        row_digest,
    )

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW = ROOT / "data" / "raw"
DEFAULT_PROCESSED = ROOT / "data" / "processed"
DEFAULT_ARTIFACT = ROOT / "models" / "triage-lr-v1.json"
DEFAULT_DICTIONARY = ROOT / "data" / "evidences_ru.json"
DEFAULT_OUTPUT = ROOT / "tests" / "fixtures" / "parity.golden.jsonl"
MIN_CASES = 100
DEFAULT_CASES = 150
DEFAULT_SEED = 0
REQUIRED_EVIDENCE_TYPES = frozenset({"B", "C", "M"})

CleanRow = tuple[int, str, str, str]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def held_out_rows(
    raw_dir: Path,
    class_order: list[str],
) -> list[CleanRow]:
    class_set = set(class_order)
    source_digests = {
        split: model_row_digests(
            raw_dir / f"release_{split}_patients.csv",
            class_set,
        )
        for split in ("train", "validate", "test")
    }
    accepted, report = decontaminate_digest_sets(source_digests)
    if any(report["pairwise_overlap_after"].values()):
        raise ValueError("held-out source still overlaps another split")
    excluded_test = source_digests["test"] - accepted["test"]
    return [
        row
        for row in iter_clean_unique(
            raw_dir / "release_test_patients.csv",
            excluded_test,
        )
        if row[2] in class_set
    ]


def stable_probabilities(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exponentials = np.exp(shifted)
    return exponentials / exponentials.sum(axis=1, keepdims=True)


def row_evidence_types(
    row: CleanRow,
    evidence_metadata: dict[str, dict[str, Any]],
) -> set[str]:
    result: set[str] = set()
    for code, _value in parse_evidences(row[3]):
        data_type = evidence_metadata.get(code, {}).get("data_type")
        if isinstance(data_type, str):
            result.add(data_type)
    return result


def select_indices(
    *,
    labels: np.ndarray,
    predicted: np.ndarray,
    rows: list[CleanRow],
    class_count: int,
    evidence_metadata: dict[str, dict[str, Any]],
    count: int,
    seed: int,
) -> list[int]:
    if count < MIN_CASES:
        raise ValueError(f"parity fixture needs at least {MIN_CASES} cases")
    if count > len(rows):
        raise ValueError(f"requested {count} cases from only {len(rows)} held-out rows")
    if labels.shape != predicted.shape or len(labels) != len(rows):
        raise ValueError("held-out rows, labels, and predictions are not aligned")

    selected: set[int] = set()
    for class_index in range(class_count):
        candidates = np.flatnonzero(
            (labels == class_index) & (predicted == class_index)
        )
        if candidates.size == 0:
            raise ValueError(
                f"class {class_index} has no correctly predicted held-out representative"
            )
        selected.add(int(candidates[0]))

    requirements: list[tuple[str, Any]] = [
        ("sex_m", lambda index: rows[index][1] == "M"),
        ("sex_f", lambda index: rows[index][1] == "F"),
    ]
    for data_type in sorted(REQUIRED_EVIDENCE_TYPES):
        requirements.append(
            (
                f"evidence_type_{data_type}",
                lambda index, expected=data_type: expected
                in row_evidence_types(rows[index], evidence_metadata),
            )
        )
    for name, predicate in requirements:
        if any(predicate(index) for index in selected):
            continue
        candidate = next(
            (index for index in range(len(rows)) if predicate(index)),
            None,
        )
        if candidate is None:
            raise ValueError(f"held-out split does not cover {name}")
        selected.add(candidate)

    if len(selected) > count:
        raise ValueError("required parity coverage exceeds requested case count")
    remaining = np.asarray(
        [index for index in range(len(rows)) if index not in selected],
        dtype=np.int64,
    )
    needed = count - len(selected)
    if needed:
        rng = np.random.default_rng(seed)
        selected.update(map(int, rng.choice(remaining, size=needed, replace=False)))
    return sorted(selected)


def evidence_vector(row: CleanRow) -> dict[str, Any]:
    age, sex, _pathology, raw_evidences = row
    evidences = [
        {"code": code} if value is None else {"code": code, "value": value}
        for code, value in parse_evidences(raw_evidences)
    ]
    return {
        "evidences": evidences,
        "age": age,
        "sex": "m" if sex == "M" else "f",
    }


def json_line(value: dict[str, Any]) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def build_fixture(
    *,
    raw_dir: Path,
    processed_dir: Path,
    artifact_path: Path,
    dictionary_path: Path,
    count: int,
    seed: int,
) -> tuple[str, dict[str, Any]]:
    artifact = load_json(artifact_path)
    specification_path = processed_dir / "feature_spec.json"
    specification = load_json(specification_path)
    feature_order = artifact.get("feature_order")
    class_order = artifact.get("class_order")
    if not isinstance(feature_order, list) or not all(
        isinstance(value, str) for value in feature_order
    ):
        raise ValueError("artifact feature_order is invalid")
    if not isinstance(class_order, list) or not all(
        isinstance(value, str) for value in class_order
    ):
        raise ValueError("artifact class_order is invalid")
    if specification.get("feature_order") != feature_order:
        raise ValueError("feature_spec feature_order differs from final artifact")
    if specification.get("class_order") != class_order:
        raise ValueError("feature_spec class_order differs from final artifact")
    if specification.get("preprocessing") != artifact.get("preprocessing"):
        raise ValueError("feature_spec preprocessing differs from final artifact")
    after_rows = specification.get("decontamination", {}).get("after_rows", {})

    matrix = sparse.load_npz(processed_dir / "X_test.npz").tocsr()
    labels = np.load(processed_dir / "y_test.npy")
    rows = held_out_rows(raw_dir, class_order)
    expected_shape = (len(rows), len(feature_order))
    if matrix.shape != expected_shape or labels.shape != (len(rows),):
        raise ValueError(
            f"processed held-out shapes {matrix.shape}/{labels.shape} "
            f"do not match raw decontaminated shape {expected_shape}"
        )
    if after_rows.get("test") != len(rows):
        raise ValueError("feature_spec held-out row count is stale")

    weights = np.asarray(artifact.get("weights"), dtype=np.float64)
    bias = np.asarray(artifact.get("bias"), dtype=np.float64)
    if weights.shape != (len(class_order), len(feature_order)):
        raise ValueError("artifact weights have the wrong shape")
    if bias.shape != (len(class_order),):
        raise ValueError("artifact bias has the wrong shape")
    all_logits = np.asarray(matrix @ weights.T) + bias
    all_probabilities = stable_probabilities(all_logits)
    predicted = all_probabilities.argmax(axis=1)

    evidence_metadata = load_json(raw_dir / "release_evidences.json")
    selected = select_indices(
        labels=labels,
        predicted=predicted,
        rows=rows,
        class_count=len(class_order),
        evidence_metadata=evidence_metadata,
        count=count,
        seed=seed,
    )
    ground_truth_coverage = sorted({class_order[int(labels[index])] for index in selected})
    argmax_coverage = sorted({class_order[int(predicted[index])] for index in selected})
    sex_coverage = sorted({evidence_vector(rows[index])["sex"] for index in selected})
    type_coverage = sorted(
        set().union(
            *(row_evidence_types(rows[index], evidence_metadata) for index in selected)
        )
    )
    if ground_truth_coverage != sorted(class_order):
        raise ValueError("selected rows do not cover every ground-truth class")
    if argmax_coverage != sorted(class_order):
        raise ValueError("selected rows do not cover every predicted class")
    if sex_coverage != ["f", "m"]:
        raise ValueError("selected rows do not cover both sex columns")
    if not REQUIRED_EVIDENCE_TYPES.issubset(type_coverage):
        raise ValueError("selected rows do not cover B/C/M evidence encoding")

    manifest: dict[str, Any] = {
        "kind": "manifest",
        "schema_version": 1,
        "generator": "scripts/export_parity_fixture.py",
        "split": "decontaminated_test",
        "selection": {
            "count": len(selected),
            "seed": seed,
            "strategy": "first_correct_per_class_then_coverage_then_seeded_sample",
        },
        "coverage": {
            "class_count": len(class_order),
            "ground_truth": ground_truth_coverage,
            "argmax": argmax_coverage,
            "sex": sex_coverage,
            "evidence_types": type_coverage,
        },
        "source": {
            "path": "data/raw/release_test_patients.csv",
            "sha256": file_sha256(raw_dir / "release_test_patients.csv"),
            "decontaminated_rows": len(rows),
        },
        "artifact": {
            "path": "models/triage-lr-v1.json",
            "sha256": file_sha256(artifact_path),
            "model_version": artifact.get("model_version"),
        },
        "dictionary": {
            "path": "data/evidences_ru.json",
            "sha256": file_sha256(dictionary_path),
        },
        "feature_spec": {
            "path": "data/processed/feature_spec.json",
            "sha256": file_sha256(specification_path),
        },
        "feature_order": feature_order,
        "class_order": class_order,
    }

    lines = [json_line(manifest)]
    for index in selected:
        vector = np.asarray(matrix.getrow(index).toarray()[0], dtype=np.float64)
        logits = np.asarray(all_logits[index], dtype=np.float64)
        probabilities = np.asarray(all_probabilities[index], dtype=np.float64)
        ranking = np.argsort(-probabilities, kind="stable")
        row = rows[index]
        lines.append(
            json_line(
                {
                    "kind": "case",
                    "id": f"test-{index:06d}",
                    "provenance": {
                        "split": "decontaminated_test",
                        "test_index": index,
                        "row_digest": row_digest(row).hex(),
                        "selection_seed": seed,
                        "ground_truth": row[2],
                        "ground_truth_index": int(labels[index]),
                    },
                    "evidence_vector": evidence_vector(row),
                    "expected": {
                        "vector": vector.tolist(),
                        "logits": logits.tolist(),
                        "probabilities": probabilities.tolist(),
                        "argmax": class_order[int(ranking[0])],
                        "top3": [class_order[int(value)] for value in ranking[:3]],
                    },
                }
            )
        )
    content = "\n".join(lines) + "\n"
    return content, manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--processed-dir", type=Path, default=DEFAULT_PROCESSED)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--dictionary", type=Path, default=DEFAULT_DICTIONARY)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--n", type=int, default=DEFAULT_CASES)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content, manifest = build_fixture(
        raw_dir=args.raw_dir.resolve(),
        processed_dir=args.processed_dir.resolve(),
        artifact_path=args.artifact.resolve(),
        dictionary_path=args.dictionary.resolve(),
        count=args.n,
        seed=args.seed,
    )
    output = args.out.resolve()
    if args.check:
        if not output.exists() or output.read_text(encoding="utf-8") != content:
            print(f"STALE parity fixture: {output}", file=sys.stderr)
            return 1
        print(f"parity fixture is deterministic and current: {output}")
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(content, encoding="utf-8")
        print(f"-> {output}")
    print(
        "PARITY FIXTURE: "
        f"rows={manifest['selection']['count']}, "
        f"classes={manifest['coverage']['class_count']}, "
        f"seed={manifest['selection']['seed']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
