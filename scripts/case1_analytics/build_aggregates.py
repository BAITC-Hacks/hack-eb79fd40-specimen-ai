"""Case 1 analytics: aggregates and load forecast from open IS BG data.

Input: three CSV parts of "Направления на плановую госпитализацию в стационары"
from Ashyq Data (data.gov.kz, dataset mz_bg_planned_hospitalization_referrals),
downloaded by scripts/case1_analytics/download.sh (into data/raw/case1, git-ignored).

Output: data/case1/aggregates.json — organisation-level aggregates only, no
patient rows. Nothing here is imported by the Next.js runtime; the workspace
reads the JSON.

Run: python -m scripts.case1_analytics.build_aggregates --raw <dir>
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

SCHEMA_VERSION = 1
PART_GLOB = "Направления_на_плановую_госпитализацию_в_стационары_part_00*_of_003.csv"
MIN_HOSPITAL_REFERRALS = 300
MIN_CELL = 10
FORECAST_CUTOFF = pd.Timestamp("2025-03-01")
FORECAST_END = pd.Timestamp("2025-04-01")
PREV_CUTOFF = pd.Timestamp("2025-02-01")
# Official non-working weekdays of Q1 2025 (production calendar of RK); checked
# against daily registration counts, which drop 2-3x on each of these dates.
HOLIDAYS_2025Q1 = ["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-07",
                   "2025-03-10", "2025-03-21", "2025-03-24", "2025-03-25"]


def working_days(start: pd.Timestamp, end: pd.Timestamp) -> int:
    return int(np.busday_count(start.date(), end.date(), holidays=HOLIDAYS_2025Q1))

# First block of hospitalization_code is the KATO region code of the referring
# organisation (checked: 1132 of 1140 referring organisations have one code).
KATO_REGIONS = {
    "10": "область Абай",
    "11": "Акмолинская область",
    "15": "Актюбинская область",
    "19": "Алматинская область",
    "23": "Атырауская область",
    "27": "Западно-Казахстанская область",
    "31": "Жамбылская область",
    "33": "область Жетісу",
    "35": "Карагандинская область",
    "39": "Костанайская область",
    "43": "Кызылординская область",
    "47": "Мангистауская область",
    "55": "Павлодарская область",
    "59": "Северо-Казахстанская область",
    "61": "Туркестанская область",
    "62": "область Ұлытау",
    "63": "Восточно-Казахстанская область",
    "71": "г. Астана",
    "75": "г. Алматы",
    "79": "г. Шымкент",
}

COLUMNS = [
    "hospitalization_code",
    "referring_mo",
    "hospital_mo",
    "bed_profile",
    "registration_dt",
    "hospitalization_dt",
    "refusal_dt",
    "territorial_type",
    "referral_purpose",
    "finance_source",
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load(raw: Path) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    paths = sorted(Path(p) for p in glob.glob(str(raw / PART_GLOB)))
    if len(paths) != 3:
        raise SystemExit(f"expected 3 CSV parts in {raw}, found {len(paths)}")
    frames = [pd.read_csv(p, usecols=COLUMNS, dtype=str) for p in paths]
    df = pd.concat(frames, ignore_index=True)
    # Timestamps mix "…:SS" and "…:SS.fff"; ISO8601 parses both, and any loss is fatal.
    frames_na = {c: int(df[c].isna().sum()) for c in ("registration_dt", "hospitalization_dt", "refusal_dt")}
    for column in ("registration_dt", "hospitalization_dt", "refusal_dt"):
        df[column] = pd.to_datetime(df[column], format="ISO8601", errors="coerce")
    for column in ("registration_dt", "hospitalization_dt", "refusal_dt"):
        lost = df[column].isna().sum() - frames_na[column]
        if lost:
            raise SystemExit(f"{column}: {lost} values failed to parse")
    df["region"] = df["hospitalization_code"].str.split(".").str[0]
    df["refused"] = df["refusal_dt"].notna()
    df["hospitalized"] = df["hospitalization_dt"].notna() & ~df["refused"]
    df["wait_days"] = (df["hospitalization_dt"] - df["registration_dt"]).dt.days
    df["self_referral"] = df["referring_mo"] == df["hospital_mo"]
    df["day_stay"] = df["bed_profile"].isna()
    df["profile"] = df["bed_profile"].fillna("Дневной стационар (профиль койки не указан)")
    inputs = [{"file": p.name, "bytes": p.stat().st_size, "sha256": sha256_file(p)} for p in paths]
    return df, inputs


def pct(x: float) -> float:
    return round(100 * float(x), 1)


def outcome_block(g: pd.DataFrame, queue: bool = True) -> dict[str, Any]:
    waits = g.loc[g["hospitalized"], "wait_days"]
    block = {
        "referrals": int(len(g)),
        "refusal_pct": pct(g["refused"].mean()),
        "hospitalized": int(g["hospitalized"].sum()),
        "wait_median_days": None if waits.empty else float(waits.median()),
        "wait_p90_days": None if waits.empty else float(waits.quantile(0.9)),
        "wait_over_30_pct": None if waits.empty else pct((waits > 30).mean()),
        "self_referral_pct": pct(g["self_referral"].mean()),
    }
    if queue:
        # The actual queue: referral from another organisation to a 24h bed.
        q = g[~g["self_referral"] & ~g["day_stay"]]
        block["external_24h"] = outcome_block(q, queue=False) if len(q) >= MIN_CELL else None
        if block["external_24h"]:
            block["external_24h"].pop("self_referral_pct")
    return block


def poisson_ci(observed: int, expected: float) -> tuple[float, float]:
    """95% interval for O/E using Byar's approximation."""
    if expected <= 0:
        return (math.nan, math.nan)
    o = observed
    lo = 0.0 if o == 0 else o * (1 - 1 / (9 * o) - 1.96 / (3 * math.sqrt(o))) ** 3
    hi = (o + 1) * (1 - 1 / (9 * (o + 1)) + 1.96 / (3 * math.sqrt(o + 1))) ** 3
    return (lo / expected, hi / expected)


