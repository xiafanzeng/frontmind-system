#!/usr/bin/env python3
"""Validate the v2.1 E4 pattern decision and article blueprint."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
EXEC_SHARED = Path(__file__).resolve().parents[2] / "shared"
ROOT_SHARED = Path(__file__).resolve().parents[3] / "shared"
sys.path.insert(0, str(EXEC_SHARED))
sys.path.insert(0, str(ROOT_SHARED))

from candidate_binding import blueprint_candidate_binding_errors  # noqa: E402
from content_route import validate_entry_pattern_route  # noqa: E402
from pattern_decision_binding import (  # noqa: E402
    validate_blueprint_decision_handoff,
    validate_blueprint_fusion,
    validate_pattern_decision,
)
from schema_validation import validate_root  # noqa: E402
from text_quality import question_key_tokens, substantive_text_errors  # noqa: E402
from registry_binding import validate_registry_binding  # noqa: E402


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _relative_to(root: Path, path: Path) -> str | None:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


def _file_ref_errors(ref: Any, path: Path, root: Path, label: str) -> list[str]:
    if not isinstance(ref, dict):
        return [f"{label} must be a fileRef"]
    relative = _relative_to(root, path)
    errors: list[str] = []
    if relative is None or ref.get("path") != relative:
        errors.append(f"{label}.path does not resolve to the supplied file inside job root")
    if ref.get("sha256") != file_sha256(path):
        errors.append(f"{label}.sha256 does not bind the supplied file bytes")
    return errors


def _frozen_e2_artifact_errors(
    intake: dict[str, Any], analysis: dict[str, Any] | None,
    analysis_path: Path | None, package_root: Path,
) -> list[str]:
    """Recheck E3's immutable E2 bytes without duplicating E2 semantics."""

    if analysis is None or analysis_path is None:
        return []
    errors: list[str] = []
    if (
        intake.get("e2_pattern_analysis_sha256") != file_sha256(analysis_path)
        or intake.get("e2_pattern_analysis_canonical_sha256") != canonical_sha256(analysis)
    ):
        errors.append("E3 intake does not freeze the supplied E2 pattern analysis bytes/object")
    frozen = intake.get("e2_frozen_artifact_sha256")
    if not isinstance(frozen, dict) or not frozen:
        return [*errors, "E3 intake lacks the frozen E2 source/retrieval/review artifact map"]
    root = package_root.resolve()
    for stored, expected in frozen.items():
        raw = str(stored or "")
        relative = Path(raw)
        if not raw or relative.is_absolute() or ".." in relative.parts or "\\" in raw:
            errors.append(f"E3 frozen E2 artifact path is unsafe: {raw!r}")
            continue
        artifact = (root / relative).resolve()
        try:
            artifact.relative_to(root)
        except ValueError:
            errors.append(f"E3 frozen E2 artifact escapes job root: {raw}")
            continue
        if not artifact.is_file() or file_sha256(artifact) != expected:
            errors.append(f"E3 frozen E2 artifact is missing or changed: {raw}")
    return errors


def _pattern(registry: dict[str, Any], pattern_id: str) -> dict[str, Any]:
    return next(
        (item for item in registry.get("patterns", []) if isinstance(item, dict) and item.get("id") == pattern_id),
        {},
    )


def _research_entry(index: dict[str, Any], pattern_id: str) -> dict[str, Any]:
    return next(
        (
            item for item in index.get("patterns", []) if isinstance(item, dict)
            and (item.get("canonical_pattern_id") or item.get("pattern_id")) == pattern_id
        ),
        {},
    )


