#!/usr/bin/env python3
"""Shared v2.3 entry, P-pattern and recommendation candidate semantics."""

from __future__ import annotations

import unicodedata
from typing import Any


def normalized_name(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().casefold()


def allowed_patterns(registry: Any, entry: str) -> set[str]:
    if not isinstance(registry, dict):
        return set()
    route = (registry.get("routing") or {}).get(entry)
    if not isinstance(route, dict):
        return set()
    return set(route.get("primary_patterns") or []) | set(route.get("secondary_patterns") or [])


def _pattern_id(document: dict[str, Any]) -> Any:
    return document.get("selected_pattern_id", document.get("pattern_id"))


def validate_entry_pattern_route(document: Any, registry: Any) -> list[str]:
    if not isinstance(document, dict):
        return ["route document must be an object"]
    entry = document.get("entry_category")
    pattern_id = _pattern_id(document)
    subintent = document.get("product_scenario_subintent")
    errors: list[str] = []
    allowed = allowed_patterns(registry, str(entry or ""))
    if allowed and pattern_id not in allowed:
        errors.append(f"pattern {pattern_id!r} is not allowed for entry {entry!r}")
    if (entry == "foundation_start") != (pattern_id == "P14"):
        errors.append("foundation_start and P14 must be a strict two-way mapping")
    if pattern_id in {"P01", "P02"} and entry != "industry_ranking":
        errors.append(f"{pattern_id} is only available through industry_ranking")
    if entry == "product_scenario":
        route = (((registry or {}).get("routing") or {}).get("product_scenario") or {})
        subroutes = route.get("subintent_routing") or {}
        primary = set(route.get("primary_patterns") or [])
        if subintent in subroutes and pattern_id in primary and pattern_id not in set(subroutes.get(subintent) or []):
            errors.append(f"pattern {pattern_id!r} is not preferred for product subintent {subintent!r}")
    return errors


def validate_recommendation_candidate_contract(document: Any, canonical_brand: str | None = None) -> list[str]:
    if not isinstance(document, dict):
        return ["candidate document must be an object"]
    pattern_id = _pattern_id(document)
    contract = document.get("candidate_contract")
    if pattern_id not in {"P01", "P02"}:
        return [] if contract is None else ["non-P01/P02 document must not declare candidate_contract"]
    if not isinstance(contract, dict):
        return [f"{pattern_id} requires candidate_contract"]

    errors: list[str] = []
    featured_id = str(contract.get("featured_brand_entity_id") or "").strip()
    candidates = contract.get("ordered_candidates")
    dimensions = contract.get("common_dimensions")
    if not featured_id:
        errors.append("candidate_contract.featured_brand_entity_id is required")
    if not isinstance(candidates, list) or not candidates:
        return [*errors, "candidate_contract.ordered_candidates must contain at least one candidate"]
    names = [normalized_name(item.get("display_name")) for item in candidates if isinstance(item, dict)]
    ids = [str(item.get("entity_id") or "") for item in candidates if isinstance(item, dict)]
    if len(names) != len(candidates) or any(not value for value in names + ids):
        errors.append("every candidate requires entity_id and display_name")
    if len(names) != len(set(names)) or len(ids) != len(set(ids)):
        errors.append("candidate identities must be unique")
    if ids and ids[0] != featured_id:
        errors.append("the first candidate must be the featured brand")
    if canonical_brand and names and normalized_name(canonical_brand) != names[0]:
        errors.append("featured candidate does not match the canonical brand")
    if pattern_id == "P01":
        if len(candidates) != 1:
            errors.append("P01 requires exactly one candidate")
        if dimensions not in ([], None):
            errors.append("P01 must not declare competitor dimensions")
    else:
        if len(candidates) < 3:
            errors.append("P02 requires at least three real candidates; return to E2 for candidates or an explicit P01 choice")
        if not isinstance(dimensions, list) or not dimensions:
            errors.append("P02 requires common dimensions")
    return errors
