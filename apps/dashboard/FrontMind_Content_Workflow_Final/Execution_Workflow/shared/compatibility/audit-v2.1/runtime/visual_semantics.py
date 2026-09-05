#!/usr/bin/env python3
"""Canonical visual-role/asset/claim semantic compatibility checks.

This module deliberately distinguishes *identity proof* from product,
capability, case, event and data proof. A valid, rights-approved image is not
automatically evidence for every valid claim.
"""

from __future__ import annotations

from typing import Any


ROLE_COMPATIBILITY = {
    "brand_editorial": {"cover", "decorative"},
    "navigate": {"cover", "decorative"},
    "explain": {"comparison", "process_explanation", "data_evidence"},
    "prove": {"entity_proof", "product_proof", "case_proof", "event_proof", "data_evidence"},
}

ROLE_ARGUMENT_COMPATIBILITY = {
    "brand_editorial": {"navigate"},
    "navigate": {"navigate"},
    "explain": {"explain"},
    "prove": {"prove"},
}

PROOF_ASSET_ROLES = {"entity_proof", "product_proof", "case_proof", "event_proof", "data_evidence"}

ASSET_KIND_FOR_PROOF_ROLE = {
    "entity_proof": {"logo", "brand_image"},
    "product_proof": {"product"},
    "case_proof": {"case"},
    "event_proof": {"event"},
    "data_evidence": {"data_visual"},
}

CLAIM_TYPES_FOR_PROOF_ROLE = {
    # A Logo or corporate identity image proves identity/existence only. It
    # cannot prove capability, performance, reputation or commercial results.
    "entity_proof": {"identity"},
    "product_proof": {"product", "specification"},
    "case_proof": {"case_result"},
    "event_proof": {"event"},
    "data_evidence": {"price", "statistic", "comparison", "case_result", "reputation"},
}


def _source_ids(value: dict[str, Any]) -> set[str]:
    return {str(item) for item in value.get("source_ids", []) if str(item).strip()}


def _claim_ids_from_blocks(blocks: Any) -> set[str]:
    result: set[str] = set()
    for block in blocks if isinstance(blocks, list) else []:
        if isinstance(block, dict):
            result.update(str(value) for value in block.get("claim_ids", []))
    return result


def model_used_claim_ids(model: dict[str, Any]) -> set[str]:
    result = {str(value) for value in model.get("lead", {}).get("claim_ids", [])}
    for section in model.get("sections", []):
        if not isinstance(section, dict):
            continue
        result.update(_claim_ids_from_blocks(section.get("blocks")))
        for subsection in section.get("subsections", []):
            if isinstance(subsection, dict):
                result.update(_claim_ids_from_blocks(subsection.get("blocks")))
    for item in model.get("faq", []):
        if isinstance(item, dict):
            result.update(str(value) for value in item.get("claim_ids", []))
    result.update(str(value) for value in model.get("conclusion", {}).get("claim_ids", []))
    return result


def section_claim_ids(model: dict[str, Any], section_id: str) -> set[str]:
    section = next(
        (item for item in model.get("sections", []) if isinstance(item, dict) and str(item.get("section_id")) == section_id),
        None,
    )
    if not section:
        return set()
    result = _claim_ids_from_blocks(section.get("blocks"))
    for subsection in section.get("subsections", []):
        if isinstance(subsection, dict):
            result.update(_claim_ids_from_blocks(subsection.get("blocks")))
    return result


def visual_claim_relevance_errors(
    *, visual_id: str, role: str, argument: Any, after_section_id: Any,
    claim_ids: list[str], model: dict[str, Any], passed_claim_ids: set[str],
) -> list[str]:
    errors: list[str] = []
    bound = set(claim_ids)
    if bound - passed_claim_ids:
        errors.append(f"{visual_id}:supports_claim_not_passed_e2_5:{sorted(bound - passed_claim_ids)}")
    used = model_used_claim_ids(model)
    if bound - used:
        errors.append(f"{visual_id}:supports_claim_not_used_in_visible_model:{sorted(bound - used)}")
    if bound and role in {"explain", "prove"} and after_section_id is not None:
        adjacent = section_claim_ids(model, str(after_section_id))
        if not (bound & adjacent):
            errors.append(f"{visual_id}:supports_claim_not_bound_to_adjacent_section:{after_section_id}")
    return errors


