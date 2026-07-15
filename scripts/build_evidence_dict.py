#!/usr/bin/env python3
"""Build and validate the frozen Russian DDXPlus evidence dictionary."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW = ROOT / "data" / "raw" / "release_evidences.json"
DEFAULT_MODEL = ROOT / "models" / "triage-lr-v1.json"
DEFAULT_OUTPUT = ROOT / "data" / "evidences_ru.json"
DEFAULT_REPORT = ROOT / "reports" / "evidence_dict_validation.json"
DEMOGRAPHIC_FEATURES = frozenset({"age_norm", "sex_m", "sex_f"})
VALID_DATA_TYPES = frozenset({"B", "C", "M"})
CYRILLIC_RE = re.compile(r"[А-Яа-яЁё]")


@dataclass(frozen=True)
class CuratedBase:
    question_en: str
    label_ru: str
    question_ru: str
    demos: tuple[str, ...]


@dataclass(frozen=True)
class CuratedValue:
    value_en: str
    value_ru: str


# These are the only medically worded translations accepted without an external
# translation service. Each is pinned to the exact English source text so a new
# DDXPlus release fails loudly instead of silently reusing stale wording.
CURATED_BASE: dict[str, CuratedBase] = {
    "E_14": CuratedBase(
        "Do you have chest pain even at rest?",
        "боль в груди в покое",
        "Есть ли боль в груди даже в покое?",
        ("demo1_chest_pain",),
    ),
    "E_55": CuratedBase(
        "Do you feel pain somewhere?",
        "локализация боли",
        "Где вы чувствуете боль?",
        ("demo1_chest_pain", "demo2_low_back"),
    ),
    "E_57": CuratedBase(
        "Does the pain radiate to another location?",
        "распространение боли",
        "Отдаёт ли боль в другую область?",
        ("demo1_chest_pain",),
    ),
    "E_63": CuratedBase(
        "Do you have difficulty articulating words/speaking?",
        "затруднение речи",
        "Трудно ли чётко произносить слова или говорить?",
        ("demo1_neurologic_negative",),
    ),
    "E_64": CuratedBase(
        "Do you feel out of breath with minimal physical effort?",
        "одышка при минимальной нагрузке",
        "Возникает ли одышка при минимальной физической нагрузке?",
        ("demo1_chest_pain",),
    ),
    "E_66": CuratedBase(
        "Are you experiencing shortness of breath or difficulty breathing in a significant way?",
        "выраженная одышка или затруднение дыхания",
        "Есть ли выраженная одышка или затруднение дыхания?",
        ("demo1_chest_pain",),
    ),
    "E_84": CuratedBase(
        "Do you feel weakness in both arms and/or both legs?",
        "слабость в обеих руках или ногах",
        "Есть ли слабость в обеих руках или обеих ногах?",
        ("demo1_neurologic_negative",),
    ),
    "E_91": CuratedBase(
        "Do you have a fever (either felt or measured with a thermometer)?",
        "повышенная температура",
        "Есть ли повышенная температура по ощущениям или измерению?",
        ("demo3_common_cold",),
    ),
    "E_156": CuratedBase(
        "Have you had weakness or paralysis on one side of the face, which may still be present or completely resolved?",
        "односторонняя слабость лица",
        "Была ли слабость или неподвижность одной стороны лица, даже если она уже прошла?",
        ("demo1_neurologic_negative",),
    ),
    "E_169": CuratedBase(
        "Is your nose or the back of your throat itchy?",
        "зуд в носу или задней части горла",
        "Есть ли зуд в носу или задней части горла?",
        ("demo3_common_cold",),
    ),
    "E_176": CuratedBase(
        "Did you previously, or do you currently, have any weakness/paralysis in one or more of your limbs or in your face?",
        "слабость в конечностях или лице",
        "Была ли раньше или есть сейчас слабость или неподвижность конечностей либо лица?",
        ("demo1_neurologic_negative",),
    ),
    "E_177": CuratedBase(
        "Do you currently, or did you ever, have numbness, loss of sensitivity or tingling anywhere on your body?",
        "онемение или покалывание",
        "Есть ли сейчас или было раньше онемение, снижение чувствительности или покалывание?",
        ("demo1_neurologic_negative", "demo2_low_back"),
    ),
    "E_181": CuratedBase(
        "Do you have nasal congestion or a clear runny nose?",
        "заложенность носа или прозрачные выделения",
        "Есть ли заложенность носа или прозрачные выделения из носа?",
        ("demo3_common_cold",),
    ),
    "E_182": CuratedBase(
        "Do you have greenish or yellowish nasal discharge?",
        "зеленоватые или желтоватые выделения из носа",
        "Есть ли зеленоватые или желтоватые выделения из носа?",
        ("demo3_common_cold",),
    ),
    "E_188": CuratedBase(
        "Do you have pale stools and dark urine?",
        "светлый стул и тёмная моча",
        "Есть ли одновременно светлый стул и тёмная моча?",
        ("demo2_urinary_context",),
    ),
}


CURATED_VALUES: dict[str, CuratedValue] = {
    "E_55@V_29": CuratedValue("lower chest", "нижняя часть груди"),
    "E_55@V_40": CuratedValue("lumbar spine", "поясничный отдел позвоночника"),
    "E_55@V_55": CuratedValue("side of the chest(R)", "правая сторона груди"),
    "E_55@V_56": CuratedValue("side of the chest(L)", "левая сторона груди"),
    "E_55@V_101": CuratedValue("upper chest", "верхняя часть груди"),
    "E_55@V_170": CuratedValue("posterior chest wall(R)", "грудная клетка сзади справа"),
    "E_55@V_171": CuratedValue("posterior chest wall(L)", "грудная клетка сзади слева"),
    "E_57@V_28": CuratedValue("forearm(L)", "левое предплечье"),
    "E_57@V_31": CuratedValue("biceps(L)", "левая верхняя часть руки"),
    "E_57@V_195": CuratedValue("shoulder(L)", "левое плечо"),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def validate_source(evidences: dict[str, Any]) -> None:
    for code, raw_metadata in evidences.items():
        if not isinstance(code, str) or not re.fullmatch(r"E_\d+", code):
            raise ValueError(f"invalid evidence code: {code!r}")
        if not isinstance(raw_metadata, dict):
            raise ValueError(f"{code}: metadata must be an object")
        metadata: dict[str, Any] = raw_metadata
        for field in ("name", "question_en", "data_type", "possible-values"):
            if field not in metadata:
                raise ValueError(f"{code}: missing source field {field!r}")
        if not isinstance(metadata["name"], str) or not metadata["name"]:
            raise ValueError(f"{code}: name must be a non-empty string")
        if not isinstance(metadata["question_en"], str) or not metadata["question_en"]:
            raise ValueError(f"{code}: question_en must be a non-empty string")
        if metadata["data_type"] not in VALID_DATA_TYPES:
            raise ValueError(f"{code}: unsupported data_type {metadata['data_type']!r}")
        values = metadata["possible-values"]
        if not isinstance(values, list):
            raise ValueError(f"{code}: possible-values must be a list")
        if len(list(map(str, values))) != len(set(map(str, values))):
            raise ValueError(f"{code}: possible-values contain duplicates")
        if metadata["data_type"] == "B" and values:
            raise ValueError(f"{code}: binary evidence cannot have possible-values")

    missing_curated = sorted(set(CURATED_BASE) - set(evidences))
    if missing_curated:
        raise ValueError(f"curated codes absent from source: {missing_curated}")
    for code, curated in CURATED_BASE.items():
        actual_question = evidences[code]["question_en"]
        if actual_question != curated.question_en:
            raise ValueError(
                f"{code}: curated translation is stale; question_en changed to "
                f"{actual_question!r}"
            )


def evidence_feature_keys(
    feature_order: list[Any], evidences: dict[str, Any]
) -> tuple[list[str], list[str]]:
    if len(feature_order) != len(set(map(str, feature_order))):
        raise ValueError("feature_order contains duplicates")
    demographic: list[str] = []
    evidence_features: list[str] = []
    for raw_feature in feature_order:
        if not isinstance(raw_feature, str) or not raw_feature:
            raise ValueError(f"invalid feature_order item: {raw_feature!r}")
        feature = raw_feature
        if feature in DEMOGRAPHIC_FEATURES:
            demographic.append(feature)
            continue
        if "@" in feature:
            parts = feature.split("@")
            if len(parts) != 2 or not all(parts):
                raise ValueError(f"invalid evidence feature: {feature!r}")
            code, value = parts
        else:
            code, value = feature, None
        if code not in evidences:
            raise ValueError(f"feature_order references unknown evidence: {feature}")
        metadata = evidences[code]
        data_type = metadata["data_type"]
        possible_values = {str(item) for item in metadata["possible-values"]}
        if data_type == "B" and value is not None:
            raise ValueError(f"binary evidence has a value feature: {feature}")
        if data_type in {"C", "M"} and value is None:
            raise ValueError(f"non-binary evidence lacks a value feature: {feature}")
        if value is not None and value not in possible_values:
            raise ValueError(f"feature_order references unknown possible value: {feature}")
        evidence_features.append(feature)
    if set(demographic) != DEMOGRAPHIC_FEATURES:
        raise ValueError(
            "feature_order demographics differ from age_norm/sex_m/sex_f: "
            f"{sorted(demographic)}"
        )
    return demographic, evidence_features


def source_value_en(metadata: dict[str, Any], value: str) -> str | None:
    meaning = metadata.get("value_meaning")
    if not isinstance(meaning, dict):
        return None
    raw_value = meaning.get(value)
    if not isinstance(raw_value, dict):
        return None
    translated = raw_value.get("en")
    return translated if isinstance(translated, str) and translated else None


def base_translation(code: str, metadata: dict[str, Any]) -> tuple[str, str, bool]:
    curated = CURATED_BASE.get(code)
    if curated is not None:
        return curated.label_ru, curated.question_ru, True
    label = f"механически описанный признак DDXPlus {code}"
    if metadata["data_type"] == "B":
        question = f"Уточните наличие признака DDXPlus {code}."
    else:
        question = f"Уточните значение признака DDXPlus {code}."
    return label, question, False


def value_translation(
    feature: str, metadata: dict[str, Any], value: str
) -> tuple[str, bool]:
    curated = CURATED_VALUES.get(feature)
    actual_en = source_value_en(metadata, value)
    if curated is not None:
        if actual_en != curated.value_en:
            raise ValueError(
                f"{feature}: curated value is stale; English value changed to {actual_en!r}"
            )
        return curated.value_ru, True
    raw_values = list(map(str, metadata["possible-values"]))
    position = raw_values.index(value) + 1
    if value.isdecimal():
        return f"значение {value}", False
    return f"вариант {position} ({value})", False


def build_entry(
    code: str, metadata: dict[str, Any], feature_value: str | None = None
) -> dict[str, Any]:
    label_ru, question_ru, base_curated = base_translation(code, metadata)
    entry: dict[str, Any] = {
        "name": metadata["name"],
        "question_en": metadata["question_en"],
        "label_ru": label_ru,
        "question_ru": question_ru,
        "data_type": metadata["data_type"],
        "possible_values": metadata["possible-values"],
        "translation_status": "curated" if base_curated else "mechanical_neutral",
    }
    if feature_value is not None:
        feature = f"{code}@{feature_value}"
        value_ru, value_curated = value_translation(feature, metadata, feature_value)
        entry["feature_value"] = feature_value
        entry["value_en"] = source_value_en(metadata, feature_value)
        entry["label_ru"] = f"{label_ru}: {value_ru}"
        entry["question_ru"] = f"{question_ru.rstrip('?.')} — {value_ru}?"
        entry["translation_status"] = (
            "curated" if base_curated and value_curated else "mechanical_neutral"
        )
    return entry


def build_dictionary(
    evidences: dict[str, Any],
    feature_order: list[Any],
    raw_hash: str,
    model_hash: str,
) -> dict[str, Any]:
    validate_source(evidences)
    demographic, evidence_features = evidence_feature_keys(feature_order, evidences)
    all_keys = set(evidences) | set(evidence_features)
    entries: dict[str, Any] = {}
    for key in sorted(all_keys):
        if "@" in key:
            code, value = key.split("@", 1)
            entries[key] = build_entry(code, evidences[code], value)
        else:
            entries[key] = build_entry(key, evidences[key])
    mechanical_count = sum(
        entry["translation_status"] == "mechanical_neutral"
        for entry in entries.values()
    )
    demo_code_groups: dict[str, list[str]] = {}
    for code, curated in CURATED_BASE.items():
        for demo in curated.demos:
            demo_code_groups.setdefault(demo, []).append(code)
    demo_code_groups = {
        demo: sorted(codes) for demo, codes in sorted(demo_code_groups.items())
    }
    meta = {
        "version": 1,
        "source": f"release_evidences.json sha256:{raw_hash}",
        "feature_order_source": f"triage-lr-v1.json sha256:{model_hash}",
        "frozen": True,
        "translation_policy": (
            "Ручная вычитка кодов трёх демо; остальные записи используют "
            "нейтральный механический шаблон без добавления медицинского смысла."
        ),
        "source_evidence_count": len(evidences),
        "feature_order_count": len(feature_order),
        "demographic_features": sorted(demographic),
        "evidence_feature_count": len(evidence_features),
        "dictionary_entry_count": len(entries),
        "curated_base_codes": sorted(CURATED_BASE),
        "curated_feature_keys": sorted(CURATED_VALUES),
        "demo_code_groups": demo_code_groups,
        "mechanical_neutral_count": mechanical_count,
    }
    return {"_meta": meta, **entries}


def validate_dictionary(
    dictionary: dict[str, Any],
    evidences: dict[str, Any],
    feature_order: list[Any],
) -> dict[str, Any]:
    _, evidence_features = evidence_feature_keys(feature_order, evidences)
    expected_keys = set(evidences) | set(evidence_features)
    actual_keys = set(dictionary) - {"_meta"}
    missing_source = sorted(set(evidences) - actual_keys)
    missing_features = sorted(set(evidence_features) - actual_keys)
    unexpected = sorted(actual_keys - expected_keys)
    if missing_source or missing_features or unexpected:
        raise ValueError(
            "dictionary coverage mismatch: "
            f"missing_source={missing_source}, missing_features={missing_features}, "
            f"unexpected={unexpected}"
        )
    required = {
        "name",
        "question_en",
        "label_ru",
        "question_ru",
        "data_type",
        "possible_values",
    }
    for key in sorted(actual_keys):
        entry = dictionary[key]
        if not isinstance(entry, dict):
            raise ValueError(f"{key}: dictionary entry must be an object")
        missing_fields = sorted(required - set(entry))
        if missing_fields:
            raise ValueError(f"{key}: missing fields {missing_fields}")
        for field in ("label_ru", "question_ru"):
            value = entry[field]
            if not isinstance(value, str) or not value.strip() or not CYRILLIC_RE.search(value):
                raise ValueError(f"{key}: {field} must be non-empty Russian text")
        code = key.split("@", 1)[0]
        source = evidences[code]
        if entry["name"] != source["name"]:
            raise ValueError(f"{key}: name differs from source")
        if entry["question_en"] != source["question_en"]:
            raise ValueError(f"{key}: question_en differs from source")
        if entry["data_type"] != source["data_type"]:
            raise ValueError(f"{key}: data_type differs from source")
        if entry["possible_values"] != source["possible-values"]:
            raise ValueError(f"{key}: possible_values differ from source")
    meta = dictionary.get("_meta")
    if not isinstance(meta, dict) or meta.get("frozen") is not True:
        raise ValueError("dictionary _meta.frozen must be true")
    return {
        "status": "valid",
        "source_evidence_count": len(evidences),
        "feature_order_count": len(feature_order),
        "demographic_feature_count": len(DEMOGRAPHIC_FEATURES),
        "evidence_feature_count": len(evidence_features),
        "dictionary_entry_count": len(actual_keys),
        "source_codes_missing": missing_source,
        "feature_keys_missing": missing_features,
        "curated_base_codes": sorted(CURATED_BASE),
        "curated_feature_keys": sorted(CURATED_VALUES),
        "demo_code_groups": meta["demo_code_groups"],
        "mechanical_neutral_count": meta["mechanical_neutral_count"],
        "notes": [
            "Технические age_norm/sex_m/sex_f не являются evidence-кодами.",
            "DDXPlus кодирует присутствующие признаки; отрицательные ответы не создают feature key.",
            "E_188 описывает цвет мочи; отдельного evidence для мочеиспускания прямым поиском не найдено.",
        ],
    }


def stable_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate that existing output and report are exactly reproducible",
    )
    args = parser.parse_args()
    raw_path = args.raw.resolve()
    model_path = args.model.resolve()
    output_path = args.output.resolve()
    report_path = args.report.resolve()
    evidences = load_object(raw_path, "release_evidences")
    model = load_object(model_path, "model artifact")
    feature_order = model.get("feature_order")
    if not isinstance(feature_order, list):
        raise ValueError("model artifact feature_order must be a list")
    dictionary = build_dictionary(
        evidences,
        feature_order,
        sha256_file(raw_path),
        sha256_file(model_path),
    )
    report = validate_dictionary(dictionary, evidences, feature_order)
    dictionary_text = stable_json(dictionary)
    report_text = stable_json(report)
    if args.check:
        current_dictionary = output_path.read_text(encoding="utf-8")
        current_report = report_path.read_text(encoding="utf-8")
        if current_dictionary != dictionary_text:
            raise ValueError(f"generated dictionary is stale: {output_path}")
        if current_report != report_text:
            raise ValueError(f"validation report is stale: {report_path}")
    else:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(dictionary_text, encoding="utf-8")
        report_path.write_text(report_text, encoding="utf-8")
    print(f"ФАКТ: source evidences = {report['source_evidence_count']}")
    print(f"ФАКТ: len(feature_order) = {report['feature_order_count']}")
    print(f"ФАКТ: evidence feature keys = {report['evidence_feature_count']}")
    print(f"ФАКТ: dictionary entries = {report['dictionary_entry_count']}")
    print(f"ФАКТ: missing source/features = {len(report['source_codes_missing'])}/{len(report['feature_keys_missing'])}")
    print(f"ФАКТ: curated base/value entries = {len(CURATED_BASE)}/{len(CURATED_VALUES)}")
    print(f"-> {output_path}")
    print(f"-> {report_path}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