def _classified(analysis: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not isinstance(analysis, dict):
        return {}
    return {
        str(item.get("observation_id")): item
        for item in analysis.get("content_observations", [])
        if isinstance(item, dict) and item.get("status") == "classified_article"
    }


def _valid_question_signal_ids(blueprint: dict[str, Any], analysis: dict[str, Any] | None) -> set[str]:
    contract = blueprint.get("question_contract") if isinstance(blueprint.get("question_contract"), dict) else {}
    result = {"primary_question"}
    for field, prefix in (
        ("necessary_subquestions", "necessary_subquestion"),
        ("misconceptions", "misconception"),
        ("decision_concerns", "decision_concern"),
        ("objections", "objection"),
        ("alternatives", "alternative"),
    ):
        result.update(f"{prefix}_{index:02d}" for index, _ in enumerate(contract.get(field, []), 1))
    for observation in _classified(analysis).values():
        classification = observation.get("classification") if isinstance(observation.get("classification"), dict) else {}
        result.update(str(value) for value in classification.get("matched_intent_signal_ids", []))
    return result


def _component_errors(
    blueprint: dict[str, Any], registry: dict[str, Any], research_index: dict[str, Any],
    decision: dict[str, Any], analysis: dict[str, Any] | None,
) -> list[str]:
    # The root helper is the sole authority for exact component coverage,
    # content-node provenance, adopted-element union, and structured rejection
    # coverage.  E4 only adds checks that need job-local question semantics or
    # the selected page's classified component vocabulary.
    errors: list[str] = list(validate_blueprint_fusion(
        blueprint, registry, research_index, decision, analysis,
    ))
    pattern_id = str(blueprint.get("pattern_id") or "")
    pattern = _pattern(registry, pattern_id)
    research_entry = _research_entry(research_index, pattern_id)
    if not research_entry or not isinstance(research_entry.get("design_contract"), dict):
        errors.append("selected pattern has no signed pattern-research design contract")

    components = {
        str(item.get("component_id")): item
        for item in pattern.get("structure_components", [])
        if isinstance(item, dict) and item.get("component_id")
    }
    decisions = blueprint.get("template_component_decisions", [])
    decision_by_id = {
        str(item.get("component_id")): item for item in decisions if isinstance(item, dict)
    }
    for component_id, component in components.items():
        item = decision_by_id.get(component_id, {})
        if item.get("disposition") == "merged":
            allowed = set(component.get("allowed_merge_targets", []))
            node_ids = set(item.get("content_node_ids", []))
            partners = {
                other_id for other_id, other in decision_by_id.items()
                if other_id != component_id and node_ids & set(other.get("content_node_ids", []))
            }
            if partners and not partners <= allowed:
                errors.append(f"template component merged with an unapproved partner: {component_id}:{sorted(partners - allowed)}")

    sections = [
        str(item.get("section_id")) for item in blueprint.get("section_plan", []) if isinstance(item, dict)
    ]
    content_nodes = {"lead", "faq", "conclusion", *sections}
    provenance = blueprint.get("section_provenance", [])
    valid_signals = _valid_question_signal_ids(blueprint, analysis)
    selected_observations = set(decision.get("selected_benchmark_observation_ids", []))
    for item in provenance:
        if not isinstance(item, dict):
            continue
        signals = set(item.get("question_signal_ids", []))
        if signals - valid_signals:
            errors.append(f"section provenance uses unknown question signals: {item.get('section_id')}:{sorted(signals - valid_signals)}")

    selected = _classified(analysis)
    benchmark_fusion = blueprint.get("benchmark_fusion") if isinstance(blueprint.get("benchmark_fusion"), dict) else {}
    fusion_decisions = benchmark_fusion.get("benchmark_decisions", [])
    fusion_by_id = {
        str(item.get("observation_id")): item for item in fusion_decisions if isinstance(item, dict)
    }
    adopted_ids = {
        key for key, item in fusion_by_id.items() if item.get("disposition") in {"adopted", "partially_adopted"}
    }
    benchmark_components = blueprint.get("benchmark_component_decisions", [])
    component_decision_observations = {
        str(item.get("observation_id")) for item in benchmark_components if isinstance(item, dict)
    }
    if component_decision_observations - adopted_ids:
        errors.append("benchmark components may only come from adopted or partially adopted benchmarks")
    for observation_id in adopted_ids:
        if observation_id not in component_decision_observations:
            errors.append(f"adopted benchmark lacks a component-to-content mapping: {observation_id}")
    for item in benchmark_components:
        if not isinstance(item, dict):
            continue
        observation_id = str(item.get("observation_id"))
        observation = selected.get(observation_id, {})
        classification = observation.get("classification") if isinstance(observation.get("classification"), dict) else {}
        matched = set(str(value) for value in classification.get("matched_structure_component_ids", []))
        component = str(item.get("adopted_component") or "")
        if component not in matched:
            errors.append(f"benchmark adopted_component was not classified from the snapshot: {observation_id}:{component}")
        if set(item.get("content_node_ids", [])) - content_nodes:
            errors.append(f"benchmark component maps to an unknown content node: {observation_id}")
    for observation_id, item in fusion_by_id.items():
        elements = set(item.get("adopted_elements", []))
        classification = selected.get(observation_id, {}).get("classification") or {}
        matched = set(str(value) for value in classification.get("matched_structure_component_ids", []))
        if elements - matched:
            errors.append(f"benchmark adopted_elements were not classified from the snapshot: {observation_id}")
    return errors


def validate(
    *, registry: dict[str, Any], registry_path: Path,
    research_index: dict[str, Any], research_index_path: Path,
    decision: dict[str, Any], decision_path: Path,
    blueprint: dict[str, Any], content_job: dict[str, Any],
    scope: dict[str, Any], scope_path: Path,
    analysis: dict[str, Any] | None, analysis_path: Path | None,
    monitoring: dict[str, Any] | None, monitoring_path: Path | None,
    claim_registry: dict[str, Any], source_registry: dict[str, Any],
    runtime_evidence_receipt: dict[str, Any],
    information_evidence: dict[str, Any], e3_intake: dict[str, Any],
    package_root: Path,
) -> dict[str, Any]:
    errors: list[str] = []
    for value, schema, label in (
        (blueprint, "article_blueprint.schema.json", "E4 article blueprint"),
        (content_job, "content_job.schema.json", "E1 Content Job"),
        (scope, "scope_analysis.schema.json", "E1 scope analysis"),
        (decision, "e4_pattern_decision.schema.json", "E4 pattern decision"),
        (claim_registry, "registries.schema.json", "E4 runtime claim registry"),
        (source_registry, "registries.schema.json", "E4 runtime source registry"),
    ):
        try:
            validate_root(value, schema, label)
        except ValueError as exc:
            errors.append(str(exc))
    try:
        validate_registry_binding(
            intake_report=e3_intake, job_id=content_job.get("job_id"),
            claim_registry=claim_registry, source_registry=source_registry,
            runtime_receipt=runtime_evidence_receipt,
        )
    except ValueError as exc:
        errors.append(f"runtime_registry_binding:{exc}")
    if analysis is not None:
        try:
            validate_root(analysis, "e2_pattern_analysis.schema.json", "E2 pattern analysis")
        except ValueError as exc:
            errors.append(str(exc))
    errors.extend(_frozen_e2_artifact_errors(e3_intake, analysis, analysis_path, package_root))
    if monitoring is not None:
        try:
            validate_root(monitoring, "monitoring_input.schema.json", "E2 monitoring input")
        except ValueError as exc:
            errors.append(str(exc))

    job_id = content_job.get("job_id")
    entry = content_job.get("entry_category")
    task = content_job.get("task") if isinstance(content_job.get("task"), dict) else {}
    pattern_id = str(blueprint.get("pattern_id") or "")
    if blueprint.get("job_id") != job_id or scope.get("job_id") != job_id:
        errors.append("job_id differs across Content Job, scope and blueprint")
    if blueprint.get("entry_category") != entry:
        errors.append("blueprint.entry_category differs from Content Job")
    if blueprint.get("question_origin") != task.get("question_origin"):
        errors.append("blueprint.question_origin differs from Content Job")
    if entry != "foundation_start" and blueprint.get("primary_question") != task.get("question_text"):
        errors.append("ordinary blueprint must preserve the externally confirmed question")
    if blueprint.get("question_contract", {}).get("primary_question") != blueprint.get("primary_question"):
        errors.append("question_contract.primary_question differs from blueprint.primary_question")
    scope_ref = blueprint.get("scope_analysis_ref", {})
    if scope_ref.get("path") != content_job.get("scope_analysis_path") or scope_ref.get("sha256") != file_sha256(scope_path):
        errors.append("scope_analysis_ref path/hash does not bind the supplied scope analysis")
    if scope.get("clarification", {}).get("status") == "required":
        errors.append("scope clarification remains unresolved")

    try:
        validate_root(information_evidence, "information_evidence_architecture.schema.json", "signed S4 information/evidence architecture")
    except ValueError as exc:
        errors.append(str(exc))
    if (
        e3_intake.get("schema_version") != "2.1.0"
        or e3_intake.get("job_id") != job_id
        or e3_intake.get("stage") != "E3_intake"
        or e3_intake.get("status") != "passed"
        or e3_intake.get("information_evidence_architecture_sha256") != canonical_sha256(information_evidence)
        or e3_intake.get("content_pattern_registry_sha256") != file_sha256(registry_path)
        or e3_intake.get("pattern_research_index_sha256") != file_sha256(research_index_path)
    ):
        errors.append("E3 intake does not approve the exact S4, Registry and pattern-research artifacts")

    errors.extend(validate_entry_pattern_route(blueprint, registry))
    errors.extend(validate_pattern_decision(
        decision=decision, content_job=content_job, analysis=analysis, analysis_path=analysis_path,
        registry=registry, registry_path=registry_path, research_index=research_index,
        research_index_path=research_index_path, package_root=package_root,
    ))
    errors.extend(validate_blueprint_decision_handoff(
        blueprint=blueprint, decision=decision, decision_path=decision_path,
        package_root=package_root,
    ))
    errors.extend(_file_ref_errors(blueprint.get("pattern_decision_ref"), decision_path, package_root, "pattern_decision_ref"))
    if pattern_id != decision.get("selected_pattern_id"):
        errors.append("blueprint.pattern_id differs from the E4 pattern decision")
    template_ref = blueprint.get("template_contract_ref") if isinstance(blueprint.get("template_contract_ref"), dict) else {}
    if (
        template_ref.get("pattern_id") != pattern_id
        or template_ref.get("research_entry_id") != pattern_id
        or template_ref.get("registry_sha256") != file_sha256(registry_path)
        or template_ref.get("research_index_sha256") != file_sha256(research_index_path)
    ):
        errors.append("template_contract_ref does not bind the selected signed Registry/research entry")

    errors.extend(blueprint_candidate_binding_errors(
        blueprint, e3_intake.get("canonical_brand_name"), monitoring,
        claim_registry, source_registry,
    ))
    if pattern_id == "P02" and not isinstance(blueprint.get("priority_angle"), dict):
        errors.append("P02 multi-brand editorial recommendation requires one S4 priority_angle")
    if pattern_id != "P02" and blueprint.get("priority_angle") is not None:
        errors.append("only P02 may set priority_angle")
    priority = blueprint.get("priority_angle")
    if isinstance(priority, dict):
        angles = {
            str(item.get("angle_id")): item for item in information_evidence.get("brand_priority_angles", [])
            if isinstance(item, dict)
        }
        selected = angles.get(str(priority.get("angle_id")))
        if not selected:
            errors.append("priority_angle.angle_id is absent from S4 brand_priority_angles")
        else:
            if priority.get("angle") != selected.get("angle"):
                errors.append("priority_angle.angle must equal the selected S4 angle")
            if entry not in set(selected.get("eligible_entry_categories", [])):
                errors.append("selected S4 priority angle is ineligible for this entry_category")
            if pattern_id not in set(selected.get("eligible_pattern_ids", [])):
                errors.append("selected S4 priority angle is ineligible for this P pattern")
            selected_proofs = set(str(value) for value in selected.get("proof_refs", []))
            blueprint_proofs = set(str(value) for value in priority.get("proof_bundle_ids", []))
            if not blueprint_proofs or not blueprint_proofs <= selected_proofs:
                errors.append("priority_angle proof bundles must be a non-empty subset of S4 proof_refs")
            proof_index = {
                str(item.get("proof_id")): item for item in information_evidence.get("proof_bundles", [])
                if isinstance(item, dict)
            }
            supported_claims = {
                str(claim_id) for proof_id in blueprint_proofs
                for claim_id in proof_index.get(proof_id, {}).get("claim_ids", [])
            }
            priority_claims = set(str(value) for value in priority.get("claim_ids", []))
            if not priority_claims or not priority_claims <= supported_claims:
                errors.append("priority_angle claim_ids must be a non-empty subset of its S4 proof bundles")

    fusion = blueprint.get("benchmark_fusion") if isinstance(blueprint.get("benchmark_fusion"), dict) else {}
    selected_ids = decision.get("selected_benchmark_observation_ids", [])
    if entry == "foundation_start":
        if monitoring is not None:
            errors.append("foundation_start must not consume monitoring input")
        if fusion.get("status") != "foundation_template_only" or any(
            fusion.get(key) is not None for key in ("monitoring_input_sha256", "e2_pattern_analysis_sha256")
        ):
            errors.append("foundation blueprint must use foundation_template_only with null runtime hashes")
    else:
        if not isinstance(monitoring, dict):
            errors.append("ordinary entries require the canonical single-question monitoring input")
        elif (
            monitoring.get("job_id") != job_id
            or monitoring.get("question") != blueprint.get("primary_question")
            or canonical_sha256(monitoring) != e3_intake.get("monitoring_input_sha256")
            or monitoring_path is None
            or _relative_to(package_root, monitoring_path) != content_job.get("monitoring_input_path")
        ):
            errors.append("monitoring input does not match the E3-frozen job/question/hash")
        if fusion.get("monitoring_input_sha256") != e3_intake.get("monitoring_input_sha256"):
            errors.append("benchmark_fusion monitoring hash differs from the E3 frozen input")
        if not analysis_path or fusion.get("e2_pattern_analysis_sha256") != file_sha256(analysis_path):
            errors.append("benchmark_fusion E2 analysis hash differs from supplied file")
        if decision.get("decision") == "template_fallback":
            if fusion.get("status") != "template_only" or selected_ids:
                errors.append("template_fallback must produce template_only fusion without runtime benchmarks")
        elif selected_ids and fusion.get("status") not in {"runtime_benchmarks", "partial_runtime_benchmarks"}:
            errors.append("selected runtime benchmarks require a runtime benchmark fusion status")
        elif not selected_ids and fusion.get("status") != "template_only":
            errors.append("zero selected benchmarks requires template_only fusion")
    if fusion.get("structure_finding_indexes") != []:
        errors.append("v2.1 E2 has no free-standing structure finding indexes; field must be empty")
    errors.extend(_component_errors(blueprint, registry, research_index, decision, analysis))

    direct = str(blueprint.get("lead_plan", {}).get("direct_answer_sentence") or "")
    errors.extend(substantive_text_errors(
        direct, label="lead_plan.direct_answer_sentence", minimum=30, ratio=0.55, minimum_unique=8,
    ))
    tokens = question_key_tokens(str(blueprint.get("primary_question") or ""))
    if not tokens or not any(token in direct.lower() for token in tokens):
        errors.append("lead direct answer must contain a primary-question/entity key token")
    section_ids = {
        str(item.get("section_id")) for item in blueprint.get("section_plan", []) if isinstance(item, dict)
    }
    entry_ids = set(blueprint.get("question_contract", {}).get("brand_intervention", {}).get("entry_section_ids", []))
    if not entry_ids or entry_ids - section_ids:
        errors.append("brand intervention must point to existing sections")
    claim_plan = set(blueprint.get("claim_plan", []))
    local_claims: set[str] = set(blueprint.get("lead_plan", {}).get("claim_ids", []))
    local_claims.update(blueprint.get("conclusion_plan", {}).get("claim_ids", []))
    if isinstance(priority, dict):
        local_claims.update(priority.get("claim_ids", []))
    local_claims.update(blueprint.get("question_contract", {}).get("brand_intervention", {}).get("supported_claim_ids", []))
    for item in blueprint.get("section_plan", []):
        if isinstance(item, dict):
            local_claims.update(item.get("claim_ids", []))
    for item in blueprint.get("faq_plan", []):
        if isinstance(item, dict):
            local_claims.update(item.get("claim_ids", []))
    if local_claims - claim_plan:
        errors.append(f"local blueprint claims absent from claim_plan: {sorted(local_claims - claim_plan)}")

    return {
        "schema_version": "2.1.0", "job_id": job_id, "stage": "E4_blueprint_validation",
        "valid": not errors, "entry_category": entry, "pattern_id": pattern_id,
        "blueprint_sha256": canonical_sha256(blueprint),
        "pattern_decision_sha256": file_sha256(decision_path),
        "e2_pattern_analysis_sha256": file_sha256(analysis_path) if analysis_path else None,
        "registry_sha256": file_sha256(registry_path),
        "pattern_research_index_sha256": file_sha256(research_index_path),
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate v2.1 E4 decision, signed template fusion and blueprint")
    parser.add_argument("--registry", type=Path, required=True, help="signed Pack content-pattern-registry.json")
    parser.add_argument("--pattern-research-index", type=Path, required=True, help="signed Pack pattern-research/index.json")
    parser.add_argument("--pattern-analysis", type=Path, help="required except foundation_start")
    parser.add_argument("--monitoring-input", type=Path, help="required except foundation_start")
    parser.add_argument("--claims", type=Path, required=True, help="E3-approved runtime claim registry")
    parser.add_argument("--sources", type=Path, required=True, help="E3-approved runtime source registry")
    parser.add_argument("--runtime-evidence-receipt", type=Path, required=True)
    parser.add_argument("--pattern-decision", type=Path, required=True)
    parser.add_argument("--blueprint", type=Path, required=True)
    parser.add_argument("--content-job", type=Path, required=True)
    parser.add_argument("--scope-analysis", type=Path, required=True)
    parser.add_argument("--information-evidence", type=Path, required=True)
    parser.add_argument("--e3-intake", type=Path, required=True)
    parser.add_argument("--job-package-root", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    analysis = load(args.pattern_analysis) if args.pattern_analysis else None
    monitoring = load(args.monitoring_input) if args.monitoring_input else None
    result = validate(
        registry=load(args.registry), registry_path=args.registry,
        research_index=load(args.pattern_research_index), research_index_path=args.pattern_research_index,
        decision=load(args.pattern_decision), decision_path=args.pattern_decision,
        blueprint=load(args.blueprint), content_job=load(args.content_job),
        scope=load(args.scope_analysis), scope_path=args.scope_analysis,
        analysis=analysis, analysis_path=args.pattern_analysis,
        monitoring=monitoring, monitoring_path=args.monitoring_input,
        claim_registry=load(args.claims), source_registry=load(args.sources),
        runtime_evidence_receipt=load(args.runtime_evidence_receipt),
        information_evidence=load(args.information_evidence), e3_intake=load(args.e3_intake),
        package_root=args.job_package_root,
    )
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered, encoding="utf-8")
    print(rendered)
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
