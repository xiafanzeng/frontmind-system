#!/usr/bin/env python3
"""Safely stage one Dashboard citation-export workbook inside a content job."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from schema_validation import validate_schema  # noqa: E402
from xlsx_safety import validate_xlsx  # noqa: E402


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative_inside(root: Path, path: Path, label: str) -> str:
    root = root.resolve()
    resolved = path.resolve(strict=False)
    try:
        return resolved.relative_to(root).as_posix()
    except ValueError as exc:
        raise ValueError(f"{label} must be staged inside --package-root") from exc


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise FileExistsError(f"refusing to overwrite staging artifact: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--job-id", required=True)
    args = parser.parse_args()

    if args.source.is_symlink():
        raise ValueError("Dashboard source workbook must be a regular non-symlink file")
    source = args.source.resolve()
    package_root = args.package_root.resolve()
    if not package_root.is_dir():
        raise FileNotFoundError(package_root)
    validate_xlsx(source)
    output_relative = relative_inside(package_root, args.output, "--output")
    receipt_relative = relative_inside(package_root, args.receipt, "--receipt")
    output = package_root / output_relative
    receipt = package_root / receipt_relative
    if output.exists() or output.is_symlink() or receipt.exists() or receipt.is_symlink():
        raise FileExistsError("refusing to overwrite a staged workbook or receipt")
    if output.resolve(strict=False) == receipt.resolve(strict=False):
        raise ValueError("--output and --receipt must be different paths")

    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{output.stem}.", suffix=".xlsx", dir=output.parent)
    os.close(descriptor)
    try:
        shutil.copyfile(source, temporary)
        with open(temporary, "rb") as handle:
            os.fsync(handle.fileno())
        validate_xlsx(Path(temporary))
        source_digest = file_sha256(source)
        temporary_digest = file_sha256(Path(temporary))
        if source_digest != temporary_digest:
            raise RuntimeError("source workbook changed while it was being safely staged")
        os.replace(temporary, output)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise

    staged_digest = file_sha256(output)
    if source_digest != staged_digest:
        raise RuntimeError("staged Dashboard workbook hash differs from source")
    payload = {
        "schema_version": "2.1.0",
        "job_id": args.job_id,
        "stage": "E1_dashboard_source_workbook_staging",
        "status": "passed",
        "staged_at": datetime.now(timezone.utc).isoformat(),
        "source_file": source.name,
        "source_sha256": source_digest,
        "staged_workbook_path": output_relative,
        "staged_workbook_sha256": staged_digest,
    }
    validate_schema(
        payload,
        Path(__file__).resolve().parents[1] / "templates" / "dashboard_source_workbook_staging_receipt.schema.json",
        "Dashboard source workbook staging receipt",
    )
    atomic_json(receipt, payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
