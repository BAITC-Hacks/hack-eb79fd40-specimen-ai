"""Build the referral feature table used by scripts/referral_ml (B3, D1).

Joins "Направления на плановую госпитализацию" with "Ожидающие плановую
госпитализацию" (both IS BG, Ashyq Data) on registration_dt and writes
referrals_features.parquet with the frozen handoff schema.

The frozen handoff (scripts/referral_ml/contracts.py:INPUT_SHA256) was built
with any_value(), which is not deterministic across runs. This script uses
min() instead: the 17 columns derived from the referrals file are identical to
the handoff row for row; the four waitlist columns differ in ~0.3% of rows.
B3 and D1 do not use those four columns, so model inputs are the same, but
the file hash differs and the trainers' hash check must be pointed at it.

The join key is a timestamp, not an identifier: region_code, profile_code,
operation_code and mo_dest_code taken from the waitlist are ambiguous and are
excluded from the models (see docs/referral-ml.md). Case 1 analytics takes the
region from hospitalization_code instead.

Run: python -m scripts.case1_analytics.build_features --raw data/raw/case1 --out data/raw/case1/referrals_features.parquet
"""

from __future__ import annotations

import argparse
from pathlib import Path

import duckdb


def build(raw: Path, out: Path) -> int:
    con = duckdb.connect()
    con.execute("PRAGMA threads=6")
    con.execute(f"""CREATE VIEW ref AS SELECT * FROM read_csv('{raw}/Направления_на_плановую_госпитализацию_в_стационары_part_00*_of_003.csv',
 header=true, sample_size=200000, types={{'registration_dt':'TIMESTAMP','planned_dt':'TIMESTAMP','polyclinic_dt':'TIMESTAMP','hospitalization_dt':'TIMESTAMP','refusal_dt':'TIMESTAMP','sdu_load_date':'TIMESTAMP'}})""")
    con.execute(f"""CREATE VIEW w AS SELECT * FROM read_csv('{raw}/Ожидающие_плановую_госпитализацию_в_стационары.csv',
 header=true, sample_size=200000, types={{'registration_dt':'TIMESTAMP','planned_dt':'TIMESTAMP','sdu_load_date':'TIMESTAMP'}})""")
    # dedup w by registration_dt to keep join 1:1; min() keeps it deterministic
    con.execute("""CREATE TABLE wd AS SELECT registration_dt, min(region_origin_code) region_code,
 min(profile_code) profile_code, min(operation_code) operation_code,
 min(mo_destination_code) mo_dest_code
FROM w GROUP BY registration_dt""")
    con.execute("""
CREATE TABLE ds AS
SELECT
  r.hospitalization_code,
  r.registration_dt,
  r.referring_mo, r.hospital_mo, r.icd10_ref_diag_code, r.bed_profile,
  r.territorial_type, r.referral_purpose, r.finance_source,
  wd.region_code, wd.profile_code, wd.operation_code,
  (wd.operation_code IS NOT NULL)::INT AS has_operation,
  date_diff('day', r.registration_dt, r.planned_dt) AS plan_lead_days,
  date_diff('day', r.registration_dt, r.polyclinic_dt) AS polyclinic_lag_days,
  (r.polyclinic_dt IS NOT NULL)::INT AS has_polyclinic,
  extract('month' FROM r.registration_dt) AS reg_month,
  extract('dow'  FROM r.registration_dt) AS reg_dow,
  (r.refusal_dt IS NOT NULL)::INT AS is_refused,
  date_diff('day', r.registration_dt, r.hospitalization_dt) AS wait_days,
  r.hospitalization_dt IS NOT NULL AS hospitalized
FROM ref r LEFT JOIN wd ON r.registration_dt = wd.registration_dt
""")
    out.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY ds TO '{out}' (FORMAT PARQUET)")
    return int(con.execute("SELECT count(*) FROM ds").fetchone()[0])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print("rows", build(args.raw, args.out))


if __name__ == "__main__":
    main()
