#!/usr/bin/env python3
"""Accept usable enterprise material without requiring one historical package profile."""

from __future__ import annotations

import argparse
import json
import stat
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


TEXT_EXTENSIONS = {
    ".json", ".md", ".txt", ".html", ".htm", ".csv", ".tsv",
    ".pdf", ".docx", ".pptx", ".xlsx",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".svg"}
IGNORED_NAMES = {".ds_store", "thumbs.db"}
MAX_ARCHIVE_FILES = 50_000
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBER_BYTES = 512 * 1024 * 1024


def safe_relative(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and ".." not in path.parts and "\\" not in name


def media_kind(name: str) -> str | None:
    suffix = PurePosixPath(name).suffix.lower()
    if suffix in TEXT_EXTENSIONS:
        return "document"
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    return None


def read_json_from_zip(archive: zipfile.ZipFile, names: list[str], basename: str) -> tuple[str | None, dict[str, Any] | None]:
    candidates = [name for name in names if PurePosixPath(name).name == basename]
    for name in candidates:
        try:
            value = json.loads(archive.read(name).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError):
            continue
        if isinstance(value, dict):
            return name, value
    return None, None


def read_json_from_directory(root: Path, basename: str) -> tuple[str | None, dict[str, Any] | None]:
    for path in sorted(root.rglob(basename)):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            return path.relative_to(root).as_posix(), value
    return None, None


def detect_package(markers: dict[str, tuple[str | None, dict[str, Any] | None]], fallback: str) -> dict[str, Any]:
    reference_path, reference = markers["reference_pack.json"]
    if reference:
        profile = str(reference.get("profile") or "") or None
        kind = "frontmind_reference_pack_v2_1" if profile and "v2.1" in profile else "frontmind_reference_pack"
        return {"input_kind": kind, "profile": profile, "source_schema_version": reference.get("schema_version"), "primary_index": reference_path}

    bundle_path, bundle = markers["BUNDLE.json"]
    if bundle and bundle.get("kind") == "frontmind.kb-working-set":
        skill = bundle.get("skill") if isinstance(bundle.get("skill"), dict) else {}
        kind = "frontmind_kb_working_set_v5" if str(skill.get("version") or "") == "5" else "frontmind_kb_working_set"
        return {"input_kind": kind, "profile": "frontmind.kb-working-set", "source_schema_version": bundle.get("schemaVersion"), "primary_index": bundle_path}

    manifest_path, manifest = markers["00_package_manifest.json"]
    if manifest:
        schema_version = manifest.get("schemaVersion")
        profile = str(manifest.get("profile") or "") or None
        kind = "canonical_enterprise_kb_v4" if schema_version == 4 and profile == "dashboard-enterprise-v1" else "canonical_enterprise_kb"
        return {"input_kind": kind, "profile": profile, "source_schema_version": schema_version, "primary_index": manifest_path}

    return {"input_kind": fallback, "profile": None, "source_schema_version": None, "primary_index": None}


def inspect_zip(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, str]], list[str]]:
    usable: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    warnings: list[str] = []
    with zipfile.ZipFile(path) as archive:
        infos = [item for item in archive.infolist() if not item.is_dir()]
        names = [item.filename for item in infos]
        if len(names) != len(set(names)):
            raise ValueError("archive contains duplicate member paths")
        if len(infos) > MAX_ARCHIVE_FILES:
            raise ValueError("archive contains too many files to process safely")
        total_size = 0
        safe_names: list[str] = []
        for info in infos:
            name = info.filename
            if not safe_relative(name):
                raise ValueError(f"unsafe archive member path: {name}")
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_ISLNK(mode):
                skipped.append({"path": name, "reason": "symbolic_link_skipped"})
                continue
            if info.file_size > MAX_MEMBER_BYTES:
                raise ValueError(f"archive member is too large to process safely: {name}")
            total_size += info.file_size
            if total_size > MAX_ARCHIVE_BYTES:
                raise ValueError("archive expands beyond the safe size limit")
            if info.compress_size and info.file_size > 10 * 1024 * 1024 and info.file_size / info.compress_size > 1000:
                raise ValueError(f"archive member has an unsafe compression ratio: {name}")
            safe_names.append(name)
            kind = media_kind(name)
            if kind:
                usable.append({"path": name, "media_kind": kind, "bytes": info.file_size})
            elif PurePosixPath(name).name.lower() not in IGNORED_NAMES:
                skipped.append({"path": name, "reason": "unsupported_format"})

        markers = {name: read_json_from_zip(archive, safe_names, name) for name in ("reference_pack.json", "BUNDLE.json", "00_package_manifest.json")}
        detected = detect_package(markers, "ordinary_zip")
        detected["optional_indexes"] = {
            "manifest_path": markers["00_package_manifest.json"][0],
            "source_index_path": next((name for name in safe_names if PurePosixPath(name).name == "00_source_index.md"), None),
            "knowledge_tree_path": next((name for name in safe_names if PurePosixPath(name).name == "00_knowledge_tree.md"), None),
            "bundle_path": markers["BUNDLE.json"][0],
            "reference_pack_path": markers["reference_pack.json"][0],
        }
    if skipped:
        warnings.append(f"{len(skipped)} unsupported or unsafe non-content items were skipped")
    return detected, usable, skipped, warnings


