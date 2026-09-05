#!/usr/bin/env python3
"""Validate the active FrontMind content-production Workflow v2.3 tree.

The validator is deliberately a development/package check.  It does not
recreate runtime receipts, approval ledgers, file fingerprints or cross-stage
hash gates.  Files under ``compatibility/`` and explicitly named legacy
references are historical material and are excluded from the active contract.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


# These are the only root contracts used by the active v2.3 workflow.  A few
# stable supporting contracts retain their earlier schema number; their values
# below document that intentionally compatible boundary.
CANONICAL_SCHEMA_VERSIONS: dict[str, set[str]] = {
    "reference_pack.schema.json": {"2.2.0", "2.1.0"},
    "content_job.schema.json": {"2.3.0"},
    "monitoring_context.schema.json": {"2.3.0"},
    "e2_pattern_analysis.schema.json": {"2.3.0"},
    "registries.schema.json": {"2.2.0", "2.0.0"},
    "article_blueprint.schema.json": {"2.3.0"},
    "content_model.schema.json": {"2.3.0"},
    "brand_facts.schema.json": {"2.3.0"},
    "scope_analysis.schema.json": {"2.3.0"},
    "title_map.schema.json": {"2.3.0"},
    "information_evidence_architecture.schema.json": {"2.3.0"},
    "job_state.schema.json": {"2.3.0"},
    "working_context.schema.json": {"2.3.0"},
    "delivery_index.schema.json": {"2.3.0"},
}

ARCHIVED_AUDIT_SCHEMAS = {
    "delivery_manifest.schema.json",
    "e2_human_review_receipt.schema.json",
    "e4_pattern_decision.schema.json",
    "quality_report.schema.json",
    "runtime_evidence_extension.schema.json",
    "title_count_receipt.schema.json",
}

CONTENT_ENTRIES = [
    "industry_ranking",
    "competitor_comparison",
    "reputation",
    "product_scenario",
    "foundation_start",
]
PATTERN_IDS = [f"P{index:02d}" for index in range(1, 17)]

NEGATION_MARKERS = (
    "不再", "不要求", "不生成", "不读取", "不调用", "不得", "不能", "不会",
    "不包含", "不含", "不保存", "不需要", "不携带", "不绑定", "不等待", "不复活",
    "不产生", "不进入", "不作为", "不消费", "已废弃", "忽略旧", "读取后忽略",
    "没有", "无需", "不是", "无逐文件",
    "删除", "移除", "归档", "兼容区", "历史", "forbidden", "removed", "without",
    "does not", "do not", "must not", "no ",
)

# Match active instructions that make an audit artifact part of execution.
# A bare image SHA used for deduplication/safe reading is intentionally allowed.
AUDIT_BINDING_PATTERNS: dict[str, re.Pattern[str]] = {
    "receipt_artifact": re.compile(
        r"(?:--[a-z0-9_-]*receipt[a-z0-9_-]*|"
        r"[a-z0-9_-]*receipt(?:\.json|\.schema\.json)?|回执)",
        re.IGNORECASE,
    ),
    "hash_binding": re.compile(
        r"(?:approved_body_sha256|content_model_sha256|hash[-_ ]bound|哈希绑定|哈希账本|"
        r"hash\s+ledger|跨阶段.{0,24}(?:hash|sha|哈希|指纹)|"
        r"逐文件.{0,24}(?:hash|sha|哈希|指纹)|"
        r"(?:sha[-_ ]?256|hash|哈希).{0,30}(?:receipt|回执|manifest|清单|账本|绑定|registry\s*一致)|"
        r"(?:receipt|回执|manifest|清单|账本|绑定|registry).{0,30}(?:sha[-_ ]?256|hash|哈希))",
        re.IGNORECASE,
    ),
    "audit_ledger": re.compile(
        r"(?:approval[-_ ]workbook|审批工作簿|审批账本|审计账本|"
        r"runtime[-_ ]registry(?:\s+copy)?|exact[-_ ]set|"
        r"(?:input|file|registry)[-_ ]fingerprint|输入指纹)",
        re.IGNORECASE,
    ),
}

FOCUSED_TEST_SUITES = (
    "scripts/tests/test_frontmind_workflow_v23.py",
    "scripts/tests/test_runtime_dependencies_v23.py",
    "shared/scripts/test_validate_json_instance.py",
    "shared/scripts/test_validate_package.py",
    "shared/scripts/test_validate_title_map.py",
    "shared/pattern-research/tests/test_validate_pattern_research.py",
    "shared/tests/test_content_route.py",
    "shared/tests/test_source_publication.py",
    "Execution_Workflow/E1.单篇任务建档师.skill/tests/test_content_intake_v23.py",
    "Execution_Workflow/E2.单问题监控与标杆拆解师.skill/tests/test_pattern_analysis_v23.py",
    "Execution_Workflow/E2.单问题监控与标杆拆解师.skill/tests/test_research_input_adapters_v23.py",
    "Execution_Workflow/E3.工作上下文汇总师.skill/tests/test_working_context_v23.py",
    "Execution_Workflow/E4.文章蓝图师.skill/tests/test_article_blueprint_v23.py",
    "Execution_Workflow/E5.正文制作师.skill/tests/test_article_quality_v23.py",
    "Execution_Workflow/E7.视觉论证与资产生产师.skill/tests/test_visual_pipeline_v23.py",
    "Execution_Workflow/E10.回归选稿与双格式交付师.skill/tests/test_content_first_e5_e10.py",
    "Execution_Workflow/shared/tests/test_content_first_runtime.py",
    "Execution_Workflow/shared/tests/test_text_quality.py",
)


def issue(
    bucket: list[dict[str, Any]],
    check: str,
    path: Path,
    message: str,
    line: int | None = None,
) -> None:
    value: dict[str, Any] = {"check": check, "file": str(path), "message": message}
    if line is not None:
        value["line"] = line
    bucket.append(value)


def is_archived(path: Path) -> bool:
    """Return true for compatibility material outside the active runtime."""

    return (
        "compatibility" in path.parts
        or any(part.startswith("legacy-") or ".legacy-" in part for part in path.parts)
        or path.name.startswith("legacy_")
    )


def is_generated(path: Path) -> bool:
    return "__pycache__" in path.parts or ".pytest_cache" in path.parts or path.suffix == ".pyc"


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def walk_refs(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "$ref" and isinstance(child, str):
                refs.append(child)
            else:
                refs.extend(walk_refs(child))
    elif isinstance(value, list):
        for child in value:
            refs.extend(walk_refs(child))
    return refs


def schema_versions(value: Any) -> set[str]:
    """Collect constants attached specifically to a ``schema_version`` key."""

    values: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "schema_version" and isinstance(child, dict) and isinstance(child.get("const"), str):
                values.add(child["const"])
            values.update(schema_versions(child))
    elif isinstance(value, list):
        for child in value:
            values.update(schema_versions(child))
    return values


def json_pointer_exists(document: Any, fragment: str) -> bool:
    if fragment in ("", "#"):
        return True
    pointer = fragment[1:] if fragment.startswith("#") else fragment
    if not pointer.startswith("/"):
        return False
    current = document
    for token in pointer[1:].split("/"):
        key = token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict) and key in current:
            current = current[key]
        elif isinstance(current, list) and key.isdigit() and int(key) < len(current):
            current = current[int(key)]
        else:
            return False
    return True


def check_hygiene(root: Path, errors: list[dict[str, Any]], counts: dict[str, int]) -> None:
    for path in sorted(root.rglob("*")):
        if path.name in {".DS_Store", "__pycache__", ".pytest_cache"}:
            issue(errors, "package_hygiene", path, f"generated artifact {path.name!r} must not be packaged")
        elif path.is_file() and path.suffix == ".pyc":
            issue(errors, "package_hygiene", path, "compiled bytecode must not be packaged")
        elif path.is_symlink():
            issue(errors, "package_hygiene", path, "symbolic links are not allowed in the release tree")
        counts["filesystem_entries"] += 1


def check_skill_frontmatter(root: Path, errors: list[dict[str, Any]], counts: dict[str, int]) -> None:
    for path in sorted(root.rglob("SKILL.md")):
        if is_archived(path) or is_generated(path):
            continue
        counts["skills"] += 1
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as exc:
            issue(errors, "skill_frontmatter", path, str(exc))
            continue
        if not lines or lines[0].strip() != "---":
            issue(errors, "skill_frontmatter", path, "first line must be ---")
            continue
        try:
            end = next(index for index, value in enumerate(lines[1:], 1) if value.strip() == "---")
        except StopIteration:
            issue(errors, "skill_frontmatter", path, "closing --- is missing")
            continue
        values: dict[str, str] = {}
        unknown: set[str] = set()
        last_key: str | None = None
        folded_key: str | None = None
        for index, raw in enumerate(lines[1:end], 2):
            match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)", raw)
            if not match:
                if raw[:1].isspace() and folded_key == "description" and raw.strip():
                    values["description"] = f"{values['description']} {raw.strip()}".strip()
                    continue
                issue(errors, "skill_frontmatter", path, "invalid frontmatter line", index)
                continue
            key, value = match.groups()
            if key not in {"name", "description"}:
                unknown.add(key)
            if key in values:
                issue(errors, "skill_frontmatter", path, f"duplicate {key!r} field", index)
            last_key = key
            folded_key = key if key == "description" and value.strip() in {">", "|-", "|", ">-"} else None
            values[key] = "" if folded_key else value.strip()
        if unknown:
            issue(errors, "skill_frontmatter", path, f"only name and description are allowed; found {sorted(unknown)}")
        for key in ("name", "description"):
            if not values.get(key):
                issue(errors, "skill_frontmatter", path, f"missing non-empty {key}")
        name = values.get("name", "")
        if name and not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
            issue(errors, "skill_frontmatter", path, "name must use lowercase hyphen-case")


def check_json(root: Path, errors: list[dict[str, Any]], counts: dict[str, int]) -> None:
    documents: dict[Path, Any] = {}
    for path in sorted(root.rglob("*.json")):
        if is_archived(path) or is_generated(path):
            continue
        counts["json"] += 1
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            issue(errors, "json_parse", path, str(exc))
            continue
        resolved = path.resolve()
        documents[resolved] = document
        if path.name.endswith(".schema.json"):
            if not isinstance(document, dict):
                issue(errors, "json_schema", path, "schema root must be an object")
            elif "$schema" not in document:
                issue(errors, "json_schema", path, "schema file lacks $schema")
            canonical = root / "shared" / path.name
            if path.name in CANONICAL_SCHEMA_VERSIONS and resolved != canonical.resolve():
                issue(errors, "schema_ssot", path, f"duplicate canonical schema; use {canonical}")

    schema_id_owners: dict[str, Path] = {}
    for path, document in sorted(documents.items(), key=lambda item: str(item[0])):
        if not isinstance(document, dict) or not isinstance(document.get("$id"), str):
            continue
        schema_id = document["$id"]
        if schema_id in schema_id_owners:
            issue(errors, "schema_ssot", path, f"duplicate schema $id {schema_id!r}; owner is {schema_id_owners[schema_id]}")
        else:
            schema_id_owners[schema_id] = path

    for path, document in documents.items():
        for raw_ref in walk_refs(document):
            if raw_ref.startswith(("http://", "https://")):
                continue
            file_part, separator, fragment = raw_ref.partition("#")
            target = path if not file_part else (path.parent / file_part).resolve()
            if is_archived(target):
                issue(errors, "json_ref", path, f"active JSON cannot reference compatibility material: {raw_ref}")
                continue
            target_document = documents.get(target)
            if target_document is None:
                issue(errors, "json_ref", path, f"missing or invalid local $ref target: {raw_ref}")
                continue
            if separator and not json_pointer_exists(target_document, fragment):
                issue(errors, "json_ref", path, f"missing JSON pointer in $ref: {raw_ref}")


def check_python(root: Path, errors: list[dict[str, Any]], counts: dict[str, int]) -> None:
    """Compile source in memory so validation cannot create bytecode files."""

    for path in sorted(root.rglob("*.py")):
        if is_archived(path) or is_generated(path):
            continue
        counts["python"] += 1
        try:
            source = path.read_text(encoding="utf-8")
            compile(source, str(path), "exec", dont_inherit=True)
        except (OSError, UnicodeDecodeError, SyntaxError) as exc:
            issue(errors, "python_compile", path, str(exc))


def check_active_docs(root: Path, errors: list[dict[str, Any]], counts: dict[str, int]) -> None:
    historical = {(root / "shared" / "workflow-migration-map.md").resolve()}
    for path in sorted(root.rglob("*.md")):
        if is_archived(path) or is_generated(path) or path.resolve() in historical:
            continue
        counts["active_markdown"] += 1
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            issue(errors, "active_document", path, str(exc))
            continue
        for offset, line in enumerate(text.splitlines(), 1):
            folded = line.casefold()
            if any(marker.casefold() in folded for marker in NEGATION_MARKERS):
                continue
            for label, pattern in AUDIT_BINDING_PATTERNS.items():
                match = pattern.search(line)
                if match:
                    issue(
                        errors,
                        "active_audit_binding",
                        path,
                        f"{label}: active instructions must not invoke receipt/hash-ledger contracts ({match.group(0)!r})",
                        offset,
                    )


def check_contracts(root: Path, errors: list[dict[str, Any]], counts: dict[str, int]) -> None:
    shared = root / "shared"
    for name, expected_versions in sorted(CANONICAL_SCHEMA_VERSIONS.items()):
        path = shared / name
        if not path.is_file():
            issue(errors, "canonical_contract", path, "required canonical schema is missing")
            continue
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        actual_versions = schema_versions(document)
        if actual_versions != expected_versions:
            issue(
                errors,
                "schema_version",
                path,
                f"expected schema_version constants {sorted(expected_versions)}, found {sorted(actual_versions)}",
            )

    for name in ARCHIVED_AUDIT_SCHEMAS:
        if (shared / name).exists():
            issue(errors, "inactive_audit_contract", shared / name, "v2.1 audit schema must remain under compatibility/audit-v2.1")

    try:
        registry = json.loads((shared / "content-pattern-registry.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        issue(errors, "pattern_registry", shared / "content-pattern-registry.json", str(exc))
        registry = {}
    entry_ids = [item.get("id") for item in registry.get("canonical_content_entries", []) if isinstance(item, dict)]
    pattern_ids = [item.get("id") for item in registry.get("patterns", []) if isinstance(item, dict)]
    if entry_ids != CONTENT_ENTRIES:
        issue(errors, "pattern_registry", shared / "content-pattern-registry.json", f"entries must be {CONTENT_ENTRIES}")
    if pattern_ids != PATTERN_IDS:
        issue(errors, "pattern_registry", shared / "content-pattern-registry.json", "patterns must be P01-P16 once and in order")
    routing = registry.get("routing") if isinstance(registry.get("routing"), dict) else {}
    foundation = routing.get("foundation_start") if isinstance(routing.get("foundation_start"), dict) else {}
    if foundation.get("primary_patterns") != ["P14"] or foundation.get("secondary_patterns") not in ([], None):
        issue(errors, "pattern_registry", shared / "content-pattern-registry.json", "foundation_start must route only to P14")

    def load_schema(name: str) -> dict[str, Any]:
        try:
            value = json.loads((shared / name).read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    pack = load_schema("reference_pack.schema.json")
    pack_defs = pack.get("$defs", {}) if isinstance(pack.get("$defs"), dict) else {}
    v22 = pack_defs.get("v22", {}) if isinstance(pack_defs.get("v22"), dict) else {}
    v21 = pack_defs.get("v21Compatibility", {}) if isinstance(pack_defs.get("v21Compatibility"), dict) else {}
    if v22.get("properties", {}).get("profile", {}).get("const") != "frontmind-content-reference-pack-v2.2":
        issue(errors, "reference_pack_contract", shared / "reference_pack.schema.json", "canonical v2.2 profile is missing")
    if v21.get("properties", {}).get("profile", {}).get("const") != "frontmind-content-reference-pack-v2.1":
        issue(errors, "reference_pack_contract", shared / "reference_pack.schema.json", "v2.1 compatibility reader is missing")
    forbidden_pack = {"approval_receipt_path", "files", "input_fingerprints"} & set(v22.get("properties", {}))
    if forbidden_pack:
        issue(errors, "reference_pack_contract", shared / "reference_pack.schema.json", f"v2.2 Pack revives audit fields: {sorted(forbidden_pack)}")

    job = load_schema("content_job.schema.json")
    job_properties = job.get("properties", {}) if isinstance(job.get("properties"), dict) else {}
    forbidden_job = {
        "target_region", "target_audience", "time_scope", "scope_analysis_path",
        "e2_pattern_analysis_path", "staging_receipt_path", "runtime_registry_path",
    } & set(job_properties)
    if forbidden_job:
        issue(errors, "content_job_contract", shared / "content_job.schema.json", f"job exposes generated/audit inputs: {sorted(forbidden_job)}")

    blueprint = load_schema("article_blueprint.schema.json")
    blueprint_properties = blueprint.get("properties", {}) if isinstance(blueprint.get("properties"), dict) else {}
    forbidden_blueprint = {
        "title", "h1", "title_candidates", "pattern_decision_ref", "template_contract_ref",
        "template_component_decisions", "benchmark_component_decisions", "section_provenance",
        "required_component_coverage", "registry_sha256",
    } & set(blueprint_properties)
    if forbidden_blueprint:
        issue(errors, "article_blueprint_contract", shared / "article_blueprint.schema.json", f"blueprint revives audit/title fields: {sorted(forbidden_blueprint)}")
    if "selected_pattern_id" not in set(blueprint.get("required", [])) or "pattern_selection" not in set(blueprint.get("required", [])):
        issue(errors, "article_blueprint_contract", shared / "article_blueprint.schema.json", "selected pattern and concise selection reason must be required")

    model = load_schema("content_model.schema.json")
    model_properties = model.get("properties", {}) if isinstance(model.get("properties"), dict) else {}
    metadata = model_properties.get("metadata", {}).get("properties", {})
    forbidden_title = {"title", "h1", "title_candidates", "meta_description"} & (set(model_properties) | set(metadata))
    if forbidden_title:
        issue(errors, "content_model_contract", shared / "content_model.schema.json", f"title-free model contains {sorted(forbidden_title)}")

    e2 = load_schema("e2_pattern_analysis.schema.json")
    forbidden_e2 = {
        "source_workbook_receipt", "human_review_receipt_ref", "pattern_registry_ref",
        "pattern_research_index_ref", "retrieval_receipt",
    } & set(e2.get("properties", {}))
    if forbidden_e2:
        issue(errors, "e2_pattern_contract", shared / "e2_pattern_analysis.schema.json", f"E2 revives receipt/hash references: {sorted(forbidden_e2)}")

    title_map = load_schema("title_map.schema.json")
    title_properties = title_map.get("properties", {}) if isinstance(title_map.get("properties"), dict) else {}
    count_contract = title_properties.get("requested_count", {})
    if (count_contract.get("type"), count_contract.get("minimum"), count_contract.get("maximum")) != ("integer", 1, 20):
        issue(errors, "title_contract", shared / "title_map.schema.json", "requested_count must be an integer from 1 through 20")
    if "approved_body_sha256" in title_properties:
        issue(errors, "title_contract", shared / "title_map.schema.json", "Title Map must not bind a body hash")

    delivery = load_schema("delivery_index.schema.json")
    delivery_properties = delivery.get("properties", {}) if isinstance(delivery.get("properties"), dict) else {}
    if {"files", "sha256", "manifest_sha256", "content_model_sha256"} & set(delivery_properties):
        issue(errors, "delivery_contract", shared / "delivery_index.schema.json", "Delivery Index must remain a non-gating filename/purpose index")

    active_skills = [
        path for path in root.rglob("SKILL.md")
        if not is_archived(path) and not is_generated(path)
    ]
    if len(active_skills) != 20:
        issue(errors, "stage_sequence", root, f"expected 20 active Skills, found {len(active_skills)}")
    strategy_ids = sorted(path.parent.name.split(".", 1)[0] for path in active_skills if "Strategy_Workflow" in path.parts)
    execution_ids = sorted(path.parent.name.split(".", 1)[0] for path in active_skills if "Execution_Workflow" in path.parts)
    if strategy_ids != [f"S{index}" for index in range(1, 10)]:
        issue(errors, "stage_sequence", root / "Strategy_Workflow", f"active stages must be S1-S9, found {strategy_ids}")
    if execution_ids != ["E1", "E10", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"]:
        issue(errors, "stage_sequence", root / "Execution_Workflow", f"active stages must be E1-E10, found {execution_ids}")
    counts["canonical_schemas"] = len(CANONICAL_SCHEMA_VERSIONS)


def check_focused_suites(root: Path, errors: list[dict[str, Any]], counts: dict[str, int]) -> None:
    environment = os.environ.copy()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    for relative in FOCUSED_TEST_SUITES:
        path = root / relative
        if not path.is_file():
            issue(errors, "focused_test", path, "required active regression suite is missing")
            continue
        try:
            completed = subprocess.run(
                [sys.executable, "-B", str(path)],
                cwd=str(path.parent),
                env=environment,
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            issue(errors, "focused_test", path, f"suite could not complete: {exc}")
            continue
        counts["focused_test_suites"] += 1
        if completed.returncode != 0:
            output = (completed.stdout + "\n" + completed.stderr).strip()
            issue(errors, "focused_test", path, f"suite failed: {output[-4000:]}")


def validate(root: Path) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    counts = {
        "filesystem_entries": 0,
        "skills": 0,
        "json": 0,
        "python": 0,
        "active_markdown": 0,
        "canonical_schemas": 0,
        "focused_test_suites": 0,
        "archived_files_excluded": sum(1 for path in root.rglob("*") if path.is_file() and is_archived(path)),
    }
    check_hygiene(root, errors, counts)
    check_skill_frontmatter(root, errors, counts)
    check_json(root, errors, counts)
    check_python(root, errors, counts)
    check_active_docs(root, errors, counts)
    check_contracts(root, errors, counts)
    check_focused_suites(root, errors, counts)
    return {
        "status": "pass" if not errors else "fail",
        "root": str(root),
        "counts": counts,
        "error_count": len(errors),
        "warning_count": 0,
        "errors": errors,
        "warnings": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the active FrontMind Workflow v2.3 tree.")
    parser.add_argument("root", nargs="?", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = validate(Path(args.root).resolve())
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.report:
        args.report.write_text(rendered + "\n", encoding="utf-8")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
