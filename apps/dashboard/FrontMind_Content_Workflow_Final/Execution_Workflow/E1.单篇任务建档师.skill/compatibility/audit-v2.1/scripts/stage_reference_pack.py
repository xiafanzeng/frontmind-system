#!/usr/bin/env python3
"""Validate and safely stage a signed Reference Pack ZIP into a persistent job directory."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from schema_validation import validate_schema  # noqa: E402


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_validate(path: Path) -> dict:
    validator = Path(__file__).resolve().parents[3] / "shared" / "scripts" / "validate_package.py"
    process = subprocess.run(
        [sys.executable, "-B", str(validator), str(path)], text=True, capture_output=True, check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    try:
        report = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(f"canonical Reference Pack validator emitted invalid JSON: {process.stderr or process.stdout}") from exc
    if process.returncode != 0 or report.get("status") != "pass":
        raise ValueError("canonical Reference Pack validation failed: " + "; ".join(report.get("errors", [])))
    return report


def safe_members(
    archive: zipfile.ZipFile, *, max_files: int, max_total_bytes: int,
    max_file_bytes: int, max_compression_ratio: float,
) -> tuple[list[tuple[zipfile.ZipInfo, PurePosixPath]], int]:
    files: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
    normalized_seen: set[str] = set()
    file_paths: set[PurePosixPath] = set()
    directory_paths: set[PurePosixPath] = set()
    total = 0
    for info in archive.infolist():
        raw = info.filename
        if not raw or "\x00" in raw or "\\" in raw:
            raise ValueError(f"unsafe ZIP member name: {raw!r}")
        path = PurePosixPath(raw)
        if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
            raise ValueError(f"ZIP member must be a normalized relative path: {raw!r}")
        collision_key = unicodedata.normalize("NFC", path.as_posix()).casefold().rstrip("/")
        if collision_key in normalized_seen:
            raise ValueError(f"duplicate/case-normalized ZIP member path: {raw!r}")
        normalized_seen.add(collision_key)
        mode = (info.external_attr >> 16) & 0xFFFF
        file_type = stat.S_IFMT(mode)
        if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
            raise ValueError(f"ZIP links/devices/special members are forbidden: {raw!r}")
        if info.flag_bits & 0x1:
            raise ValueError(f"encrypted ZIP members are forbidden: {raw!r}")
        if info.is_dir():
            directory_paths.add(path)
            continue
        if info.file_size < 0 or info.file_size > max_file_bytes:
            raise ValueError(f"ZIP member exceeds per-file size limit: {raw!r} ({info.file_size})")
        ratio = float("inf") if info.compress_size == 0 and info.file_size else (
            info.file_size / max(1, info.compress_size)
        )
        if ratio > max_compression_ratio:
            raise ValueError(f"ZIP member compression ratio exceeds limit: {raw!r} ({ratio:.2f})")
        total += info.file_size
        if total > max_total_bytes:
            raise ValueError(f"ZIP total uncompressed size exceeds limit: {total}")
        files.append((info, path))
        file_paths.add(path)
    if not files or len(files) > max_files:
        raise ValueError(f"ZIP file count must be 1-{max_files}; found {len(files)}")
    for path in file_paths:
        parent = path.parent
        while parent != PurePosixPath("."):
            if parent in file_paths:
                raise ValueError(f"ZIP path is both file and parent directory: {parent}")
            parent = parent.parent
    if PurePosixPath("reference_pack.json") not in file_paths:
        raise ValueError("ZIP root must contain reference_pack.json")
    return files, total


def extract_safely(archive: zipfile.ZipFile, members: list[tuple[zipfile.ZipInfo, PurePosixPath]], target: Path) -> None:
    target_resolved = target.resolve()
    for info, stored in members:
        output = (target / Path(*stored.parts)).resolve()
        try:
            output.relative_to(target_resolved)
        except ValueError as exc:
            raise ValueError(f"ZIP member escapes staging directory: {stored}") from exc
        output.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        with archive.open(info, "r") as source, output.open("xb") as destination:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > info.file_size:
                    raise ValueError(f"ZIP member expanded beyond declared size: {stored}")
                destination.write(chunk)
        if written != info.file_size:
            raise ValueError(f"ZIP member size differs from central directory: {stored}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", dest="zip_path", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True,
                        help="new persistent job-local Reference Pack directory; must not already exist")
    parser.add_argument("--manifest-output", type=Path,
                        help="receipt outside the staged Pack; defaults beside --output-dir")
    parser.add_argument("--job-package-root", type=Path, required=True,
                        help="persistent job root; receipt paths are relative to this directory")
    parser.add_argument("--max-files", type=int, default=10000)
    parser.add_argument("--max-total-bytes", type=int, default=1024 * 1024 * 1024)
    parser.add_argument("--max-file-bytes", type=int, default=256 * 1024 * 1024)
    parser.add_argument("--max-compression-ratio", type=float, default=200.0)
    args = parser.parse_args()
    source = args.zip_path.resolve()
    output = args.output_dir.resolve()
    manifest_output = (args.manifest_output or output.with_name(output.name + ".staging.json")).resolve()
    job_root = args.job_package_root.resolve()
    job_root.mkdir(parents=True, exist_ok=True)
    for value, label in ((output, "--output-dir"), (manifest_output, "--manifest-output")):
        try:
            value.relative_to(job_root)
        except ValueError as exc:
            raise ValueError(f"{label} must be inside --job-package-root") from exc
    if not source.is_file() or source.suffix.lower() != ".zip":
        raise FileNotFoundError("--zip must be an existing ZIP file")
    if output.exists():
        raise FileExistsError("--output-dir must not already exist; staging never overwrites a Pack")
    if manifest_output.exists():
        raise FileExistsError("--manifest-output already exists; staging never overwrites a receipt")
    if manifest_output == output or output in manifest_output.parents:
        raise ValueError("--manifest-output must be outside the staged Reference Pack directory")
    if min(args.max_files, args.max_total_bytes, args.max_file_bytes) <= 0 or args.max_compression_ratio < 1:
        raise ValueError("archive safety limits must be positive")
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest_output.parent.mkdir(parents=True, exist_ok=True)

    temporary = Path(tempfile.mkdtemp(prefix=output.name + ".staging-", dir=output.parent))
    try:
        with zipfile.ZipFile(source) as archive:
            members, total = safe_members(
                archive, max_files=args.max_files, max_total_bytes=args.max_total_bytes,
                max_file_bytes=args.max_file_bytes, max_compression_ratio=args.max_compression_ratio,
            )
            pre_report = canonical_validate(source)
            extract_safely(archive, members, temporary)
        post_report = canonical_validate(temporary)
        pack = json.loads((temporary / "reference_pack.json").read_text(encoding="utf-8"))
        os.replace(temporary, output)
        receipt = {
            "schema_version": "2.1.0", "stage": "E1_reference_pack_staging", "status": "passed",
            "source_zip_file": source.name, "source_zip_sha256": file_sha256(source),
            "staged_at": datetime.now(timezone.utc).isoformat(),
            "staged_package_dir": output.relative_to(job_root).as_posix(),
            "reference_pack_path": (output / "reference_pack.json").relative_to(job_root).as_posix(),
            "pack_id": pack.get("pack_id"),
            "pack_version": pack.get("version"), "file_count": len(members),
            "total_uncompressed_bytes": total, "canonical_pre_validation": pre_report.get("status"),
            "canonical_post_validation": post_report.get("status"),
        }
        validate_schema(
            receipt, Path(__file__).resolve().parents[1] / "templates" / "staged_reference_pack.schema.json",
            "E1 staged Reference Pack receipt",
        )
        manifest_output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "status": "passed", "staged_package_dir": output.name,
            "reference_pack_path": receipt["reference_pack_path"], "staging_receipt": manifest_output.name,
        }, ensure_ascii=False))
        return 0
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