def hospital_region(df: pd.DataFrame) -> pd.Series:
    """Region of a hospital: its own referrals first, else modal patient region."""
    own = df[df["self_referral"]].groupby("hospital_mo")["region"].agg(lambda s: s.mode().iat[0])
    modal = df.groupby("hospital_mo")["region"].agg(lambda s: s.mode().iat[0])
    return own.reindex(modal.index).fillna(modal)


def standardized(df: pd.DataFrame, flag: str, strata: list[str]) -> pd.DataFrame:
    """Observed vs expected events per hospital, expected from national stratum rates."""
    rate = df.groupby(strata)[flag].transform("mean")
    out = df.assign(_exp=rate).groupby("hospital_mo").agg(observed=(flag, "sum"), expected=("_exp", "sum"))
    out["observed"] = out["observed"].astype(int)
    return out


def factors(df: pd.DataFrame) -> list[dict[str, Any]]:
    base = df["refused"].mean()
    rows = []
    groups = {
        "Кто направил": df["self_referral"].map({True: "стационар сам себе", False: "другая организация"}),
        "Цель госпитализации": df["referral_purpose"],
        "Тип койки": df["day_stay"].map({True: "дневной стационар", False: "круглосуточный"}),
        "Регион пациента и стационара": df["inter_region"].map({True: "разные регионы", False: "один регион"}),
        "Источник финансирования": df["finance_source"],
        "Территория": df["territorial_type"],
    }
    for factor, series in groups.items():
        for value, g in df.groupby(series, dropna=True):
            if len(g) < 1000:
                continue
            rows.append({
                "factor": factor,
                "value": str(value),
                "referrals": int(len(g)),
                "refusal_pct": pct(g["refused"].mean()),
                "lift": round(float(g["refused"].mean() / base), 2),
            })
    return rows


