#!/bin/bash
# Скачивание открытых данных ИС БГ с Ashyq Data (data.gov.kz). Авторизация не нужна.
# Направления на плановую госпитализацию, 3 части, около 660 МБ.
# Использование: bash scripts/case1_analytics/download.sh data/raw/case1
set -euo pipefail
OUT="${1:-data/raw/case1}"
mkdir -p "$OUT" && cd "$OUT"
BASE="https://magda-minio-web.data.gov.kz/magda-datasets"
enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
for p in 001 002 003; do
  f="Направления на плановую госпитализацию в стационары_part_${p}_of_003.csv"
  curl -# -fL -C - -o "${f// /_}" "$BASE/mz_bg_planned_hospitalization_referrals/$(enc "$f")"
done
echo "готово: $OUT"
