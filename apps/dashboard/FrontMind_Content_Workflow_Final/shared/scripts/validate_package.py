#!/usr/bin/env python3
"""Validate a lightweight v2.2 Reference Pack or readable v2.1 Pack.

The validator protects paths and ensures that writing content can be opened.
It intentionally does not require approval workbooks, receipts, reviewers,
files[] ledgers, or cross-stage SHA bindings.
"""

from __future__ import annotations

import argparse
import json
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from validate_json_instance import load_json as load_schema_json, validate_instance


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
REFERENCE_SCHEMA = PACKAGE_ROOT / "shared/reference_pack.schema.json"
MAX_FILES = 5_000
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
CORE_REGISTRY_KEYS = (
    "knowledge_registry_path",
    "source_registry_path",
    "claim_registry_path",
    "image_registry_path",
)


def safe_relative(value: str) -> bool:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and ".." not in path.parts and path.as_posix() == value


def reject_duplicate_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, child in pairs:
        if key in value:
            raise ValueError(f"duplicate object key: {key!r}")
        value[key] = child
    return value


def reject_nonstandard_number(value: str) -> None:
    raise ValueError(f"non-standard JSON number is forbidden: {value}")


def decode_json(data: bytes, label: str) -> Any:
    try:
        return json.loads(
            data.decode("utf-8"),
            object_pairs_hook=reject_duplicate_object,
            parse_constant=reject_nonstandard_number,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"invalid JSON {label}: {exc}") from exc


class PackageView:
    def names(self) -> list[str]:
        raise NotImplementedError

    def read(self, name: str) -> bytes:
        raise NotImplementedError


class DirectoryView(PackageView):
    def __init__(self, root: Path):
        self.root = root
        if not root.is_dir():
            raise ValueError(f"not a package directory: {root}")
        for path in root.rglob("*"):
            if path.is_symlink():
                raise ValueError(f"directory package contains symlink: {path.relative_to(root)}")

    def names(self) -> list[str]:
        names = sorted(path.relative_to(self.root).as_posix() for path in self.root.rglob("*") if path.is_file())
        if len(names) > MAX_FILES:
            raise ValueError(f"package contains more than {MAX_FILES} files")
        total = 0
        for name in names:
            if not safe_relative(name):
                raise ValueError(f"unsafe package path: {name}")
            size = (self.root / name).stat().st_size
            if size > MAX_FILE_BYTES:
                raise ValueError(f"package file is too large: {name}")
            total += size
        if total > MAX_TOTAL_BYTES:
            raise ValueError("package exceeds the uncompressed size limit")
        return names

    def read(self, name: str) -> bytes:
        if not safe_relative(name):
            raise ValueError(f"unsafe package path: {name}")
        return (self.root / name).read_bytes()


class ZipView(PackageView):
    def __init__(self, path: Path):
        self.archive = zipfile.ZipFile(path)
        infos = [item for item in self.archive.infolist() if not item.is_dir()]
        names = [item.filename for item in infos]
        if len(names) != len(set(names)):
            raise ValueError("ZIP contains duplicate paths")
        if len(names) > MAX_FILES:
            raise ValueError(f"ZIP contains more than {MAX_FILES} files")
        total = 0
        for item in infos:
            if not safe_relative(item.filename):
                raise ValueError(f"unsafe ZIP path: {item.filename}")
            if item.flag_bits & 0x1:
                raise ValueError(f"encrypted ZIP member is unsupported: {item.filename}")
            mode = item.external_attr >> 16
            if mode and stat.S_ISLNK(mode):
                raise ValueError(f"ZIP contains symlink: {item.filename}")
            if item.file_size > MAX_FILE_BYTES:
                raise ValueError(f"ZIP member is too large: {item.filename}")
            if item.compress_size and item.file_size / item.compress_size > MAX_COMPRESSION_RATIO:
                raise ValueError(f"ZIP member exceeds compression-ratio limit: {item.filename}")
            total += item.file_size
        if total > MAX_TOTAL_BYTES:
            raise ValueError("ZIP exceeds the uncompressed size limit")

    def names(self) -> list[str]:
        return sorted(item.filename for item in self.archive.infolist() if not item.is_dir())

    def read(self, name: str) -> bytes:
        if not safe_relative(name):
            raise ValueError(f"unsafe ZIP path: {name}")
        return self.archive.read(name)


def _path(pack: dict[str, Any], key: str) -> Any:
    registries = pack.get("registries") if isinstance(pack.get("registries"), dict) else {}
    return registries.get(key)


def _v21_writing_paths(pack: dict[str, Any]) -> list[Any]:
    writing = pack.get("writing_assets") if isinstance(pack.get("writing_assets"), dict) else {}
    aliases = (
        "information_architecture_path",
        "information_evidence_architecture_path",
        "voice_path",
        "voice_token_path",
        "visual_rules_path",
        "question_library_path",
        "faq_library_path",
        "trend_viewpoints_path",
    )
    return [writing.get(key) for key in aliases if writing.get(key) is not None]


