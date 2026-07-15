#!/usr/bin/env python3
"""Render the canonical Russian eval cards from decontaminated DDXPlus test rows."""

from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import heapq
import json
import math
import random
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from scripts.build_features import (
        clean_row,
        decontaminate_digest_sets,
        model_row_digests,
        parse_evidences,
        row_digest,
    )
except ModuleNotFoundError:  # Direct `python scripts/render_cases.py` execution.
    from build_features import (  # type: ignore[no-redef]
        clean_row,
        decontaminate_digest_sets,
        model_row_digests,
        parse_evidences,
        row_digest,
    )

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW = ROOT / "data" / "raw"
DEFAULT_PROCESSED = ROOT / "data" / "processed"
DEFAULT_ARTIFACT = ROOT / "models" / "triage-lr-v1.json"
DEFAULT_DICTIONARY = ROOT / "data" / "evidences_ru.json"
DEFAULT_PHRASES = ROOT / "data" / "evidence_phrases_ru.json"
DEFAULT_PATHOLOGY_MAP = ROOT / "data" / "pathology_map.json"
DEFAULT_CANONICAL = ROOT / "eval" / "cases.jsonl"
DEFAULT_MANIFEST = ROOT / "eval" / "manifest.json"
DEFAULT_SEED = 42
RENDERER_VERSION = "ddxplus_ru_structured_v1"
CASE_COUNT = 48
DDX_CASE_COUNT = 40
KIND_COUNTS = {"flat": 28, "dialog": 12, "redflag": 8}
REDFLAG_POSITIVE_COUNT = 5
REDFLAG_NEGATIVE_COUNT = 3
MIN_CANDIDATES_PER_CLASS = 32
REQUIRED_EVIDENCE_TYPES = frozenset({"B", "C", "M"})
GENERIC_QUESTIONS = (
    "Что ещё вы заметили?",
    "Есть ли другие наблюдаемые проявления?",
    "Что ещё важно указать?",
    "Остались ли другие наблюдения?",
)


@dataclass(frozen=True)
class SourceRow:
    raw_row_index: int
    decontaminated_index: int
    age: int
    sex: str
    pathology: str
    raw_evidences: str
    raw_differential: str
    initial_evidence: str
    identity_digest: str
    source_row_sha256: str


@dataclass(frozen=True)
class EvalConfig:
    raw_dir: Path = DEFAULT_RAW
    processed_dir: Path = DEFAULT_PROCESSED
    artifact_path: Path = DEFAULT_ARTIFACT
    dictionary_path: Path = DEFAULT_DICTIONARY
    phrases_path: Path = DEFAULT_PHRASES
    pathology_map_path: Path = DEFAULT_PATHOLOGY_MAP
    canonical_path: Path = DEFAULT_CANONICAL
    manifest_path: Path = DEFAULT_MANIFEST
    seed: int = DEFAULT_SEED


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def load_array(path: Path) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError(f"{path} must contain an array of objects")
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def pretty_json(value: Any) -> str:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )


def source_row_hash(raw: dict[str, str]) -> str:
    fields = {
        key: raw[key]
        for key in (
            "AGE",
            "DIFFERENTIAL_DIAGNOSIS",
            "SEX",
            "PATHOLOGY",
            "EVIDENCES",
            "INITIAL_EVIDENCE",
        )
    }
    return hashlib.sha256(canonical_json(fields).encode("utf-8")).hexdigest()


def selection_score(seed: int, tag: str, row: SourceRow) -> int:
    payload = f"{seed}:{tag}:{row.identity_digest}:{row.source_row_sha256}"
    return int.from_bytes(hashlib.sha256(payload.encode("utf-8")).digest(), "big")


