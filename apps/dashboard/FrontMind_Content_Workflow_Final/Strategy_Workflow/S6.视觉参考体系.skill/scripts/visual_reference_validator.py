#!/usr/bin/env python3
"""Validate S6 visual references against asset rights and shared patterns."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def load(path: str) -> Any:
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        return json.load(handle)


def collect_ids(payload: Any, keys: set[str]) -> set[str]:
    result: set[str] = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in keys and isinstance(value, str):
                result.add(value)
            result.update(collect_ids(value, keys))
    elif isinstance(payload, list):
        for value in payload:
            result.update(collect_ids(value, keys))
    return result


def collect_list_values(payload: Any, key_name: str) -> set[str]:
    result: set[str] = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key == key_name and isinstance(value, list):
                result.update(str(item) for item in value)
            result.update(collect_list_values(value, key_name))
    elif isinstance(payload, list):
        for value in payload:
            result.update(collect_list_values(value, key_name))
    return result


def image_policy_map(registry: Any) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    items = registry.get("images", []) if isinstance(registry, dict) and registry.get("registry_type") == "image_registry" else []
    for item in items:
        if isinstance(item, dict) and item.get("asset_id"):
            result[str(item["asset_id"])] = item
    return result


def validate(payload: Any, image_policies: dict[str, dict[str, Any]] | None, pattern_ids: set[str] | None) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["root must be an object"]
    if payload.get("schema_version") == "2.3.0":
        for field in ("status", "delivery_mode", "asset_pool", "visual_roles", "brand_rules", "aigc_boundaries", "pattern_recipes"):
            if field not in payload:
                errors.append(f"missing field: {field}")
        roles = payload.get("visual_roles") or {}
        if set(roles) != {"brand_editorial", "navigate", "explain", "prove"}:
            errors.append("visual_roles must define brand_editorial, navigate, explain, and prove")
        if "禁止生成、猜测或重绘" not in str((payload.get("brand_rules") or {}).get("logo") or ""):
            errors.append("brand_rules.logo must prohibit generated or redrawn logos")
        for index, asset in enumerate(payload.get("asset_pool") or []):
            if not isinstance(asset, dict) or asset.get("rights_status") not in {"approved", "approved_with_credit"}:
                errors.append(f"asset_pool[{index}] lacks publishable rights")
        if pattern_ids is not None:
            unknown = {str(item.get("pattern_id")) for item in payload.get("pattern_recipes", []) if isinstance(item, dict)} - pattern_ids
            if unknown:
                errors.append(f"unknown pattern recipes: {sorted(unknown)}")
        return errors
    for field in ("brand_constraints", "asset_usage", "visual_language", "visual_patterns", "logo_policy", "accessibility"):
        if field not in payload:
            errors.append(f"missing field: {field}")
    if payload.get("schema_version") not in {"2.0.0", "2.2.0"}:
        errors.append("schema_version should be 2.0.0 or 2.2.0")

    usage = payload.get("asset_usage") or []
    usage_by_asset: dict[str, str] = {}
    for index, item in enumerate(usage):
        label = f"asset_usage[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label} must be an object")
            continue
        asset_ref = str(item.get("asset_ref") or "")
        mode = item.get("usage_mode")
        if not asset_ref:
            errors.append(f"{label}.asset_ref is required")
        if mode not in {"direct_use", "overlay_only", "reference_only", "blocked"}:
            errors.append(f"{label}.usage_mode is invalid")
        usage_by_asset[asset_ref] = str(mode)
        if image_policies is not None:
            if asset_ref not in image_policies:
                errors.append(f"{label} references unknown asset: {asset_ref}")
            elif mode in {"direct_use", "overlay_only"} and image_policies[asset_ref].get("rights_status") not in {"approved", "approved_with_credit"}:
                errors.append(
                    f"{label} cannot {mode} asset with rights_status="
                    f"{image_policies[asset_ref].get('rights_status')}"
                )
            elif (
                mode in {"direct_use", "overlay_only"}
                and image_policies[asset_ref].get("rights_status") == "approved_with_credit"
                and not str(image_policies[asset_ref].get("attribution_text") or "").strip()
            ):
                errors.append(f"{label} uses approved_with_credit asset without attribution_text")

    logo_policy = payload.get("logo_policy") or {}
    if logo_policy.get("mode") != "overlay_real_asset":
        errors.append("logo_policy.mode must be overlay_real_asset")
    if logo_policy.get("generation_rule") != "never_generate_or_redraw_logo":
        errors.append("logo_policy.generation_rule must be the canonical never_generate_or_redraw_logo policy")
    logo_refs = set((payload.get("brand_constraints") or {}).get("logo_asset_refs") or [])
    for asset_ref in logo_refs:
        if usage_by_asset.get(asset_ref) != "overlay_only":
            errors.append(f"logo asset must use overlay_only: {asset_ref}")
        if image_policies is not None:
            image = image_policies.get(asset_ref)
            if image is None:
                errors.append(f"logo policy references unknown asset: {asset_ref}")
                continue
            if image.get("rights_status") not in {"approved", "approved_with_credit"}:
                errors.append(f"logo asset lacks publishable rights: {asset_ref}")
            if image.get("asset_kind") != "logo":
                errors.append(f"logo asset must have canonical asset_kind=logo: {asset_ref}")
            if "entity_proof" not in set(image.get("allowed_roles") or []):
                errors.append(f"logo asset must allow entity_proof: {asset_ref}")

    seen_patterns: set[str] = set()
    for index, visual in enumerate(payload.get("visual_patterns") or []):
        label = f"visual_patterns[{index}]"
        if not isinstance(visual, dict):
            errors.append(f"{label} must be an object")
            continue
        visual_id = str(visual.get("visual_pattern_id") or "")
        if not visual_id or visual_id in seen_patterns:
            errors.append(f"{label}.visual_pattern_id must be non-empty and unique")
        seen_patterns.add(visual_id)
        if not visual.get("message_refs"):
            errors.append(f"{label}.message_refs must not be empty")
        if not visual.get("slots"):
            errors.append(f"{label}.slots must not be empty")
        if not visual.get("quality_gates"):
            errors.append(f"{label}.quality_gates must not be empty")
        prompt_text = json.dumps(visual.get("prompt_scaffold") or {}, ensure_ascii=False).lower()
        if any(token in prompt_text for token in ("generate logo", "render logo", "生成logo", "重绘logo")):
            errors.append(f"{label}.prompt_scaffold attempts to generate a logo")
        if pattern_ids is not None:
            unknown = set(visual.get("pattern_refs") or []) - pattern_ids
            if unknown:
                errors.append(f"{label} has unknown pattern refs: {sorted(unknown)}")

    accessibility = payload.get("accessibility") or {}
    for field in ("alt_template", "caption_rule", "contrast_rule"):
        if not accessibility.get(field):
            errors.append(f"accessibility.{field} is required")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate S6 visual reference system")
    parser.add_argument("visual_json")
    parser.add_argument("--image-registry")
    parser.add_argument("--pattern-registry")
    args = parser.parse_args()
    payload = load(args.visual_json)
    image_policies = image_policy_map(load(args.image_registry)) if args.image_registry else None
    pattern_ids = None
    if args.pattern_registry:
        registry = load(args.pattern_registry)
        pattern_ids = collect_ids(registry.get("patterns") or [], {"id"}) if isinstance(registry, dict) else set()
    warnings = validate(payload, image_policies, pattern_ids)
    errors = [] if isinstance(payload, dict) else ["visual reference root must be an object"]
    print(json.dumps({"valid": not errors, "errors": errors, "warnings": warnings, "usable_visuals_optional": True}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
