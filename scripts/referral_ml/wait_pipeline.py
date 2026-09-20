"""Cohort, split, baselines and metrics for the offline D1 benchmark."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

import numpy as np
import pandas as pd  # type: ignore[import-untyped]
from sklearn.compose import ColumnTransformer  # type: ignore[import-untyped]
from sklearn.ensemble import HistGradientBoostingRegressor  # type: ignore[import-untyped]
from sklearn.impute import SimpleImputer  # type: ignore[import-untyped]
from sklearn.linear_model import Ridge  # type: ignore[import-untyped]
from sklearn.pipeline import Pipeline  # type: ignore[import-untyped]
from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder  # type: ignore[import-untyped]

from .contracts import CATEGORICAL_FEATURES, HORIZON_DAYS

TRAIN_END: Final = pd.Timestamp("2025-02-01")
VALIDATION_END: Final = pd.Timestamp("2025-03-01")


@dataclass(frozen=True)
class Cohort:
    frame: pd.DataFrame
    attrition: dict[str, int | float]


@dataclass(frozen=True)
class TemporalPartitions:
    train: pd.DataFrame
    validation: pd.DataFrame
    test: pd.DataFrame


@dataclass
class WaitModelBundle:
    pipeline: Pipeline
    feature_order: tuple[str, ...]
    prediction_clip: tuple[float, float]
    target_policy: str

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        values = self.pipeline.predict(feature_matrix(frame))
        return np.clip(values, *self.prediction_clip)


def build_cohort(frame: pd.DataFrame) -> Cohort:
    required = {
        "registration_dt",
        "hospitalized",
        "is_refused",
        "wait_days",
        *CATEGORICAL_FEATURES,
    }
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"missing_required_columns:{','.join(missing)}")

    data = frame.copy()
    data["registration_dt"] = pd.to_datetime(
        data["registration_dt"], errors="coerce", format="mixed"
    )
    data["wait_days"] = pd.to_numeric(data["wait_days"], errors="coerce")
    hospitalized = data["hospitalized"].fillna(False).astype(bool)
    refused = data["is_refused"].fillna(0).astype(int).eq(1)
    valid_date = data["registration_dt"].notna()
    valid_wait = data["wait_days"].notna()

    both = hospitalized & refused
    refused_only = ~hospitalized & refused
    unresolved = ~hospitalized & ~refused
    hospitalized_only = hospitalized & ~refused
    invalid_registration = hospitalized_only & ~valid_date
    missing_wait = hospitalized_only & valid_date & ~valid_wait
    negative_wait = hospitalized_only & valid_date & valid_wait & data["wait_days"].lt(0)
    beyond_horizon = (
        hospitalized_only & valid_date & valid_wait & data["wait_days"].gt(HORIZON_DAYS)
    )
    eligible = (
        hospitalized_only
        & valid_date
        & valid_wait
        & data["wait_days"].ge(0)
        & data["wait_days"].le(HORIZON_DAYS)
    )

    cohort = data.loc[eligible, ["registration_dt", "wait_days", *CATEGORICAL_FEATURES]].copy()
    cohort.sort_values("registration_dt", kind="mergesort", inplace=True)
    cohort.reset_index(drop=True, inplace=True)
    attrition: dict[str, int | float] = {
        "input_rows": int(len(data)),
        "both_hospitalized_and_refused": int(both.sum()),
        "refused_only": int(refused_only.sum()),
        "unresolved": int(unresolved.sum()),
        "hospitalized_only": int(hospitalized_only.sum()),
        "missing_wait_days": int(missing_wait.sum()),
        "negative_wait_days": int(negative_wait.sum()),
        "over_60_wait_days": int(beyond_horizon.sum()),
        "invalid_registration_dt": int(invalid_registration.sum()),
        "eligible_rows": int(eligible.sum()),
        "eligible_fraction": round(float(eligible.mean()), 8),
    }
    return Cohort(frame=cohort, attrition=attrition)


def temporal_split(frame: pd.DataFrame) -> TemporalPartitions:
    dates = pd.to_datetime(frame["registration_dt"], errors="raise")
    train = frame.loc[dates.lt(TRAIN_END)].copy()
    validation = frame.loc[dates.ge(TRAIN_END) & dates.lt(VALIDATION_END)].copy()
    test = frame.loc[dates.ge(VALIDATION_END)].copy()
    if min(len(train), len(validation), len(test)) == 0:
        raise ValueError("empty_temporal_partition")
    if not train["registration_dt"].max() < validation["registration_dt"].min():
        raise ValueError("train_validation_overlap")
    if not validation["registration_dt"].max() < test["registration_dt"].min():
        raise ValueError("validation_test_overlap")
    return TemporalPartitions(train=train, validation=validation, test=test)


def make_pipeline(alpha: float) -> Pipeline:
    categories = Pipeline(
        steps=[
            ("missing", SimpleImputer(strategy="constant", fill_value="__MISSING__")),
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
    return Pipeline(
        steps=[
            ("preprocess", preprocessing),
            ("regressor", Ridge(alpha=alpha, solver="lsqr", tol=1e-5)),
        ]
    )


def feature_matrix(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.loc[:, list(CATEGORICAL_FEATURES)].fillna("__MISSING__").astype(str)


def fit_model(frame: pd.DataFrame, alpha: float) -> WaitModelBundle:
    pipeline = make_pipeline(alpha)
    pipeline.fit(feature_matrix(frame), frame["wait_days"].to_numpy())
    return WaitModelBundle(
        pipeline=pipeline,
        feature_order=CATEGORICAL_FEATURES,
        prediction_clip=(0.0, float(HORIZON_DAYS)),
        target_policy="hospitalized_only_observed_wait_0_to_60_days_inclusive",
    )


def make_hist_gradient_pipeline(loss: str, max_leaf_nodes: int) -> Pipeline:
    encoder = OrdinalEncoder(
        handle_unknown="use_encoded_value",
        unknown_value=np.nan,
        encoded_missing_value=np.nan,
        min_frequency=20,
        max_categories=255,
        dtype=np.float64,
    )
    regressor = HistGradientBoostingRegressor(
        loss=loss,
        learning_rate=0.08,
        max_iter=300,
        max_leaf_nodes=max_leaf_nodes,
        min_samples_leaf=50,
        l2_regularization=5.0,
        categorical_features=np.ones(len(CATEGORICAL_FEATURES), dtype=bool),
        random_state=20250919,
    )
    return Pipeline(steps=[("ordinal", encoder), ("regressor", regressor)])


def fit_hist_gradient_model(
    frame: pd.DataFrame, *, loss: str, max_leaf_nodes: int
) -> WaitModelBundle:
    pipeline = make_hist_gradient_pipeline(loss, max_leaf_nodes)
    pipeline.fit(feature_matrix(frame), frame["wait_days"].to_numpy())
    return WaitModelBundle(
        pipeline=pipeline,
        feature_order=CATEGORICAL_FEATURES,
        prediction_clip=(0.0, float(HORIZON_DAYS)),
        target_policy="hospitalized_only_observed_wait_0_to_60_days_inclusive",
    )


def regression_metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float | int]:
    actual_values = np.asarray(actual, dtype=np.float64)
    predicted_values = np.asarray(predicted, dtype=np.float64)
    if actual_values.shape != predicted_values.shape or actual_values.size == 0:
        raise ValueError("invalid_metric_inputs")
    error = predicted_values - actual_values
    absolute = np.abs(error)
    return {
        "rows": int(actual_values.size),
        "mae_days": round(float(absolute.mean()), 6),
        "median_absolute_error_days": round(float(np.median(absolute)), 6),
        "p90_absolute_error_days": round(float(np.quantile(absolute, 0.9)), 6),
        "rmse_days": round(float(np.sqrt(np.mean(np.square(error)))), 6),
        "mean_error_days": round(float(error.mean()), 6),
        "within_3_days_fraction": round(float(np.mean(absolute <= 3)), 6),
        "within_7_days_fraction": round(float(np.mean(absolute <= 7)), 6),
    }


def global_median_predictions(train: pd.DataFrame, target: pd.DataFrame) -> np.ndarray:
    return np.full(len(target), float(train["wait_days"].median()), dtype=np.float64)


def hierarchical_median_predictions(train: pd.DataFrame, target: pd.DataFrame) -> np.ndarray:
    """Use hospital+profile, then profile, then global medians from prior partitions."""

    normalized_train = train.assign(
        hospital_mo=train["hospital_mo"].fillna("__MISSING__").astype(str),
        bed_profile=train["bed_profile"].fillna("__MISSING__").astype(str),
    )
    normalized_target = target.assign(
        hospital_mo=target["hospital_mo"].fillna("__MISSING__").astype(str),
        bed_profile=target["bed_profile"].fillna("__MISSING__").astype(str),
    )
    global_value = float(normalized_train["wait_days"].median())
    pair_stats = normalized_train.groupby(["hospital_mo", "bed_profile"])["wait_days"].agg(
        ["median", "count"]
    )
    profile_stats = normalized_train.groupby("bed_profile")["wait_days"].agg(
        ["median", "count"]
    )
    pair_values = {
        key: float(row["median"])
        for key, row in pair_stats.iterrows()
        if int(row["count"]) >= 50
    }
    profile_values = {
        key: float(row["median"])
        for key, row in profile_stats.iterrows()
        if int(row["count"]) >= 100
    }

    predictions = np.empty(len(target), dtype=np.float64)
    hospitals = normalized_target["hospital_mo"].to_numpy()
    profiles = normalized_target["bed_profile"].to_numpy()
    for index, (hospital, profile) in enumerate(zip(hospitals, profiles, strict=True)):
        predictions[index] = pair_values.get(
            (hospital, profile),
            profile_values.get(profile, global_value),
        )
    return predictions