def inspect_directory(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, str]], list[str]]:
    usable: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    warnings: list[str] = []
    for item in sorted(path.rglob("*")):
        relative = item.relative_to(path).as_posix()
        if item.is_symlink():
            skipped.append({"path": relative, "reason": "symbolic_link_skipped"})
            continue
        if not item.is_file():
            continue
        kind = media_kind(relative)
        if kind:
            usable.append({"path": relative, "media_kind": kind, "bytes": item.stat().st_size})
        elif item.name.lower() not in IGNORED_NAMES:
            skipped.append({"path": relative, "reason": "unsupported_format"})
    markers = {name: read_json_from_directory(path, name) for name in ("reference_pack.json", "BUNDLE.json", "00_package_manifest.json")}
    detected = detect_package(markers, "ordinary_directory")
    detected["optional_indexes"] = {
        "manifest_path": markers["00_package_manifest.json"][0],
        "source_index_path": next((item["path"] for item in usable if PurePosixPath(item["path"]).name == "00_source_index.md"), None),
        "knowledge_tree_path": next((item["path"] for item in usable if PurePosixPath(item["path"]).name == "00_knowledge_tree.md"), None),
        "bundle_path": markers["BUNDLE.json"][0],
        "reference_pack_path": markers["reference_pack.json"][0],
    }
    if skipped:
        warnings.append(f"{len(skipped)} unsupported or unsafe non-content items were skipped")
    return detected, usable, skipped, warnings


def inspect_input(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, str]], list[str], str]:
    if path.is_dir():
        detected, usable, skipped, warnings = inspect_directory(path)
        return detected, usable, skipped, warnings, "directory"
    if not path.is_file():
        raise ValueError("input does not exist")
    direct_kind = media_kind(path.name)
    if direct_kind:
        detected = {
            "input_kind": "standalone_document" if direct_kind == "document" else "standalone_image",
            "profile": None,
            "source_schema_version": None,
            "primary_index": None,
            "optional_indexes": {"manifest_path": None, "source_index_path": None, "knowledge_tree_path": None, "bundle_path": None, "reference_pack_path": None},
        }
        return detected, [{"path": path.name, "media_kind": direct_kind, "bytes": path.stat().st_size}], [], [], "file"
    if zipfile.is_zipfile(path):
        detected, usable, skipped, warnings = inspect_zip(path)
        return detected, usable, skipped, warnings, "archive"
    raise ValueError("input file format is not supported")


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect usable FrontMind enterprise material")
    parser.add_argument("--brand", required=True)
    parser.add_argument("--input", type=Path, required=True, help="Reference Pack, KB, ZIP, directory, document, or image")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--intake-route",
        choices=("auto", "direct", "legacy_enrichment"),
        default="auto",
        help="Use direct normalization or preserve the original S1 as an optional enrichment path for scattered material",
    )
    args = parser.parse_args()
    try:
        brand = args.brand.strip()
        if not brand:
            raise ValueError("--brand must be non-empty")
        detected, usable, skipped, warnings, format_mode = inspect_input(args.input.resolve())
        if not usable:
            raise ValueError("input contains no supported, safely readable content")
        canonical_kinds = {
            "frontmind_reference_pack", "frontmind_reference_pack_v2_1",
            "canonical_enterprise_kb", "canonical_enterprise_kb_v4",
            "frontmind_kb_working_set", "frontmind_kb_working_set_v5",
        }
        if args.intake_route == "legacy_enrichment" and detected["input_kind"] in canonical_kinds:
            warnings.append("Canonical content was detected; legacy enrichment was not needed and direct normalization was selected.")
            selected_route = "direct_normalization"
        elif args.intake_route == "legacy_enrichment":
            selected_route = "legacy_s1_enrichment_then_normalization"
        else:
            selected_route = "direct_normalization"
        status = "completed_with_limits" if skipped or warnings else "completed"
        payload = {
            "schema_version": "2.3.0",
            "stage": "S1_material_intake",
            "status": status,
            "brand": brand,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "input": {
                "input_name": args.input.name,
                "input_kind": detected["input_kind"],
                "format_mode": format_mode,
                "profile": detected["profile"],
                "source_schema_version": detected["source_schema_version"],
                "primary_index": detected["primary_index"],
                "selected_route": selected_route,
                "legacy_enrichment_skill": "../compatibility/legacy-s1/SKILL.md" if selected_route == "legacy_s1_enrichment_then_normalization" else None,
                "optional_indexes": detected["optional_indexes"],
                "usable_files": usable,
                "skipped_files": skipped,
            },
            "warnings": warnings,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        parser.error(str(exc))
    print(json.dumps({"stage": "S1", "status": payload["status"], "usable_files": len(usable), "output": args.output.name}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
