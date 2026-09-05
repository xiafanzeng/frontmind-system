#!/usr/bin/env python3
"""Validate a single-article job, Reference Pack, registries, and monitoring input."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from schema_validation import validate_root, validate_schema  # noqa: E402
from e2_pattern_contract import validate_e2_relations  # noqa: E402


ENTRY_CATEGORIES = {
    "industry_ranking", "competitor_comparison", "reputation", "product_scenario", "foundation_start",
}
PRODUCT_SUBINTENTS = {
    "offering_definition", "feature_mechanism", "scenario_fit", "delivery_usage", "support_boundary", "price_selection",
}
REGISTRY_PATHS = {
    "knowledge_registry_path": "knowledge_registry",
    "source_registry_path": "source_registry",
    "claim_registry_path": "claim_registry",
    "image_registry_path": "image_registry",
}


def normalized_question(value: object) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip()


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: dict[str, Any]) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def resolve_inside(root: Path, stored: str, errors: list[str], label: str) -> Path | None:
    candidate = Path(stored)
    if candidate.is_absolute() or ".." in candidate.parts or "\\" in stored:
        errors.append(f"{label}: path must be package-relative without traversal: {stored}")
        return None
    resolved = (root / candidate).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        errors.append(f"{label}: path escapes package root: {stored}")
        return None
    return resolved


def validate_job(job: dict[str, Any], errors: list[str]) -> None:
    if job.get("schema_version") != "2.1.0" or not str(job.get("job_id", "")).startswith("job_"):
        errors.append("content_job schema_version/job_id invalid")
    entry = job.get("entry_category")
    task = job.get("task") if isinstance(job.get("task"), dict) else {}
    if entry not in ENTRY_CATEGORIES:
        errors.append("content_job.entry_category must be one of the five canonical entries")
    subintent = task.get("product_scenario_subintent")
    if entry == "foundation_start":
        if (
            task.get("question_text") is not None
            or task.get("question_origin") != "foundation_derived"
            or not str(task.get("foundation_subject") or "").strip()
            or task.get("manual_foundation_selection") is not True
            or subintent is not None
            or job.get("monitoring_input_path") is not None
            or job.get("source_workbook_path") is not None
            or job.get("e2_pattern_analysis_path") is not None
        ):
            errors.append("foundation_start must be manual, question-free, monitoring/E2-source-free")
    else:
        if not 4 <= len(str(task.get("question_text") or "").strip()) <= 300:
            errors.append("ordinary entries require task.question_text with 4-300 Unicode characters")
        if task.get("question_text") != normalized_question(task.get("question_text")):
            errors.append("ordinary content_job.task.question_text is not canonical NFKC/whitespace text")
        if task.get("question_origin") != "external_confirmed" or task.get("manual_foundation_selection") is not False:
            errors.append("ordinary entries must be externally confirmed and not foundation-selected")
        if job.get("monitoring_input_path") is None:
            errors.append("ordinary entries require monitoring_input_path")
        if job.get("source_workbook_path") is None or job.get("e2_pattern_analysis_path") is None:
            errors.append("ordinary entries require source_workbook_path and e2_pattern_analysis_path")
        if job.get("source_workbook_path") != "01_monitoring/dashboard_source_workbook.xlsx":
            errors.append(
                "ordinary source_workbook_path must be "
                "01_monitoring/dashboard_source_workbook.xlsx"
            )
    if entry == "product_scenario" and subintent not in PRODUCT_SUBINTENTS:
        errors.append("product_scenario requires one canonical product_scenario_subintent before E2")
    if entry != "product_scenario" and subintent is not None:
        errors.append("non-product question requires null product_scenario_subintent")
    target = job.get("optimizer_target") if isinstance(job.get("optimizer_target"), dict) else {}
    if {"dataset", "engine_llm"} - set(target) or set(target) - {"dataset", "engine_llm", "extra_options"}:
        errors.append("content_job.optimizer_target fields do not match the root contract")
    if not str(target.get("dataset", "")).strip() or not str(target.get("engine_llm", "")).strip():
        errors.append("optimizer_target.dataset and engine_llm are required")
    if job.get("deliverables") != {"docx_body": True, "html_body_fragment": True, "title_map": True}:
        errors.append("deliverables must request title-free DOCX/HTML body plus a separate title map")
    if job.get("editorial_profile") != "third_party_objective_with_evidence_based_brand_promotion":
        errors.append("editorial_profile is not the canonical profile")
    constraints = job.get("user_constraints")
    if constraints is not None and (not isinstance(constraints, list) or any(not isinstance(value, str) or len(value) > 500 for value in constraints)):
        errors.append("content_job.user_constraints must be an array of strings up to 500 characters")


def validate_registry_links(
    registries: dict[str, dict[str, Any]], registry_paths: dict[str, Path],
    pack_root: Path, errors: list[str],
) -> None:
    sources = {item.get("source_id") for item in registries["source_registry"].get("sources", []) if isinstance(item, dict)}
    claims = registries["claim_registry"].get("claims", [])
    images = {item.get("asset_id"): item for item in registries["image_registry"].get("images", []) if isinstance(item, dict)}
    pack_file_records = {
        str(item.get("path")): item for item in registries.get("__pack_files__", {}).get("files", [])
        if isinstance(item, dict)
    }
    for claim in claims:
        if not isinstance(claim, dict):
            errors.append("claim_registry contains a non-object")
            continue
        for source_id in claim.get("source_ids", []):
            if source_id not in sources:
                errors.append(f"claim {claim.get('claim_id')} references unknown source {source_id}")
        original = claim.get("original_evidence")
        if isinstance(original, dict):
            for source_id in original.get("source_ids", []):
                if source_id not in sources:
                    errors.append(f"claim {claim.get('claim_id')} original_evidence references unknown source {source_id}")
            for record_ref in original.get("record_refs", []):
                ref_path = resolve_inside(pack_root, str(record_ref), errors, f"claim {claim.get('claim_id')}.original_evidence.record_refs")
                record = pack_file_records.get(str(record_ref))
                if not record:
                    errors.append(f"claim {claim.get('claim_id')} original_evidence record_ref is not a signed Pack file: {record_ref}")
                elif not ref_path or not ref_path.is_file() or sha256(ref_path) != record.get("sha256"):
                    errors.append(f"claim {claim.get('claim_id')} original_evidence record_ref missing/hash mismatch: {record_ref}")
    for asset_id, asset in images.items():
        for source_id in asset.get("source_ids", []):
            if source_id not in sources:
                errors.append(f"image {asset_id} references unknown source {source_id}")
        stored, expected = asset.get("file_path"), asset.get("sha256")
        if stored and expected:
            image_path = resolve_inside(pack_root, str(stored), errors, f"image_registry.images[{asset_id}].file_path")
            if not image_path or not image_path.is_file():
                errors.append(f"image {asset_id} file missing")
            elif sha256(image_path) != expected:
                errors.append(f"image {asset_id} SHA256 mismatch")
    for unit in registries["knowledge_registry"].get("knowledge_units", []):
        if not isinstance(unit, dict):
            continue
        unknown_sources = set(unit.get("source_ids", [])) - sources
        unknown_assets = set(unit.get("asset_ids", [])) - set(images)
        if unknown_sources:
            errors.append(f"knowledge {unit.get('knowledge_id')} references unknown sources {sorted(unknown_sources)}")
        if unknown_assets:
            errors.append(f"knowledge {unit.get('knowledge_id')} references unknown assets {sorted(unknown_assets)}")


def run_root_pack_validator(pack_path: Path, errors: list[str]) -> dict[str, Any]:
    """Run the workflow's canonical package validator; never maintain a second package contract here."""
    if pack_path.name != "reference_pack.json":
        errors.append("--reference-pack must point to the canonical reference_pack.json entrypoint")
        return {"status": "fail", "errors": ["invalid entrypoint"]}
    validator = Path(__file__).resolve().parents[3] / "shared" / "scripts" / "validate_package.py"
    if not validator.is_file():
        errors.append(f"canonical Reference Pack validator missing: {validator}")
        return {"status": "fail", "errors": ["validator missing"]}
    process = subprocess.run(
        [sys.executable, "-B", str(validator), str(pack_path.parent)],
        text=True, capture_output=True, check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    try:
        result = json.loads(process.stdout)
    except json.JSONDecodeError:
        errors.append(f"canonical Reference Pack validator emitted invalid JSON: {process.stderr or process.stdout}")
        return {"status": "fail", "errors": ["invalid validator output"]}
    if result.get("status") != "pass" or process.returncode != 0:
        errors.extend(f"reference_pack canonical validation: {item}" for item in result.get("errors", []))
    return result


def validate_pack(pack: dict[str, Any], pack_path: Path, job: dict[str, Any], errors: list[str]) -> tuple[dict[str, dict[str, Any]], dict[str, Path]]:
    if pack.get("schema_version") != "2.1.0" or pack.get("profile") != "frontmind-content-reference-pack-v2.1":
        errors.append("reference_pack schema_version/profile invalid")
    if pack.get("pack_id") != job.get("pack_id"):
        errors.append("content_job.pack_id does not match reference_pack.pack_id")
    root = pack_path.parent
    file_records = {item.get("path"): item for item in pack.get("files", []) if isinstance(item, dict)}
    for stored, record in file_records.items():
        path = resolve_inside(root, str(stored), errors, f"reference_pack.files[{stored}]")
        if path and (not path.is_file() or sha256(path) != record.get("sha256")):
            errors.append(f"reference_pack file missing/hash mismatch: {stored}")
    registries: dict[str, dict[str, Any]] = {}
    paths: dict[str, Path] = {}
    registry_mapping = pack.get("registries") if isinstance(pack.get("registries"), dict) else {}
    for path_key, registry_type in REGISTRY_PATHS.items():
        stored = registry_mapping.get(path_key)
        path = resolve_inside(root, str(stored or ""), errors, path_key)
        if not path or not path.is_file():
            errors.append(f"required registry missing: {path_key}")
            continue
        record = file_records.get(stored)
        if not record or record.get("role") != registry_type:
            errors.append(f"registry is missing matching file record/role: {stored}")
        value = load(path)
        if value.get("schema_version") != "2.0.0" or value.get("registry_type") != registry_type:
            errors.append(f"registry contract invalid: {stored}")
        registries[registry_type], paths[registry_type] = value, path
    for key in ("approval_receipt_path", "brand_facts_path"):
        stored = pack.get(key)
        path = resolve_inside(root, str(stored or ""), errors, key)
        if not path or not path.is_file() or stored not in file_records:
            errors.append(f"reference_pack required approved artifact missing: {key}")
    if set(registries) == set(REGISTRY_PATHS.values()):
        registries["__pack_files__"] = {"files": pack.get("files", [])}
        validate_registry_links(registries, paths, root, errors)
        registries.pop("__pack_files__", None)
    return registries, paths


def validate_monitoring(monitoring: dict[str, Any], monitoring_path: Path, package_root: Path,
                        job: dict[str, Any], errors: list[str]) -> None:
    if monitoring.get("schema_version") != "2.1.0" or monitoring.get("job_id") != job.get("job_id"):
        errors.append("monitoring_input schema_version/job_id invalid")
    if monitoring.get("question") != job.get("task", {}).get("question_text"):
        errors.append("monitoring_input.question differs from content_job.task.question_text")
    if monitoring.get("analysis_status") not in {"available", "partial"}:
        errors.append("monitoring_input.analysis_status invalid")
    answers, observations = monitoring.get("answers", []), monitoring.get("source_observations", [])
    if not isinstance(answers, list) or not answers or not isinstance(observations, list) or not observations:
        errors.append("monitoring_input requires at least one answer and one source observation")
    files = monitoring.get("input_files") if isinstance(monitoring.get("input_files"), dict) else {}
    for path_key, hash_key in (("answers_table_path", "answers_table_sha256"), ("sources_table_path", "sources_table_sha256")):
        stored = str(files.get(path_key) or "")
        path = resolve_inside(package_root, stored, errors, f"monitoring_input.{path_key}")
        if not path or not path.is_file() or sha256(path) != files.get(hash_key):
            errors.append(f"monitoring physical input missing/hash mismatch: {path_key}")
    derived = monitoring.get("derived") if isinstance(monitoring.get("derived"), dict) else {}
    answer_ids = {str(item.get("answer_id")) for item in answers if isinstance(item, dict)}
    excluded = {
        str(item.get("record_id")) for item in derived.get("excluded_observations", []) if isinstance(item, dict)
    }
    if not (answer_ids - excluded):
        errors.append("monitoring_input has no unexcluded answer for the exact question")
    landscape_ids = {
        str(item.get("answer_id")) for item in derived.get("answer_landscape", []) if isinstance(item, dict)
    }
    if not landscape_ids or landscape_ids - (answer_ids - excluded):
        errors.append("answer_landscape must reference one or more unexcluded answers only")
    for competitor in derived.get("competitors", []):
        if isinstance(competitor, dict):
            competitor_ids = {str(value) for value in competitor.get("answer_ids", [])}
            if not competitor_ids or competitor_ids - (answer_ids - excluded):
                errors.append(f"competitor references unknown/excluded answers: {competitor.get('name')}")
    stored_monitoring = str(job.get("monitoring_input_path") or "")
    expected = resolve_inside(package_root, stored_monitoring, errors, "content_job.monitoring_input_path")
    if expected and expected.resolve() != monitoring_path.resolve():
        errors.append("content_job.monitoring_input_path does not resolve to supplied monitoring file")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--content-job", type=Path, required=True)
    parser.add_argument("--reference-pack", type=Path, required=True)
    parser.add_argument("--scope-analysis", type=Path, required=True)
    parser.add_argument("--monitoring-input", type=Path,
                        help="required for ordinary four entries; forbidden for foundation_start")
    parser.add_argument("--source-workbook", type=Path,
                        help="staged Dashboard prefiltered single-question workbook; ordinary entries only")
    parser.add_argument("--e2-pattern-analysis", type=Path,
                        help="E2 v2.1 cited-content pattern analysis; ordinary entries only")
    parser.add_argument("--staging-receipt", type=Path, required=True)
    parser.add_argument("--source-zip", type=Path, required=True)
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    for path in (args.content_job, args.reference_pack, args.scope_analysis, args.staging_receipt, args.source_zip):
        if not path.is_file():
            raise FileNotFoundError(path)
    if args.monitoring_input is not None and not args.monitoring_input.is_file():
        raise FileNotFoundError(args.monitoring_input)
    if args.source_workbook is not None and not args.source_workbook.is_file():
        raise FileNotFoundError(args.source_workbook)
    if args.e2_pattern_analysis is not None and not args.e2_pattern_analysis.is_file():
        raise FileNotFoundError(args.e2_pattern_analysis)
    package_root = args.package_root.resolve()
    if not package_root.is_dir():
        raise FileNotFoundError(package_root)
    errors: list[str] = []
    for supplied, label in (
        (args.content_job, "--content-job"),
        (args.reference_pack, "--reference-pack"),
        (args.scope_analysis, "--scope-analysis"),
        (args.staging_receipt, "--staging-receipt"),
    ):
        try:
            supplied.resolve().relative_to(package_root)
        except ValueError:
            errors.append(f"{label} must be staged inside --package-root")
    if args.monitoring_input is not None:
        try:
            args.monitoring_input.resolve().relative_to(package_root)
        except ValueError:
            errors.append("--monitoring-input must be staged inside --package-root")
    for supplied, label in (
        (args.source_workbook, "--source-workbook"),
        (args.e2_pattern_analysis, "--e2-pattern-analysis"),
    ):
        if supplied is not None:
            try:
                supplied.resolve().relative_to(package_root)
            except ValueError:
                errors.append(f"{label} must be staged inside --package-root")
    job, pack, scope = load(args.content_job), load(args.reference_pack), load(args.scope_analysis)
    monitoring = load(args.monitoring_input) if args.monitoring_input is not None else None
    e2_pattern_analysis = load(args.e2_pattern_analysis) if args.e2_pattern_analysis is not None else None
    staging_receipt = load(args.staging_receipt)
    try:
        validate_schema(
            staging_receipt,
            Path(__file__).resolve().parents[2] / "E1.单篇任务建档师.skill" / "templates" / "staged_reference_pack.schema.json",
            "E1 staging receipt",
        )
    except ValueError as exc:
        errors.append(str(exc))
    expected_entrypoint = (package_root / str(staging_receipt.get("reference_pack_path") or "")).resolve()
    expected_staged_dir = (package_root / str(staging_receipt.get("staged_package_dir") or "")).resolve()
    if (
        staging_receipt.get("pack_id") != pack.get("pack_id")
        or staging_receipt.get("pack_version") != pack.get("version")
        or expected_staged_dir != args.reference_pack.parent.resolve()
        or expected_entrypoint != args.reference_pack.resolve()
        or staging_receipt.get("source_zip_file") != args.source_zip.name
        or staging_receipt.get("source_zip_sha256") != sha256(args.source_zip)
        or staging_receipt.get("canonical_pre_validation") != "pass"
        or staging_receipt.get("canonical_post_validation") != "pass"
    ):
        errors.append("staging receipt/ZIP/package root/reference_pack binding mismatch")
    for value, schema_name, label in (
        (job, "content_job.schema.json", "content_job"),
        (pack, "reference_pack.schema.json", "reference_pack"),
        (scope, "scope_analysis.schema.json", "scope_analysis"),
    ):
        try:
            validate_root(value, schema_name, label)
        except ValueError as exc:
            errors.append(str(exc))
    validate_job(job, errors)
    expected_scope = resolve_inside(package_root, str(job.get("scope_analysis_path") or ""), errors, "content_job.scope_analysis_path")
    if expected_scope is None or expected_scope != args.scope_analysis.resolve() or scope.get("job_id") != job.get("job_id"):
        errors.append("scope analysis path/job binding mismatch")
    canonical_pack_report = run_root_pack_validator(args.reference_pack, errors)
    registries, _ = validate_pack(pack, args.reference_pack, job, errors)
    if job.get("entry_category") == "foundation_start":
        if monitoring is not None:
            errors.append("foundation_start forbids --monitoring-input")
        if args.source_workbook is not None or e2_pattern_analysis is not None:
            errors.append("foundation_start forbids --source-workbook and --e2-pattern-analysis")
    elif monitoring is None or args.monitoring_input is None:
        errors.append("ordinary entries require --monitoring-input")
    else:
        try:
            validate_root(monitoring, "monitoring_input.schema.json", "monitoring_input")
        except ValueError as exc:
            errors.append(str(exc))
        validate_monitoring(monitoring, args.monitoring_input, package_root, job, errors)
    if job.get("entry_category") != "foundation_start" and (
        args.source_workbook is None or args.e2_pattern_analysis is None or e2_pattern_analysis is None
    ):
        errors.append("ordinary entries require --source-workbook and --e2-pattern-analysis")
    if args.source_workbook is not None:
        expected_source_workbook = resolve_inside(
            package_root, str(job.get("source_workbook_path") or ""), errors,
            "content_job.source_workbook_path",
        )
        if expected_source_workbook and expected_source_workbook != args.source_workbook.resolve():
            errors.append("content_job.source_workbook_path does not resolve to supplied workbook")
    if args.e2_pattern_analysis is not None:
        expected_e2 = resolve_inside(
            package_root, str(job.get("e2_pattern_analysis_path") or ""), errors,
            "content_job.e2_pattern_analysis_path",
        )
        if expected_e2 and expected_e2 != args.e2_pattern_analysis.resolve():
            errors.append("content_job.e2_pattern_analysis_path does not resolve to supplied E2 analysis")
    pattern_registry_path = resolve_inside(
        args.reference_pack.parent, str(pack.get("content_pattern_registry_path") or ""), errors,
        "reference_pack.content_pattern_registry_path",
    )
    pattern_registry_sha256 = None
    pattern_registry_canonical_sha256 = None
    if pattern_registry_path and pattern_registry_path.is_file():
        pattern_registry = load(pattern_registry_path)
        pattern_registry_sha256 = sha256(pattern_registry_path)
        pattern_registry_canonical_sha256 = canonical_sha256(pattern_registry)
        routing = pattern_registry.get("routing", {})
        entry = job.get("entry_category")
        if entry not in routing:
            errors.append(f"Pack pattern registry has no routing for entry_category={entry}")
        if entry == "foundation_start" and routing.get(entry) != {
            "primary_patterns": ["P14"], "secondary_patterns": [],
        }:
            errors.append("foundation_start must route exclusively to P14")
    pattern_research_index_path = resolve_inside(
        args.reference_pack.parent,
        str(pack.get("content_pattern_research_index_path") or ""), errors,
        "reference_pack.content_pattern_research_index_path",
    )
    pattern_research_index_sha256 = None
    if pattern_research_index_path and pattern_research_index_path.is_file():
        pattern_research_index_sha256 = sha256(pattern_research_index_path)

    e2_frozen_artifacts: dict[str, str] = {}
    if e2_pattern_analysis is not None and args.e2_pattern_analysis is not None:
        try:
            validate_root(e2_pattern_analysis, "e2_pattern_analysis.schema.json", "E2 pattern analysis")
        except ValueError as exc:
            errors.append(str(exc))
        task = job.get("task") if isinstance(job.get("task"), dict) else {}
        if (
            e2_pattern_analysis.get("job_id") != job.get("job_id")
            or e2_pattern_analysis.get("question") != task.get("question_text")
            or e2_pattern_analysis.get("entry_category") != job.get("entry_category")
            or e2_pattern_analysis.get("product_scenario_subintent") != task.get("product_scenario_subintent")
        ):
            errors.append("E2 pattern analysis job/question/entry/subintent differs from Content Job")
        if pattern_registry_path and pattern_research_index_path and args.source_workbook:
            relation_errors, e2_frozen_artifacts = validate_e2_relations(
                e2_pattern_analysis, package_root, pattern_registry_path,
                pattern_research_index_path, args.source_workbook,
            )
            errors.extend(f"E2 pattern analysis: {item}" for item in relation_errors)
    architecture_path = resolve_inside(
        args.reference_pack.parent,
        str((pack.get("writing_assets") or {}).get("information_evidence_architecture_path") or ""),
        errors,
        "reference_pack.writing_assets.information_evidence_architecture_path",
    )
    information_evidence_architecture_sha256 = None
    if architecture_path and architecture_path.is_file():
        architecture = load(architecture_path)
        try:
            validate_root(
                architecture, "information_evidence_architecture.schema.json",
                "Pack information/evidence architecture",
            )
        except ValueError as exc:
            errors.append(str(exc))
        record = next(
            (
                item for item in pack.get("files", [])
                if isinstance(item, dict) and item.get("path") == (
                    pack.get("writing_assets") or {}
                ).get("information_evidence_architecture_path")
            ),
            None,
        )
        if not record or record.get("role") != "information_evidence_architecture":
            errors.append("information/evidence architecture lacks its canonical signed file role")
        information_evidence_architecture_sha256 = canonical_sha256(architecture)
    report = {
        "schema_version": "2.1.0", "job_id": job.get("job_id"), "stage": "E3_intake",
        "status": "failed" if errors else "passed",
        "canonical_brand_name": (pack.get("brand") or {}).get("canonical_name"),
        "canonical_brand_aliases": (pack.get("brand") or {}).get("aliases", []),
        "checks": {
            "content_job": "passed" if not any("content_job" in item for item in errors) else "failed",
            "reference_pack": "passed" if not any("reference_pack" in item or "registry" in item for item in errors) else "failed",
            "scope_analysis": "passed" if not any("scope" in item for item in errors) else "failed",
            "monitoring_input": (
                "not_applicable" if job.get("entry_category") == "foundation_start"
                else "passed" if not any("monitoring" in item or "answer_landscape" in item for item in errors) else "failed"
            ),
            "e2_pattern_analysis": (
                "not_applicable" if job.get("entry_category") == "foundation_start"
                else "passed" if not any("E2 pattern" in item or "source_workbook" in item for item in errors)
                else "failed"
            ),
            "registry_types_loaded": sorted(registries),
            "canonical_reference_pack_validator": canonical_pack_report.get("status"),
        },
        "reference_pack_sha256": canonical_sha256(pack),
        "staging_receipt_sha256": canonical_sha256(staging_receipt),
        "content_pattern_registry_sha256": pattern_registry_sha256,
        "content_pattern_registry_canonical_sha256": pattern_registry_canonical_sha256,
        "pattern_research_index_sha256": pattern_research_index_sha256,
        "source_workbook_sha256": sha256(args.source_workbook) if args.source_workbook else None,
        "monitoring_input_sha256": canonical_sha256(monitoring) if monitoring else None,
        "monitoring_input_file_sha256": sha256(args.monitoring_input) if args.monitoring_input else None,
        "e2_pattern_analysis_sha256": sha256(args.e2_pattern_analysis) if args.e2_pattern_analysis else None,
        "e2_pattern_analysis_canonical_sha256": canonical_sha256(e2_pattern_analysis) if e2_pattern_analysis else None,
        "e2_frozen_artifact_sha256": e2_frozen_artifacts,
        "e2_retrieval_artifact_sha256": {
            path: digest for path, digest in e2_frozen_artifacts.items()
            if path != str(job.get("source_workbook_path") or "")
        },
        "information_evidence_architecture_sha256": information_evidence_architecture_sha256,
        "signed_pack_files": {
            str(item.get("path")): str(item.get("sha256"))
            for item in pack.get("files", []) if isinstance(item, dict)
        },
        "registry_sha256": {
            registry_type: canonical_sha256(value)
            for registry_type, value in sorted(registries.items())
        },
        "errors": errors,
        "warnings": [],
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