def _v21_content_candidates(pack: dict[str, Any], names: set[str]) -> list[Any]:
    """Find legacy content without requiring one historical manifest layout."""

    registries = pack.get("registries") if isinstance(pack.get("registries"), dict) else {}
    declared = [value for value in registries.values() if isinstance(value, str)]
    conventional = [
        "registries/knowledge_registry.json",
        "registries/source_registry.json",
        "registries/claim_registry.json",
        "registries/image_registry.json",
        "brand/brand_facts.json",
        "materials/index.json",
    ]
    candidates = [*declared, *_v21_writing_paths(pack), *(path for path in conventional if path in names)]
    if not candidates:
        # Some early v2.1 packs only provided a generic materials directory.
        candidates.extend(
            name for name in sorted(names)
            if name != "reference_pack.json" and Path(name).suffix.lower() in {".json", ".md", ".txt"}
        )
    unique: list[Any] = []
    seen: set[str] = set()
    for value in candidates:
        if isinstance(value, str):
            if value in seen:
                continue
            seen.add(value)
        unique.append(value)
    return unique


def _load_object(view: PackageView, name: str, errors: list[str]) -> dict[str, Any] | None:
    try:
        value = decode_json(view.read(name), name)
    except (KeyError, OSError, ValueError) as exc:
        errors.append(str(exc) if not isinstance(exc, KeyError) else f"missing file: {name}")
        return None
    if not isinstance(value, dict):
        errors.append(f"JSON root must be an object: {name}")
        return None
    return value


def validate(view: PackageView) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        names = set(view.names())
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        return {"status": "fail", "errors": [str(exc)], "warnings": [], "checked_files": 0}
    if "reference_pack.json" not in names:
        return {
            "status": "fail",
            "errors": ["package root must contain reference_pack.json"],
            "warnings": [],
            "checked_files": len(names),
        }
    pack = _load_object(view, "reference_pack.json", errors)
    if pack is None:
        return {"status": "fail", "errors": errors, "warnings": warnings, "checked_files": len(names)}

    version = pack.get("schema_version")
    profile = pack.get("profile")
    if version == "2.2.0":
        schema = load_schema_json(REFERENCE_SCHEMA)
        for failure in validate_instance(pack, schema, REFERENCE_SCHEMA):
            errors.append(f"reference_pack.json schema {failure.keyword} at {failure.json_path}: {failure.message}")
    elif version == "2.1.0" and profile == "frontmind-content-reference-pack-v2.1":
        warnings.append("v2.1 Reference Pack was accepted through the v2.2 compatibility reader")
    else:
        errors.append(f"unsupported Reference Pack identity: schema_version={version!r}, profile={profile!r}")

    brand = pack.get("brand")
    if not isinstance(brand, dict) or not str(brand.get("canonical_name") or "").strip():
        errors.append("brand.canonical_name is required")

    if version == "2.2.0":
        required_paths = [_path(pack, key) for key in CORE_REGISTRY_KEYS]
        required_paths.append(pack.get("material_index_path"))
        writing = pack.get("writing_assets") if isinstance(pack.get("writing_assets"), dict) else {}
        optional_paths = [value for value in writing.values() if value is not None]
        for value in required_paths:
            if not isinstance(value, str) or not safe_relative(value):
                errors.append(f"required content path is missing or unsafe: {value!r}")
                continue
            if value not in names:
                errors.append(f"required content file is absent: {value}")
                continue
            if value.endswith(".json"):
                _load_object(view, value, errors)
    else:
        # v2.1 had more than one pack layout. Content availability, rather than
        # an obsolete exact path set, decides whether the legacy pack is usable.
        optional_paths = _v21_content_candidates(pack, names)
        readable_legacy_content = 0
        for value in optional_paths:
            if not isinstance(value, str) or not safe_relative(value):
                warnings.append(f"legacy content path was ignored because it is unsafe: {value!r}")
                continue
            if value not in names:
                warnings.append(f"legacy content path is absent and will be skipped: {value}")
                continue
            if value.endswith(".json"):
                try:
                    legacy_value = decode_json(view.read(value), value)
                    if not isinstance(legacy_value, dict):
                        raise ValueError("JSON root is not an object")
                except (KeyError, OSError, ValueError) as exc:
                    warnings.append(f"legacy content asset is unreadable and will be skipped: {value}: {exc}")
                    continue
            readable_legacy_content += 1
        if readable_legacy_content == 0:
            errors.append("v2.1 pack contains no readable content asset")
        optional_paths = []

    for value in optional_paths:
        if not isinstance(value, str) or not safe_relative(value):
            warnings.append(f"optional writing asset path was ignored because it is unsafe: {value!r}")
        elif value not in names:
            warnings.append(f"optional writing asset is absent and will be skipped: {value}")
        elif value.endswith(".json"):
            try:
                optional_value = decode_json(view.read(value), value)
                if not isinstance(optional_value, dict):
                    raise ValueError("JSON root is not an object")
            except (KeyError, OSError, ValueError) as exc:
                # A malformed optional asset is excluded without invalidating usable core content.
                warnings.append(f"optional writing asset is unreadable and will be skipped: {value}: {exc}")

    return {
        "status": "pass" if not errors else "fail",
        "errors": errors,
        "warnings": warnings,
        "checked_files": len(names),
        "pack_schema_version": version,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Reference Pack readability and path safety.")
    parser.add_argument("package", type=Path)
    args = parser.parse_args()
    try:
        view: PackageView = DirectoryView(args.package) if args.package.is_dir() else ZipView(args.package)
        report = validate(view)
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        report = {"status": "fail", "errors": [str(exc)], "warnings": [], "checked_files": 0}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    raise SystemExit(main())
