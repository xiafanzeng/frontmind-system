#!/usr/bin/env python3
"""Build a self-contained FrontMind Reference Pack ZIP from approved artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


ZIP_OUTPUT_NAME = re.compile(r"^S9_(?P<brand>[^/]+)_reference_pack_v(?P<version>[1-9][0-9]*)\.zip$")


REQUIRED_ROLES = {
    "s2_adapter_report": ("**/S2_*adapter_report.json",),
    "s4_brand_facts": ("**/S4_*brand_facts.json", "**/S4_*canonical_brand_facts*.json"),
    "s2_knowledge_registry": ("**/S2_*knowledge_registry.json",),
    "s2_source_registry": ("**/S2_*source_registry.json",),
    "s2_claim_registry": ("**/S2_*claim_registry.json",),
    "s2_image_registry": ("**/S2_*image_registry.json",),
    "s4_information_evidence": ("**/S4_*information_evidence*.json", "**/S4_*信息与证据架构*.json"),
    "s5_voice_contract": ("**/S5_*voice_contract*.json", "**/S5_*文章话语契约*.json"),
    "s6_visual_reference": ("**/S6_*visual_reference*.json", "**/S6_*视觉参考体系*.json"),
    "s7_question_library": ("**/S7_*question_library*.json", "**/S7_*问题与FAQ参考库*.json"),
    "s8_approval": ("**/S8_*approval.json", "**/S8_*审批记录*.json"),
}

OPTIONAL_ROLES = {
    "s3_trends": ("**/S3_*trend_reference*.json", "**/S3_*内容趋势参考*.json", "**/S3_status.json", "**/S3_*status.json"),
    "s2_publication_authorizations": ("**/S2_*_source_publication_authorizations.json",),
}

DESTINATIONS = {
    "s4_brand_facts": "brand/brand_facts.json",
    "s2_adapter_report": "diagnostics/adapter_report.json",
    "s2_knowledge_registry": "registries/knowledge_registry.json",
    "s2_source_registry": "registries/source_registry.json",
    "s2_claim_registry": "registries/claim_registry.json",
    "s2_image_registry": "registries/image_registry.json",
    "s3_trends": "writing/trend_reference.json",
    "s4_information_evidence": "writing/information_evidence_architecture.json",
    "s5_voice_contract": "writing/voice_contract.json",
    "s6_visual_reference": "writing/visual_reference.json",
    "s7_question_library": "writing/question_library.json",
    "s8_approval": "approval/approval.json",
}

FILE_ROLES = {
    "s4_brand_facts": "brand_facts",
    "s2_adapter_report": "adapter_report",
    "s2_knowledge_registry": "knowledge_registry",
    "s2_source_registry": "source_registry",
    "s2_claim_registry": "claim_registry",
    "s2_image_registry": "image_registry",
    "s3_trends": "trend_viewpoints",
    "s4_information_evidence": "information_evidence_architecture",
    "s5_voice_contract": "voice_tokens",
    "s6_visual_reference": "visual_rules",
    "s7_question_library": "faq_library",
    "s8_approval": "approval_receipt",
    "s2_publication_authorizations": "source_publication_authorizations",
}


sys.dont_write_bytecode = True

APPROVAL_FINGERPRINT_ROLES = {
    "adapter_report": "s2_adapter_report",
    "knowledge_registry": "s2_knowledge_registry",
    "source_registry": "s2_source_registry",
    "claim_registry": "s2_claim_registry",
    "image_registry": "s2_image_registry",
    "brand_facts": "s4_brand_facts",
    "information_evidence_architecture": "s4_information_evidence",
    "voice_contract": "s5_voice_contract",
    "visual_reference": "s6_visual_reference",
    "question_library": "s7_question_library",
    "trend_reference": "s3_trends",
}

APPROVAL_CONFIRMATIONS = {
    "第一方资料公开授权与声明边界已确认",
    "自适应决策情境与适用范围已确认",
    "话语与竞品比较边界已确认",
    "七意图与五入口参考资产已确认",
    "图片权利与Logo规则已确认",
    "未决风险与附带条件已确认",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def safe_relative(value: str) -> bool:
    path = PurePosixPath(value)
    return bool(value) and not path.is_absolute() and ".." not in path.parts and "\\" not in value


def slug(value: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    if not result:
        result = "brand_" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
    return result[:48]


def discover_one(root: Path, patterns: tuple[str, ...]) -> Path | None:
    matches: set[Path] = set()
    for pattern in patterns:
        matches.update(path.resolve() for path in root.glob(pattern) if path.is_file())
    return sorted(matches, key=lambda path: (path.stat().st_mtime_ns, str(path)), reverse=True)[0] if matches else None


def parse_overrides(values: list[str]) -> dict[str, Path]:
    allowed = set(REQUIRED_ROLES) | set(OPTIONAL_ROLES)
    result: dict[str, Path] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"--artifact must be role=/path: {value}")
        role, raw_path = value.split("=", 1)
        if role not in allowed:
            raise ValueError(f"unknown artifact role: {role}")
        path = Path(raw_path).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"artifact not found: {path}")
        result[role] = path
    return result


def copy_file(source: Path, staging: Path, relative: str) -> Path:
    if not safe_relative(relative):
        raise ValueError(f"unsafe staging path: {relative}")
    destination = staging / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return destination


def artifact_destination(role: str, source: Path) -> str:
    if role == "s2_publication_authorizations":
        return f"diagnostics/{source.name}"
    return DESTINATIONS[role]


def validate_registry_paths(staging: Path) -> None:
    knowledge = load_json(staging / DESTINATIONS["s2_knowledge_registry"])
    sources = load_json(staging / DESTINATIONS["s2_source_registry"])
    images = load_json(staging / DESTINATIONS["s2_image_registry"])
    for index, unit in enumerate(knowledge.get("knowledge_units") or []):
        if not isinstance(unit, dict):
            raise ValueError(f"knowledge_units[{index}] is not an object")
        relative = unit.get("package_path")
        if not isinstance(relative, str) or not safe_relative(relative) or not (staging / relative).is_file():
            raise ValueError(f"knowledge_units[{index}] package_path is not self-contained: {relative!r}")
    for index, source in enumerate(sources.get("sources") or []):
        if not isinstance(source, dict):
            raise ValueError(f"sources[{index}] is not an object")
        relative = source.get("file_path")
        if relative is not None and (
            not isinstance(relative, str) or not safe_relative(relative) or not (staging / relative).is_file()
        ):
            raise ValueError(f"sources[{index}] file_path is not self-contained: {relative!r}")
    for index, image in enumerate(images.get("images") or []):
        if not isinstance(image, dict):
            raise ValueError(f"images[{index}] is not an object")
        relative = image.get("file_path")
        if relative is not None and (
            not isinstance(relative, str) or not safe_relative(relative) or not (staging / relative).is_file()
        ):
            raise ValueError(f"images[{index}] file_path is not self-contained: {relative!r}")


def zip_members(path: Path) -> tuple[list[str], str]:
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if not name.endswith("/")]
    if len(names) != len(set(names)):
        raise ValueError("knowledge ZIP contains duplicate member names")
    for name in names:
        if not safe_relative(name):
            raise ValueError(f"unsafe knowledge ZIP path: {name}")
    manifests = [name for name in names if name == "00_package_manifest.json" or name.endswith("/00_package_manifest.json")]
    if len(manifests) != 1:
        raise ValueError(f"knowledge ZIP must contain exactly one 00_package_manifest.json, found {len(manifests)}")
    prefix = str(PurePosixPath(manifests[0]).parent)
    return names, "" if prefix == "." else prefix


def copy_knowledge_base(source: Path, staging: Path) -> tuple[dict[str, Any], str, list[str]]:
    destination_root = staging / "sources/knowledge_base"
    destination_root.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []
    if source.is_file():
        if not zipfile.is_zipfile(source):
            raise ValueError("--kb file must be a ZIP")
        names, prefix = zip_members(source)
        normalized: set[str] = set()
        with zipfile.ZipFile(source) as archive:
            for name in names:
                if prefix:
                    prefix_with_slash = prefix + "/"
                    if not name.startswith(prefix_with_slash):
                        raise ValueError(f"knowledge ZIP mixes files outside package root: {name}")
                    relative = name[len(prefix_with_slash):]
                else:
                    relative = name
                if not safe_relative(relative) or relative in normalized:
                    raise ValueError(f"unsafe or duplicate normalized knowledge path: {relative}")
                normalized.add(relative)
                target = destination_root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
                copied.append(f"sources/knowledge_base/{relative}")
        copy_file(source, staging, "sources/original_kb.zip")
        copied.append("sources/original_kb.zip")
        package_hash = sha256_file(source)
    else:
        raise ValueError(f"knowledge input must be the canonical KB source ZIP: {source}")
    manifest_path = destination_root / "00_package_manifest.json"
    if not manifest_path.is_file():
        raise ValueError("normalized knowledge base lacks 00_package_manifest.json")
    manifest = load_json(manifest_path)
    if manifest.get("schemaVersion") != 4 or manifest.get("profile") != "dashboard-enterprise-v1":
        raise ValueError("knowledge base must be schemaVersion=4, profile=dashboard-enterprise-v1")
    for required in ("00_source_index.md", "00_knowledge_tree.md"):
        if not (destination_root / required).is_file():
            raise ValueError(f"normalized knowledge base lacks {required}")
    return manifest, package_hash, copied


def copy_images(image_registry_path: Path, staging: Path) -> list[str]:
    registry = load_json(image_registry_path)
    if not isinstance(registry, dict) or registry.get("registry_type") != "image_registry":
        raise ValueError("S2 image registry has the wrong wrapper")
    copied: list[str] = []
    for index, image in enumerate(registry.get("images") or []):
        if not isinstance(image, dict):
            raise ValueError(f"image registry images[{index}] is not an object")
        relative = image.get("file_path")
        rights = image.get("rights_status")
        if relative is None:
            if rights in {"approved", "approved_with_credit"}:
                raise ValueError(f"approved image has no file_path: {image.get('asset_id')}")
            continue
        if not isinstance(relative, str) or not safe_relative(relative):
            raise ValueError(f"unsafe image file_path: {relative!r}")
        source = (image_registry_path.parent / relative).resolve()
        if not source.is_file():
            raise ValueError(f"image file absent beside registry: {relative}")
        expected = image.get("sha256")
        actual = sha256_file(source)
        if expected and expected != actual:
            raise ValueError(f"image hash mismatch before packing: {relative}")
        copy_file(source, staging, relative)
        copied.append(relative)
    return copied


def copy_registry_source_files(source_registry_path: Path, staging: Path) -> list[str]:
    """Carry S2-local evidence files referenced by the source registry.

    Canonical KB paths are already copied into staging.  Supplemental S1
    evidence is copied from beside the S2 registry, preserving the canonical
    package-relative path and preventing dangling evidence references.
    """
    registry = load_json(source_registry_path)
    if not isinstance(registry, dict) or registry.get("registry_type") != "source_registry":
        raise ValueError("S2 source registry has the wrong wrapper")
    registry_root = source_registry_path.parent.resolve()
    copied: list[str] = []
    for index, source_item in enumerate(registry.get("sources") or []):
        if not isinstance(source_item, dict):
            raise ValueError(f"source registry sources[{index}] is not an object")
        relative = source_item.get("file_path")
        if relative is None:
            continue
        if not isinstance(relative, str) or not safe_relative(relative):
            raise ValueError(f"source registry sources[{index}] has unsafe file_path: {relative!r}")
        destination = staging / relative
        if destination.is_file():
            continue
        candidate = (registry_root / relative).resolve()
        try:
            candidate.relative_to(registry_root)
        except ValueError as exc:
            raise ValueError(f"source registry sources[{index}] escapes its S2 root") from exc
        if not candidate.is_file() or candidate.is_symlink():
            raise ValueError(f"source registry sources[{index}] file is absent beside S2 registry: {relative!r}")
        copy_file(candidate, staging, relative)
        copied.append(relative)
    return copied


def media_type(path: Path) -> str:
    if path.suffix.lower() == ".json":
        return "application/json"
    if path.suffix.lower() == ".md":
        return "text/markdown"
    if path.suffix.lower() == ".zip":
        return "application/zip"
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def role_for_path(path: str, explicit: dict[str, str]) -> str:
    if path in explicit:
        return explicit[path]
    if path == "sources/knowledge_base/00_package_manifest.json":
        return "knowledge_manifest"
    if path == "sources/knowledge_base/00_source_index.md":
        return "knowledge_index"
    if path == "sources/knowledge_base/00_knowledge_tree.md":
        return "knowledge_tree"
    if path == "sources/original_kb.zip":
        return "knowledge_source_package"
    return "supporting_reference"


def validate_package(validator: Path, package: Path) -> dict[str, Any]:
    environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    completed = subprocess.run([sys.executable, "-B", str(validator), str(package)], text=True, capture_output=True, check=False, env=environment)
    try:
        report = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(f"shared validator returned invalid output: {completed.stderr or completed.stdout}") from exc
    if completed.returncode != 0 or report.get("status") != "pass":
        raise ValueError("shared package validation failed: " + json.dumps(report, ensure_ascii=False))
    return report


def run_checked(label: str, command: list[str]) -> None:
    environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    completed = subprocess.run(command, text=True, capture_output=True, check=False, env=environment)
    if completed.returncode != 0:
        detail = (completed.stdout or completed.stderr).strip()
        raise ValueError(f"{label} failed: {detail}")


def validate_json_instance(schema_validator: Path, schema: Path, instance: Path) -> None:
    if not schema_validator.is_file():
        raise ValueError(f"canonical JSON Schema runtime is missing: {schema_validator}")
    run_checked(
        f"schema validation for {instance.name}",
        [sys.executable, "-B", str(schema_validator), str(schema), str(instance)],
    )


def validate_active_artifacts(
    package_root: Path,
    artifacts: dict[str, Path],
    pattern_registry: Path,
    pattern_research_index: Path,
) -> None:
    """Run every structural and semantic gate before an approval can be packed."""
    schema_validator = package_root / "shared/scripts/validate_json_instance.py"
    strategy = package_root / "Strategy_Workflow"
    schemas = {
        "s4_brand_facts": package_root / "shared/brand_facts.schema.json",
        "s2_knowledge_registry": package_root / "shared/registries.schema.json",
        "s2_source_registry": package_root / "shared/registries.schema.json",
        "s2_claim_registry": package_root / "shared/registries.schema.json",
        "s2_image_registry": package_root / "shared/registries.schema.json",
        "s4_information_evidence": package_root / "shared/information_evidence_architecture.schema.json",
        "s5_voice_contract": strategy / "S5.文章话语契约.skill/templates/article_voice_contract_schema.json",
        "s6_visual_reference": strategy / "S6.视觉参考体系.skill/templates/visual_reference_schema.json",
        "s7_question_library": strategy / "S7.问题与FAQ参考库.skill/templates/question_library_schema.json",
        "s8_approval": strategy / "S8.ReferencePack确认师.skill/templates/reference_pack_approval_schema.json",
    }
    for role, schema in schemas.items():
        validate_json_instance(schema_validator, schema, artifacts[role])

    pattern = load_json(pattern_registry)
    expected_categories = ["industry_ranking", "competitor_comparison", "reputation", "product_scenario", "foundation_start"]
    expected_patterns = [f"P{index:02d}" for index in range(1, 17)]
    all_entry_ids = [item.get("id") for item in pattern.get("canonical_content_entries", []) if isinstance(item, dict)]
    category_ids = all_entry_ids
    pattern_ids = [item.get("id") for item in pattern.get("patterns", []) if isinstance(item, dict)]
    if (
        pattern.get("schema_version") != "2.1.0"
        or category_ids != expected_categories
        or pattern_ids != expected_patterns
    ):
        raise ValueError("content pattern registry is not the canonical v2.1 five-entry/P01-P16 registry")
    if any("variants" in item for item in pattern.get("patterns", []) if isinstance(item, dict)):
        raise ValueError("v2.1 patterns must not expose the retired pattern variants field")
    foundation_route = (pattern.get("routing") or {}).get("foundation_start") or {}
    if foundation_route.get("primary_patterns") != ["P14"] or foundation_route.get("secondary_patterns") not in ([], None):
        raise ValueError("foundation_start must route exclusively to P14")

    research_index = load_json(pattern_research_index)
    if not isinstance(research_index, dict) or research_index.get("schema_version") != "2.1.0":
        raise ValueError("content pattern research index must be a v2.1 JSON object")
    if research_index.get("required_pattern_ids") != expected_patterns:
        raise ValueError("content pattern research index does not cover P01-P16 exactly")

    report = load_json(artifacts["s2_adapter_report"])
    if report.get("schema_version") != "2.0.0" or report.get("fatal_errors") or report.get("formal_handoff_ready") is not True:
        raise ValueError("S2 adapter report is not a clean formal handoff")

    validators = {
        "s4": strategy / "S4.内容价值与证据架构师.skill/scripts/information_evidence_validator.py",
        "s5": strategy / "S5.文章话语契约.skill/scripts/article_voice_contract_validator.py",
        "s6": strategy / "S6.视觉参考体系.skill/scripts/visual_reference_validator.py",
        "s7": strategy / "S7.问题与FAQ参考库.skill/scripts/question_library_validator.py",
    }
    run_checked("S4 semantic validation", [
        sys.executable, "-B", str(validators["s4"]), str(artifacts["s4_information_evidence"]),
        "--brand-facts", str(artifacts["s4_brand_facts"]),
        "--knowledge-registry", str(artifacts["s2_knowledge_registry"]),
        "--claim-registry", str(artifacts["s2_claim_registry"]),
        "--source-registry", str(artifacts["s2_source_registry"]),
        "--pattern-registry", str(pattern_registry),
    ])
    run_checked("S5 semantic validation", [
        sys.executable, "-B", str(validators["s5"]), str(artifacts["s5_voice_contract"]),
        "--architecture", str(artifacts["s4_information_evidence"]),
        "--pattern-registry", str(pattern_registry),
    ])
    run_checked("S6 semantic validation", [
        sys.executable, "-B", str(validators["s6"]), str(artifacts["s6_visual_reference"]),
        "--image-registry", str(artifacts["s2_image_registry"]),
        "--pattern-registry", str(pattern_registry),
    ])
    run_checked("S7 semantic validation", [
        sys.executable, "-B", str(validators["s7"]), str(artifacts["s7_question_library"]),
        "--pattern-registry", str(pattern_registry),
        "--knowledge-registry", str(artifacts["s2_knowledge_registry"]),
        "--source-registry", str(artifacts["s2_source_registry"]),
        "--claim-registry", str(artifacts["s2_claim_registry"]),
        "--architecture", str(artifacts["s4_information_evidence"]),
    ])


def validate_approval_receipt(
    approval: dict[str, Any],
    brand: str,
    artifacts: dict[str, Path],
    pattern_registry: Path,
    pattern_research_index: Path,
    work_dir: Path,
) -> Path:
    """Require an unconditional, hash-bound S8 approval and its source workbook."""
    decision = approval.get("approval") if isinstance(approval.get("approval"), dict) else {}
    if approval.get("brand") != brand:
        raise ValueError("S8 approval brand does not match --brand")
    if decision.get("status") != "approved":
        raise ValueError(f"S8 approval must be exactly approved, got {decision.get('status')!r}")
    if not all(str(decision.get(key, "")).strip() for key in ("reviewer", "reviewer_role", "approved_at")):
        raise ValueError("S8 approved receipt requires reviewer, reviewer_role and approved_at")
    if decision.get("conditions") or decision.get("unresolved_risks"):
        raise ValueError("S8 approved receipt cannot contain conditions or unresolved risks")
    confirmations = approval.get("confirmations") if isinstance(approval.get("confirmations"), dict) else {}
    if set(confirmations) != APPROVAL_CONFIRMATIONS or not all(confirmations.values()):
        raise ValueError("all six canonical S8 confirmations must be true")
    reviews = approval.get("review_decisions")
    if not isinstance(reviews, list) or not reviews or any(
        not isinstance(item, dict) or item.get("decision") != "keep" or not str(item.get("object_id", "")).strip()
        for item in reviews
    ):
        raise ValueError("S8 approved receipt requires non-empty, all-keep object review decisions")

    expected: dict[str, Path] = {
        "pattern_registry": pattern_registry,
        "pattern_research_index": pattern_research_index,
    }
    for receipt_role, artifact_role in APPROVAL_FINGERPRINT_ROLES.items():
        if artifact_role in artifacts:
            expected[receipt_role] = artifacts[artifact_role]
    fingerprints = approval.get("input_files")
    if not isinstance(fingerprints, list):
        raise ValueError("S8 approval input_files must be an array")
    by_role: dict[str, dict[str, Any]] = {}
    for item in fingerprints:
        if not isinstance(item, dict) or not isinstance(item.get("role"), str) or item["role"] in by_role:
            raise ValueError("S8 approval input_files roles must be unique objects")
        by_role[item["role"]] = item
    if set(by_role) != set(expected):
        raise ValueError(f"S8 approval fingerprints differ from pack inputs: expected={sorted(expected)}, actual={sorted(by_role)}")
    for role, path in expected.items():
        item = by_role[role]
        if item.get("file_name") != path.name or item.get("sha256") != sha256_file(path) or item.get("bytes") != path.stat().st_size:
            raise ValueError(f"S8 approval fingerprint mismatch for {role}")
    if approval.get("pattern_registry_sha256") != sha256_file(pattern_registry):
        raise ValueError("S8 approval pattern_registry_sha256 mismatch")
    if approval.get("pattern_research_index_sha256") != sha256_file(pattern_research_index):
        raise ValueError("S8 approval pattern_research_index_sha256 mismatch")

    workbook = approval.get("workbook") if isinstance(approval.get("workbook"), dict) else {}
    workbook_name, workbook_hash = workbook.get("file_name"), workbook.get("sha256")
    if not isinstance(workbook_name, str) or not safe_relative(workbook_name) or not isinstance(workbook_hash, str):
        raise ValueError("S8 approval workbook fingerprint is invalid")
    candidates = [path for path in work_dir.rglob(workbook_name) if path.is_file() and sha256_file(path) == workbook_hash]
    if len(candidates) != 1:
        raise ValueError("S8 approval source workbook is missing, duplicated, or hash-mismatched")
    return candidates[0]


def main() -> int:
    parser = argparse.ArgumentParser(description="Build an approved self-contained FrontMind Reference Pack ZIP")
    parser.add_argument("--brand", required=True)
    parser.add_argument("--alias", action="append", default=[])
    parser.add_argument("--legal-entity-name")
    parser.add_argument("--official-website")
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--kb", required=True, help="Canonical KB v4 source ZIP (hash-bound into the formal pack)")
    parser.add_argument("--pattern-registry", required=True)
    parser.add_argument("--pattern-research-index", required=True)
    parser.add_argument("--output", required=True, help="Output ZIP path")
    parser.add_argument("--version", type=int, default=1)
    parser.add_argument("--artifact", action="append", default=[], help="Override discovery with role=/absolute/path.json")
    parser.add_argument("--validator", help="Override root shared/scripts/validate_package.py")
    parser.add_argument("--force", action="store_true", help="Replace an existing output ZIP")
    args = parser.parse_args()

    work_dir = Path(args.work_dir).expanduser().resolve()
    kb_path = Path(args.kb).expanduser().resolve()
    pattern_registry = Path(args.pattern_registry).expanduser().resolve()
    pattern_research_index = Path(args.pattern_research_index).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    package_root = Path(__file__).resolve().parents[3]
    validator = Path(args.validator).expanduser().resolve() if args.validator else package_root / "shared/scripts/validate_package.py"
    if not work_dir.is_dir():
        parser.error(f"work directory does not exist: {work_dir}")
    if not kb_path.is_file() or not zipfile.is_zipfile(kb_path):
        parser.error("--kb must be the canonical KB v4 source ZIP used by S2")
    if not pattern_registry.is_file():
        parser.error(f"pattern registry does not exist: {pattern_registry}")
    if not pattern_research_index.is_file():
        parser.error(f"pattern research index does not exist: {pattern_research_index}")
    if not validator.is_file():
        parser.error(f"shared validator does not exist: {validator}")
    output_name = ZIP_OUTPUT_NAME.fullmatch(output.name)
    if output_name is None:
        parser.error("--output basename must be S9_{brand_label}_reference_pack_v{N}.zip")
    if int(output_name.group("version")) != args.version:
        parser.error("--output filename version must equal --version")
    if output.exists() and not args.force:
        parser.error(f"output already exists; pass --force to replace: {output}")
    try:
        overrides = parse_overrides(args.artifact)
    except ValueError as exc:
        parser.error(str(exc))

    artifacts: dict[str, Path] = {}
    missing: list[str] = []
    for role, patterns in REQUIRED_ROLES.items():
        found = overrides.get(role) or discover_one(work_dir, patterns)
        if found is None:
            missing.append(role)
        else:
            artifacts[role] = found
    for role, patterns in OPTIONAL_ROLES.items():
        found = overrides.get(role) or discover_one(work_dir, patterns)
        if found is not None:
            artifacts[role] = found
    if missing:
        parser.error("missing required artifacts: " + ", ".join(missing))

    try:
        validate_active_artifacts(package_root, artifacts, pattern_registry, pattern_research_index)
        approval = load_json(artifacts["s8_approval"])
        approval_workbook = validate_approval_receipt(
            approval, args.brand, artifacts, pattern_registry, pattern_research_index, work_dir
        )
        adapter_report = load_json(artifacts["s2_adapter_report"])
        adapter_fingerprints = adapter_report.get("input_fingerprints") if isinstance(adapter_report.get("input_fingerprints"), dict) else {}
        if adapter_fingerprints.get("kb") != sha256_file(kb_path):
            raise ValueError("--kb is not the canonical KB ZIP used to produce the approved S2 artifacts")
        publication = adapter_report.get("publication_authorizations") if isinstance(adapter_report.get("publication_authorizations"), dict) else {}
        publication_status = publication.get("status")
        publication_artifact = artifacts.get("s2_publication_authorizations")
        if publication_status == "applied":
            if publication_artifact is None:
                raise ValueError("S2 applied publication authorizations but the canonical authorization artifact is missing")
            if publication.get("file_name") != publication_artifact.name or publication.get("sha256") != sha256_file(publication_artifact):
                raise ValueError("S2 publication authorization artifact does not match adapter_report")
        elif publication_artifact is not None:
            raise ValueError("S2 publication authorization artifact exists but adapter_report status is not applied")
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        parser.error(str(exc))

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="frontmind-reference-pack-") as temporary:
        staging = Path(temporary) / "package"
        staging.mkdir()
        try:
            manifest, kb_hash, _ = copy_knowledge_base(kb_path, staging)
            explicit_roles: dict[str, str] = {}
            for role, source in artifacts.items():
                relative = artifact_destination(role, source)
                copy_file(source, staging, relative)
                if role in FILE_ROLES:
                    explicit_roles[relative] = FILE_ROLES[role]
            copy_file(approval_workbook, staging, "approval/confirmation_workbook.xlsx")
            explicit_roles["approval/confirmation_workbook.xlsx"] = "approval_evidence"
            copy_registry_source_files(artifacts["s2_source_registry"], staging)
            copy_images(artifacts["s2_image_registry"], staging)
            validate_registry_paths(staging)
            copy_file(pattern_registry, staging, "shared/content-pattern-registry.json")
            explicit_roles["shared/content-pattern-registry.json"] = "content_pattern_registry"
            copy_file(pattern_research_index, staging, "shared/pattern-research/index.json")
            explicit_roles["shared/pattern-research/index.json"] = "content_pattern_research_index"
            guide = pattern_registry.with_name("content-pattern-guide.md")
            if guide.is_file():
                copy_file(guide, staging, "shared/content-pattern-guide.md")
                explicit_roles["shared/content-pattern-guide.md"] = "supporting_reference"

            files = []
            for path in sorted(item for item in staging.rglob("*") if item.is_file()):
                relative = path.relative_to(staging).as_posix()
                files.append({"path": relative, "sha256": sha256_file(path), "media_type": media_type(path), "role": role_for_path(relative, explicit_roles)})

            pack = {
                "schema_version": "2.1.0",
                "profile": "frontmind-content-reference-pack-v2.1",
                "pack_id": f"rp_{slug(args.brand)}_{kb_hash[:8]}_v21",
                "version": args.version,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "brand": {
                    "canonical_name": args.brand,
                    "aliases": sorted(set(args.alias)),
                    "legal_entity_name": args.legal_entity_name,
                    "official_website": args.official_website,
                },
                "knowledge_base": {
                    "schema_version": str(manifest.get("schemaVersion") or "unknown"),
                    "profile": str(manifest.get("profile") or "unknown"),
                    "package_sha256": kb_hash,
                    "original_package_path": "sources/original_kb.zip",
                    "package_manifest_path": "sources/knowledge_base/00_package_manifest.json",
                    "source_index_path": "sources/knowledge_base/00_source_index.md",
                    "knowledge_tree_path": "sources/knowledge_base/00_knowledge_tree.md",
                },
                "diagnostics": {"adapter_report_path": DESTINATIONS["s2_adapter_report"]},
                "approval_receipt_path": DESTINATIONS["s8_approval"],
                "approval_evidence_path": "approval/confirmation_workbook.xlsx",
                "content_pattern_registry_path": "shared/content-pattern-registry.json",
                "content_pattern_research_index_path": "shared/pattern-research/index.json",
                "brand_facts_path": DESTINATIONS["s4_brand_facts"],
                "registries": {
                    "knowledge_registry_path": DESTINATIONS["s2_knowledge_registry"],
                    "source_registry_path": DESTINATIONS["s2_source_registry"],
                    "claim_registry_path": DESTINATIONS["s2_claim_registry"],
                    "image_registry_path": DESTINATIONS["s2_image_registry"],
                },
                "writing_assets": {
                    "information_evidence_architecture_path": DESTINATIONS["s4_information_evidence"],
                    "trend_viewpoints_path": DESTINATIONS["s3_trends"] if "s3_trends" in artifacts else None,
                    "voice_token_path": DESTINATIONS["s5_voice_contract"],
                    "visual_rules_path": DESTINATIONS["s6_visual_reference"],
                    "faq_library_path": DESTINATIONS["s7_question_library"],
                },
                "files": files,
                "warnings": (
                    list(adapter_report.get("warnings") or []) if isinstance(adapter_report, dict) else []
                ) + ([] if "s3_trends" in artifacts else ["S3 optional trend reference was not supplied"]),
            }
            with (staging / "reference_pack.json").open("w", encoding="utf-8") as handle:
                json.dump(pack, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            validate_json_instance(
                package_root / "shared/scripts/validate_json_instance.py",
                package_root / "shared/reference_pack.schema.json",
                staging / "reference_pack.json",
            )
            directory_report = validate_package(validator, staging)

            temporary_zip = Path(temporary) / output.name
            seen: set[str] = set()
            with zipfile.ZipFile(temporary_zip, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                for path in sorted(item for item in staging.rglob("*") if item.is_file()):
                    relative = path.relative_to(staging).as_posix()
                    if relative in seen or not safe_relative(relative):
                        raise ValueError(f"duplicate or unsafe output path: {relative}")
                    seen.add(relative)
                    archive.write(path, relative)
            zip_report = validate_package(validator, temporary_zip)
            if output.exists():
                output.unlink()
            shutil.move(str(temporary_zip), output)
        except (OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
            parser.error(str(exc))

    print(json.dumps({"status": "ok", "output": str(output), "sha256": sha256_file(output), "files": len(files) + 1, "directory_validation": directory_report["status"], "zip_validation": zip_report["status"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
