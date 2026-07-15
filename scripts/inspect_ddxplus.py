#!/usr/bin/env python3
"""Inspect downloaded DDXPlus files and report only facts derived from them."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from build_features import (
    MIN_CLASS_ROWS,
    build_feature_order,
    iter_clean_unique,
    row_digest,
)

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW = ROOT / "data" / "raw"
DEFAULT_REPORT = ROOT / "reports" / "ddxplus_inspect.md"
DEMO_PROBES = {
    "demo1_chest_pain": [r"chest", r"angin", r"coronar", r"infarct", r"thorac", r"pulmonary embol"],
    "demo2_low_back": [r"back", r"lombair", r"lumbar", r"spine", r"dorsal", r"sciatic"],
    "demo3_common_cold": [r"common cold", r"rhinit", r"coryza", r"urti", r"upper respiratory", r"influenza"],
}


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def count_csv(path: Path) -> tuple[int, Counter[str], list[str], dict[str, int]]:
    csv.field_size_limit(sys.maxsize)
    counts: Counter[str] = Counter()
    max_age: dict[str, int] = {}
    with path.open(encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        columns = reader.fieldnames or []
        rows = 0
        for row in reader:
            rows += 1
            pathology = row.get("PATHOLOGY", "")
            counts[pathology] += 1
            try:
                age = int(row.get("AGE", ""))
            except ValueError:
                continue
            max_age[pathology] = max(age, max_age.get(pathology, age))
    return rows, counts, columns, max_age


def clean_split_facts(path: Path) -> tuple[Counter[str], set[bytes]]:
    counts: Counter[str] = Counter()
    hashes: set[bytes] = set()
    for row in iter_clean_unique(path):
        counts[row[2]] += 1
        hashes.add(row_digest(row))
    return counts, hashes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    args = parser.parse_args()
    raw = args.dir.resolve()
    report = args.report.resolve()
    evidences: dict[str, dict[str, Any]] = json.loads(
        (raw / "release_evidences.json").read_text(encoding="utf-8")
    )
    conditions: dict[str, dict[str, Any]] = json.loads(
        (raw / "release_conditions.json").read_text(encoding="utf-8")
    )
    release_readme = (raw / "README.md").read_text(encoding="utf-8")
    provenance = json.loads((raw / "PROVENANCE.json").read_text(encoding="utf-8"))
    artifact_path = ROOT / "models" / "triage-lr-v1.json"
    artifact = json.loads(artifact_path.read_text(encoding="utf-8")) if artifact_path.exists() else None
    raw_split_facts = {
        split: count_csv(raw / f"release_{split}_patients.csv")
        for split in ("train", "validate", "test")
    }
    clean_split_facts_by_name = {
        split: clean_split_facts(raw / f"release_{split}_patients.csv")
        for split in ("train", "validate", "test")
    }
    output: list[str] = ["# DDXPlus — фактическая инспекция", ""]

    def say(line: str = "") -> None:
        print(line)
        output.append(line)

    say("## Провенанс")
    say(f"- Figshare article: `{provenance['article_id']}`, version `{provenance['version']}`")
    say(f"- DOI: `{provenance['doi']}`")
    say(
        f"- Лицензия из metadata первичного источника: "
        f"`{provenance['license']['name']}` ({provenance['license']['url']})"
    )
    say("- Отдельный LICENSE в опубликованном релизе: **нет**; локальный LICENSE создан из metadata Figshare.")
    say("")
    say("### Файлы")
    for path in sorted(raw.iterdir()):
        if path.is_file():
            say(
                f"- `{path.name}`: {path.stat().st_size} bytes, "
                f"sha256 `{file_hash(path)}`"
            )

    say("")
    say("## Evidences")
    say(f"- ФАКТ: число evidences = **{len(evidences)}**")
    evidence_types = Counter(item.get("data_type", "?") for item in evidences.values())
    say(f"- ФАКТ: `data_type` = `{dict(sorted(evidence_types.items()))}`")
    binary_columns = sum(item.get("data_type") == "B" for item in evidences.values())
    categorical_columns = sum(
        len(item.get("possible-values") or [])
        for item in evidences.values()
        if item.get("data_type") == "C"
    )
    multichoice_columns = sum(
        len(item.get("possible-values") or [])
        for item in evidences.values()
        if item.get("data_type") == "M"
    )
    evidence_columns = binary_columns + categorical_columns + multichoice_columns
    feature_order = build_feature_order(evidences)
    say(
        "- ФАКТ: one-hot evidence columns = "
        f"**{evidence_columns}**: B = **{binary_columns}**, "
        f"C possible-values = **{categorical_columns}**, "
        f"M possible-values = **{multichoice_columns}**"
    )
    say(
        f"- ФАКТ: `len(feature_order)` = **{len(feature_order)}** "
        f"= {evidence_columns} evidence columns + age_norm + sex_m + sex_f"
    )
    say(f"- ФАКТ: ключи evidence = `{sorted({key for item in evidences.values() for key in item})}`")

    say("")
    say("## Патологии (label space)")
    say(f"- ФАКТ: число патологий = **{len(conditions)}**")
    condition_keys = sorted({key for item in conditions.values() for key in item})
    say(f"- ФАКТ: ключи pathology = `{condition_keys}`")
    icd10 = {
        code: item.get("icd10-id")
        for code, item in conditions.items()
        if str(item.get("icd10-id", "")).strip()
    }
    say(f"- ФАКТ: непустой `icd10-id` = **{len(icd10)}/{len(conditions)}**")
    severity = {
        code: item["severity"]
        for code, item in conditions.items()
        if item.get("severity") is not None
    }
    if severity:
        low, high = min(severity.values()), max(severity.values())
        low_names = [code for code, value in severity.items() if value == low]
        high_names = [code for code, value in severity.items() if value == high]
        readme_direction = bool(
            re.search(r"severity[^\n]*lower the more severe", release_readme, re.IGNORECASE)
        )
        say(f"- ФАКТ: severity range = **[{low}, {high}]**")
        say(f"- ФАКТ: pathology at minimum severity: `{low_names}`")
        say(f"- ФАКТ: pathology at maximum severity: `{high_names}`")
        say(
            "- ФАКТ: направление шкалы по README релиза: "
            + ("**меньшее значение = более тяжёлое состояние**" if readme_direction else "**НЕ ПРОВЕРЕНО**")
        )
    else:
        say("- ФАКТ: поле severity отсутствует или пусто")

    say("")
    say("## Покрытие демо-сценариев SPINE §8")
    searchable = {
        code: json.dumps(item, ensure_ascii=False).lower()
        for code, item in conditions.items()
    }
    for demo, patterns in DEMO_PROBES.items():
        hits = [
            code
            for code, text in searchable.items()
            if any(re.search(pattern, code.lower()) or re.search(pattern, text) for pattern in patterns)
        ]
        if hits:
            status = "классы-кандидаты существуют; покрытие конкретного сценария НЕ ДОКАЗАНО"
        else:
            status = "классы-кандидаты по прямым пробам НЕ НАЙДЕНЫ"
        say(f"- `{demo}`: **{status}**; кандидаты: `{hits}`")

    say("")
    say("## Строки и классы")
    for split in ("train", "validate", "test"):
        rows, counts, columns, _ = raw_split_facts[split]
        say(f"- ФАКТ: {split} = **{rows}** строк; классов = **{len(counts)}**; колонки = `{columns}`")
        if split == "train":
            say(f"  - top-5: `{counts.most_common(5)}`")
            say(f"  - bottom-5: `{counts.most_common()[-5:]}`")

    raw_labels = {
        str(item.get("cond-name-eng"))
        for item in conditions.values()
        if item.get("cond-name-eng")
    }
    cleaned_train_counts = clean_split_facts_by_name["train"][0]
    derived_class_order = sorted(
        pathology
        for pathology, count in cleaned_train_counts.items()
        if count >= MIN_CLASS_ROWS
    )
    model_class_order = artifact["class_order"] if artifact else derived_class_order
    removed_classes = sorted(raw_labels - set(model_class_order))
    train_max_age = raw_split_facts["train"][3]
    removed_with_ages = {
        pathology: train_max_age.get(pathology)
        for pathology in removed_classes
    }
    say("")
    say("## Raw label space и фактический model class_order")
    say(f"- ФАКТ: raw label space из `release_conditions.json` = **{len(raw_labels)}**")
    say(
        "- ФАКТ: после проектного adult-only фильтра `AGE >= 18` "
        f"model `class_order` = **{len(model_class_order)}**"
    )
    say(
        f"- ФАКТ: исчезнувшие классы и максимальный возраст в raw train = "
        f"`{removed_with_ages}`"
    )
    say(
        "- Следствие: будущий `data/pathology_map.json` должен ключеваться фактическим "
        f"`class_order` из **{len(model_class_order)}** классов, а не raw-списком из {len(raw_labels)}."
    )

    train_hashes = clean_split_facts_by_name["train"][1]
    say("")
    say("## Cross-split leakage")
    say(
        "Дубли считаются после внутрисплитовой дедупликации и adult-only очистки по "
        "проектному ключу `(AGE, SEX, PATHOLOGY, EVIDENCES)`."
    )
    for split in ("validate", "test"):
        split_hashes = clean_split_facts_by_name[split][1]
        overlap = len(train_hashes & split_hashes)
        ratio = overlap / len(split_hashes)
        say(
            f"- ФАКТ: train↔{split} = **{overlap}** полных дублей "
            f"(**{ratio:.2%}** от очищенного {split}, N={len(split_hashes)})"
        )
    say(
        "- Обязательное действие перед финальными train/eval (задачи 3.5/4.x): "
        "cross-split decontamination — удалить из validate/test ключи, присутствующие в train, "
        "затем переобучить и пересчитать независимую оценку."
    )

    if artifact:
        metrics = artifact["train_metrics"]
        say("")
        say("## Черновой model artifact")
        say(
            f"- ФАКТ: `n_train_rows={artifact['n_train_rows']}`, "
            f"`top1={metrics['top1']}`, `top3={metrics['top3']}`, "
            f"`n_test={metrics['n_test']}`"
        )
        say(
            "- Эти `train_metrics` воспроизводимы, но из-за измеренного cross-split leakage "
            "могут быть завышены и **не являются независимой оценкой**. В README они не идут; "
            "там допустимы только метрики `eval/report.json` по продовому TS-пути после decontamination."
        )

    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("\n".join(output) + "\n", encoding="utf-8")
    print(f"-> {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
