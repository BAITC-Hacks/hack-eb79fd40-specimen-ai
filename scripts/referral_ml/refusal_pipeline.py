"""Leakage-safe cohort, baselines, model and metrics for offline B3."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

import numpy as np
import pandas as pd  # type: ignore[import-untyped]
from sklearn.compose import ColumnTransformer  # type: ignore[import-untyped]
from sklearn.impute import SimpleImputer  # type: ignore[import-untyped]
from sklearn.linear_model import LogisticRegression  # type: ignore[import-untyped]
from sklearn.metrics import (  # type: ignore[import-untyped]
    average_precision_score,
    brier_score_loss,
    precision_recall_curve,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline  # type: ignore[import-untyped]
from sklearn.preprocessing import OneHotEncoder  # type: ignore[import-untyped]

from .refusal_contracts import CATEGORICAL_FEATURES, RANDOM_SEED

TRAIN_START: Final = pd.Timestamp("2025-01-01")
TRAIN_END: Final = pd.Timestamp("2025-02-01")
VALIDATION_END: Final = pd.Timestamp("2025-03-01")
TEST_END: Final = pd.Timestamp("2025-04-01")
MISSING_VALUE: Final = "__MISSING__"
DUPLICATE_POLICY: Final = (
    "exclude_all_rows_for_repeated_hospitalization_code_before_temporal_split"
)


@dataclass(frozen=True)
class TemporalPartitions:
    train: pd.DataFrame
    validation: pd.DataFrame
    test: pd.DataFrame


@dataclass(frozen=True)
class RefusalCohort:
    frame: pd.DataFrame
    attrition: dict[str, object]


@dataclass(frozen=True)
class ThresholdSelection:
    threshold: float
    precision: float
    recall: float
    f1: float


@dataclass
class LogisticModelBundle:
    pipeline: Pipeline
    feature_order: tuple[str, ...]
    iterations: int
    max_iterations: int

    @property
    def converged(self) -> bool:
        return self.iterations < self.max_iterations

    def predict_proba(self, frame: pd.DataFrame) -> np.ndarray:
        probabilities = self.pipeline.predict_proba(feature_matrix(frame))[:, 1]
        return np.clip(probabilities, 0.0, 1.0)


@dataclass(frozen=True)
class FrequencyPrediction:
    probabilities: np.ndarray
    source_counts: dict[str, int]


@dataclass(frozen=True)
class SmoothedPairBaseline:
    global_probability: float
    pair_probabilities: dict[tuple[str, str], float]
    hospital_probabilities: dict[str, float]
    profile_probabilities: dict[str, float]
    smoothing_strength: float

    def predict(self, frame: pd.DataFrame) -> FrequencyPrediction:
        normalized = normalize_categories(frame)
        probabilities = np.empty(len(normalized), dtype=np.float64)
        counts = {
            "pair": 0,
            "hospital_profile_blend": 0,
            "hospital": 0,
            "profile": 0,
            "global": 0,
        }
        hospitals = normalized["hospital_mo"].to_numpy()
        profiles = normalized["bed_profile"].to_numpy()
        for index, (hospital, profile) in enumerate(
            zip(hospitals, profiles, strict=True)
        ):
            pair = self.pair_probabilities.get((hospital, profile))
            if pair is not None:
                probabilities[index] = pair
                counts["pair"] += 1
                continue
            hospital_probability = self.hospital_probabilities.get(hospital)
            profile_probability = self.profile_probabilities.get(profile)
            if hospital_probability is not None and profile_probability is not None:
                probabilities[index] = (hospital_probability + profile_probability) / 2
                counts["hospital_profile_blend"] += 1
            elif hospital_probability is not None:
                probabilities[index] = hospital_probability
                counts["hospital"] += 1
            elif profile_probability is not None:
                probabilities[index] = profile_probability
                counts["profile"] += 1
            else:
                probabilities[index] = self.global_probability
                counts["global"] += 1
        return FrequencyPrediction(probabilities=probabilities, source_counts=counts)


def normalize_categories(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.loc[:, list(CATEGORICAL_FEATURES)].fillna(MISSING_VALUE).astype(str)


def _outcome_summary(
    refused: pd.Series, hospitalized: pd.Series
) -> dict[str, int]:
    return {
        "input_rows": int(len(refused)),
        "mature_rows": int((refused ^ hospitalized).sum()),
        "refused_only": int((refused & ~hospitalized).sum()),
        "hospitalized_only": int((~refused & hospitalized).sum()),
        "censored_neither": int((~refused & ~hospitalized).sum()),
        "conflicting_both": int((refused & hospitalized).sum()),
    }


def build_cohort(frame: pd.DataFrame) -> RefusalCohort:
    required = {
        "hospitalization_code",
        "registration_dt",
        "is_refused",
        "hospitalized",
        *CATEGORICAL_FEATURES,
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"missing_required_columns:{','.join(missing)}")

    data = frame.loc[
        :,
        [
            "hospitalization_code",
            "registration_dt",
            "is_refused",
            "hospitalized",
            *CATEGORICAL_FEATURES,
        ],
    ].copy()
    if data["hospitalization_code"].isna().any():
        raise ValueError("missing_hospitalization_code")
    data["registration_dt"] = pd.to_datetime(
        data["registration_dt"], errors="coerce", format="mixed"
    )
    if data["registration_dt"].isna().any():
        raise ValueError("invalid_registration_dt")
    numeric_target = pd.to_numeric(data["is_refused"], errors="coerce")
    if numeric_target.isna().any() or not numeric_target.isin((0, 1)).all():
        raise ValueError("invalid_binary_target")
    numeric_hospitalized = pd.to_numeric(data["hospitalized"], errors="coerce")
    if numeric_hospitalized.isna().any() or not numeric_hospitalized.isin((0, 1)).all():
        raise ValueError("invalid_hospitalized_flag")

    data["is_refused"] = numeric_target.astype(np.int8)
    data["hospitalized"] = numeric_hospitalized.astype(np.int8)

    repeated = data["hospitalization_code"].duplicated(keep=False)
    repeated_rows = data.loc[repeated]
    repeated_codes = repeated_rows.groupby("hospitalization_code", sort=False)
    duplicate_audit = {
        "policy": DUPLICATE_POLICY,
        "unique_hospitalization_codes": int(data["hospitalization_code"].nunique()),
        "repeated_hospitalization_codes": int(
            repeated_rows["hospitalization_code"].nunique()
        ),
        "rows_with_repeated_hospitalization_code": int(repeated.sum()),
        "is_refused_conflicting_codes": int(
            repeated_codes["is_refused"].nunique().gt(1).sum()
        ),
        "hospitalized_conflicting_codes": int(
            repeated_codes["hospitalized"].nunique().gt(1).sum()
        ),
        "cross_month_codes": int(
            repeated_rows.assign(
                registration_month=repeated_rows["registration_dt"]
                .dt.to_period("M")
                .astype(str)
            )
            .groupby("hospitalization_code")["registration_month"]
            .nunique()
            .gt(1)
            .sum()
        ),
        "selection_uses_target_or_timestamp": False,
    }
    if duplicate_audit["cross_month_codes"] != 0:
        raise ValueError("duplicate_identifier_crosses_temporal_partition")
    data = data.loc[~repeated].copy()
    duplicate_audit["rows_after_policy"] = int(len(data))

    refused = data["is_refused"].eq(1)
    hospitalized = data["hospitalized"].eq(1)
    mature = refused ^ hospitalized
    months = data["registration_dt"].dt.to_period("M").astype(str)
    by_month: dict[str, dict[str, int]] = {}
    for month in sorted(months.unique().tolist()):
        selected = months.eq(month)
        by_month[month] = _outcome_summary(
            refused.loc[selected], hospitalized.loc[selected]
        )

    cohort = data.loc[
        mature, ["registration_dt", "is_refused", *CATEGORICAL_FEATURES]
    ].copy()
    cohort.sort_values("registration_dt", kind="mergesort", inplace=True)
    cohort.reset_index(drop=True, inplace=True)
    attrition: dict[str, object] = {
        **_outcome_summary(refused, hospitalized),
        "source_rows_before_duplicate_policy": int(len(frame)),
        "duplicate_audit": duplicate_audit,
        "by_month": by_month,
        "policy": (
            f"{DUPLICATE_POLICY}_then_exclude_censored_neither_and_conflicting_both"
        ),
    }
    return RefusalCohort(frame=cohort, attrition=attrition)


def temporal_split(frame: pd.DataFrame) -> TemporalPartitions:
    dates = pd.to_datetime(frame["registration_dt"], errors="raise")
    if dates.lt(TRAIN_START).any() or dates.ge(TEST_END).any():
        raise ValueError("outside_supported_period")
    train = frame.loc[dates.ge(TRAIN_START) & dates.lt(TRAIN_END)].copy()
    validation = frame.loc[dates.ge(TRAIN_END) & dates.lt(VALIDATION_END)].copy()
    test = frame.loc[dates.ge(VALIDATION_END) & dates.lt(TEST_END)].copy()
    if min(len(train), len(validation), len(test)) == 0:
        raise ValueError("empty_temporal_partition")
    if not train["registration_dt"].max() < validation["registration_dt"].min():
        raise ValueError("train_validation_overlap")
    if not validation["registration_dt"].max() < test["registration_dt"].min():
        raise ValueError("validation_test_overlap")
    return TemporalPartitions(train=train, validation=validation, test=test)


def constant_predictions(train: pd.DataFrame, target: pd.DataFrame) -> np.ndarray:
    probability = float(train["is_refused"].mean())
    return np.full(len(target), probability, dtype=np.float64)


def _smoothed_probabilities(
    frame: pd.DataFrame,
    groups: list[str],
    prior: float,
    smoothing_strength: float,
) -> dict[object, float]:
    stats = frame.groupby(groups, dropna=False)["is_refused"].agg(["sum", "count"])
    probabilities: dict[object, float] = {}
    for key, row in stats.iterrows():
        normalized_key: object
        if isinstance(key, tuple):
            normalized_key = tuple(str(value) for value in key)
        else:
            normalized_key = str(key)
        probabilities[normalized_key] = float(
            (float(row["sum"]) + smoothing_strength * prior)
            / (float(row["count"]) + smoothing_strength)
        )
    return probabilities


def fit_smoothed_pair_baseline(
    train: pd.DataFrame, *, smoothing_strength: float = 50.0
) -> SmoothedPairBaseline:
    if smoothing_strength <= 0:
        raise ValueError("invalid_smoothing_strength")
    normalized = normalize_categories(train).assign(
        is_refused=train["is_refused"].to_numpy()
    )
    global_probability = float(normalized["is_refused"].mean())
    hospital = _smoothed_probabilities(
        normalized, ["hospital_mo"], global_probability, smoothing_strength
    )
    profile = _smoothed_probabilities(
        normalized, ["bed_profile"], global_probability, smoothing_strength
    )

    pair_stats = normalized.groupby(
        ["hospital_mo", "bed_profile"], dropna=False
    )["is_refused"].agg(["sum", "count"])
    pair: dict[tuple[str, str], float] = {}
    for key, row in pair_stats.iterrows():
        hospital_key, profile_key = (str(key[0]), str(key[1]))
        prior = (
            hospital.get(hospital_key, global_probability)
            + profile.get(profile_key, global_probability)
        ) / 2
        pair[(hospital_key, profile_key)] = float(
            (float(row["sum"]) + smoothing_strength * prior)
            / (float(row["count"]) + smoothing_strength)
        )
    return SmoothedPairBaseline(
        global_probability=global_probability,
        pair_probabilities=pair,
        hospital_probabilities={str(key): value for key, value in hospital.items()},
        profile_probabilities={str(key): value for key, value in profile.items()},
        smoothing_strength=smoothing_strength,
    )


def feature_matrix(frame: pd.DataFrame) -> pd.DataFrame:
    return normalize_categories(frame)


def make_logistic_pipeline(c_value: float) -> Pipeline:
    if c_value <= 0:
        raise ValueError("invalid_regularization")
    categories = Pipeline(
        steps=[
            ("missing", SimpleImputer(strategy="constant", fill_value=MISSING_VALUE)),
            (
                "one_hot",
                OneHotEncoder(
                    handle_unknown="infrequent_if_exist",
                    min_frequency=20,
                    dtype=np.float32,
                ),
            ),
        ]
    )
    preprocessing = ColumnTransformer(
        [("categories", categories, list(CATEGORICAL_FEATURES))],
        remainder="drop",
    )
    classifier = LogisticRegression(
        C=c_value,
        class_weight=None,
        max_iter=300,
        random_state=RANDOM_SEED,
        solver="liblinear",
        tol=1e-4,
    )
    return Pipeline(steps=[("preprocess", preprocessing), ("classifier", classifier)])


def fit_logistic_model(frame: pd.DataFrame, c_value: float) -> LogisticModelBundle:
    pipeline = make_logistic_pipeline(c_value)
    pipeline.fit(feature_matrix(frame), frame["is_refused"].to_numpy())
    classifier: LogisticRegression = pipeline.named_steps["classifier"]
    return LogisticModelBundle(
        pipeline=pipeline,
        feature_order=CATEGORICAL_FEATURES,
        iterations=int(classifier.n_iter_[0]),
        max_iterations=int(classifier.max_iter),
    )


def select_f1_threshold(actual: np.ndarray, probabilities: np.ndarray) -> ThresholdSelection:
    labels = np.asarray(actual, dtype=np.int8)
    scores = np.asarray(probabilities, dtype=np.float64)
    if labels.shape != scores.shape or labels.size == 0:
        raise ValueError("invalid_threshold_inputs")
    precision, recall, thresholds = precision_recall_curve(labels, scores)
    if thresholds.size == 0:
        raise ValueError("no_threshold_candidates")
    numerators = 2 * precision[:-1] * recall[:-1]
    denominators = precision[:-1] + recall[:-1]
    f1 = np.divide(
        numerators,
        denominators,
        out=np.zeros_like(numerators),
        where=denominators > 0,
    )
    best = max(
        range(len(thresholds)),
        key=lambda index: (f1[index], precision[index], thresholds[index]),
    )
    return ThresholdSelection(
        threshold=float(thresholds[best]),
        precision=float(precision[best]),
        recall=float(recall[best]),
        f1=float(f1[best]),
    )


def classification_metrics(
    actual: np.ndarray, probabilities: np.ndarray, threshold: float
) -> dict[str, float | int]:
    labels = np.asarray(actual, dtype=np.int8)
    scores = np.asarray(probabilities, dtype=np.float64)
    if labels.shape != scores.shape or labels.size == 0:
        raise ValueError("invalid_metric_inputs")
    if not np.array_equal(np.unique(labels), np.array([0, 1], dtype=np.int8)):
        raise ValueError("metrics_require_both_classes")
    if not np.isfinite(scores).all() or ((scores < 0) | (scores > 1)).any():
        raise ValueError("invalid_probabilities")
    predicted = scores >= threshold
    positives = labels == 1
    true_positive = int(np.sum(predicted & positives))
    predicted_positive = int(predicted.sum())
    actual_positive = int(positives.sum())
    precision = true_positive / predicted_positive if predicted_positive else 0.0
    recall = true_positive / actual_positive if actual_positive else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "rows": int(labels.size),
        "positives": actual_positive,
        "prevalence": round(float(labels.mean()), 8),
        "pr_auc": round(float(average_precision_score(labels, scores)), 8),
        "roc_auc": round(float(roc_auc_score(labels, scores)), 8),
        "brier": round(float(brier_score_loss(labels, scores)), 8),
        "threshold": float(threshold),
        "predicted_positive": predicted_positive,
        "precision": round(float(precision), 8),
        "recall": round(float(recall), 8),
        "f1": round(float(f1), 8),
    }


def calibration_deciles(
    actual: np.ndarray, probabilities: np.ndarray, *, requested_bins: int = 10
) -> dict[str, int | list[dict[str, float | int]]]:
    labels = np.asarray(actual, dtype=np.int8)
    scores = np.asarray(probabilities, dtype=np.float64)
    if labels.shape != scores.shape or labels.size == 0 or requested_bins < 2:
        raise ValueError("invalid_calibration_inputs")
    edges = np.unique(np.quantile(scores, np.linspace(0.0, 1.0, requested_bins + 1)))
    if len(edges) == 1:
        assignments = np.zeros(len(scores), dtype=np.int8)
    else:
        assignments = np.searchsorted(edges[1:-1], scores, side="right")
    bins: list[dict[str, float | int]] = []
    for bin_index in sorted(np.unique(assignments).tolist()):
        selected = assignments == bin_index
        bin_scores = scores[selected]
        bin_labels = labels[selected]
        bins.append(
            {
                "bin": len(bins) + 1,
                "rows": int(selected.sum()),
                "score_min": round(float(bin_scores.min()), 8),
                "score_max": round(float(bin_scores.max()), 8),
                "mean_predicted": round(float(bin_scores.mean()), 8),
                "observed_rate": round(float(bin_labels.mean()), 8),
            }
        )
    return {
        "requested_bins": requested_bins,
        "actual_bins": len(bins),
        "bins": bins,
    }