def parse_differential(raw: str) -> list[dict[str, Any]]:
    parsed = ast.literal_eval(raw)
    if not isinstance(parsed, list) or not parsed:
        raise ValueError("DIFFERENTIAL_DIAGNOSIS must be a non-empty list")
    result: list[dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ValueError("invalid DIFFERENTIAL_DIAGNOSIS entry")
        pathology, weight = item
        if not isinstance(pathology, str) or not pathology:
            raise ValueError("differential pathology must be non-empty")
        if not isinstance(weight, (int, float)) or not math.isfinite(float(weight)):
            raise ValueError("differential weight must be finite")
        result.append({"pathology": pathology, "weight": float(weight)})
    return result


def held_out_candidate_rows(
    raw_dir: Path,
    class_order: list[str],
    seed: int,
) -> tuple[dict[str, list[SourceRow]], dict[str, Any], Counter[str]]:
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

    heaps: dict[str, list[tuple[int, int, SourceRow]]] = {
        pathology: [] for pathology in class_order
    }
    seen: set[bytes] = set()
    frequencies: Counter[str] = Counter()
    accepted_index = 0
    csv.field_size_limit(sys.maxsize)
    source_path = raw_dir / "release_test_patients.csv"
    with source_path.open(encoding="utf-8", newline="") as source:
        for raw_index, raw in enumerate(csv.DictReader(source)):
            cleaned = clean_row(raw)
            if cleaned is None:
                continue
            digest = row_digest(cleaned)
            if digest in seen or digest in excluded_test:
                continue
            seen.add(digest)
            if cleaned[2] not in class_set:
                continue
            row = SourceRow(
                raw_row_index=raw_index,
                decontaminated_index=accepted_index,
                age=cleaned[0],
                sex=cleaned[1],
                pathology=cleaned[2],
                raw_evidences=cleaned[3],
                raw_differential=raw["DIFFERENTIAL_DIAGNOSIS"],
                initial_evidence=raw["INITIAL_EVIDENCE"],
                identity_digest=digest.hex(),
                source_row_sha256=source_row_hash(raw),
            )
            accepted_index += 1
            frequencies[row.pathology] += 1
            score = selection_score(seed, "candidate", row)
            heap = heaps[row.pathology]
            entry = (-score, -raw_index, row)
            if len(heap) < MIN_CANDIDATES_PER_CLASS:
                heapq.heappush(heap, entry)
            elif entry > heap[0]:
                heapq.heapreplace(heap, entry)

    expected_rows = report["after_rows"]["test"]
    if accepted_index != expected_rows:
        raise ValueError(
            f"decontaminated test rows differ: raw={accepted_index}, report={expected_rows}"
        )
    candidates: dict[str, list[SourceRow]] = {}
    for pathology in class_order:
        if not heaps[pathology]:
            raise ValueError(f"held-out split has no row for {pathology}")
        candidates[pathology] = [
            entry[2]
            for entry in sorted(
                heaps[pathology],
                key=lambda item: (-item[0], -item[1]),
            )
        ]
    return candidates, report, frequencies


def evidence_types(
    rows: list[SourceRow], evidence_metadata: dict[str, Any]
) -> set[str]:
    result: set[str] = set()
    for row in rows:
        for code, _value in parse_evidences(row.raw_evidences):
            metadata = evidence_metadata.get(code)
            if not isinstance(metadata, dict):
                raise ValueError(f"source evidence metadata lacks {code}")
            data_type = metadata.get("data_type")
            if not isinstance(data_type, str):
                raise ValueError(f"source evidence {code} lacks data_type")
            result.add(data_type)
    return result


def select_rows(
    candidates: dict[str, list[SourceRow]],
    class_order: list[str],
    evidence_metadata: dict[str, Any],
    frequencies: Counter[str],
    seed: int,
) -> list[SourceRow]:
    class_index = {pathology: index for index, pathology in enumerate(class_order)}
    covered_classes = sorted(
        class_order,
        key=lambda pathology: (-frequencies[pathology], class_index[pathology]),
    )[:DDX_CASE_COUNT]
    selected = [candidates[pathology][0] for pathology in covered_classes]

    if len({row.identity_digest for row in selected}) != DDX_CASE_COUNT:
        raise ValueError("eval selection contains duplicate source identities")
    if len({row.pathology for row in selected}) != DDX_CASE_COUNT:
        raise ValueError("eval selection must cover forty distinct model classes")
    if {row.sex for row in selected} != {"M", "F"}:
        raise ValueError("eval selection must cover both source sex values")
    covered_types = evidence_types(selected, evidence_metadata)
    if not REQUIRED_EVIDENCE_TYPES.issubset(covered_types):
        raise ValueError(
            f"eval selection lacks evidence types {sorted(REQUIRED_EVIDENCE_TYPES - covered_types)}"
        )
    return selected


def assign_kinds(
    rows: list[SourceRow],
    seed: int,
) -> dict[str, str]:
    assignments: dict[str, str] = {}
    remaining = sorted(rows, key=lambda row: selection_score(seed, "dialog", row))
    dialog_candidates = [
        row for row in remaining if len(parse_evidences(row.raw_evidences)) >= 3
    ]
    if len(dialog_candidates) < KIND_COUNTS["dialog"]:
        raise ValueError("selected rows cannot supply twelve multi-turn dialogs")
    for row in dialog_candidates[: KIND_COUNTS["dialog"]]:
        assignments[row.identity_digest] = "dialog"
    for row in remaining:
        assignments.setdefault(row.identity_digest, "flat")
    counts = Counter(assignments.values())
    expected = Counter({"flat": KIND_COUNTS["flat"], "dialog": KIND_COUNTS["dialog"]})
    if counts != expected:
        raise ValueError(f"eval kind composition differs: {dict(counts)}")
    return assignments


def evidence_key(code: str, value: str | None) -> str:
    return code if value is None else f"{code}@{value}"


def required_evidence_keys(rows: list[SourceRow]) -> set[str]:
    return {
        evidence_key(code, value)
        for row in rows
        for code, value in parse_evidences(row.raw_evidences)
    }


def validate_phrase_source(
    value: dict[str, Any], required_keys: set[str]
) -> tuple[dict[str, str], dict[str, Any]]:
    metadata = value.get("_meta")
    phrases = value.get("phrases")
    if not isinstance(metadata, dict) or metadata.get("frozen") is not True:
        raise ValueError("evidence phrase source must be frozen")
    review = metadata.get("manual_review")
    generation = metadata.get("generation")
    if not isinstance(review, dict) or review.get("status") not in {
        "partial",
        "complete",
    }:
        raise ValueError("evidence phrase source must record manual review status")
    if not isinstance(generation, dict) or generation.get("deterministic") is not True:
        raise ValueError("evidence phrase source must record deterministic generation")
    if not isinstance(phrases, dict):
        raise ValueError("evidence phrase source must contain a phrases object")
    actual_keys = set(phrases)
    missing = sorted(required_keys - actual_keys)
    unknown = sorted(actual_keys - required_keys)
    if missing:
        raise KeyError(f"evidence phrase source lacks selected keys: {missing}")
    if unknown:
        raise KeyError(f"evidence phrase source has unknown selected keys: {unknown}")
    if metadata.get("selected_key_count") != len(required_keys):
        raise ValueError("evidence phrase selected_key_count differs from selection")
    result: dict[str, str] = {}
    source_counts: Counter[str] = Counter()
    for key, entry in phrases.items():
        if not isinstance(entry, dict):
            raise ValueError(f"evidence phrase entry must be an object for {key}")
        phrase = entry.get("text")
        source = entry.get("source")
        if source not in {"manual_reviewed", "deterministic_generator"}:
            raise ValueError(f"evidence phrase source is invalid for {key}")
        if not isinstance(phrase, str) or not phrase.strip():
            raise ValueError(f"evidence phrase is empty for {key}")
        result[key] = phrase.strip()
        source_counts[source] += 1
    if metadata.get("source_counts") != dict(sorted(source_counts.items())):
        raise ValueError("evidence phrase source_counts differ from entries")
    return result, metadata


def evidence_payloads(
    row: SourceRow,
    phrases: dict[str, str],
) -> tuple[list[dict[str, Any]], list[str]]:
    gold: list[dict[str, Any]] = []
    labels: list[str] = []
    for code, value in parse_evidences(row.raw_evidences):
        key = evidence_key(code, value)
        label = phrases.get(key)
        if not isinstance(label, str) or not label.strip():
            raise KeyError(f"evidence phrase source lacks {key}")
        gold.append({"code": code} if value is None else {"code": code, "value": value})
        labels.append(label.strip())
    if not gold:
        raise ValueError("source row has no evidences")
    return gold, labels


def row_rng(seed: int, row: SourceRow, kind: str) -> random.Random:
    payload = f"{seed}:{kind}:{row.identity_digest}"
    value = int.from_bytes(hashlib.sha256(payload.encode("utf-8")).digest()[:8], "big")
    return random.Random(value)


def age_sex_text(row: SourceRow) -> str:
    sex_ru = "мужчина" if row.sex == "M" else "женщина"
    return f"Мне {row.age} лет, {sex_ru}."


def render_flat(row: SourceRow, labels: list[str], seed: int) -> list[dict[str, str]]:
    ordered = list(labels)
    row_rng(seed, row, "flat").shuffle(ordered)
    content = f"{age_sex_text(row)} Отмечаю: {'; '.join(ordered)}."
    return [
        {"role": "assistant", "content": "Здравствуйте! Что вас беспокоит?"},
        {"role": "user", "content": content},
    ]


def chunks(values: list[str], count: int) -> list[list[str]]:
    return [values[index::count] for index in range(count)]


def render_dialog(row: SourceRow, labels: list[str], seed: int) -> list[dict[str, str]]:
    ordered = list(labels)
    rng = row_rng(seed, row, "dialog")
    rng.shuffle(ordered)
    turn_count = min(5, max(3, len(ordered) // 4 + 1))
    groups = chunks(ordered, turn_count)
    if any(not group for group in groups):
        raise ValueError("dialog renderer produced an empty patient turn")
    messages = [
        {"role": "assistant", "content": "Здравствуйте! Что вас беспокоит?"},
        {
            "role": "user",
            "content": f"{age_sex_text(row)} Отмечаю: {'; '.join(groups[0])}.",
        },
    ]
    for index, group in enumerate(groups[1:]):
        messages.extend(
            [
                {
                    "role": "assistant",
                    "content": GENERIC_QUESTIONS[
                        (index + row.raw_row_index) % len(GENERIC_QUESTIONS)
                    ],
                },
                {"role": "user", "content": f"Также отмечаю: {'; '.join(group)}."},
            ]
        )
    return messages


def pathology_map_by_code(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        pathology = row.get("pathology")
        urgency = row.get("urgency")
        specialty = row.get("specialty")
        alternatives = row.get("specialty_alt")
        if not isinstance(pathology, str) or not pathology or pathology in result:
            raise ValueError("pathology map has invalid or duplicate pathology")
        if urgency not in {"routine", "planned", "urgent", "emergency"}:
            raise ValueError(f"pathology map has invalid urgency for {pathology}")
        if not isinstance(specialty, str) or not specialty:
            raise ValueError(f"pathology map has invalid specialty for {pathology}")
        if not isinstance(alternatives, list) or not all(
            isinstance(value, str) and value for value in alternatives
        ):
            raise ValueError(f"pathology map has invalid specialty_alt for {pathology}")
        if row.get("validated") is not False:
            raise ValueError(
                "task 4.1 expects the routing map to remain explicitly unvalidated"
            )
        result[pathology] = row
    return result


def specialty_set(
    pathology: str,
    differential: list[dict[str, Any]],
    mapping: dict[str, dict[str, Any]],
) -> list[str]:
    pathologies = [pathology, *(item["pathology"] for item in differential)]
    specialties: set[str] = set()
    for code in pathologies:
        if code not in mapping:
            raise KeyError(f"pathology map lacks differential entry {code}")
        specialties.add(mapping[code]["specialty"])
        specialties.update(mapping[code]["specialty_alt"])
    return sorted(specialties)


def build_manual_safety_cases(seed: int) -> list[dict[str, Any]]:
    definitions = [
        (
            "rf-01",
            [
                {"role": "assistant", "content": "Что вас беспокоит?"},
                {
                    "role": "user",
                    "content": "Давит в груди и появилась одышка в покое.",
                },
            ],
            ["chest_pain", "dyspnea_rest"],
            ["кардиология"],
            True,
        ),
        (
            "rf-02",
            [
                {"role": "assistant", "content": "Что произошло?"},
                {
                    "role": "user",
                    "content": "Внезапно перекосило лицо и речь нарушена.",
                },
            ],
            ["stroke"],
            ["неврология"],
            True,
        ),
        (
            "rf-03",
            [
                {"role": "assistant", "content": "Опишите жалобу."},
                {"role": "user", "content": "Сегодня началась рвота с кровью."},
            ],
            ["bleeding"],
            ["скорая/приёмный покой"],
            True,
        ),
        (
            "rf-04",
            [
                {"role": "assistant", "content": "Как началась боль?"},
                {
                    "role": "user",
                    "content": "Как удар в голову, началась сильнейшая головная боль.",
                },
            ],
            ["thunderclap_headache"],
            ["неврология"],
            True,
        ),
        (
            "rf-05",
            [
                {"role": "assistant", "content": "Что случилось?"},
                {"role": "user", "content": "Потерял сознание, затем были судороги."},
            ],
            ["consciousness"],
            ["неврология"],
            True,
        ),
        (
            "rf-06",
            [
                {"role": "assistant", "content": "Есть боль или одышка?"},
                {"role": "user", "content": "В груди не болит, одышки нет."},
            ],
            [],
            [],
            False,
        ),
        (
            "rf-07",
            [
                {"role": "assistant", "content": "Болит ли грудь?"},
                {"role": "user", "content": "Нет."},
            ],
            [],
            [],
            False,
        ),
        (
            "rf-08",
            [
                {"role": "assistant", "content": "Опишите ощущение."},
                {"role": "user", "content": "Сердце щемит от волнения, боли нет."},
            ],
            [],
            [],
            False,
        ),
    ]
    cases = []
    for (
        case_id,
        messages,
        red_flag_codes,
        specialties,
        emergency_expected,
    ) in definitions:
        cases.append(
            {
                "id": case_id,
                "kind": "redflag",
                "lang": "ru",
                "messages": messages,
                "gold": {
                    "pathology": None,
                    "red_flag_codes": red_flag_codes,
                    "emergency_expected": emergency_expected,
                    "urgency": "emergency" if emergency_expected else "routine",
                    "specialty_set": specialties,
                    "origins": {
                        "manual_safety": [
                            "red_flag_codes",
                            "emergency_expected",
                            "urgency",
                            "specialty_set",
                        ]
                    },
                },
                "provenance": {
                    "dataset": "manual_safety_fixtures",
                    "split": "manual_chapter_09_exception",
                    "renderer": "manual_safety_v1",
                    "source": "handwritten_chapter_09_sets_P_N",
                    "seed": seed,
                },
            }
        )
    return cases


def build_case(
    row: SourceRow,
    kind: str,
    phrases: dict[str, str],
    mapping: dict[str, dict[str, Any]],
    seed: int,
) -> dict[str, Any]:
    evidences, labels = evidence_payloads(row, phrases)
    differential = parse_differential(row.raw_differential)
    urgency = mapping[row.pathology]["urgency"]
    if kind == "flat":
        messages = render_flat(row, labels, seed)
    elif kind == "dialog":
        messages = render_dialog(row, labels, seed)
    else:
        raise ValueError(f"unknown eval kind {kind}")
    return {
        "id": f"ddx-{row.identity_digest[:16]}",
        "kind": kind,
        "lang": "ru",
        "messages": messages,
        "gold": {
            "pathology": row.pathology,
            "differential": [item["pathology"] for item in differential],
            "differential_weights": differential,
            "evidences": evidences,
            "age": row.age,
            "sex": "m" if row.sex == "M" else "f",
            "initial_evidence": row.initial_evidence,
            "specialty_set": specialty_set(row.pathology, differential, mapping),
            "urgency": urgency,
            "emergency_expected": urgency == "emergency",
            "origins": {
                "native_ddxplus": [
                    "pathology",
                    "differential",
                    "differential_weights",
                    "evidences",
                    "age",
                    "sex",
                    "initial_evidence",
                ],
                "pathology_map_unvalidated": [
                    "specialty_set",
                    "urgency",
                    "emergency_expected",
                ],
            },
        },
        "provenance": {
            "dataset": "DDXPlus",
            "source_split": "test",
            "split": "decontaminated_test",
            "raw_row_index": row.raw_row_index,
            "decontaminated_index": row.decontaminated_index,
            "identity_digest_blake2b16": row.identity_digest,
            "source_row_sha256": row.source_row_sha256,
            "renderer": RENDERER_VERSION,
            "seed": seed,
        },
    }


def validate_inputs(
    artifact: dict[str, Any],
    specification: dict[str, Any],
    dictionary: dict[str, Any],
    mapping: dict[str, dict[str, Any]],
) -> tuple[list[str], dict[str, Any]]:
    class_order = artifact.get("class_order")
    feature_order = artifact.get("feature_order")
    if not isinstance(class_order, list) or not all(
        isinstance(item, str) and item for item in class_order
    ):
        raise ValueError("artifact class_order is invalid")
    if len(class_order) != len(set(class_order)):
        raise ValueError("artifact class_order contains duplicates")
    if len(class_order) >= CASE_COUNT:
        raise ValueError("48-card set cannot cover every class plus an extra row")
    if specification.get("class_order") != class_order:
        raise ValueError("feature_spec class_order differs from final artifact")
    if specification.get("feature_order") != feature_order:
        raise ValueError("feature_spec feature_order differs from final artifact")
    if specification.get("preprocessing") != artifact.get("preprocessing"):
        raise ValueError("feature_spec preprocessing differs from final artifact")
    if set(mapping) != set(class_order):
        raise ValueError("pathology map must exactly match final class_order")
    dictionary_meta = dictionary.get("_meta")
    if (
        not isinstance(dictionary_meta, dict)
        or dictionary_meta.get("frozen") is not True
    ):
        raise ValueError("evidence dictionary must be frozen")
    return class_order, dictionary_meta


def build_outputs(config: EvalConfig) -> tuple[str, str, dict[str, Any]]:
    artifact = load_object(config.artifact_path)
    specification_path = config.processed_dir / "feature_spec.json"
    specification = load_object(specification_path)
    dictionary = load_object(config.dictionary_path)
    mapping_rows = load_array(config.pathology_map_path)
    mapping = pathology_map_by_code(mapping_rows)
    class_order, dictionary_meta = validate_inputs(
        artifact, specification, dictionary, mapping
    )
    evidence_metadata = load_object(config.raw_dir / "release_evidences.json")
    candidates, decontamination, frequencies = held_out_candidate_rows(
        config.raw_dir, class_order, config.seed
    )
    if decontamination != specification.get("decontamination"):
        raise ValueError("current raw decontamination differs from feature_spec")
    selected = select_rows(
        candidates, class_order, evidence_metadata, frequencies, config.seed
    )
    phrase_source = load_object(config.phrases_path)
    phrases, phrase_meta = validate_phrase_source(
        phrase_source, required_evidence_keys(selected)
    )
    assignments = assign_kinds(selected, config.seed)
    ddx_cases = [
        build_case(
            row,
            assignments[row.identity_digest],
            phrases,
            mapping,
            config.seed,
        )
        for row in selected
    ]
    cases = [*ddx_cases, *build_manual_safety_cases(config.seed)]
    cases.sort(key=lambda case: (case["kind"], case["id"]))

    canonical_content = "\n".join(canonical_json(case) for case in cases) + "\n"
    redflag_cases = [case for case in cases if case["kind"] == "redflag"]
    positive_ids = sorted(
        case["id"] for case in redflag_cases if case["gold"]["emergency_expected"]
    )
    negative_ids = sorted(
        case["id"] for case in redflag_cases if not case["gold"]["emergency_expected"]
    )
    all_evidence_keys = {
        evidence_key(item["code"], item.get("value"))
        for case in ddx_cases
        for item in case["gold"]["evidences"]
    }
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "generator": "scripts/render_cases.py",
        "renderer_version": RENDERER_VERSION,
        "seed": config.seed,
        "split": "decontaminated_test",
        "selection": {
            "count": len(cases),
            "strategy": "top_40_held_out_classes_by_frequency_seeded_min_hash_row",
            "n_by_kind": dict(sorted(Counter(case["kind"] for case in cases).items())),
            "raw_row_indices": sorted(
                case["provenance"]["raw_row_index"] for case in ddx_cases
            ),
        },
        "sets": {
            "P": {
                "count": len(positive_ids),
                "case_ids": positive_ids,
                "label_source": "manual_chapter_09_safety_exception",
            },
            "N": {
                "count": len(negative_ids),
                "case_ids": negative_ids,
                "label_source": "manual_chapter_09_safety_exception",
            },
            "F": {
                "count": "at_least_28",
                "location": "tests/fixtures/redflags.fixtures.ts",
                "included_in_cases": False,
            },
        },
        "coverage": {
            "class_count": len({case["gold"]["pathology"] for case in ddx_cases}),
            "model_label_space_count": len(class_order),
            "classes": sorted({case["gold"]["pathology"] for case in ddx_cases}),
            "sex": sorted({case["gold"]["sex"] for case in ddx_cases}),
            "evidence_feature_count": len(all_evidence_keys),
            "evidence_types": sorted(evidence_types(selected, evidence_metadata)),
            "urgency": dict(
                sorted(Counter(case["gold"]["urgency"] for case in cases).items())
            ),
            "emergency_expected": dict(
                sorted(
                    Counter(
                        str(case["gold"]["emergency_expected"]).lower()
                        for case in cases
                    ).items()
                )
            ),
        },
        "artifact": {
            "path": "eval/cases.jsonl",
            "format": "jsonl",
            "sha256": hashlib.sha256(canonical_content.encode("utf-8")).hexdigest(),
        },
        "source": {
            "path": "data/raw/release_test_patients.csv",
            "sha256": file_sha256(config.raw_dir / "release_test_patients.csv"),
            "input_sha256": {
                split: file_sha256(config.raw_dir / f"release_{split}_patients.csv")
                for split in ("train", "validate", "test")
            },
            "decontamination": decontamination,
            "selected_identity_sha256": hashlib.sha256(
                "\n".join(sorted(row.identity_digest for row in selected)).encode(
                    "ascii"
                )
            ).hexdigest(),
        },
        "dependencies": {
            "artifact": {
                "path": "models/triage-lr-v1.json",
                "sha256": file_sha256(config.artifact_path),
                "model_version": artifact.get("model_version"),
                "dataset_sha256": artifact.get("dataset_sha256"),
            },
            "dictionary": {
                "path": "data/evidences_ru.json",
                "sha256": file_sha256(config.dictionary_path),
                "source": dictionary_meta.get("source"),
                "feature_order_source": dictionary_meta.get("feature_order_source"),
            },
            "evidence_phrases": {
                "path": "data/evidence_phrases_ru.json",
                "sha256": file_sha256(config.phrases_path),
                "selected_key_count": phrase_meta.get("selected_key_count"),
                "source_counts": phrase_meta.get("source_counts"),
                "generation": phrase_meta.get("generation"),
                "manual_review": phrase_meta.get("manual_review"),
            },
            "pathology_map": {
                "path": "data/pathology_map.json",
                "sha256": file_sha256(config.pathology_map_path),
                "validated": False,
            },
            "feature_spec": {
                "path": "data/processed/feature_spec.json",
                "sha256": file_sha256(specification_path),
            },
            "renderer": {
                "path": "scripts/render_cases.py",
                "sha256": file_sha256(Path(__file__).resolve()),
            },
        },
        "methodology": {
            "case_text": "mechanical_templates_plus_frozen_selected_evidence_phrases",
            "native_gold": [
                "pathology",
                "differential",
                "differential_weights",
                "evidences",
                "age",
                "sex",
                "initial_evidence",
            ],
            "derived_not_medical_gold": [
                "specialty_set",
                "urgency",
                "emergency_expected",
            ],
            "limitations": [
                "pathology_map rows are not clinician-validated",
                "pathology-derived routing and urgency fields are table-dependent",
                "eight safety cards are the explicit manual chapter 09 exception",
                "phrase provenance distinguishes manual review from deterministic generation; neither is clinician validation",
            ],
            "llm_used_for_generation_or_labeling": False,
            "manual_case_labeling": True,
            "manual_case_labeling_scope": "five positive and three negative safety cards only",
            "pii_fields": [],
        },
    }
    manifest_content = pretty_json(manifest)
    return canonical_content, manifest_content, manifest


def write_or_check(path: Path, content: str, check: bool) -> bool:
    if check:
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            print(f"STALE eval artifact: {path}", file=sys.stderr)
            return False
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print(f"-> {path}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--processed-dir", type=Path, default=DEFAULT_PROCESSED)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--dictionary", type=Path, default=DEFAULT_DICTIONARY)
    parser.add_argument("--phrases", type=Path, default=DEFAULT_PHRASES)
    parser.add_argument("--pathology-map", type=Path, default=DEFAULT_PATHOLOGY_MAP)
    parser.add_argument("--out", type=Path, default=DEFAULT_CANONICAL)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    config = EvalConfig(
        raw_dir=args.raw_dir.resolve(),
        processed_dir=args.processed_dir.resolve(),
        artifact_path=args.artifact.resolve(),
        dictionary_path=args.dictionary.resolve(),
        phrases_path=args.phrases.resolve(),
        pathology_map_path=args.pathology_map.resolve(),
        canonical_path=args.out.resolve(),
        manifest_path=args.manifest.resolve(),
        seed=args.seed,
    )
    canonical, manifest_content, manifest = build_outputs(config)
    current = all(
        (
            write_or_check(config.canonical_path, canonical, args.check),
            write_or_check(config.manifest_path, manifest_content, args.check),
        )
    )
    if args.check and not current:
        return 1
    action = "current" if args.check else "generated"
    print(
        f"EVAL {action}: cards={manifest['selection']['count']}, "
        f"classes={manifest['coverage']['class_count']}, seed={manifest['seed']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
