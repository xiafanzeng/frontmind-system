#!/usr/bin/env python3
"""Assemble a lightweight v2.2 Reference Pack from available writing material."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


REGISTRIES = {
    "knowledge_registry_path": ("**/S2_*knowledge_registry.json", "registries/knowledge_registry.json"),
    "source_registry_path": ("**/S2_*source_registry.json", "registries/source_registry.json"),
    "claim_registry_path": ("**/S2_*claim_registry.json", "registries/claim_registry.json"),
    "image_registry_path": ("**/S2_*image_registry.json", "registries/image_registry.json"),
}
WRITING_ASSETS = {
    # A skipped S3, an empty S6, or an empty S7 is still represented by a real
    # content asset. Requiring the files prevents prepare from silently jumping
    # over the stages while keeping their contents optional.
    "information_architecture_path": ("**/S4_*information_evidence_architecture.json", "writing/information_architecture.json"),
    "question_library_path": ("**/S7_*question_library.json", "writing/question_library.json"),
    "trend_viewpoints_path": ("**/S3_*trend_reference.json", "writing/trend_viewpoints.json"),
    "voice_path": ("**/S5_*voice_contract.json", "writing/voice.json"),
    "visual_rules_path": ("**/S6_*visual_reference.json", "writing/visual_rules.json"),
}


def safe_relative(value: str) -> bool:
    path = PurePosixPath(value)
    return bool(value) and not path.is_absolute() and ".." not in path.parts and "\\" not in value


def find_one(work_dir: Path, pattern: str, required: bool) -> Path | None:
    matches = sorted(path for path in work_dir.glob(pattern) if path.is_file() and "compatibility" not in path.parts)
    if not matches:
        if required:
            raise ValueError(f"required strategy content is missing: {pattern}")
        return None
    return matches[-1]


def copy_file(source: Path, root: Path, relative: str) -> None:
    if not safe_relative(relative):
        raise ValueError(f"unsafe package path: {relative}")
    destination = (root / relative).resolve()
    if root.resolve() not in destination.parents:
        raise ValueError(f"package path escapes staging: {relative}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def copy_tree(source: Path, destination: Path, warnings: list[str]) -> None:
    if not source.is_dir():
        return
    for item in sorted(source.rglob("*")):
        if item.is_symlink():
            warnings.append(f"Skipped symbolic link in material tree: {item.name}")
            continue
        if not item.is_file():
            continue
        relative = item.relative_to(source).as_posix()
        if not safe_relative(relative):
            warnings.append(f"Skipped unsafe material path: {relative}")
            continue
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item, target)


def collect_warnings(work_dir: Path) -> list[str]:
    warnings: list[str] = []
    for pattern in ("**/S1_*intake.json", "**/S2_*adapter_report.json", "**/S8_*usability.json"):
        path = find_one(work_dir, pattern, False)
        if not path:
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            warnings.append(f"Could not read optional status file: {path.name}")
            continue
        warnings.extend(str(item) for item in payload.get("warnings", []) if str(item).strip())
        if payload.get("status") == "completed_with_limits":
            warnings.append(f"{payload.get('stage') or path.stem} completed with content limits")
    return list(dict.fromkeys(warnings))


def validate_registry(path: Path, expected_type: str) -> None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"unreadable registry {path.name}: {exc}") from exc
    if not isinstance(payload, dict) or payload.get("registry_type") != expected_type:
        raise ValueError(f"registry has the wrong type: {path.name}")


def write_zip(root: Path, output: Path) -> int:
    files = sorted(path for path in root.rglob("*") if path.is_file() and not path.is_symlink())
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            relative = path.relative_to(root).as_posix()
            if not safe_relative(relative):
                raise ValueError(f"unsafe staged path: {relative}")
            archive.write(path, relative)
    return len(files)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a lightweight FrontMind Reference Pack v2.2")
    parser.add_argument("--brand", required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--version", type=int, default=1)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        brand = args.brand.strip()
        if not brand:
            raise ValueError("--brand must be non-empty")
        if args.version < 1:
            raise ValueError("--version must be a positive integer")
        work_dir = args.work_dir.resolve()
        if not work_dir.is_dir():
            raise ValueError("--work-dir must be a directory")
        # S8 confirmation itself is owned by the resumable runner. The assembler
        # only requires the human-readable summary to exist; it does not create or
        # inspect any separate confirmation artifact.
        find_one(work_dir, "**/S8_*pack_summary.json", True)
        warnings = collect_warnings(work_dir)
        with tempfile.TemporaryDirectory(prefix="frontmind-reference-pack-v2.2-") as temp_dir:
            root = Path(temp_dir)
            registry_paths: dict[str, str] = {}
            for field, (pattern, destination) in REGISTRIES.items():
                source = find_one(work_dir, pattern, True)
                expected_type = field.removesuffix("_path")
                validate_registry(source, expected_type)
                copy_file(source, root, destination)
                registry_paths[field] = destination

            writing_paths: dict[str, str | None] = {}
            for field, (pattern, destination) in WRITING_ASSETS.items():
                source = find_one(work_dir, pattern, True)
                copy_file(source, root, destination)
                writing_paths[field] = destination

            for source_dir in sorted(path for path in work_dir.rglob("sources") if path.is_dir() and "compatibility" not in path.parts):
                copy_tree(source_dir, root / "sources", warnings)
            for asset_dir in sorted(path for path in work_dir.rglob("assets") if path.is_dir() and "compatibility" not in path.parts):
                copy_tree(asset_dir, root / "assets", warnings)

            slug = re.sub(r"[^0-9a-z]+", "_", brand.lower()).strip("_")
            if len(slug) < 3:
                import hashlib
                slug = "brand_" + hashlib.sha1(brand.encode("utf-8")).hexdigest()[:10]
            slug = slug[:64].rstrip("_")
            created_at = datetime.now(timezone.utc).isoformat()
            material_index = {
                "schema_version": "2.2.0",
                "sources_path": "sources" if (root / "sources").is_dir() else None,
                "assets_path": "assets" if (root / "assets").is_dir() else None,
                "source_file_count": len([path for path in (root / "sources").rglob("*") if path.is_file()]) if (root / "sources").is_dir() else 0,
                "asset_file_count": len([path for path in (root / "assets").rglob("*") if path.is_file()]) if (root / "assets").is_dir() else 0,
            }
            (root / "materials").mkdir(parents=True, exist_ok=True)
            (root / "materials/index.json").write_text(json.dumps(material_index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            payload = {
                "schema_version": "2.2.0",
                "profile": "frontmind-content-reference-pack-v2.2",
                "pack_id": f"rp_{slug}_v{args.version}",
                "version": args.version,
                "created_at": created_at,
                "brand": {"canonical_name": brand, "aliases": []},
                "material_index_path": "materials/index.json",
                "registries": registry_paths,
                "writing_assets": writing_paths,
                "warnings": list(dict.fromkeys(warnings)),
            }
            (root / "reference_pack.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            file_count = write_zip(root, args.output.resolve())
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps({"stage": "S9", "status": "completed_with_limits" if payload["warnings"] else "completed", "profile": payload["profile"], "file_count": file_count, "output": args.output.name}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
