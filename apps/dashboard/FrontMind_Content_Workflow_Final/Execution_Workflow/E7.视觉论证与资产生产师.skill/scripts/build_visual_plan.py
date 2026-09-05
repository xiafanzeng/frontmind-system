#!/usr/bin/env python3
"""Choose real assets first and prepare safe prompts for missing visual roles."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any


EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
sys.path.insert(0, str(SHARED))
from content_first_runtime import load_object, write_json  # noqa: E402
from schema_validation import validate_root, validate_schema  # noqa: E402


REAL_ONLY_KINDS = {
    "logo", "product", "team", "customer", "case", "certificate", "project_site",
    "medical_case", "real_event", "clinic", "facility",
}
GENERATABLE_ROLES = {"brand_editorial", "navigate", "explain"}


def safe_images(context: dict[str, Any]) -> list[dict[str, Any]]:
    """Merge the image registry with S6/E3 visual-role projections.

    ``images`` remains the source of truth for file, rights and credit metadata,
    while ``visual_assets`` carries the roles selected by the visual system.
    A projected asset may also be self-contained; accepting it here keeps E7
    compatible with lightweight Packs without rebuilding an audit registry.
    """
    merged: dict[str, dict[str, Any]] = {}
    for raw in context.get("images", []):
        if isinstance(raw, dict) and raw.get("image_id"):
            merged[str(raw["image_id"])] = dict(raw)
    for raw in context.get("visual_assets", []):
        if not isinstance(raw, dict) or not raw.get("image_id"):
            continue
        image_id = str(raw["image_id"])
        combined = dict(merged.get(image_id, {}))
        combined.update(raw)
        combined.setdefault("usage_status", "usable" if raw.get("usable_for") else "excluded")
        merged[image_id] = combined
    return [
        item for item in merged.values()
        if item.get("file_path") and item.get("usage_status") != "excluded"
        and item.get("rights_status") in {"approved", "approved_with_credit"}
        and (item.get("rights_status") != "approved_with_credit" or str(item.get("credit") or "").strip())
    ]


def choose_logo(images: list[dict[str, Any]]) -> str | None:
    item = next((value for value in images if str(value.get("asset_kind", "")).casefold() == "logo"), None)
    return str(item["image_id"]) if item else None


def choose_real_asset(role: str, images: list[dict[str, Any]], used: set[str]) -> dict[str, Any] | None:
    candidates = [item for item in images if str(item.get("image_id")) not in used]
    if role == "brand_editorial":
        order = ("brand_cover", "brand_image", "clinic", "facility", "product")
    elif role == "prove":
        order = ("certificate", "case", "project_site", "product", "facility", "team", "reference_image")
    else:
        order = ("diagram", "infographic", "reference_image")
    for kind in order:
        found = next((item for item in candidates if str(item.get("asset_kind", "")).casefold() == kind), None)
        if found:
            return found
    return None


def default_slots(model: dict[str, Any]) -> list[dict[str, Any]]:
    sections = [item for item in model.get("sections", []) if isinstance(item, dict)]
    slots: list[dict[str, Any]] = []
    if model.get("pattern_id") in {"P01", "P02", "P14"}:
        slots.append({
            "after_section_id": None, "role": "brand_editorial",
            "brief": "以品牌真实视觉语言建立封面氛围，不承担事实证明功能。",
        })
    if sections:
        slots.append({
            "after_section_id": sections[0].get("section_id"), "role": "explain",
            "brief": "用清晰的信息关系解释本节的选择标准或流程。",
        })
    return slots


def build(
    model: dict[str, Any], context: dict[str, Any], blueprint: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    result = copy.deepcopy(model)
    images = safe_images(context)
    logo_id = choose_logo(images)
    slots = [item for item in blueprint.get("visual_plan", []) if isinstance(item, dict)] or default_slots(model)
    section_facts = {
        str(item.get("section_id")): [str(value) for value in item.get("fact_ids", [])]
        for item in blueprint.get("sections", []) if isinstance(item, dict) and item.get("section_id")
    }
    placements: list[dict[str, Any]] = []
    prompt_images: list[dict[str, Any]] = []
    used: set[str] = set()
    for index, slot in enumerate(slots, 1):
        role = str(slot.get("role") or "explain")
        if role not in {"brand_editorial", "navigate", "explain", "prove"}:
            continue
        visual_id = f"vis_{index:02d}"
        after_section = slot.get("after_section_id")
        fact_ids = [
            str(value) for value in (
                slot.get("supports_fact_ids") or slot.get("fact_ids")
                or section_facts.get(str(after_section), [])
            )
        ]
        asset = choose_real_asset(role, images, used)
        if asset is not None:
            image_id = str(asset["image_id"])
            used.add(image_id)
            placements.append({
                "visual_id": visual_id, "after_section_id": after_section,
                "asset_id": image_id, "role": role,
                "alt_text": str(slot.get("alt_text") or asset.get("notes") or slot.get("brief") or "文章配图"),
                "supports_fact_ids": fact_ids if role == "prove" else [],
            })
            continue
        if role not in GENERATABLE_ROLES:
            continue
        prompt_images.append({
            "visual_id": visual_id, "role": role, "after_section_id": after_section,
            "alt_text": str(slot.get("alt_text") or slot.get("brief") or "文章解释图"),
            "supports_fact_ids": fact_ids if role == "explain" else [],
            "prompt_guidance": (
                f"为中文品牌文章制作一张{role}视觉。{slot.get('brief') or '清楚呈现章节关系。'}"
                "画面编辑感强、留白自然、信息层级清楚；不得把虚构画面表现为真实企业现场或证明材料。"
            ),
            "negative_constraints": [
                "不要生成、猜测或重绘Logo", "不要冒充真实产品、团队、客户、病例、证书或项目现场",
                "不要加入无法核对的数字、奖项、排名、疗效或认证", "不要使用密集小字和网页UI卡片拼贴",
            ],
            "logo_overlay_asset_id": logo_id,
        })
    result["visual_placements"] = placements
    plan = {"schema_version": "2.3.0", "job_id": model.get("job_id"), "images": prompt_images}
    return result, plan


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--working-context", type=Path, required=True)
    parser.add_argument("--blueprint", type=Path, required=True)
    parser.add_argument("--output-model", type=Path, required=True)
    parser.add_argument("--prompt-plan", type=Path, required=True)
    args = parser.parse_args()
    model, context, blueprint = load_object(args.model), load_object(args.working_context), load_object(args.blueprint)
    if len({model.get("job_id"), context.get("job_id"), blueprint.get("job_id")}) != 1:
        raise ValueError("E7 visual planning job_id mismatch")
    output, plan = build(model, context, blueprint)
    validate_root(output, "content_model.schema.json", "E7 planned Content Model")
    validate_schema(plan, Path(__file__).resolve().parents[1] / "templates" / "prompt_plan_schema.json",
                    "E7 prompt plan")
    write_json(args.output_model, output)
    write_json(args.prompt_plan, plan)
    print(json.dumps({
        "status": "completed", "real_placements": len(output["visual_placements"]),
        "generation_prompts": len(plan["images"]),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
