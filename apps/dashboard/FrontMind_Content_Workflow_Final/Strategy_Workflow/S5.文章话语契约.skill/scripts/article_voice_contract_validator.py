#!/usr/bin/env python3
"""Validate that the S5 voice contract is executable and evidence bounded."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def load(path: str) -> Any:
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        return json.load(handle)


def collect(payload: Any, key: str) -> set[str]:
    values: set[str] = set()
    if isinstance(payload, dict):
        for name, value in payload.items():
            if name == key:
                if isinstance(value, str):
                    values.add(value)
                elif isinstance(value, list):
                    values.update(str(item) for item in value)
            values.update(collect(value, key))
    elif isinstance(payload, list):
        for item in payload:
            values.update(collect(item, key))
    return values


def known_ids(payload: Any, keys: set[str]) -> set[str]:
    result: set[str] = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in keys and isinstance(value, str):
                result.add(value)
            result.update(known_ids(value, keys))
    elif isinstance(payload, list):
        for value in payload:
            result.update(known_ids(value, keys))
    return result


def pattern_contract(payload: Any) -> tuple[set[str], set[str]]:
    if not isinstance(payload, dict):
        return set(), set()
    patterns = {
        str(item["id"]) for item in payload.get("patterns", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    categories = {
        str(item["id"]) for item in payload.get("canonical_content_entries", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    return patterns, categories


def validate(payload: Any, proof_ids: set[str] | None, pattern_ids: set[str] | None, category_ids: set[str] | None) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["root must be an object"]
    if payload.get("schema_version") == "2.3.0":
        required = ("voice_mode", "editorial_position", "reader_experience", "style", "brand_messages", "publication_language", "comparison_style", "forbidden_public_phrases", "entry_overrides")
        for field in required:
            if field not in payload:
                errors.append(f"missing field: {field}")
        if payload.get("voice_mode") != "third_party_objective_reporting_plus_brand_promotion":
            errors.append("voice_mode must be third_party_objective_reporting_plus_brand_promotion")
        style = payload.get("style") or {}
        for field in ("perspective", "tone", "sentence_rhythm", "evidence_expression", "brand_expression"):
            if not style.get(field):
                errors.append(f"style.{field} is required")
        used_categories = {str(item.get("entry_category")) for item in payload.get("entry_overrides", []) if isinstance(item, dict)}
        if category_ids is not None and used_categories != category_ids:
            errors.append("entry_overrides must cover the shared content entries")
        return errors
    required = ["default_voice", "terminology", "messaging_house", "claim_expression_rules", "comparison_rules", "entry_tone_overrides", "system_prompt_fragment"]
    for field in required:
        if field not in payload:
            errors.append(f"missing field: {field}")
    if payload.get("schema_version") not in {"2.0.0", "2.2.0"}:
        errors.append("schema_version should be 2.0.0 or 2.2.0")
    if "category_tone_overrides" in payload:
        errors.append("legacy category_tone_overrides is forbidden; use entry_tone_overrides")

    voice = payload.get("default_voice") or {}
    if len(voice.get("observable_rules") or []) < 3:
        errors.append("default_voice needs at least three observable rules")
    if not voice.get("sentence_style") or not voice.get("explanation_style"):
        errors.append("default_voice needs sentence_style and explanation_style")

    terminology = payload.get("terminology") or {}
    for index, term in enumerate(terminology.get("avoid_terms") or []):
        if not isinstance(term, dict) or not term.get("term") or not term.get("reason"):
            errors.append(f"avoid_terms[{index}] needs term and reason")

    messaging = payload.get("messaging_house") or {}
    if not messaging.get("core_message"):
        errors.append("messaging_house.core_message is required")
    pillars = messaging.get("pillars") or []
    if not pillars:
        errors.append("messaging_house.pillars must not be empty")
    for index, pillar in enumerate(pillars):
        if not isinstance(pillar, dict) or not pillar.get("message"):
            errors.append(f"messaging_house.pillars[{index}] needs message")
            continue
        refs = set(pillar.get("proof_refs") or [])
        if not refs:
            errors.append(f"messaging_house.pillars[{index}] needs proof_refs")
        elif proof_ids is not None and refs - proof_ids:
            errors.append(f"messaging_house.pillars[{index}] has unknown proof refs: {sorted(refs - proof_ids)}")

    claim_rules = payload.get("claim_expression_rules") or {}
    canonical_states = ("public_fact", "public_with_qualification", "internal_only", "do_not_use")
    for state in canonical_states:
        rule = claim_rules.get(state)
        if not isinstance(rule, dict) or not rule.get("allowed") or not rule.get("forbidden"):
            errors.append(f"claim_expression_rules.{state} needs allowed and forbidden")
    legacy_states = {"approved_fact", "attributed_only", "needs_evidence", "blocked"} & set(claim_rules)
    if legacy_states:
        errors.append(f"legacy claim-expression states are forbidden: {sorted(legacy_states)}")

    comparison = payload.get("comparison_rules") or {}
    if comparison.get("named_competitors") in {"always_allowed", "always_forbidden"}:
        errors.append("comparison_rules must be evidence-conditional, not an absolute named-competitor rule")
    for field in ("named_comparison_conditions", "no_evidence_fallback"):
        if not comparison.get(field):
            errors.append(f"comparison_rules.{field} is required")

    if pattern_ids is not None:
        unknown = collect(payload, "pattern_refs") - pattern_ids
        if unknown:
            errors.append(f"unknown pattern refs: {sorted(unknown)}")
    overrides = payload.get("entry_tone_overrides") or []
    used_categories = {
        str(item.get("entry_category"))
        for item in overrides if isinstance(item, dict) and item.get("entry_category")
    }
    if category_ids is not None and used_categories != category_ids:
        errors.append(
            "entry_tone_overrides must cover each shared content entry exactly once; "
            f"missing={sorted(category_ids - used_categories)}, unknown={sorted(used_categories - category_ids)}"
        )
    if len(used_categories) != len(overrides):
        errors.append("entry_tone_overrides contains duplicate/blank entry_category")
    if len(str(payload.get("system_prompt_fragment") or "")) < 20:
        errors.append("system_prompt_fragment is too short")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate S5 article voice contract")
    parser.add_argument("contract_json")
    parser.add_argument("--architecture")
    parser.add_argument("--pattern-registry")
    args = parser.parse_args()
    payload = load(args.contract_json)
    proof_ids = known_ids(load(args.architecture), {"proof_id"}) if args.architecture else None
    pattern_ids: set[str] | None = None
    category_ids: set[str] | None = None
    if args.pattern_registry:
        pattern_ids, category_ids = pattern_contract(load(args.pattern_registry))
    warnings = validate(payload, proof_ids, pattern_ids, category_ids)
    errors: list[str] = []
    if not isinstance(payload, dict):
        errors.append("voice contract root must be an object")
    elif not any(payload.get(key) for key in ("default_voice", "messaging_house", "system_prompt_fragment", "voice_mode", "editorial_position")):
        errors.append("voice contract contains no usable writing guidance")
    print(json.dumps({"valid": not errors, "errors": errors, "warnings": warnings}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
