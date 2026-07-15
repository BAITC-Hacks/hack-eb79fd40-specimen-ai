#!/usr/bin/env python3
"""Freeze Russian phrases for exactly the selected held-out eval evidences."""

from __future__ import annotations

import argparse
from collections import Counter
import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    from scripts.render_cases import (
        DEFAULT_ARTIFACT,
        DEFAULT_DICTIONARY,
        DEFAULT_PATHOLOGY_MAP,
        DEFAULT_PHRASES,
        DEFAULT_PROCESSED,
        DEFAULT_RAW,
        DEFAULT_SEED,
        file_sha256,
        held_out_candidate_rows,
        load_array,
        load_object,
        pathology_map_by_code,
        required_evidence_keys,
        select_rows,
        validate_inputs,
    )
except ModuleNotFoundError:  # Direct `python scripts/build_eval_phrases.py` execution.
    from render_cases import (  # type: ignore[no-redef]
        DEFAULT_ARTIFACT,
        DEFAULT_DICTIONARY,
        DEFAULT_PATHOLOGY_MAP,
        DEFAULT_PHRASES,
        DEFAULT_PROCESSED,
        DEFAULT_RAW,
        DEFAULT_SEED,
        file_sha256,
        held_out_candidate_rows,
        load_array,
        load_object,
        pathology_map_by_code,
        required_evidence_keys,
        select_rows,
        validate_inputs,
    )

CYRILLIC = re.compile(r"[А-Яа-яЁё]")


def build_phrase_source(
    *,
    raw_dir: Path,
    processed_dir: Path,
    artifact_path: Path,
    dictionary_path: Path,
    pathology_map_path: Path,
    seed: int,
) -> dict[str, Any]:
    artifact = load_object(artifact_path)
    specification_path = processed_dir / "feature_spec.json"
    specification = load_object(specification_path)
    dictionary = load_object(dictionary_path)
    mapping = pathology_map_by_code(load_array(pathology_map_path))
    class_order, dictionary_meta = validate_inputs(
        artifact, specification, dictionary, mapping
    )
    evidence_metadata = load_object(raw_dir / "release_evidences.json")
    candidates, decontamination, frequencies = held_out_candidate_rows(
        raw_dir, class_order, seed
    )
    if decontamination != specification.get("decontamination"):
        raise ValueError("current raw decontamination differs from feature_spec")
    selected = select_rows(
        candidates, class_order, evidence_metadata, frequencies, seed
    )
    keys = sorted(required_evidence_keys(selected))
    curated_base = set(dictionary_meta.get("curated_base_codes", []))
    curated_features = set(dictionary_meta.get("curated_feature_keys", []))
    phrases: dict[str, dict[str, str]] = {}
    source_counts: Counter[str] = Counter()
    for key in keys:
        entry = dictionary.get(key)
        if not isinstance(entry, dict):
            raise KeyError(f"accepted dictionary lacks selected key {key}")
        label = entry.get("label_ru")
        if not isinstance(label, str) or not label.strip():
            raise ValueError(
                f"accepted dictionary has an empty selected phrase for {key}"
            )
        phrase = label.strip()
        if not CYRILLIC.search(phrase):
            raise ValueError(f"selected phrase has no Cyrillic text for {key}")
        base_code = key.split("@", 1)[0]
        source = (
            "manual_reviewed"
            if key in curated_features or ("@" not in key and base_code in curated_base)
            else "deterministic_generator"
        )
        phrases[key] = {"text": phrase, "source": source}
        source_counts[source] += 1

    return {
        "_meta": {
            "schema_version": 1,
            "frozen": True,
            "selected_key_count": len(keys),
            "source_counts": dict(sorted(source_counts.items())),
            "selection": {
                "seed": seed,
                "split": "decontaminated_test",
                "strategy": "top_40_held_out_classes_by_frequency_seeded_min_hash_row",
                "pathologies": sorted(row.pathology for row in selected),
            },
            "generation": {
                "deterministic": True,
                "generator": "scripts/build_eval_phrases.py",
                "source_dictionary": "data/evidences_ru.json",
                "source_dictionary_sha256": file_sha256(dictionary_path),
            },
            "manual_review": {
                "status": "partial",
                "date": "2026-07-14",
                "scope": "selected curated demo evidence phrases only",
                "policy": "every entry records manual_reviewed or deterministic_generator; generated phrases never masquerade as reviewed",
            },
        },
        "phrases": phrases,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--processed-dir", type=Path, default=DEFAULT_PROCESSED)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--dictionary", type=Path, default=DEFAULT_DICTIONARY)
    parser.add_argument("--pathology-map", type=Path, default=DEFAULT_PATHOLOGY_MAP)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out", type=Path, default=DEFAULT_PHRASES)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    value = build_phrase_source(
        raw_dir=args.raw_dir.resolve(),
        processed_dir=args.processed_dir.resolve(),
        artifact_path=args.artifact.resolve(),
        dictionary_path=args.dictionary.resolve(),
        pathology_map_path=args.pathology_map.resolve(),
        seed=args.seed,
    )
    content = (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    output = args.out.resolve()
    if args.check:
        if not output.exists() or output.read_text(encoding="utf-8") != content:
            print(f"STALE eval phrase source: {output}", file=sys.stderr)
            return 1
        print(f"EVAL phrases current: keys={value['_meta']['selected_key_count']}")
        return 0
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(content, encoding="utf-8")
    print(f"-> {output}")
    print(f"EVAL phrases generated: keys={value['_meta']['selected_key_count']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
