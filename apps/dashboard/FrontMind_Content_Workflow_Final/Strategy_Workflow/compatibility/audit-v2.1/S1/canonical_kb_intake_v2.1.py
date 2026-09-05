#!/usr/bin/env python3
"""Validate a canonical KB v4 ZIP and emit the S1 v2 intake receipt."""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


def digest_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def digest_tree(root: Path) -> tuple[int, str]:
    files = sorted(path for path in root.rglob("*") if path.is_file() and not path.is_symlink())
    value = hashlib.sha256()
    for path in files:
        relative = path.relative_to(root).as_posix()
        value.update(relative.encode("utf-8"))
        value.update(b"\0")
        value.update(bytes.fromhex(digest_file(path)))
        value.update(b"\n")
    return len(files), value.hexdigest()


def safe_members(archive: zipfile.ZipFile) -> list[str]:
    names = [item.filename for item in archive.infolist() if not item.is_dir()]
    if len(names) != len(set(names)):
        raise ValueError("canonical KB ZIP contains duplicate member paths")
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name:
            raise ValueError(f"unsafe canonical KB ZIP member: {name}")
    return names


def prefixed(prefix: str, relative: str) -> str:
    return f"{prefix}/{relative}" if prefix else relative


def validate_kb(path: Path) -> dict[str, Any]:
    if not path.is_file() or not zipfile.is_zipfile(path):
        raise ValueError("formal S1 input must be an existing canonical KB ZIP")
    with zipfile.ZipFile(path) as archive:
        names = safe_members(archive)
        manifests = [name for name in names if PurePosixPath(name).name == "00_package_manifest.json"]
        if len(manifests) != 1:
            raise ValueError("canonical KB ZIP must contain exactly one 00_package_manifest.json")
        manifest_path = manifests[0]
        prefix_path = PurePosixPath(manifest_path).parent
        prefix = "" if str(prefix_path) == "." else prefix_path.as_posix()
        try:
            manifest = json.loads(archive.read(manifest_path).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid canonical KB manifest: {exc}") from exc
        if manifest.get("schemaVersion") != 4 or manifest.get("profile") != "dashboard-enterprise-v1":
            raise ValueError("canonical KB must use schemaVersion=4/profile=dashboard-enterprise-v1")
        source_index = prefixed(prefix, "00_source_index.md")
        knowledge_tree = prefixed(prefix, "00_knowledge_tree.md")
        for required in (source_index, knowledge_tree):
            if required not in names or not archive.read(required).strip():
                raise ValueError(f"canonical KB lacks required non-empty file: {required}")
        documents = manifest.get("documents")
        assets = manifest.get("assets")
        if not isinstance(documents, list) or not documents:
            raise ValueError("canonical KB manifest.documents must be a non-empty array")
        if not isinstance(assets, list):
            raise ValueError("canonical KB manifest.assets must be an array")
        for group, label in ((documents, "document"), (assets, "asset")):
            for index, item in enumerate(group):
                relative = str(item.get("path") or "") if isinstance(item, dict) else ""
                member = prefixed(prefix, relative)
                if not relative or member not in names:
                    raise ValueError(f"manifest {label} is missing from ZIP at index {index}: {relative}")
        return {
            "file_name": path.name,
            "bytes": path.stat().st_size,
            "sha256": digest_file(path),
            "schema_version": 4,
            "profile": "dashboard-enterprise-v1",
            "build_revision": manifest.get("buildRevision"),
            "manifest_path": manifest_path,
            "source_index_path": source_index,
            "knowledge_tree_path": knowledge_tree,
            "document_count": len(documents),
            "asset_count": len(assets),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the S1 canonical KB intake boundary")
    parser.add_argument("--brand", required=True)
    parser.add_argument("--kb", type=Path, required=True)
    parser.add_argument("--source-mode", choices=("existing_canonical_kb", "legacy_s1_then_builder"), required=True)
    parser.add_argument("--legacy-s1-dir", type=Path)
    parser.add_argument("--builder-receipt", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        canonical_kb = validate_kb(args.kb.resolve())
        legacy_s1 = None
        builder_receipt = None
        if args.source_mode == "legacy_s1_then_builder":
            if not args.legacy_s1_dir or not args.legacy_s1_dir.is_dir():
                raise ValueError("legacy_s1_then_builder requires --legacy-s1-dir")
            if not args.builder_receipt or not args.builder_receipt.is_file():
                raise ValueError("legacy_s1_then_builder requires --builder-receipt")
            file_count, content_sha256 = digest_tree(args.legacy_s1_dir.resolve())
            if not file_count:
                raise ValueError("legacy S1 directory is empty")
            legacy_s1 = {
                "directory_name": "legacy-s1",
                "file_count": file_count,
                "content_sha256": content_sha256,
            }
            builder_receipt = {
                "file_name": args.builder_receipt.name,
                "sha256": digest_file(args.builder_receipt.resolve()),
            }
        elif args.legacy_s1_dir or args.builder_receipt:
            raise ValueError("existing_canonical_kb must not attach legacy S1 or builder receipt")
        payload = {
            "schema_version": "2.0.0",
            "stage": "S1_canonical_kb_intake",
            "status": "passed",
            "brand": args.brand.strip(),
            "source_mode": args.source_mode,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "canonical_kb": canonical_kb,
            "legacy_s1": legacy_s1,
            "builder_receipt": builder_receipt,
        }
        if not payload["brand"]:
            raise ValueError("--brand must be non-empty")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        parser.error(str(exc))
    print(json.dumps({"status": "passed", "output": args.output.name, "kb_sha256": canonical_kb["sha256"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
