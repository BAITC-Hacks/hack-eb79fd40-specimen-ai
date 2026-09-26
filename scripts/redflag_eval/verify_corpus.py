"""Fail-closed structural verifier for the frozen RU/KK research corpus."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from .common import TRIGGERS, load_json


PRODUCTION_EXPECTATIONS = {
    "давящая боль за грудиной, отдаёт в левую руку, холодный пот": (
        True,
        "chest_pain",
    ),
    "самая сильная головная боль в жизни, как удар по голове": (
        True,
        "thunderclap_headache",
    ),
    "шею не могу нагнуть, от света больно глазам, температура 39": (
        True,
        "meningeal",
    ),
    "год назад болело в груди, обследовалась, всё прошло, сейчас насморк": (
        False,
        "chest_pain",
    ),
}


def fail(message: str) -> None:
    raise SystemExit(f"REDFLAG_CORPUS_INVALID: {message}")


def verify(path: Path) -> None:
    corpus = load_json(path)
    if corpus.get("schema_version") != "redflags-eval-v1":
        fail("unexpected schema_version")
    if corpus.get("research_only") is not True:
        fail("research_only must be true")
    items = corpus.get("items")
    if not isinstance(items, list) or not 150 <= len(items) <= 200:
        fail("item count must be in [150, 200]")

    ids: set[str] = set()
    fingerprints: set[str] = set()
    trigger_counts: Counter[str] = Counter()
    language_counts: Counter[str] = Counter()
    polarity_counts: Counter[tuple[str, str, bool]] = Counter()
    production_found: dict[str, tuple[bool, str]] = {}

    for index, item in enumerate(items):
        if not isinstance(item, dict):
            fail(f"item {index} is not an object")
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id or item_id in ids:
            fail(f"item {index} has a missing or duplicate id")
        ids.add(item_id)
        language = item.get("language")
        if language not in {"ru", "kk"}:
            fail(f"{item_id}: invalid language")
        target = item.get("target_trigger")
        if target not in TRIGGERS:
            fail(f"{item_id}: invalid target_trigger")
        expected = item.get("expected_emergency")
        if not isinstance(expected, bool):
            fail(f"{item_id}: expected_emergency must be boolean")
        expected_codes = item.get("expected_codes")
        wanted_codes = [target] if expected else []
        if expected_codes != wanted_codes:
            fail(f"{item_id}: expected_codes does not match polarity")
        messages = item.get("messages")
        if not isinstance(messages, list) or not messages:
            fail(f"{item_id}: messages must be non-empty")
        for message in messages:
            if not isinstance(message, dict):
                fail(f"{item_id}: invalid message")
            if message.get("role") not in {"user", "assistant"}:
                fail(f"{item_id}: invalid role")
            if not isinstance(message.get("content"), str) or not message["content"].strip():
                fail(f"{item_id}: empty content")
        if not any(message["role"] == "user" for message in messages):
            fail(f"{item_id}: no patient message")
        fingerprint = json.dumps(messages, ensure_ascii=False, sort_keys=True)
        if fingerprint in fingerprints:
            fail(f"{item_id}: duplicate messages")
        fingerprints.add(fingerprint)
        provenance = item.get("provenance")
        if not isinstance(provenance, dict):
            fail(f"{item_id}: missing provenance")
        if provenance.get("kind") not in {
            "production_regression",
            "synthetic_adversarial",
        }:
            fail(f"{item_id}: invalid provenance kind")
        if not isinstance(provenance.get("source"), str) or not provenance["source"]:
            fail(f"{item_id}: missing provenance source")
        if provenance.get("clinician_validated") is not False:
            fail(f"{item_id}: corpus is not clinician-validated")
        if not expected and not item.get("trap"):
            fail(f"{item_id}: negative item lacks trap class")

        trigger_counts[target] += 1
        language_counts[language] += 1
        polarity_counts[(target, language, expected)] += 1
        phrase = " ".join(
            message["content"] for message in messages if message["role"] == "user"
        )
        if provenance.get("kind") == "production_regression":
            production_found[phrase] = (expected, target)

    if set(trigger_counts) != TRIGGERS:
        fail("all eight triggers must be represented")
    if any(trigger_counts[trigger] < 16 for trigger in TRIGGERS):
        fail("each trigger needs at least 16 items")
    if min(language_counts.values(), default=0) < 60:
        fail("both RU and KK need at least 60 items")
    for trigger in TRIGGERS:
        for language in ("ru", "kk"):
            for expected in (False, True):
                if polarity_counts[(trigger, language, expected)] < 4:
                    fail(f"insufficient slice: {trigger}/{language}/{expected}")
    if production_found != PRODUCTION_EXPECTATIONS:
        fail("the exact four 2026-09-26 production regressions are not frozen")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", type=Path)
    args = parser.parse_args()
    verify(args.corpus)
    print("REDFLAG_CORPUS_OK")


if __name__ == "__main__":
    main()