def visual_semantic_errors(
    *, visual_id: str, role: str, argument: Any, asset: dict[str, Any], claim_ids: list[str],
    claims: dict[str, dict[str, Any]], known_source_ids: set[str] | None = None,
) -> list[str]:
    """Return deterministic semantic errors for one visual binding."""
    errors: list[str] = []
    argument_text = str(argument or "")
    if argument_text not in ROLE_ARGUMENT_COMPATIBILITY.get(role, set()):
        errors.append(f"{visual_id}:role_argument_function_mismatch:{role}:{argument_text}")
    if role == "prove" and not claim_ids:
        errors.append(f"{visual_id}:prove_visual_without_claim")
    if role in {"brand_editorial", "navigate"} and claim_ids:
        errors.append(f"{visual_id}:editorial_or_navigation_visual_must_not_bind_claims")

    allowed_roles = set(str(value) for value in asset.get("allowed_roles", []))
    compatible_asset_roles = allowed_roles & ROLE_COMPATIBILITY.get(role, set())
    if not compatible_asset_roles:
        errors.append(f"{visual_id}:asset_role_not_allowed")
        return errors

    source_kind = str(asset.get("source_kind", ""))
    asset_kind = str(asset.get("asset_kind", ""))
    if source_kind == "generated_explanatory" and allowed_roles & PROOF_ASSET_ROLES:
        errors.append(f"{visual_id}:generated_explanatory_declares_proof_role")
    if argument_text == "prove" and source_kind == "generated_explanatory":
        errors.append(f"{visual_id}:generated_explanatory_cannot_prove_real_fact")
    if source_kind == "generated_data_chart":
        asset_sources = _source_ids(asset)
        if not asset_sources:
            errors.append(f"{visual_id}:generated_data_chart_without_sources")
        if known_source_ids is not None and asset_sources - known_source_ids:
            errors.append(f"{visual_id}:generated_data_chart_unknown_sources:{sorted(asset_sources - known_source_ids)}")
        for claim_id in claim_ids:
            claim = claims.get(claim_id)
            if claim and not (asset_sources & _source_ids(claim)):
                errors.append(f"{visual_id}:generated_data_chart_claim_source_mismatch:{claim_id}")

    if argument_text != "prove":
        return errors

    # A proof visual must resolve to exactly one proof semantics family. This
    # prevents a registry record from self-declaring several incompatible proof
    # roles and then choosing the most permissive one at runtime.
    proof_roles = sorted(compatible_asset_roles & PROOF_ASSET_ROLES)
    if len(proof_roles) != 1:
        errors.append(f"{visual_id}:proof_asset_role_must_be_exactly_one:{proof_roles}")
        return errors
    proof_role = proof_roles[0]
    expected_kinds = ASSET_KIND_FOR_PROOF_ROLE[proof_role]
    if asset_kind not in expected_kinds:
        errors.append(f"{visual_id}:proof_asset_kind_mismatch:{proof_role}:{asset_kind}")

    permitted_claim_types = CLAIM_TYPES_FOR_PROOF_ROLE[proof_role]
    asset_sources = _source_ids(asset)
    for claim_id in claim_ids:
        claim = claims.get(claim_id)
        if not claim:
            continue
        claim_type = str(claim.get("claim_type", ""))
        if claim_type not in permitted_claim_types:
            errors.append(f"{visual_id}:proof_claim_type_mismatch:{proof_role}:{claim_id}:{claim_type}")
        # Entity/product/case/event/data proof must share a registered source
        # with the claim. A Logo identity claim is the only exception because a
        # first-party Logo file and an identity fact may be registered from two
        # separately signed first-party documents.
        if not (proof_role == "entity_proof" and asset_kind == "logo"):
            claim_sources = _source_ids(claim)
            if not asset_sources or not claim_sources or not (asset_sources & claim_sources):
                errors.append(f"{visual_id}:proof_source_mismatch:{proof_role}:{claim_id}")
    return errors
