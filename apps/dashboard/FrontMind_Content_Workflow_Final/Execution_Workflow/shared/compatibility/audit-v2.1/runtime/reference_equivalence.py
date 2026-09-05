#!/usr/bin/env python3
"""Canonical visible-reference set gate for the execution workflow."""

from __future__ import annotations

from collections import Counter
from typing import Any


PUBLIC_ORIGINAL_AUTHORIZATIONS = {"public_approved", "anonymized_approved"}


def model_used_claim_ids(model: dict[str, Any]) -> set[str]:
    """Collect field-local claims that support visible article prose."""
    result: set[str] = set()
    lead = model.get("lead") or {}
    if isinstance(lead, dict):
        result.update(str(value) for value in lead.get("claim_ids", []) if str(value).strip())
    for section in model.get("sections", []):
        if not isinstance(section, dict):
            continue
        groups = [section.get("blocks", [])]
        groups.extend(
            subsection.get("blocks", [])
            for subsection in section.get("subsections", [])
            if isinstance(subsection, dict)
        )
        for blocks in groups:
            for block in blocks if isinstance(blocks, list) else []:
                if isinstance(block, dict):
                    result.update(str(value) for value in block.get("claim_ids", []) if str(value).strip())
    for item in model.get("faq", []):
        if isinstance(item, dict):
            result.update(str(value) for value in item.get("claim_ids", []) if str(value).strip())
    conclusion = model.get("conclusion") or {}
    if isinstance(conclusion, dict):
        result.update(str(value) for value in conclusion.get("claim_ids", []) if str(value).strip())
    return result


def reference_source_contract(model: dict[str, Any], claim_registry: dict[str, Any]) -> dict[str, Any]:
    """Return the exact expected/visible source sets and any invariant errors."""
    claims = {
        str(item.get("claim_id")): item
        for item in claim_registry.get("claims", [])
        if isinstance(item, dict) and str(item.get("claim_id", "")).strip()
    }
    used_claim_ids = model_used_claim_ids(model)
    expected_source_ids: set[str] = set()
    errors: list[str] = []
    for claim_id in sorted(used_claim_ids):
        claim = claims.get(claim_id)
        if not claim:
            continue
        claim_source_ids = {
            str(value) for value in claim.get("source_ids", []) if str(value).strip()
        }
        expected_source_ids.update(claim_source_ids)
        original = claim.get("original_evidence")
        if not isinstance(original, dict) or original.get("authorization_status") not in PUBLIC_ORIGINAL_AUTHORIZATIONS:
            continue
        original_source_ids = {
            str(value) for value in original.get("source_ids", []) if str(value).strip()
        }
        if not original_source_ids:
            errors.append(f"authorized_original_evidence_requires_visible_source_id:{claim_id}")
            continue
        hidden = sorted(original_source_ids - claim_source_ids)
        if hidden:
            errors.append(
                f"original_evidence_sources_must_be_claim_sources:{claim_id}:{','.join(hidden)}"
            )

    visible_list = [
        str(item.get("source_id"))
        for item in model.get("references", [])
        if isinstance(item, dict) and str(item.get("source_id", "")).strip()
    ]
    visible_source_ids = set(visible_list)
    duplicates = sorted(value for value, count in Counter(visible_list).items() if count > 1)
    if duplicates:
        errors.append(f"duplicate_visible_reference_source_ids:{','.join(duplicates)}")
    missing = sorted(expected_source_ids - visible_source_ids)
    if missing:
        errors.append(f"used_claim_sources_missing_from_visible_references:{','.join(missing)}")
    extra = sorted(visible_source_ids - expected_source_ids)
    if extra:
        errors.append(f"visible_references_not_used_by_article_claims:{','.join(extra)}")
    return {
        "used_claim_ids": sorted(used_claim_ids),
        "expected_source_ids": sorted(expected_source_ids),
        "visible_source_ids": sorted(visible_source_ids),
        "errors": errors,
        "valid": not errors,
    }


def reference_equivalence_errors(model: dict[str, Any], claim_registry: dict[str, Any]) -> list[str]:
    return list(reference_source_contract(model, claim_registry)["errors"])
