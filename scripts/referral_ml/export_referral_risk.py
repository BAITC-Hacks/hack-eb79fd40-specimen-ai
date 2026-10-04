"""Export the trusted B3 sklearn pipeline into a privacy-safe runtime JSON."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Final

import joblib  # type: ignore[import-untyped]
import numpy as np
import pandas as pd  # type: ignore[import-untyped]

from .compare_reports import semantic_report_sha256
from .io import sha256_file, write_json
from .refusal_contracts import CATEGORICAL_FEATURES
from .refusal_pipeline import MISSING_VALUE, build_cohort, feature_matrix, temporal_split
from .verify_refusal_report import verify_refusal_report

MODEL_ID: Final = "referral-refusal-baseline-v0"
TOKEN_NAMESPACE: Final = "demeu:b3:category:v1"
EXPECTED_JOBLIB_SHA256: Final = (
    "2ff0d5405d758b110d88b23b26b6f6e764f67aad65959a741ed7ab7da05097f3"
)
EXPECTED_REPORT_SHA256: Final = (
    "d8b9a831af78e34cc78b641e29160bcd00d3a43b8332614dacd0ff64180a246a"
)
EXPECTED_INPUT_SHA256: Final = (
    "c9386df30d37f3035aa653772abb74f648348a17b7de5497e9306b088bc01798"
)


def category_token(feature: str, value: str | None) -> str:
    normalized = MISSING_VALUE if value is None else value
    payload = f"{TOKEN_NAMESPACE}\0{feature}\0{normalized}".encode()
    return hashlib.sha256(payload).hexdigest()


def _sigmoid(logit: float) -> float:
    if logit >= 0:
        return 1.0 / (1.0 + math.exp(-logit))
    exp_value = math.exp(logit)
    return exp_value / (1.0 + exp_value)


def _field_specs(
    bundle: Any,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, str]]]:
    pipeline = bundle.pipeline
    encoder = pipeline.named_steps["preprocess"].named_transformers_[
        "categories"
    ].named_steps["one_hot"]
    weights = pipeline.named_steps["classifier"].coef_[0]
    result: list[dict[str, Any]] = []
    private_categories: dict[str, dict[str, str]] = {}
    base = [str(values[0]) for values in encoder.categories_]
    for index, name in enumerate(CATEGORICAL_FEATURES):
        categories = [str(value) for value in encoder.categories_[index]]
        infrequent_values = encoder.infrequent_categories_[index]
        infrequent = (
            {str(value) for value in infrequent_values}
            if infrequent_values is not None
            else set()
        )
        probes = np.asarray([base.copy() for _ in categories], dtype=object)
        probes[:, index] = categories
        encoded = encoder.transform(probes).tocsr()
        row_indices = [set(encoded.indices[encoded.indptr[row] : encoded.indptr[row + 1]]) for row in range(len(categories))]
        observed_indices = set().union(*row_indices)
        other_always_active = set.intersection(*row_indices)
        field_indices = observed_indices - other_always_active
        expected_outputs = len(categories) - len(infrequent) + (1 if infrequent else 0)
        if len(field_indices) != expected_outputs:
            raise ValueError("unable_to_probe_encoded_field_columns")
        transformed_indices: dict[str, int] = {}
        for category, active_indices in zip(categories, row_indices, strict=True):
            active = active_indices & field_indices
            if len(active) != 1:
                raise ValueError("ambiguous_encoded_category_column")
            transformed_indices[category] = active.pop()
        frequent = [value for value in categories if value not in infrequent]
        frequent_entries = [
            {
                "token": category_token(name, value),
                "weight": float(weights[transformed_indices[value]]),
            }
            for value in frequent
        ]
        infrequent_indices = {transformed_indices[value] for value in infrequent}
        if len(infrequent_indices) > 1:
            raise ValueError("infrequent_categories_do_not_share_column")
        result.append(
            {
                "name": name,
                "frequent": frequent_entries,
                "infrequentWeight": (
                    float(weights[next(iter(infrequent_indices))]) if infrequent else None
                ),
                "unseenPolicy": "infrequent" if infrequent else "zero",
                "missingTrained": MISSING_VALUE in frequent,
            }
        )
        private_categories[name] = {
            str(entry["token"]): value
            for entry, value in zip(frequent_entries, frequent, strict=True)
        }
    if sum(len(field["frequent"]) + (field["infrequentWeight"] is not None) for field in result) != len(weights):
        raise ValueError("encoded_weight_count_mismatch")
    return result, private_categories


def _resolve_weight(
    field: dict[str, Any], value: str | None, *, token_override: str | None = None
) -> tuple[float, str]:
    token = token_override or category_token(field["name"], value)
    frequent = {entry["token"]: entry["weight"] for entry in field["frequent"]}
    if token in frequent:
        coverage = "missing" if value is None else "frequent"
        return float(frequent[token]), coverage
    if field["unseenPolicy"] == "infrequent":
        return float(field["infrequentWeight"]), "fallback_infrequent_or_unseen"
    return 0.0, "unknown_all_zero"


def _oracle_case(
    name: str,
    fields: list[dict[str, Any]],
    inputs: dict[str, dict[str, Any]],
    intercept: float,
    threshold: float,
    expected_probability: float,
    expected_logit: float,
) -> dict[str, Any]:
    logit = intercept
    coverage: dict[str, str] = {}
    for field in fields:
        value = inputs[field["name"]]
        raw = value.get("value") if value["kind"] == "raw" else "tokenized"
        weight, state = _resolve_weight(
            field,
            raw,
            token_override=value.get("token"),
        )
        logit += weight
        coverage[field["name"]] = state
    probability = expected_probability
    if not math.isclose(logit, expected_logit, rel_tol=0.0, abs_tol=1e-12):
        raise ValueError("exported_oracle_formula_differs_from_sklearn")
    return {
        "name": name,
        "inputs": inputs,
        "expected": {
            "logit": expected_logit,
            "probability": probability,
            "riskBand": (
                "at_or_above_working_threshold"
                if probability >= threshold
                else "below_working_threshold"
            ),
            "coverage": coverage,
        },
    }


def _oracle(
    fields: list[dict[str, Any]], private_categories: dict[str, dict[str, str]],
    intercept: float, threshold: float, bundle: Any,
) -> dict[str, Any]:
    def token_inputs(position: str) -> dict[str, dict[str, Any]]:
        return {
            field["name"]: {
                "kind": "token",
                "token": (
                    min(field["frequent"], key=lambda item: item["weight"])["token"]
                    if position == "low"
                    else max(field["frequent"], key=lambda item: item["weight"])["token"]
                ),
            }
            for field in fields
        }

    def raw_row(inputs: dict[str, dict[str, Any]]) -> dict[str, str | None]:
        return {
            field: (
                value.get("value")
                if value["kind"] == "raw"
                else private_categories[field][value["token"]]
            )
            for field, value in inputs.items()
        }

    def case(name: str, inputs: dict[str, dict[str, Any]]) -> dict[str, Any]:
        row = pd.DataFrame([raw_row(inputs)], columns=list(CATEGORICAL_FEATURES))
        probability = float(bundle.predict_proba(row)[0])
        decision = float(bundle.pipeline.decision_function(feature_matrix(row))[0])
        return _oracle_case(
            name, fields, inputs, intercept, threshold, probability, decision
        )

    base = token_inputs("low")
    cases = [case("all_fields_low", base), case("all_fields_high", token_inputs("high"))]
    for field in fields:
        changed = json.loads(json.dumps(base))
        changed[field["name"]] = {
            "kind": "token",
            "token": max(field["frequent"], key=lambda item: item["weight"])[
                "token"
            ],
        }
        cases.append(case(f"frequent_{field['name']}", changed))
        if field["unseenPolicy"] == "infrequent":
            changed = json.loads(json.dumps(base))
            changed[field["name"]] = {
                "kind": "raw",
                "value": f"synthetic-unseen-{field['name']}",
            }
            cases.append(case(f"infrequent_{field['name']}", changed))
        else:
            changed = json.loads(json.dumps(base))
            changed[field["name"]] = {
                "kind": "raw",
                "value": f"synthetic-unseen-{field['name']}",
            }
            cases.append(case(f"zero_{field['name']}", changed))
    missing = json.loads(json.dumps(base))
    missing["bed_profile"] = {"kind": "raw", "value": None}
    cases.append(case("missing_bed_profile", missing))
    return {
        "hashVector": {
            "feature": "bed_profile",
            "value": " Synthetic Ё ",
            "token": category_token("bed_profile", " Synthetic Ё "),
        },
        "cases": cases,
    }


def export_artifact(model_path: Path, report_path: Path) -> dict[str, Any]:
    if sha256_file(model_path) != EXPECTED_JOBLIB_SHA256:
        raise ValueError("untrusted_joblib_sha256")
    if sha256_file(report_path) != EXPECTED_REPORT_SHA256:
        raise ValueError("untrusted_report_sha256")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    verify_refusal_report(report, model_path)
    binary = joblib.load(model_path)
    if binary.get("model_name") != MODEL_ID:
        raise ValueError("unexpected_model_id")
    if tuple(binary.get("feature_order", ())) != CATEGORICAL_FEATURES:
        raise ValueError("unexpected_feature_order")
    if binary.get("input_sha256") != EXPECTED_INPUT_SHA256:
        raise ValueError("unexpected_input_sha256")
    bundle = binary["model"]
    if not bundle.converged:
        raise ValueError("selected_model_not_converged")
    pipeline = bundle.pipeline
    classifier = pipeline.named_steps["classifier"]
    if (
        classifier.solver != "liblinear"
        or float(classifier.C) != 1.0
        or classifier.classes_.tolist() != [0, 1]
    ):
        raise ValueError("unexpected_classifier")
    threshold = float(binary["thresholds"]["model"])
    if threshold != float(report["model_artifact"]["exact_threshold"]):
        raise ValueError("threshold_report_mismatch")
    fields, private_categories = _field_specs(bundle)
    intercept = float(classifier.intercept_[0])
    return {
        "schemaVersion": 1,
        "modelId": MODEL_ID,
        "task": "B3_referral_refusal_research_inference",
        "researchOnly": True,
        "target": "refusal_probability_among_mature_outcomes",
        "featureOrder": list(CATEGORICAL_FEATURES),
        "normalization": {
            "stringPolicy": "exact_utf8_no_trim_case_or_unicode_normalization",
            "nullValue": MISSING_VALUE,
        },
        "tokenization": {"algorithm": "sha256", "namespace": TOKEN_NAMESPACE},
        "classifier": {
            "kind": "one_hot_logistic_regression",
            "solver": "liblinear",
            "c": float(classifier.C),
            "classes": [0, 1],
            "positiveClass": 1,
            "intercept": intercept,
            "iterations": int(classifier.n_iter_[0]),
            "maxIterations": int(classifier.max_iter),
            "workingThreshold": threshold,
            "fields": fields,
        },
        "oracle": _oracle(fields, private_categories, intercept, threshold, bundle),
        "provenance": {
            "joblibSha256": EXPECTED_JOBLIB_SHA256,
            "sourceReportSha256": EXPECTED_REPORT_SHA256,
            "semanticReportSha256": semantic_report_sha256(report),
            "inputSha256": EXPECTED_INPUT_SHA256,
            "sourceReport": "reports/referral-refusal-baseline-v0.json",
            "licenseStatus": "not_verified",
            "sklearnVersion": report["reproducibility"]["packages"]["scikit-learn"],
        },
        "heldoutBenchmark": {
            "period": report["split"]["test"]["period"],
            "rows": report["split"]["test"]["rows"],
            "positives": report["split"]["test"]["positives"],
            "prAuc": report["test"]["one_hot_logistic_regression"]["metrics"][
                "pr_auc"
            ],
            "brier": report["test"]["one_hot_logistic_regression"]["metrics"][
                "brier"
            ],
            "previouslyExamined": True,
        },
        "privacy": {
            "containsRowData": False,
            "containsIdentifiers": False,
            "containsCategoryValues": False,
            "categoryRepresentation": "sha256_dictionary_matchable_tokens",
        },
    }


def exported_probabilities(
    artifact: dict[str, Any], frame: pd.DataFrame
) -> np.ndarray:
    fields = artifact["classifier"]["fields"]
    logits = np.full(len(frame), artifact["classifier"]["intercept"], dtype=np.float64)
    for field in fields:
        weights = {entry["token"]: entry["weight"] for entry in field["frequent"]}
        values = frame[field["name"]]
        for row_index, value in enumerate(values):
            raw = None if pd.isna(value) else str(value)
            token = category_token(field["name"], raw)
            if token in weights:
                logits[row_index] += weights[token]
            elif field["unseenPolicy"] == "infrequent":
                logits[row_index] += field["infrequentWeight"]
    return 1.0 / (1.0 + np.exp(-logits))


def parity_report(
    artifact: dict[str, Any], artifact_path: Path, model_path: Path, input_path: Path
) -> dict[str, Any]:
    if sha256_file(input_path) != EXPECTED_INPUT_SHA256:
        raise ValueError("untrusted_input_sha256")
    binary = joblib.load(model_path)
    partition = temporal_split(build_cohort(pd.read_parquet(input_path)).frame).test
    sklearn_probabilities = binary["model"].predict_proba(partition)
    exported = exported_probabilities(artifact, partition)
    threshold = artifact["classifier"]["workingThreshold"]
    repo_root = Path(__file__).resolve().parents[2]
    verifier = Path(__file__).with_name("verify_referral_risk_ts.ts")
    process = subprocess.Popen(
        [str(repo_root / "node_modules/.bin/tsx"), str(verifier), str(artifact_path)],
        cwd=repo_root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if process.stdin is None:
        raise ValueError("ts_parity_stdin_unavailable")
    columns = [partition[feature].to_numpy() for feature in CATEGORICAL_FEATURES]
    try:
        for offset in range(0, len(partition), 1000):
            lines: list[str] = []
            for row_index in range(offset, min(offset + 1000, len(partition))):
                tokens = [
                    "-" if pd.isna(column[row_index]) else category_token(feature, str(column[row_index]))
                    for feature, column in zip(CATEGORICAL_FEATURES, columns, strict=True)
                ]
                lines.append("\t".join([repr(float(sklearn_probabilities[row_index])), *tokens]))
            process.stdin.write("\n".join(lines) + "\n")
        process.stdin.close()
        output = process.stdout.read() if process.stdout else ""
        error = process.stderr.read() if process.stderr else ""
        status = process.wait()
    except BaseException:
        process.kill()
        process.wait()
        raise
    if status != 0:
        raise ValueError(f"ts_parity_failed:{error[:200]}")
    ts_parity = json.loads(output)
    if (
        ts_parity.get("rows") != len(partition)
        or ts_parity.get("maximumAbsoluteProbabilityDelta", 1.0) > 1e-12
        or ts_parity.get("riskBandMismatches") != 0
    ):
        raise ValueError("ts_parity_mismatch")
    return {
        "schemaVersion": 1,
        "modelId": MODEL_ID,
        "artifactSha256": "filled_after_write",
        "source": {
            "inputSha256": EXPECTED_INPUT_SHA256,
            "partition": "2025-03-01 <= registration_dt < 2025-04-01",
            "rows": int(len(partition)),
            "containsRowData": False,
            "containsIdentifiers": False,
            "containsCategoryValues": False,
        },
        "pythonExportFormulaParity": {
            "reference": "sklearn_pipeline_vs_exported_python_formula",
            "maximumAbsoluteProbabilityDelta": float(
                np.max(np.abs(sklearn_probabilities - exported))
            ),
            "workingThreshold": threshold,
            "riskBandMismatches": int(
                np.sum(
                    (sklearn_probabilities >= threshold) != (exported >= threshold)
                )
            ),
            "passed": bool(
                np.max(np.abs(sklearn_probabilities - exported)) <= 1e-12
                and np.sum(
                    (sklearn_probabilities >= threshold) != (exported >= threshold)
                )
                == 0
            ),
        },
        "pythonTsRuntimeParity": {
            "reference": "sklearn_pipeline_predict_proba_vs_lib_referral_risk_ts",
            "rows": ts_parity["rows"],
            "maximumAbsoluteProbabilityDelta": ts_parity[
                "maximumAbsoluteProbabilityDelta"
            ],
            "riskBandMismatches": ts_parity["riskBandMismatches"],
            "passed": True,
        },
        "limitations": [
            "March was previously examined in the source handoff.",
            "This verifies exported arithmetic, not prospective clinical utility.",
            "Source dataset license remains not verified.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--parity-report", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    artifact = export_artifact(args.model, args.report)
    with tempfile.TemporaryDirectory(prefix="demeu-referral-risk-") as directory:
        staged = Path(directory) / "artifact.json"
        write_json(staged, artifact)
        artifact_sha = sha256_file(staged)
        fixture = {
            "schemaVersion": 1,
            "artifactSha256": artifact_sha,
            "hashVector": artifact["oracle"]["hashVector"],
            "cases": artifact["oracle"]["cases"],
        }
        parity = parity_report(artifact, staged, args.model, args.input)
        parity["artifactSha256"] = artifact_sha
        if not parity["pythonExportFormulaParity"]["passed"] or not parity["pythonTsRuntimeParity"]["passed"]:
            raise ValueError("python_export_parity_failed")
        for value in (artifact, fixture, parity):
            json.dumps(value, ensure_ascii=False, allow_nan=False)
        staged_fixture = Path(directory) / "fixture.json"
        staged_parity = Path(directory) / "parity.json"
        write_json(staged_fixture, fixture)
        write_json(staged_parity, parity)
        for source, target in (
            (staged, args.output),
            (staged_fixture, args.fixture),
            (staged_parity, args.parity_report),
        ):
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".tmp")
            temporary.write_bytes(source.read_bytes())
            os.replace(temporary, target)


if __name__ == "__main__":
    main()
