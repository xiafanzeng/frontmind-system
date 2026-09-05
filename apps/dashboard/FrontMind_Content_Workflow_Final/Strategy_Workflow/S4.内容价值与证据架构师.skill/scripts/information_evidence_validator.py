#!/usr/bin/env python3
"""Validate S4 object references, root evidence states, and brand facts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


PUBLIC_USAGES = {"public_fact", "public_with_qualification"}
ALLOWED_USAGES = PUBLIC_USAGES | {"internal_only", "do_not_use"}
VERIFICATION = {"verified", "verified_with_limits", "needs_verification", "disallowed"}
PRECISIONS = {"exact", "claim", "branch", "document", "source", "none", "unknown"}
LEGACY_KEYS = {"publishability", "claim_refs", "source_refs", "knowledge_refs"}
RETIRED_KEYS = {"visibility_score", "citation_share", "bsas_score", "business_action_plan"}
PLACEHOLDER = re.compile(r"^(?:tbd|todo|unknown|待确认|待补充|未知)(?:\b|[：:])", re.IGNORECASE)


def load(path: str) -> Any:
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        return json.load(handle)


def scalar_ids(payload: Any, key_names: set[str]) -> set[str]:
    result: set[str] = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in key_names and isinstance(value, str):
                result.add(value)
            result.update(scalar_ids(value, key_names))
    elif isinstance(payload, list):
        for value in payload:
            result.update(scalar_ids(value, key_names))
    return result


def list_values(payload: Any, key_name: str) -> set[str]:
    result: set[str] = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key == key_name and isinstance(value, list):
                result.update(str(item) for item in value if isinstance(item, str))
            result.update(list_values(value, key_name))
    elif isinstance(payload, list):
        for value in payload:
            result.update(list_values(value, key_name))
    return result


def find_keys(payload: Any, targets: set[str], path: str = "") -> list[str]:
    hits: list[str] = []
    if isinstance(payload, dict):
        for key, value in payload.items():
            child = f"{path}.{key}" if path else key
            if key in targets:
                hits.append(child)
            hits.extend(find_keys(value, targets, child))
    elif isinstance(payload, list):
        for index, value in enumerate(payload):
            hits.extend(find_keys(value, targets, f"{path}[{index}]"))
    return hits


def registry_ids(payload: Any, array_key: str, id_key: str) -> set[str]:
    if not isinstance(payload, dict) or not isinstance(payload.get(array_key), list):
        return set()
    return {
        str(item[id_key])
        for item in payload[array_key]
        if isinstance(item, dict) and isinstance(item.get(id_key), str)
    }


def claim_source_contract(payload: Any) -> dict[str, set[str]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("claims"), list):
        return {}
    return {
        str(item["claim_id"]): {
            str(source_id) for source_id in item.get("source_ids", []) if isinstance(source_id, str)
        }
        for item in payload["claims"]
        if isinstance(item, dict) and isinstance(item.get("claim_id"), str)
    }


def source_contract(payload: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("sources"), list):
        return {}
    return {
        str(item["source_id"]): item
        for item in payload["sources"]
        if isinstance(item, dict) and isinstance(item.get("source_id"), str)
    }


def pattern_contract(payload: Any) -> tuple[set[str], set[str], dict[str, set[str]]]:
    if not isinstance(payload, dict):
        return set(), set(), {}
    patterns = {
        str(item["id"])
        for item in payload.get("patterns", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    categories = {
        str(item["id"])
        for item in payload.get("canonical_content_entries", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    routes: dict[str, set[str]] = {}
    for entry, route in (payload.get("routing") or {}).items():
        if isinstance(route, dict):
            routes[str(entry)] = set(route.get("primary_patterns") or []) | set(route.get("secondary_patterns") or [])
    return patterns, categories, routes


def validate_architecture(
    payload: Any,
    known_claims: set[str] | None,
    known_sources: set[str] | None,
    known_knowledge: set[str] | None,
    known_patterns: set[str] | None,
    known_categories: set[str] | None,
    category_pattern_routes: dict[str, set[str]] | None = None,
    claim_sources: dict[str, set[str]] | None = None,
    source_records: dict[str, dict[str, Any]] | None = None,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["root must be an object"]
    if payload.get("schema_version") == "2.3.0":
        required = ("positioning", "information_pillars", "differentiation_evidence_map", "proof_bundles", "brand_priority_angles", "comparison_boundary", "publication_boundary")
        for field in required:
            if field not in payload:
                errors.append(f"missing top-level field: {field}")
        positioning = payload.get("positioning") or {}
        for field in ("category_frame", "brand_role", "differentiated_value", "reasons_to_believe"):
            if not positioning.get(field):
                errors.append(f"positioning.{field} is required")
        proof_ids: set[str] = set()
        for index, bundle in enumerate(payload.get("proof_bundles") or []):
            label = f"proof_bundles[{index}]"
            if not isinstance(bundle, dict):
                errors.append(f"{label} must be an object")
                continue
            proof_id = str(bundle.get("proof_id") or "")
            if not proof_id or proof_id in proof_ids:
                errors.append(f"{label}.proof_id must be unique")
            proof_ids.add(proof_id)
            if not bundle.get("claim") or not bundle.get("claim_ids") or not bundle.get("source_ids") or not bundle.get("allowed_wording"):
                errors.append(f"{label} needs claim, claim_ids, source_ids, and allowed_wording")
        for index, angle in enumerate(payload.get("brand_priority_angles") or []):
            if not isinstance(angle, dict) or not angle.get("angle_id") or not angle.get("priority_message") or not angle.get("proof_refs"):
                errors.append(f"brand_priority_angles[{index}] is incomplete")
            elif set(angle.get("proof_refs") or []) - proof_ids:
                errors.append(f"brand_priority_angles[{index}] has unknown proof refs")
        return errors
    required = [
        "positioning_anchor", "audience_decision_contexts", "message_pillars",
        "value_structure", "differentiation_evidence_map", "brand_priority_angles", "proof_bundles", "claim_policy", "comparison_boundary",
        "entry_tone_guidance", "research_gaps",
    ]
    for key in required:
        if key not in payload:
            errors.append(f"missing top-level field: {key}")
    if payload.get("schema_version") != "2.1.0":
        errors.append("information/evidence architecture schema_version must be 2.1.0")

    legacy = find_keys(payload, LEGACY_KEYS)
    if legacy:
        errors.append(f"legacy reference/evidence fields are forbidden: {legacy}")
    retired = find_keys(payload, RETIRED_KEYS)
    if retired:
        errors.append(f"retired monitoring/scoring fields are forbidden: {retired}")

    anchor = payload.get("positioning_anchor") or {}
    for field in ("target_audience", "category_context", "brand_role", "differentiated_value", "reasons_to_believe"):
        if not anchor.get(field):
            errors.append(f"positioning_anchor.{field} is required")

    contexts = payload.get("audience_decision_contexts") or []
    if not contexts:
        errors.append("at least one audience decision context is required")
    context_ids: set[str] = set()
    for index, context in enumerate(contexts):
        label = f"audience_decision_contexts[{index}]"
        if not isinstance(context, dict):
            errors.append(f"{label} must be an object")
            continue
        context_id = str(context.get("context_id") or "")
        if not context_id or context_id in context_ids:
            errors.append(f"{label}.context_id must be non-empty and unique")
        context_ids.add(context_id)
        for field in ("role", "trigger", "job", "provenance_status"):
            if not context.get(field):
                errors.append(f"{label}.{field} is required")
        if len(context.get("decision_criteria") or []) < 2:
            errors.append(f"{label} needs at least two decision criteria")
        if context.get("provenance_status") not in {"validated", "client_asserted", "hypothesis"}:
            errors.append(f"{label}.provenance_status is invalid")
        if not (context.get("knowledge_ids") or context.get("source_ids")):
            errors.append(f"{label} must bind at least one knowledge_id or source_id")

    bundles = payload.get("proof_bundles") or []
    bundle_by_id: dict[str, dict[str, Any]] = {}
    for index, bundle in enumerate(bundles):
        label = f"proof_bundles[{index}]"
        if not isinstance(bundle, dict):
            errors.append(f"{label} must be an object")
            continue
        bundle_id = str(bundle.get("proof_id") or "")
        if not bundle_id or bundle_id in bundle_by_id:
            errors.append(f"{label}.proof_id must be non-empty and unique")
        bundle_by_id[bundle_id] = bundle
        claim_ids = bundle.get("claim_ids") or []
        source_ids = bundle.get("source_ids") or []
        verification = bundle.get("verification_status")
        usage = bundle.get("allowed_usage")
        precision = bundle.get("evidence_precision")
        if not claim_ids:
            errors.append(f"{label}.claim_ids must not be empty")
        if not source_ids:
            errors.append(f"{label}.source_ids must not be empty")
        if not str(bundle.get("statement") or "").strip():
            errors.append(f"{label}.statement is required")
        if claim_sources is not None:
            attached_sources = set().union(*(claim_sources.get(str(claim_id), set()) for claim_id in claim_ids)) if claim_ids else set()
            unattached = set(source_ids) - attached_sources
            if unattached:
                errors.append(f"{label}.source_ids are not attached to its claim_ids: {sorted(unattached)}")
            unsupported_claims = sorted(
                str(claim_id) for claim_id in claim_ids
                if not set(source_ids).intersection(claim_sources.get(str(claim_id), set()))
            )
            if unsupported_claims:
                errors.append(f"{label}.source_ids do not support referenced claims: {unsupported_claims}")
        if verification not in VERIFICATION:
            errors.append(f"{label}.verification_status is invalid")
        if usage not in ALLOWED_USAGES:
            errors.append(f"{label}.allowed_usage is invalid")
        if precision not in PRECISIONS:
            errors.append(f"{label}.evidence_precision is invalid")
        if usage == "public_fact" and (verification != "verified" or precision not in {"exact", "claim"}):
            errors.append(f"{label} public_fact requires verified exact/claim evidence")
        if usage == "public_with_qualification" and verification not in {"verified", "verified_with_limits"}:
            errors.append(f"{label} qualified public use requires verified evidence status")
        if usage in PUBLIC_USAGES and source_records is not None:
            non_publishable: list[str] = []
            for source_id in source_ids:
                source = source_records.get(str(source_id)) or {}
                if source.get("source_type") in {"first_party_official", "first_party_internal"} and source.get("publication_authorization") not in {
                    "public_approved", "anonymized_approved", "runtime_approved", "not_applicable",
                }:
                    non_publishable.append(str(source_id))
            if non_publishable:
                errors.append(f"{label} uses first-party sources without publication authorization: {sorted(non_publishable)}")
        wording = str(bundle.get("allowed_wording") or "").strip()
        if usage in PUBLIC_USAGES and not wording:
            errors.append(f"{label}.allowed_wording is required for public use")
        if usage not in PUBLIC_USAGES and wording:
            errors.append(f"{label}.allowed_wording must be blank for non-public evidence")
        if usage == "public_with_qualification" and not str(bundle.get("caveat") or "").strip():
            errors.append(f"{label}.caveat is required for public_with_qualification")
        if usage == "public_with_qualification" and not str(bundle.get("necessary_qualification") or "").strip():
            errors.append(f"{label}.necessary_qualification is required for public_with_qualification")
        applicable_patterns = set(bundle.get("applicable_patterns") or [])
        if not applicable_patterns:
            errors.append(f"{label}.applicable_patterns must not be empty")
        if known_patterns is not None and applicable_patterns - known_patterns:
            errors.append(f"{label} has unknown applicable patterns: {sorted(applicable_patterns - known_patterns)}")

    for index, pillar in enumerate(payload.get("message_pillars") or []):
        label = f"message_pillars[{index}]"
        if not isinstance(pillar, dict):
            errors.append(f"{label} must be an object")
            continue
        if not pillar.get("message"):
            errors.append(f"{label}.message is required")
        proof_refs = set(pillar.get("proof_refs") or [])
        if not proof_refs:
            errors.append(f"{label} must consume at least one proof bundle")
        unknown = proof_refs - set(bundle_by_id)
        if unknown:
            errors.append(f"{label} has unknown proof refs: {sorted(unknown)}")
        non_public = sorted(
            ref for ref in proof_refs
            if ref in bundle_by_id and bundle_by_id[ref].get("allowed_usage") not in PUBLIC_USAGES
        )
        if non_public:
            errors.append(f"{label} references non-public proof bundles: {non_public}")
        unknown_contexts = set(pillar.get("audience_context_refs") or []) - context_ids
        if unknown_contexts:
            errors.append(f"{label} has unknown audience context refs: {sorted(unknown_contexts)}")

    value_structure = payload.get("value_structure") or {}
    value_ids: set[str] = set()
    for layer in ("functional", "emotional", "self_expression"):
        values = value_structure.get(layer) if isinstance(value_structure, dict) else None
        if not isinstance(values, list):
            errors.append(f"value_structure.{layer} must be an array")
            continue
        if layer == "functional" and not values:
            errors.append("value_structure.functional needs at least one evidence-aware value")
        for index, item in enumerate(values):
            label = f"value_structure.{layer}[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{label} must be an object")
                continue
            value_id = str(item.get("value_id") or "")
            if not value_id or value_id in value_ids:
                errors.append(f"{label}.value_id must be non-empty and unique")
            value_ids.add(value_id)
            mode = item.get("expression_mode")
            proof_refs = set(item.get("proof_refs") or [])
            unknown_proofs = proof_refs - set(bundle_by_id)
            if unknown_proofs:
                errors.append(f"{label} has unknown proof refs: {sorted(unknown_proofs)}")
            unknown_contexts = set(item.get("audience_context_refs") or []) - context_ids
            if unknown_contexts:
                errors.append(f"{label} has unknown audience context refs: {sorted(unknown_contexts)}")
            if mode in {"evidence_backed", "attributed_brand_expression"} and not proof_refs:
                errors.append(f"{label} {mode} requires at least one proof ref")
            if mode == "evidence_backed":
                non_public = sorted(
                    ref for ref in proof_refs
                    if ref in bundle_by_id and bundle_by_id[ref].get("allowed_usage") not in PUBLIC_USAGES
                )
                if non_public:
                    errors.append(f"{label} evidence_backed uses non-public proof bundles: {non_public}")
            if mode == "research_hypothesis" and str(item.get("allowed_wording") or "").strip():
                errors.append(f"{label}.allowed_wording must be blank for a research hypothesis")

    differentiation_ids: set[str] = set()
    for index, item in enumerate(payload.get("differentiation_evidence_map") or []):
        label = f"differentiation_evidence_map[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        differentiation_id = str(item.get("differentiation_id") or "")
        if not differentiation_id or differentiation_id in differentiation_ids:
            errors.append(f"{label}.differentiation_id must be non-empty and unique")
        differentiation_ids.add(differentiation_id)
        proof_refs = set(item.get("proof_refs") or [])
        unknown_proofs = proof_refs - set(bundle_by_id)
        if unknown_proofs:
            errors.append(f"{label} has unknown proof refs: {sorted(unknown_proofs)}")
        unknown_contexts = set(item.get("audience_context_refs") or []) - context_ids
        if unknown_contexts:
            errors.append(f"{label} has unknown audience context refs: {sorted(unknown_contexts)}")
        state = item.get("evidence_state")
        wording = str(item.get("allowed_wording") or "").strip()
        direct_claims = set(item.get("claim_ids") or [])
        direct_sources = set(item.get("source_ids") or [])
        bundle_claims = set().union(*(
            set(bundle_by_id[ref].get("claim_ids") or []) for ref in proof_refs if ref in bundle_by_id
        )) if proof_refs else set()
        bundle_sources = set().union(*(
            set(bundle_by_id[ref].get("source_ids") or []) for ref in proof_refs if ref in bundle_by_id
        )) if proof_refs else set()
        if state in {"supported", "qualified"} and (direct_claims != bundle_claims or direct_sources != bundle_sources):
            errors.append(
                f"{label} claim_ids/source_ids must exactly match its proof bundles; "
                f"claims_missing={sorted(bundle_claims - direct_claims)}, claims_extra={sorted(direct_claims - bundle_claims)}, "
                f"sources_missing={sorted(bundle_sources - direct_sources)}, sources_extra={sorted(direct_sources - bundle_sources)}"
            )
        if claim_sources is not None:
            attached = set().union(*(claim_sources.get(claim_id, set()) for claim_id in direct_claims)) if direct_claims else set()
            unattached = direct_sources - attached
            if unattached:
                errors.append(f"{label}.source_ids are not attached to its claim_ids: {sorted(unattached)}")
        if state in {"supported", "qualified"} and not proof_refs:
            errors.append(f"{label} {state} differentiation requires proof refs")
        if state == "supported":
            non_public = sorted(
                ref for ref in proof_refs
                if ref in bundle_by_id and bundle_by_id[ref].get("allowed_usage") != "public_fact"
            )
            if non_public:
                errors.append(f"{label} supported differentiation requires public_fact proof bundles: {non_public}")
        if state == "qualified" and not wording:
            errors.append(f"{label}.allowed_wording is required for qualified differentiation")
        if state == "unsupported":
            if proof_refs or direct_claims or direct_sources or wording or item.get("comparison_allowed") is not False:
                errors.append(f"{label} unsupported differentiation cannot expose evidence/wording or allow comparison")
            if not str(item.get("evidence_gap") or "").strip():
                errors.append(f"{label}.evidence_gap is required for unsupported differentiation")
        if item.get("comparison_allowed") is True and state not in {"supported", "qualified"}:
            errors.append(f"{label}.comparison_allowed requires supported or qualified evidence")
        for field in ("dimension_definition", "brand_performance", "geographic_scope", "version_scope"):
            if not str(item.get(field) or "").strip():
                errors.append(f"{label}.{field} is required")
        if not item.get("applicability_conditions"):
            errors.append(f"{label}.applicability_conditions must not be empty")

    angle_ids: set[str] = set()
    for index, item in enumerate(payload.get("brand_priority_angles") or []):
        label = f"brand_priority_angles[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        angle_id = str(item.get("angle_id") or "")
        if not angle_id or angle_id in angle_ids:
            errors.append(f"{label}.angle_id must be non-empty and unique")
        angle_ids.add(angle_id)
        unknown_contexts = set(item.get("audience_context_refs") or []) - context_ids
        unknown_values = set(item.get("value_refs") or []) - value_ids
        unknown_differentiators = set(item.get("differentiation_refs") or []) - differentiation_ids
        unknown_proofs = set(item.get("proof_refs") or []) - set(bundle_by_id)
        unknown_entries = set(item.get("eligible_entry_categories") or []) - (known_categories or set(item.get("eligible_entry_categories") or []))
        unknown_patterns = set(item.get("eligible_pattern_ids") or []) - (known_patterns or set(item.get("eligible_pattern_ids") or []))
        if unknown_contexts:
            errors.append(f"{label} has unknown audience context refs: {sorted(unknown_contexts)}")
        if unknown_values:
            errors.append(f"{label} has unknown value refs: {sorted(unknown_values)}")
        if unknown_differentiators:
            errors.append(f"{label} has unknown differentiation refs: {sorted(unknown_differentiators)}")
        if unknown_proofs:
            errors.append(f"{label} has unknown proof refs: {sorted(unknown_proofs)}")
        if unknown_entries:
            errors.append(f"{label} has unknown eligible entry categories: {sorted(unknown_entries)}")
        if unknown_patterns:
            errors.append(f"{label} has unknown eligible pattern IDs: {sorted(unknown_patterns)}")
        if category_pattern_routes is not None:
            routed = set().union(*(
                category_pattern_routes.get(entry, set()) for entry in item.get("eligible_entry_categories", [])
            )) if item.get("eligible_entry_categories") else set()
            outside_routes = set(item.get("eligible_pattern_ids") or []) - routed
            if outside_routes:
                errors.append(f"{label} has pattern IDs outside eligible entry routing: {sorted(outside_routes)}")
        if not item.get("trigger_conditions"):
            errors.append(f"{label}.trigger_conditions must not be empty")

    if known_claims is not None:
        unknown = list_values(payload, "claim_ids") - known_claims
        if unknown:
            errors.append(f"unknown claim IDs: {sorted(unknown)}")
    if known_sources is not None:
        unknown = list_values(payload, "source_ids") - known_sources
        if unknown:
            errors.append(f"unknown source IDs: {sorted(unknown)}")
    if known_knowledge is not None:
        unknown = list_values(payload, "knowledge_ids") - known_knowledge
        if unknown:
            errors.append(f"unknown knowledge IDs: {sorted(unknown)}")
    if known_patterns is not None:
        unknown = list_values(payload, "pattern_refs") - known_patterns
        if unknown:
            errors.append(f"unknown pattern refs: {sorted(unknown)}")
    guidance = payload.get("entry_tone_guidance") or []
    used_categories = {
        str(item.get("entry_category"))
        for item in guidance if isinstance(item, dict) and item.get("entry_category")
    }
    if known_categories is not None and used_categories != known_categories:
        errors.append(
            "entry_tone_guidance must cover each shared content entry exactly once; "
            f"missing={sorted(known_categories - used_categories)}, unknown={sorted(used_categories - known_categories)}"
        )
    if len(used_categories) != len(guidance):
        errors.append("entry_tone_guidance contains duplicate/blank entry_category")
    if category_pattern_routes is not None:
        for index, item in enumerate(guidance):
            if not isinstance(item, dict):
                continue
            entry = str(item.get("entry_category") or "")
            outside_routes = set(item.get("pattern_refs") or []) - category_pattern_routes.get(entry, set())
            if outside_routes:
                errors.append(
                    f"entry_tone_guidance[{index}] has pattern refs outside {entry} routing: {sorted(outside_routes)}"
                )
    return errors


def validate_brand_facts(
    payload: Any,
    known_claims: set[str] | None,
    known_sources: set[str] | None,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["brand facts root must be an object"]
    if payload.get("schema_version") == "2.3.0":
        for field in ("brand_identity", "positioning", "offerings", "capabilities", "proof_points", "limitations"):
            if field not in payload:
                errors.append(f"brand facts missing field: {field}")
        identity = payload.get("brand_identity") or {}
        if not identity.get("canonical_name") or not identity.get("source_ids"):
            errors.append("brand_identity needs canonical_name and source_ids")
        if not isinstance(payload.get("offerings"), list) or not payload.get("offerings"):
            errors.append("brand facts offerings must contain usable facts")
        return errors
    required = {"brand_identity", "positioning", "offerings", "capabilities", "proof_points", "limitations"}
    missing = required - set(payload)
    if missing:
        errors.append(f"brand facts missing fields: {sorted(missing)}")
    if payload.get("schema_version") != "2.0.0":
        errors.append("brand facts schema_version must be 2.0.0")
    identity = payload.get("brand_identity") or {}
    positioning = payload.get("positioning") or {}
    if not identity.get("canonical_name") or not identity.get("source_ids"):
        errors.append("brand_identity needs canonical_name and source_ids")
    if not isinstance(identity.get("aliases"), list):
        errors.append("brand_identity.aliases must be an array")
    for field in ("category", "target_audiences", "value_proposition", "reasons_to_believe", "source_ids"):
        if not positioning.get(field):
            errors.append(f"positioning.{field} is required and cannot be a placeholder")

    arrays = {
        "offerings": ("offering_id", "off_", ("name", "offering_type", "definition", "fit", "limitations", "source_ids")),
        "capabilities": ("capability_id", "cap_", ("name", "description", "verification", "source_ids")),
        "proof_points": ("proof_id", "proof_", ("proof_type", "statement", "claim_ids", "source_ids")),
        "limitations": ("limitation_id", "lim_", ("statement", "applies_to", "source_ids")),
    }
    for array_name, (id_key, prefix, fields) in arrays.items():
        items = payload.get(array_name)
        if not isinstance(items, list):
            errors.append(f"brand facts {array_name} must be an array")
            continue
        seen: set[str] = set()
        for index, item in enumerate(items):
            label = f"brand facts {array_name}[{index}]"
            if not isinstance(item, dict):
                errors.append(f"{label} must be an object")
                continue
            identifier = str(item.get(id_key) or "")
            if not identifier.startswith(prefix) or identifier in seen:
                errors.append(f"{label}.{id_key} must be unique and start with {prefix}")
            seen.add(identifier)
            for field in fields:
                value = item.get(field)
                if field not in item or value is None or value == "":
                    errors.append(f"{label}.{field} is required")
            if not item.get("source_ids"):
                errors.append(f"{label}.source_ids must not be empty")
            if array_name == "proof_points" and not item.get("claim_ids"):
                errors.append(f"{label}.claim_ids must not be empty")

    for value in scalar_ids(payload, {"canonical_name", "category", "value_proposition", "name", "definition", "description", "statement"}):
        if PLACEHOLDER.search(value.strip()):
            errors.append(f"brand facts contains placeholder value: {value}")
    if known_sources is not None:
        unknown = list_values(payload, "source_ids") - known_sources
        if unknown:
            errors.append(f"brand facts has unknown source IDs: {sorted(unknown)}")
    if known_claims is not None:
        unknown = list_values(payload, "claim_ids") - known_claims
        if unknown:
            errors.append(f"brand facts has unknown claim IDs: {sorted(unknown)}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate S4 information/evidence architecture and canonical brand facts")
    parser.add_argument("architecture_json")
    parser.add_argument("--brand-facts", required=True)
    parser.add_argument("--knowledge-registry")
    parser.add_argument("--claim-registry")
    parser.add_argument("--source-registry")
    parser.add_argument("--pattern-registry")
    args = parser.parse_args()

    claim_registry = load(args.claim_registry) if args.claim_registry else None
    source_registry = load(args.source_registry) if args.source_registry else None
    known_claims = registry_ids(claim_registry, "claims", "claim_id") if claim_registry is not None else None
    known_sources = registry_ids(source_registry, "sources", "source_id") if source_registry is not None else None
    known_knowledge = registry_ids(load(args.knowledge_registry), "knowledge_units", "knowledge_id") if args.knowledge_registry else None
    known_patterns: set[str] | None = None
    known_categories: set[str] | None = None
    category_pattern_routes: dict[str, set[str]] | None = None
    if args.pattern_registry:
        known_patterns, known_categories, category_pattern_routes = pattern_contract(load(args.pattern_registry))

    architecture = load(args.architecture_json)
    brand_facts = load(args.brand_facts)
    warnings = validate_architecture(
        architecture, known_claims, known_sources, known_knowledge,
        known_patterns, known_categories,
        category_pattern_routes,
        claim_source_contract(claim_registry) if claim_registry is not None else None,
        source_contract(source_registry) if source_registry is not None else None,
    )
    warnings.extend(validate_brand_facts(brand_facts, known_claims, known_sources))
    errors: list[str] = []
    if not isinstance(architecture, dict):
        errors.append("architecture root must be an object")
    elif not any(architecture.get(key) for key in ("positioning_anchor", "message_pillars", "proof_bundles", "brand_priority_angles")):
        errors.append("architecture contains no usable positioning, message, proof, or priority-angle content")
    if not isinstance(brand_facts, dict):
        errors.append("brand facts root must be an object")
    print(json.dumps({"valid": not errors, "errors": errors, "warnings": warnings}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
