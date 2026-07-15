#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$ROOT_DIR/deploy/smoke.mjs" scenario1-once
