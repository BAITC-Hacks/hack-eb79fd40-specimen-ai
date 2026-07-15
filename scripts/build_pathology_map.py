#!/usr/bin/env python3
"""Build and validate the unreviewed DDXPlus pathology routing table."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONDITIONS = ROOT / "data" / "raw" / "release_conditions.json"
DEFAULT_MODEL = ROOT / "models" / "triage-lr-v1.json"
DEFAULT_OUTPUT = ROOT / "data" / "pathology_map.json"
DEFAULT_REPORT = ROOT / "reports" / "pathology_map_validation.json"
SPECIALTIES = frozenset(
    {
        "терапевт",
        "кардиология",
        "неврология",
        "пульмонология",
        "гастроэнтерология",
        "ЛОР",
        "хирургия",
        "аллергология",
        "инфекционист",
        "скорая/приёмный покой",
    }
)
URGENCIES = frozenset({"routine", "planned", "urgent", "emergency"})
ROUTING_AGGREGATION = "sum"
CYRILLIC_RE = re.compile(r"[А-Яа-яЁё]")


@dataclass(frozen=True)
class RouteSpec:
    label_ru: str
    specialty: str
    specialty_alt: tuple[str, ...]
    urgency: str


# This is an initial product mapping, not a claim of clinical validation. It is
# deliberately explicit so task 3.3 can review and edit every row independently.
ROUTE_SPECS: dict[str, RouteSpec] = {
    "Acute COPD exacerbation / infection": RouteSpec(
        "Острое обострение ХОБЛ или инфекция",
        "пульмонология",
        ("терапевт",),
        "urgent",
    ),
    "Acute dystonic reactions": RouteSpec(
        "Острая дистоническая реакция",
        "неврология",
        ("скорая/приёмный покой",),
        "urgent",
    ),
    "Acute laryngitis": RouteSpec(
        "Острый ларингит", "ЛОР", ("терапевт",), "routine"
    ),
    "Acute otitis media": RouteSpec(
        "Острый средний отит", "ЛОР", ("терапевт",), "planned"
    ),
    "Acute pulmonary edema": RouteSpec(
        "Острый отёк лёгких",
        "скорая/приёмный покой",
        ("кардиология",),
        "emergency",
    ),
    "Acute rhinosinusitis": RouteSpec(
        "Острый риносинусит", "ЛОР", ("терапевт",), "planned"
    ),
    "Allergic sinusitis": RouteSpec(
        "Аллергический ринит",
        "аллергология",
        ("ЛОР", "терапевт"),
        "routine",
    ),
    "Anaphylaxis": RouteSpec(
        "Анафилаксия",
        "скорая/приёмный покой",
        ("аллергология",),
        "emergency",
    ),
    "Anemia": RouteSpec("Анемия", "терапевт", (), "planned"),
    "Atrial fibrillation": RouteSpec(
        "Фибрилляция предсердий",
        "кардиология",
        ("скорая/приёмный покой",),
        "urgent",
    ),
    "Boerhaave": RouteSpec(
        "Синдром Бурхаве",
        "скорая/приёмный покой",
        ("хирургия",),
        "emergency",
    ),
    "Bronchiectasis": RouteSpec(
        "Бронхоэктатическая болезнь",
        "пульмонология",
        ("терапевт",),
        "planned",
    ),
    "Bronchitis": RouteSpec(
        "Бронхит", "терапевт", ("пульмонология",), "routine"
    ),
    "Bronchospasm / acute asthma exacerbation": RouteSpec(
        "Бронхоспазм или острое обострение астмы",
        "пульмонология",
        ("скорая/приёмный покой", "терапевт"),
        "urgent",
    ),
    "Chagas": RouteSpec(
        "Болезнь Шагаса",
        "инфекционист",
        ("кардиология", "терапевт"),
        "planned",
    ),
    "Chronic rhinosinusitis": RouteSpec(
        "Хронический риносинусит", "ЛОР", ("аллергология",), "routine"
    ),
    "Cluster headache": RouteSpec(
        "Кластерная головная боль", "неврология", ("терапевт",), "planned"
    ),
    "Ebola": RouteSpec(
        "Болезнь, вызванная вирусом Эбола",
        "скорая/приёмный покой",
        ("инфекционист",),
        "emergency",
    ),
    "Epiglottitis": RouteSpec(
        "Эпиглоттит",
        "скорая/приёмный покой",
        ("ЛОР",),
        "emergency",
    ),
    "GERD": RouteSpec(
        "Гастроэзофагеальная рефлюксная болезнь",
        "гастроэнтерология",
        ("терапевт",),
        "planned",
    ),
    "Guillain-Barré syndrome": RouteSpec(
        "Синдром Гийена — Барре",
        "неврология",
        ("скорая/приёмный покой",),
        "urgent",
    ),
    "HIV (initial infection)": RouteSpec(
        "Первичная ВИЧ-инфекция",
        "инфекционист",
        ("терапевт",),
        "urgent",
    ),
    "Influenza": RouteSpec(
        "Грипп", "терапевт", ("инфекционист",), "planned"
    ),
    "Inguinal hernia": RouteSpec(
        "Паховая грыжа", "хирургия", ("терапевт",), "planned"
    ),
    "Larygospasm": RouteSpec(
        "Ларингоспазм",
        "скорая/приёмный покой",
        ("ЛОР",),
        "emergency",
    ),
    "Localized edema": RouteSpec(
        "Локализованный отёк",
        "терапевт",
        ("кардиология",),
        "planned",
    ),
    "Myasthenia gravis": RouteSpec(
        "Миастения", "неврология", ("терапевт",), "urgent"
    ),
    "Myocarditis": RouteSpec(
        "Миокардит",
        "кардиология",
        ("скорая/приёмный покой",),
        "urgent",
    ),
    "PSVT": RouteSpec(
        "Пароксизмальная наджелудочковая тахикардия",
        "кардиология",
        ("скорая/приёмный покой",),
        "urgent",
    ),
    "Pancreatic neoplasm": RouteSpec(
        "Новообразование поджелудочной железы",
        "гастроэнтерология",
        ("хирургия", "терапевт"),
        "urgent",
    ),
    "Panic attack": RouteSpec(
        "Паническая атака", "терапевт", ("неврология",), "routine"
    ),
    "Pericarditis": RouteSpec(
        "Перикардит",
        "кардиология",
        ("скорая/приёмный покой",),
        "urgent",
    ),
    "Pneumonia": RouteSpec(
        "Пневмония", "пульмонология", ("терапевт",), "urgent"
    ),
    "Possible NSTEMI / STEMI": RouteSpec(
        "Возможный острый инфаркт миокарда",
        "скорая/приёмный покой",
        ("кардиология",),
        "emergency",
    ),
    "Pulmonary embolism": RouteSpec(
        "Тромбоэмболия лёгочной артерии",
        "скорая/приёмный покой",
        ("пульмонология", "кардиология"),
        "emergency",
    ),
    "Pulmonary neoplasm": RouteSpec(
        "Новообразование лёгкого",
        "пульмонология",
        ("хирургия", "терапевт"),
        "urgent",
    ),
    "SLE": RouteSpec(
        "Системная красная волчанка", "терапевт", (), "planned"
    ),
    "Sarcoidosis": RouteSpec(
        "Саркоидоз", "пульмонология", ("терапевт",), "planned"
    ),
    "Scombroid food poisoning": RouteSpec(
        "Скомброидное пищевое отравление",
        "скорая/приёмный покой",
        ("аллергология", "инфекционист"),
        "urgent",
    ),
    "Spontaneous pneumothorax": RouteSpec(
        "Спонтанный пневмоторакс",
        "скорая/приёмный покой",
        ("пульмонология", "хирургия"),
        "emergency",
    ),
    "Spontaneous rib fracture": RouteSpec(
        "Спонтанный перелом ребра",
        "хирургия",
        ("терапевт",),
        "urgent",
    ),
    "Stable angina": RouteSpec(
        "Стабильная стенокардия",
        "кардиология",
        ("терапевт",),
        "urgent",
    ),
    "Tuberculosis": RouteSpec(
        "Туберкулёз",
        "инфекционист",
        ("пульмонология",),
        "urgent",
    ),
    "URTI": RouteSpec(
        "Острая инфекция верхних дыхательных путей",
        "терапевт",
        ("ЛОР",),
        "routine",
    ),
    "Unstable angina": RouteSpec(
        "Нестабильная стенокардия",
        "скорая/приёмный покой",
        ("кардиология",),
        "emergency",
    ),
    "Viral pharyngitis": RouteSpec(
        "Вирусный фарингит", "терапевт", ("ЛОР",), "routine"
    ),
    "Whooping cough": RouteSpec(
        "Коклюш", "инфекционист", ("пульмонология", "терапевт"), "urgent"
    ),
}

CARDIAC_CHEST_CLASSES = frozenset(
    {
        "Atrial fibrillation",
        "Myocarditis",
        "PSVT",
        "Pericarditis",
        "Possible NSTEMI / STEMI",
        "Stable angina",
        "Unstable angina",
    }
)
RHINITIS_CLASSES = frozenset(
    {
        "Acute rhinosinusitis",
        "Allergic sinusitis",
        "Chronic rhinosinusitis",
        "Influenza",
        "URTI",
        "Viral pharyngitis",
    }
)
LOW_BACK_PROBES = ("back", "lumb", "sciatic", "spine")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ValueError(f"{label} not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} is not valid JSON: {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object: {path}")
    return value


def conditions_by_pathology(conditions: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for source_key, raw in conditions.items():
        if not isinstance(raw, dict):
            raise ValueError(f"condition {source_key!r} must be an object")
        pathology = raw.get("cond-name-eng")
        if not isinstance(pathology, str) or not pathology:
            raise ValueError(f"condition {source_key!r} lacks cond-name-eng")
        if pathology in result:
            raise ValueError(f"duplicate cond-name-eng: {pathology}")
        result[pathology] = raw
    return result


def build_rows(
    class_order: list[Any], conditions: dict[str, Any]
) -> list[dict[str, Any]]:
    if not all(isinstance(item, str) and item for item in class_order):
        raise ValueError("class_order must contain non-empty strings")
    if len(class_order) != len(set(class_order)):
        raise ValueError("class_order contains duplicates")
    classes = set(class_order)
    missing_specs = sorted(classes - set(ROUTE_SPECS))
    extra_specs = sorted(set(ROUTE_SPECS) - classes)
    if missing_specs or extra_specs:
        raise ValueError(
            f"route specs differ from class_order: missing={missing_specs}, extra={extra_specs}"
        )
    by_pathology = conditions_by_pathology(conditions)
    missing_conditions = sorted(classes - set(by_pathology))
    if missing_conditions:
        raise ValueError(f"class_order lacks source conditions: {missing_conditions}")

    rows: list[dict[str, Any]] = []
    for pathology in class_order:
        spec = ROUTE_SPECS[pathology]
        row: dict[str, Any] = {
            "pathology": pathology,
            "label_ru": spec.label_ru,
            "specialty": spec.specialty,
            "specialty_alt": list(spec.specialty_alt),
            "urgency": spec.urgency,
            "validated": False,
        }
        raw_icd10 = by_pathology[pathology].get("icd10-id")
        if raw_icd10 is not None and str(raw_icd10):
            if not isinstance(raw_icd10, str):
                raise ValueError(f"{pathology}: source icd10-id must be a string")
            row["icd10"] = raw_icd10
        rows.append(row)
    return rows


def validate_rows(
    rows: list[Any], class_order: list[Any], conditions: dict[str, Any]
) -> dict[str, Any]:
    if len(rows) != len(class_order):
        raise ValueError(
            f"row count differs from class_order: {len(rows)} != {len(class_order)}"
        )
    pathologies: list[str] = []
    by_pathology = conditions_by_pathology(conditions)
    icd10_copies: list[dict[str, str]] = []
    for index, raw_row in enumerate(rows):
        if not isinstance(raw_row, dict):
            raise ValueError(f"row {index} must be an object")
        row: dict[str, Any] = raw_row
        required = {
            "pathology",
            "label_ru",
            "specialty",
            "specialty_alt",
            "urgency",
            "validated",
        }
        missing = sorted(required - set(row))
        unexpected = sorted(set(row) - required - {"icd10"})
        if missing or unexpected:
            raise ValueError(
                f"row {index} schema mismatch: missing={missing}, unexpected={unexpected}"
            )
        pathology = row["pathology"]
        if not isinstance(pathology, str) or not pathology:
            raise ValueError(f"row {index}: pathology must be a non-empty string")
        pathologies.append(pathology)
        label = row["label_ru"]
        if not isinstance(label, str) or not label.strip() or not CYRILLIC_RE.search(label):
            raise ValueError(f"{pathology}: label_ru must be non-empty Russian text")
        specialty = row["specialty"]
        if specialty not in SPECIALTIES:
            raise ValueError(f"{pathology}: unknown specialty {specialty!r}")
        alternatives = row["specialty_alt"]
        if not isinstance(alternatives, list):
            raise ValueError(f"{pathology}: specialty_alt must be a list")
        if not all(item in SPECIALTIES for item in alternatives):
            raise ValueError(f"{pathology}: specialty_alt has an unknown value")
        if len(alternatives) != len(set(alternatives)):
            raise ValueError(f"{pathology}: specialty_alt contains duplicates")
        if specialty in alternatives:
            raise ValueError(f"{pathology}: main specialty is duplicated in specialty_alt")
        if row["urgency"] not in URGENCIES:
            raise ValueError(f"{pathology}: invalid urgency {row['urgency']!r}")
        if row["validated"] is not False:
            raise ValueError(f"{pathology}: validated must remain false before doctor review")
        source_icd10 = by_pathology.get(pathology, {}).get("icd10-id")
        if "icd10" in row:
            if row["icd10"] != source_icd10:
                raise ValueError(
                    f"{pathology}: icd10 is not a byte-for-byte source copy"
                )
            icd10_copies.append(
                {
                    "pathology": pathology,
                    "source_field": "icd10-id",
                    "value": row["icd10"],
                }
            )
        elif source_icd10:
            raise ValueError(f"{pathology}: non-empty source icd10-id was omitted")

    if pathologies != class_order:
        raise ValueError("pathology rows must exactly match class_order and its order")
    if len(pathologies) != len(set(pathologies)):
        raise ValueError("pathology rows contain duplicates")

    for pathology in CARDIAC_CHEST_CLASSES:
        row = rows[class_order.index(pathology)]
        available_routes = {row["specialty"], *row["specialty_alt"]}
        if not available_routes & {"кардиология", "скорая/приёмный покой"}:
            raise ValueError(f"{pathology}: cardiac route is missing")
        if row["urgency"] not in {"urgent", "emergency"}:
            raise ValueError(f"{pathology}: cardiac urgency must be urgent or emergency")

    low_back_classes = sorted(
        pathology
        for pathology in class_order
        if any(probe in pathology.lower() for probe in LOW_BACK_PROBES)
    )
    for pathology in low_back_classes:
        row = rows[class_order.index(pathology)]
        available_routes = {row["specialty"], *row["specialty_alt"]}
        if not {"терапевт", "неврология"}.issubset(available_routes):
            raise ValueError(
                f"{pathology}: low-back route must include therapist and neurology"
            )

    for pathology in RHINITIS_CLASSES:
        row = rows[class_order.index(pathology)]
        if row["specialty"] not in {
            "ЛОР",
            "аллергология",
            "терапевт",
            "инфекционист",
        }:
            raise ValueError(f"{pathology}: respiratory route is outside expected set")
        if row["urgency"] not in {"routine", "planned"}:
            raise ValueError(f"{pathology}: respiratory urgency must be routine or planned")

    return {
        "status": "valid",
        "row_count": len(rows),
        "class_order_count": len(class_order),
        "pathologies_missing": [],
        "pathologies_extra": [],
        "all_validated_false": True,
        "routing_aggregation": ROUTING_AGGREGATION,
        "specialty_distribution": dict(
            sorted(Counter(row["specialty"] for row in rows).items())
        ),
        "urgency_distribution": dict(
            sorted(Counter(row["urgency"] for row in rows).items())
        ),
        "icd10_count": len(icd10_copies),
        "icd10_copies": icd10_copies,
        "cardiac_chest_classes": sorted(CARDIAC_CHEST_CLASSES),
        "rhinitis_candidate_classes": sorted(RHINITIS_CLASSES),
        "low_back_classes": low_back_classes,
        "limitations": [
            "Все маршруты и приоритеты имеют validated=false до построчной проверки врачом.",
            "Метрики маршрутизации и приоритета до врачебной проверки не заявляются.",
            "В class_order нет класса боли в пояснице; демо-сценарий должен использовать abstain-путь.",
            "Закрытый список не содержит отдельных онколога, гематолога, ревматолога и психиатра; для соответствующих строк указан доступный основной маршрут.",
        ],
    }


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--conditions", type=Path, default=DEFAULT_CONDITIONS)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate that output and report are exactly reproducible",
    )
    args = parser.parse_args()
    conditions_path = args.conditions.resolve()
    model_path = args.model.resolve()
    output_path = args.output.resolve()
    report_path = args.report.resolve()
    conditions = load_object(conditions_path, "release_conditions")
    model = load_object(model_path, "model artifact")
    class_order = model.get("class_order")
    if not isinstance(class_order, list):
        raise ValueError("model artifact class_order must be a list")
    rows = build_rows(class_order, conditions)
    report = validate_rows(rows, class_order, conditions)
    report["class_order_sha256"] = sha256_json(class_order)
    report["conditions_source"] = (
        f"release_conditions.json sha256:{sha256_file(conditions_path)}"
    )
    report["icd10_provenance"] = (
        "Each icd10 is copied byte-for-byte from the matched icd10-id field via cond-name-eng."
    )
    output_text = stable_json(rows)
    report_text = stable_json(report)
    if args.check:
        if output_path.read_text(encoding="utf-8") != output_text:
            raise ValueError(f"generated pathology map is stale: {output_path}")
        if report_path.read_text(encoding="utf-8") != report_text:
            raise ValueError(f"validation report is stale: {report_path}")
    else:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output_text, encoding="utf-8")
        report_path.write_text(report_text, encoding="utf-8")
    print(f"ФАКТ: class_order rows = {report['row_count']}")
    print(f"ФАКТ: sourced icd10 rows = {report['icd10_count']}")
    print("ФАКТ: validated=true rows = 0")
    print(f"ФАКТ: low-back classes = {len(report['low_back_classes'])}")
    print(f"ФАКТ: routing aggregation contract = {ROUTING_AGGREGATION}")
    print(f"-> {output_path}")
    print(f"-> {report_path}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
