#!/usr/bin/env python3
"""Fail-closed OOXML safety gate shared by E1 staging and E2 import."""

from __future__ import annotations

import stat
import zipfile
from pathlib import Path, PurePosixPath


MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_MEMBERS = 4096
MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
MAX_MEMBER_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
REQUIRED_MEMBERS = {"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"}


def _safe_member_name(name: str) -> bool:
    if not name or "\x00" in name or "\\" in name or name.startswith("/"):
        return False
    path = PurePosixPath(name)
    return not path.is_absolute() and all(part not in {"", ".", ".."} for part in path.parts)


def validate_xlsx(path: Path) -> dict[str, int]:
    """Validate a regular XLSX without extracting it.

    The limits apply to both metadata and streamed bytes, blocking path
    traversal, encrypted/symlink members, duplicate names and ZIP bombs.
    """
    if path.suffix.lower() != ".xlsx":
        raise ValueError("Dashboard source workbook must be an .xlsx file")
    if path.is_symlink() or not path.is_file():
        raise ValueError("Dashboard source workbook must be a regular non-symlink file")
    archive_bytes = path.stat().st_size
    if not 1 <= archive_bytes <= MAX_ARCHIVE_BYTES:
        raise ValueError(f"Dashboard source workbook size is outside 1-{MAX_ARCHIVE_BYTES} bytes")
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if not 1 <= len(members) <= MAX_MEMBERS:
                raise ValueError(f"OOXML member count is outside 1-{MAX_MEMBERS}")
            names = [item.filename for item in members]
            if len(names) != len(set(names)):
                raise ValueError("OOXML archive contains duplicate member names")
            if not REQUIRED_MEMBERS <= set(names):
                raise ValueError("file is not a complete OOXML workbook")
            declared_total = 0
            for info in members:
                if not _safe_member_name(info.filename):
                    raise ValueError(f"unsafe OOXML member path: {info.filename}")
                if info.flag_bits & 0x1:
                    raise ValueError(f"encrypted OOXML member is forbidden: {info.filename}")
                mode = (info.external_attr >> 16) & 0xFFFF
                if mode and stat.S_ISLNK(mode):
                    raise ValueError(f"symlink OOXML member is forbidden: {info.filename}")
                if info.file_size > MAX_MEMBER_UNCOMPRESSED_BYTES:
                    raise ValueError(f"OOXML member exceeds the per-member limit: {info.filename}")
                declared_total += info.file_size
                if declared_total > MAX_TOTAL_UNCOMPRESSED_BYTES:
                    raise ValueError("OOXML total uncompressed size exceeds the safety limit")
                if info.file_size:
                    if info.compress_size <= 0 or info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
                        raise ValueError(f"OOXML member compression ratio exceeds the safety limit: {info.filename}")

            streamed_total = 0
            for info in members:
                if info.is_dir():
                    continue
                streamed_member = 0
                with archive.open(info, "r") as handle:
                    while True:
                        chunk = handle.read(1024 * 1024)
                        if not chunk:
                            break
                        streamed_member += len(chunk)
                        streamed_total += len(chunk)
                        if streamed_member > MAX_MEMBER_UNCOMPRESSED_BYTES:
                            raise ValueError(f"OOXML member expands past the safety limit: {info.filename}")
                        if streamed_total > MAX_TOTAL_UNCOMPRESSED_BYTES:
                            raise ValueError("OOXML archive expands past the total safety limit")
                if streamed_member != info.file_size:
                    raise ValueError(f"OOXML member size differs from ZIP metadata: {info.filename}")
    except (zipfile.BadZipFile, RuntimeError) as exc:
        raise ValueError("Dashboard source workbook is not a valid safe XLSX ZIP") from exc
    return {
        "archive_bytes": archive_bytes,
        "member_count": len(members),
        "uncompressed_bytes": streamed_total,
    }


__all__ = ["validate_xlsx"]