def forecast(df: pd.DataFrame, hospitals: list[str]) -> dict[str, Any]:
    """March admissions per hospital, forecast from data known on 1 March.

    Admissions come from referrals already pending at the cutoff plus new
    referrals of the month. Both conversion rates are learned on the previous
    month (cutoff 1 Feb -> February), shrunk towards the national rate.
    New referrals are projected by working days (the calendar is known in
    advance). Baselines: February admissions scaled by working days and by
    calendar days.
    """
    adm = df["hospitalization_dt"]
    reg = df["registration_dt"]
    resolved_before = lambda cut: (adm < cut) | (df["refusal_dt"] < cut)

    def month_rates(cut: pd.Timestamp, end: pd.Timestamp) -> tuple[pd.Series, pd.Series, float, float]:
        pending = (reg < cut) & ~resolved_before(cut)
        new = (reg >= cut) & (reg < end)
        admitted = (adm >= cut) & (adm < end) & df["hospitalized"]
        p = df[pending].assign(a=admitted[pending]).groupby("hospital_mo")["a"].agg(["sum", "count"])
        n = df[new].assign(a=admitted[new]).groupby("hospital_mo")["a"].agg(["sum", "count"])
        gp = p["sum"].sum() / max(p["count"].sum(), 1)
        gn = n["sum"].sum() / max(n["count"].sum(), 1)
        k = 20.0  # pseudo-count for shrinkage towards the national rate
        rp = (p["sum"] + k * gp) / (p["count"] + k)
        rn = (n["sum"] + k * gn) / (n["count"] + k)
        return rp, rn, gp, gn

    rp, rn, gp, gn = month_rates(PREV_CUTOFF, FORECAST_CUTOFF)
    feb_days = (FORECAST_CUTOFF - PREV_CUTOFF).days
    mar_days = (FORECAST_END - FORECAST_CUTOFF).days
    feb_work = working_days(PREV_CUTOFF, FORECAST_CUTOFF)
    mar_work = working_days(FORECAST_CUTOFF, FORECAST_END)

    pending_mar = ((reg < FORECAST_CUTOFF) & ~resolved_before(FORECAST_CUTOFF))
    pending_n = df[pending_mar].groupby("hospital_mo").size()
    feb_new = df[(reg >= PREV_CUTOFF) & (reg < FORECAST_CUTOFF)].groupby("hospital_mo").size()
    expected_new = feb_new * mar_work / feb_work
    feb_adm = df[(adm >= PREV_CUTOFF) & (adm < FORECAST_CUTOFF) & df["hospitalized"]].groupby("hospital_mo").size()
    mar_adm = df[(adm >= FORECAST_CUTOFF) & (adm < FORECAST_END) & df["hospitalized"]].groupby("hospital_mo").size()

    idx = pd.Index(hospitals)
    from_pending = pending_n.reindex(idx, fill_value=0) * rp.reindex(idx).fillna(gp)
    from_new = expected_new.reindex(idx, fill_value=0) * rn.reindex(idx).fillna(gn)
    flow = from_pending + from_new
    naive = feb_adm.reindex(idx, fill_value=0) * mar_work / feb_work
    # Equal-weight average of the flow model and the working-day baseline.
    # Chosen after comparing three variants on March, so March is not a fully
    # untouched test for this choice (flow alone: see "flow_only").
    pred = (flow + naive) / 2
    naive_calendar = feb_adm.reindex(idx, fill_value=0) * mar_days / feb_days
    actual = mar_adm.reindex(idx, fill_value=0)

    def metrics(p: pd.Series) -> dict[str, float]:
        err = (p - actual).abs()
        return {
            "mae_admissions": round(float(err.mean()), 1),
            "wape_pct": pct(err.sum() / actual.sum()),
            "median_abs_pct_error": pct(((p - actual).abs() / actual.clip(lower=1)).median()),
        }

    per_hospital = pd.DataFrame({
        "forecast": pred.round(0), "naive": naive.round(0), "actual": actual,
        "from_pending": from_pending.round(0), "from_new": from_new.round(0),
        "pending_at_cutoff": pending_n.reindex(idx, fill_value=0),
    })
    return {
        "target": "поступления в стационар в марте 2025 по направлениям I квартала",
        "made_at": FORECAST_CUTOFF.date().isoformat(),
        "horizon_days": mar_days,
        "method": "среднее двух оценок: (1) поток — ожидающие на 01.03 × доля поступивших за месяц + новые направления (темп февраля на рабочий день × рабочие дни марта) × доля поступивших в месяц регистрации; доли выучены на феврале со сжатием к средней по стране; (2) февраль по рабочим дням",
        "selection_note": "вариант со средним выбран из трёх после сравнения на марте; модель потока без усреднения — flow_only",
        "working_days": {"february": feb_work, "march": mar_work},
        "baseline": "поступления за февраль, пересчитанные по рабочим дням марта",
        "baseline_calendar": "поступления за февраль, пересчитанные на 31 календарный день",
        "hospitals": len(idx),
        "model": metrics(pred),
        "flow_only": metrics(flow),
        "naive": metrics(naive),
        "naive_calendar": metrics(naive_calendar),
        "national": {
            "forecast": int(round(pred.sum())),
            "naive": int(round(naive.sum())),
            "naive_calendar": int(round(naive_calendar.sum())),
            "actual": int(actual.sum()),
        },
        "per_hospital": per_hospital,
    }


