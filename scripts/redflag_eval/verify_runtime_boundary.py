"""Prove that research candidates did not enter the runtime detector."""

from __future__ import annotations

import argparse
from pathlib import Path

from .common import load_json


FORBIDDEN_RUNTIME_MARKERS = (
    "qwen",
    "ollama",
    "typesafe/jev",
    "/alpha/decisions",
    "fetch(",
    "http://",
    "https://",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("runtime", type=Path)
    args = parser.parse_args()
    report = load_json(args.report)
    if report.get("research_only") is not True:
        raise SystemExit("REDFLAG_RUNTIME_BOUNDARY_INVALID: report is not research-only")
    if report.get("runtime_integration") != "none":
        raise SystemExit("REDFLAG_RUNTIME_BOUNDARY_INVALID: integration recorded")
    runtime = args.runtime.read_text(encoding="utf-8").lower()
    found = [marker for marker in FORBIDDEN_RUNTIME_MARKERS if marker in runtime]
    if found:
        raise SystemExit(
            f"REDFLAG_RUNTIME_BOUNDARY_INVALID: runtime markers found: {found}"
        )
    print("REDFLAG_RUNTIME_BOUNDARY_OK")


if __name__ == "__main__":
    main()
