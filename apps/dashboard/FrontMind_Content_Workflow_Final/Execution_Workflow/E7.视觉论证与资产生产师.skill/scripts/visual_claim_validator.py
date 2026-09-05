#!/usr/bin/env python3
"""Filter unsafe/unavailable visuals without blocking the article."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
sys.path.insert(0, str(SHARED))
from content_first_runtime import (  # noqa: E402
    load_object, resolve_input_file, update_job_state, write_json,
)
from schema_validation import validate_root, validate_schema  # noqa: E402


FORBIDDEN_GENERATED_KINDS = {
    "logo", "product", "team", "customer", "case", "certificate", "project_site",
    "medical_case", "real_event",
}


def has_positive_dimensions(asset: dict[str, Any]) -> bool:
    width, height = asset.get("width"), asset.get("height")
    return isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0


def load_generated(path: Path | None) -> list[dict[str, Any]]:
    if path is None:
        return []
    value = load_object(path)
    validate_schema(
        value, Path(__file__).resolve().parents[1] / "templates" / "generated_assets.schema.json",
        "E7 generated assets",
    )
    images = value.get("images", [])
    if not isinstance(images, list):
        raise ValueError("generated assets must contain images[]")
    return [item for item in images if isinstance(item, dict)]


def actual_dimensions(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            return int(image.width), int(image.height)
    except Exception as exc:
        raise ValueError(f"image is unreadable: {exc}") from exc


def filter_visuals(
    model: dict[str, Any], context: dict[str, Any], asset_root: Path,
    generated: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, str]], list[str]]:
    result = copy.deepcopy(model)
    raw_facts = context.get("fact_cards") if isinstance(context.get("fact_cards"), list) else context.get("facts", [])
    facts = {
        str(item.get("fact_id")): item
        for item in raw_facts
        if isinstance(item, dict) and item.get("fact_id")
    }
    assets = {
        str(item.get("image_id")): dict(item, origin=item.get("origin", "uploaded"))
        for item in context.get("images", [])
        if isinstance(item, dict) and item.get("image_id")
    }
    for item in generated:
        image_id = str(item.get("image_id", ""))
        if image_id:
            assets[image_id] = dict(item, origin=item.get("origin", "generated"))
            visual_id = str(item.get("visual_id") or "")
            if visual_id and not any(
                isinstance(value, dict) and value.get("visual_id") == visual_id
                for value in result.get("visual_placements", [])
            ):
                result.setdefault("visual_placements", []).append({
                    "visual_id": visual_id,
                    "after_section_id": item.get("after_section_id"),
                    "asset_id": image_id,
                    "role": item.get("role"),
                    "alt_text": item.get("alt_text") or "文章配图",
                    "supports_fact_ids": item.get("supports_fact_ids", []),
                })
    kept: list[dict[str, Any]] = []
    used: list[dict[str, Any]] = []
    dropped: list[dict[str, str]] = []
    warnings: list[str] = []
    seen_assets: set[str] = set()
    seen_content: set[str] = set()
    for placement in result.get("visual_placements", []):
        if not isinstance(placement, dict):
            continue
        visual_id = str(placement.get("visual_id", "vis_unknown"))
        image_id = str(placement.get("asset_id", ""))
        asset = assets.get(image_id)
        reason = None
        if not asset:
            reason = "image is not present in working context or generated assets"
        elif asset.get("usage_status", "usable") == "excluded":
            reason = "image is excluded"
        elif asset.get("rights_status") not in {"approved", "approved_with_credit"}:
            reason = "image rights are not approved"
        elif asset.get("rights_status") == "approved_with_credit" and not str(
            asset.get("credit") or asset.get("attribution_text") or ""
        ).strip():
            reason = "image credit is required by its rights status"
        elif image_id in seen_assets:
            reason = "duplicate image placement"
        elif (asset.get("width") is not None or asset.get("height") is not None) and not has_positive_dimensions(asset):
            reason = "image dimensions are invalid"
        elif asset.get("origin") == "generated" and str(asset.get("asset_kind")) in FORBIDDEN_GENERATED_KINDS:
            reason = "generated image may not impersonate a real asset"
        elif str(asset.get("asset_kind")) == "logo" and asset.get("origin") == "generated":
            reason = "Logo may not be generated or redrawn"
        elif placement.get("role") == "prove" and asset.get("origin") == "generated":
            reason = "generated image may not act as proof"
        elif placement.get("role") == "prove":
            fact_ids = [str(value) for value in placement.get("supports_fact_ids", [])]
            if not fact_ids or any(
                value not in facts or facts[value].get("usage_status") == "excluded" for value in fact_ids
            ):
                reason = "prove visual lacks usable facts"
        if reason is None:
            try:
                file_path = resolve_input_file(asset_root, str(asset.get("file_path", "")))
                if not file_path.is_file():
                    reason = "image file is missing"
                else:
                    width, height = actual_dimensions(file_path)
                    if width < 320 or height < 180:
                        reason = "image dimensions are too small for publication"
                    digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
                    if digest in seen_content:
                        reason = "duplicate image content"
            except (OSError, ValueError) as exc:
                reason = f"unsafe or unreadable image path: {exc}"
        if reason is not None:
            dropped.append({"visual_id": visual_id, "reason": reason})
            warnings.append(f"visual_dropped:{visual_id}:{reason}")
            continue
        seen_assets.add(image_id)
        seen_content.add(digest)
        kept.append(placement)
        used.append({
            "visual_id": visual_id, "image_id": image_id,
            "file_path": str(file_path), "role": str(placement.get("role")),
            "rights_status": str(asset.get("rights_status")),
            "credit": asset.get("credit") or asset.get("attribution_text"),
            "width": width, "height": height,
        })
    result["visual_placements"] = kept
    return result, used, dropped, warnings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--working-context", type=Path, required=True)
    parser.add_argument("--asset-root", type=Path, required=True)
    parser.add_argument("--generated-assets", type=Path)
    parser.add_argument("--output-model", type=Path, required=True)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--job-state", type=Path)
    args = parser.parse_args()

    model, context = load_object(args.model), load_object(args.working_context)
    if model.get("job_id") != context.get("job_id"):
        raise ValueError("E7 job_id mismatch")
    filtered, used, dropped, warnings = filter_visuals(
        model, context, args.asset_root, load_generated(args.generated_assets),
    )
    validate_root(filtered, "content_model.schema.json", "E7 Content Model")
    status = "completed_with_limits" if dropped or (model.get("visual_placements") and not used) else "completed"
    selection = {
        "schema_version": "2.3.0", "job_id": filtered.get("job_id"), "stage": "E7",
        "status": status, "used": used, "dropped": dropped, "warnings": warnings,
    }
    validate_schema(
        selection, Path(__file__).resolve().parents[1] / "templates" / "visual_selection.schema.json",
        "E7 visual selection",
    )
    write_json(args.output_model, filtered)
    write_json(args.selection, selection)
    update_job_state(
        args.job_state, stage="E7", status=status, warnings=warnings,
        selected_pattern_id=str(filtered.get("pattern_id")),
    )
    print(json.dumps(selection, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