def build(raw: Path) -> dict[str, Any]:
    df, inputs = load(raw)
    unknown = sorted(set(df["region"]) - set(KATO_REGIONS))
    if unknown:
        raise SystemExit(f"unknown KATO region codes: {unknown}")

    h_region = hospital_region(df)
    df["hospital_region"] = df["hospital_mo"].map(h_region)
    df["inter_region"] = df["region"] != df["hospital_region"]

    period = [df["registration_dt"].min().date().isoformat(), df["registration_dt"].max().date().isoformat()]

    # Regions (by patient's referring region)
    regions = []
    for code, g in df.groupby("region"):
        block = outcome_block(g)
        block.update({
            "code": code,
            "name": KATO_REGIONS[code],
            "treated_in_other_region_pct": pct(g["inter_region"].mean()),
            "hospitals": int(g["hospital_mo"].nunique()),
            "monthly_referrals": {m.strftime("%Y-%m"): int(n) for m, n in g.groupby(g["registration_dt"].dt.to_period("M")).size().items()},
        })
        regions.append(block)

    # Hospitals with enough volume
    counts = df["hospital_mo"].value_counts()
    big = sorted(counts[counts >= MIN_HOSPITAL_REFERRALS].index.tolist())
    refusal_oe = standardized(df, "refused", ["profile", "referral_purpose", "self_referral"])
    hosp = df[df["hospitalized"]].assign(long=lambda d: d["wait_days"] > 30)
    wait_oe = standardized(hosp, "long", ["profile", "referral_purpose", "self_referral"])
    fc = forecast(df, big)
    per_h = fc.pop("per_hospital")

    hospitals = []
    for name in big:
        g = df[df["hospital_mo"] == name]
        block = outcome_block(g)
        ro = refusal_oe.loc[name]
        r_ratio = ro["observed"] / ro["expected"] if ro["expected"] > 0 else math.nan
        r_lo, r_hi = poisson_ci(int(ro["observed"]), float(ro["expected"]))
        entry: dict[str, Any] = {
            "name": name,
            "region_code": h_region[name],
            "region": KATO_REGIONS[h_region[name]],
            **block,
            "from_other_regions_pct": pct(g["inter_region"].mean()),
            "day_stay_pct": pct(g["day_stay"].mean()),
            "top_profiles": [
                {"profile": p, "referrals": int(n)}
                for p, n in sorted(g["profile"].value_counts().items(), key=lambda t: (-t[1], t[0]))[:3]
                if n >= MIN_CELL
            ],
            "refusal_vs_expected": {
                "observed": int(ro["observed"]),
                "expected": round(float(ro["expected"]), 1),
                "ratio": round(float(r_ratio), 2),
                "ci95": [round(r_lo, 2), round(r_hi, 2)],
                "excess": round(float(ro["observed"] - ro["expected"]), 1),
            },
        }
        if name in wait_oe.index and wait_oe.loc[name, "expected"] >= 5:
            wo = wait_oe.loc[name]
            w_lo, w_hi = poisson_ci(int(wo["observed"]), float(wo["expected"]))
            entry["long_wait_vs_expected"] = {
                "observed": int(wo["observed"]),
                "expected": round(float(wo["expected"]), 1),
                "ratio": round(float(wo["observed"] / wo["expected"]), 2),
                "ci95": [round(w_lo, 2), round(w_hi, 2)],
            }
        f = per_h.loc[name]
        entry["march_forecast"] = {k: int(f[k]) for k in ("forecast", "naive", "actual", "pending_at_cutoff", "from_pending", "from_new")}
        signals = []
        if r_lo > 1.5:
            signals.append("refusal_above_expected")
        lw = entry.get("long_wait_vs_expected")
        if lw and lw["ci95"][0] > 1.5:
            signals.append("long_wait_above_expected")
        entry["signals"] = signals
        hospitals.append(entry)
    hospitals.sort(key=lambda h: (-h["referrals"], h["name"]))

    profiles = []
    for p, g in df.groupby("profile"):
        if len(g) < 1000:
            continue
        block = outcome_block(g)
        block["profile"] = p
        profiles.append(block)
    profiles.sort(key=lambda b: (-b["referrals"], b["profile"]))

    weekly = df.groupby(df["registration_dt"].dt.to_period("W-SUN")).agg(
        referrals=("refused", "size"), refused=("refused", "sum"))
    weekly_series = [
        {"week_start": w.start_time.date().isoformat(), "referrals": int(r.referrals), "refusal_pct": pct(r.refused / r.referrals)}
        for w, r in weekly.iterrows()
    ]

    flagged = [h for h in hospitals if h["signals"]]
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "offline_snapshot",
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": {
            "name": "ИС «Бюро госпитализации»: Направления на плановую госпитализацию в стационары",
            "publisher": "Ashyq Data (data.gov.kz), открытые данные МЗ РК",
            "dataset": "mz_bg_planned_hospitalization_referrals",
            "registration_period": period,
            "outcomes_observed_until": "2026-05-13",
            "inputs": inputs,
        },
        "definitions": {
            "region": "регион направившей организации (КАТО, первый блок hospitalization_code)",
            "hospital_region": "регион стационара: по его собственным направлениям, иначе самый частый регион пациентов",
            "refusal": "у направления заполнена дата отказа (refusal_dt); причина отказа в данных отсутствует",
            "wait_days": "дней от регистрации направления до госпитализации, только госпитализированные",
            "self_referral": "направившая организация совпадает со стационаром",
            "external_24h": "очередь в собственном смысле: направление из другой организации на круглосуточную койку",
            "day_stay": "профиль койки не указан; по доле и отказам соответствует дневному стационару",
            "refusal_vs_expected": "отказы стационара против ожидаемых при средних по стране долях в той же группе (профиль × цель × самонаправление); 95% интервал по Пуассону",
            "signals": "интервал отношения целиком выше 1,5 — отказов или ожиданий >30 дней заметно больше, чем у сопоставимых стационаров",
        },
        "limitations": [
            "Один квартал регистрации (I кв. 2025): сезонность и годовой тренд не видны.",
            "Коечного фонда и занятости коек в открытых данных нет; «перегрузка» — косвенный сигнал по отказам и длинным ожиданиям.",
            "Причина отказа не публикуется; связь отказов с неполным пакетом обследований — гипотеза.",
            "Строки — направления, не уникальные пациенты.",
            f"Стационары с менее чем {MIN_HOSPITAL_REFERRALS} направлениями за квартал не показываются поимённо.",
            "Лабораторная нагрузка (ЕИП) и пролеченные случаи (ЭРСБ) в этот срез не входят.",
        ],
        "national": {**outcome_block(df), "hospitals_total": int(df["hospital_mo"].nunique()), "treated_in_other_region_pct": pct(df["inter_region"].mean())},
        "weekly": weekly_series,
        "regions": sorted(regions, key=lambda r: (-r["referrals"], r["code"])),
        "profiles": profiles,
        "factors": factors(df),
        "forecast": fc,
        "hospitals": hospitals,
        "signals_summary": {
            "hospitals_checked": len(hospitals),
            "refusal_above_expected": sum("refusal_above_expected" in h["signals"] for h in hospitals),
            "long_wait_above_expected": sum("long_wait_above_expected" in h["signals"] for h in hospitals),
            "both": sum(len(h["signals"]) == 2 for h in hospitals),
            "top_by_excess_refusals": [
                {"name": h["name"], "region": h["region"], "excess_refusals": h["refusal_vs_expected"]["excess"], "signals": h["signals"]}
                for h in sorted(flagged, key=lambda h: (-h["refusal_vs_expected"]["excess"], h["name"]))[:15]
            ],
        },
    }


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--raw", type=Path, required=True, help="folder with the three CSV parts")
    parser.add_argument("--out", type=Path, default=Path("data/case1/aggregates.json"))
    args = parser.parse_args()
    report = build(args.raw)
    write_json(args.out, report)
    fc = report["forecast"]
    print(f"regions {len(report['regions'])}, hospitals {len(report['hospitals'])}, "
          f"forecast WAPE {fc['model']['wape_pct']}% vs naive {fc['naive']['wape_pct']}%")


if __name__ == "__main__":
    main()
