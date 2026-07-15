#!/usr/bin/env python3
"""Download the official DDXPlus release and record reproducible provenance."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path
from typing import Any

import requests
from tqdm import tqdm

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RAW = ROOT / "data" / "raw"
FIGSHARE_ARTICLE_ID = 20043374
FIGSHARE_API_URL = f"https://api.figshare.com/v2/articles/{FIGSHARE_ARTICLE_ID}"
EXPECTED_FILES = {
    "README.md",
    "release_conditions.json",
    "release_evidences.json",
    "release_test_patients.zip",
    "release_train_patients.zip",
    "release_validate_patients.zip",
}


def file_hash(path: Path, algorithm: str = "sha256") -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_metadata(session: requests.Session) -> dict[str, Any]:
    response = session.get(FIGSHARE_API_URL, timeout=60)
    response.raise_for_status()
    metadata: dict[str, Any] = response.json()
    if metadata.get("id") != FIGSHARE_ARTICLE_ID or not metadata.get("is_public"):
        raise RuntimeError("Figshare returned an unexpected or non-public article")
    return metadata


def download(session: requests.Session, url: str, destination: Path, size: int) -> None:
    partial = destination.with_suffix(destination.suffix + ".part")
    partial.unlink(missing_ok=True)
    response = session.get(url, stream=True, timeout=(30, 180))
    response.raise_for_status()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with partial.open("wb") as target, tqdm(
        total=size,
        unit="B",
        unit_scale=True,
        desc=destination.name,
    ) as progress:
        for chunk in response.iter_content(1 << 20):
            if chunk:
                target.write(chunk)
                progress.update(len(chunk))
    if partial.stat().st_size != size:
        raise RuntimeError(
            f"size mismatch for {destination.name}: {partial.stat().st_size} != {size}"
        )
    partial.replace(destination)


def extract_patient_archives(raw: Path) -> None:
    for archive in sorted(raw.glob("release_*_patients.zip")):
        expected_csv = raw / archive.with_suffix(".csv").name
        if expected_csv.exists():
            continue
        with zipfile.ZipFile(archive) as source:
            file_members = [name for name in source.namelist() if not name.endswith("/")]
            if len(file_members) != 1:
                raise RuntimeError(
                    f"expected one patient-data file in {archive.name}, found {file_members}"
                )
            member = file_members[0]
            with source.open(member) as compressed, expected_csv.open("wb") as target:
                shutil.copyfileobj(compressed, target, length=1 << 20)
        print(f"extracted {archive.name} -> {expected_csv.name}")


def write_license_record(raw: Path, metadata: dict[str, Any]) -> dict[str, str]:
    license_meta = metadata.get("license") or {}
    name = str(license_meta.get("name") or "НЕ ПРОВЕРЕНО")
    url = str(license_meta.get("url") or "")
    record = (
        f"{name}\n"
        f"Source: Figshare article metadata {FIGSHARE_API_URL}\n"
        f"License URL: {url}\n"
        "Note: the published release contains no standalone LICENSE file; "
        "this record was generated from the official article metadata.\n"
    )
    (raw / "LICENSE").write_text(record, encoding="utf-8")
    return {"name": name, "url": url, "source": "figshare_article_metadata"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--no-extract", action="store_true")
    args = parser.parse_args()
    raw = args.dir.resolve()

    with requests.Session() as session:
        session.headers["User-Agent"] = "Demeu-DDXPlus-downloader/1.0"
        metadata = fetch_metadata(session)
        files = {item["name"]: item for item in metadata.get("files", [])}
        missing = EXPECTED_FILES - files.keys()
        if missing:
            raise RuntimeError(f"official release is missing expected files: {sorted(missing)}")

        raw.mkdir(parents=True, exist_ok=True)
        provenance_files: dict[str, dict[str, Any]] = {}
        for name in sorted(EXPECTED_FILES):
            item = files[name]
            destination = raw / name
            expected_md5 = str(item["computed_md5"])
            if destination.exists() and (
                destination.stat().st_size != int(item["size"])
                or file_hash(destination, "md5") != expected_md5
            ):
                print(f"existing {name} does not match Figshare metadata; downloading again")
                destination.unlink()
            if not destination.exists():
                download(
                    session,
                    str(item["download_url"]),
                    destination,
                    int(item["size"]),
                )
            actual_md5 = file_hash(destination, "md5")
            if actual_md5 != expected_md5:
                raise RuntimeError(f"MD5 mismatch for {name}: {actual_md5} != {expected_md5}")
            provenance_files[name] = {
                "figshare_file_id": item["id"],
                "url": item["download_url"],
                "bytes": destination.stat().st_size,
                "md5": actual_md5,
                "sha256": file_hash(destination),
            }

    license_record = write_license_record(raw, metadata)
    provenance = {
        "downloaded_at": dt.datetime.now(dt.UTC).isoformat(),
        "article_id": FIGSHARE_ARTICLE_ID,
        "article_url": metadata["figshare_url"],
        "api_url": FIGSHARE_API_URL,
        "doi": metadata.get("doi"),
        "version": metadata.get("version"),
        "published_date": metadata.get("published_date"),
        "license": license_record,
        "license_file_in_release": False,
        "files": provenance_files,
    }
    (raw / "PROVENANCE.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if not args.no_extract:
        extract_patient_archives(raw)
    print(f"OK -> {raw / 'PROVENANCE.json'}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, requests.RequestException, zipfile.BadZipFile) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
