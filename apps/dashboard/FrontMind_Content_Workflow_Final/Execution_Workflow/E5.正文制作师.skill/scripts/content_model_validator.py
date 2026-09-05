#!/usr/bin/env python3
"""Normalize the v2.3 title-free article without forcing a house cadence."""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path
from typing import Any


EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
sys.path.insert(0, str(SHARED))
from content_first_runtime import (  # noqa: E402
    iter_public_containers, load_object, refresh_references, title_field_paths,
    update_job_state, visible_text, write_json,
)
from schema_validation import validate_root, validate_schema  # noqa: E402
from text_quality import article_specificity_errors, material_fact_binding_errors  # noqa: E402


INTERNAL_PHRASES = (
    "资料较完整", "相关资料显示", "以审核为准", "服务边界", "信息边界", "保持克制",
    "用户提交资料", "待核验候选", "当前团队与产品待核验", "当前医师与产品待核验",
    "当前可公开资料不足", "资料粒度不同", "预研模板", "内部审稿",
)


def normalize_text(value: Any) -> str:
    text = " ".join(str(value or "").split()).strip()
    if re.search(r"[\u3400-\u9fff]", text):
        text = text.replace(",", "，").replace(";", "；").replace(":", "：").replace("?", "？")
    return re.sub(r"\s+([，。；：！？])", r"\1", text)


def normalize(model: dict[str, Any], context: dict[str, Any]) -> tuple[dict[str, Any], list[str], list[str]]:
    result = copy.deepcopy(model)
    repairs: list[str] = []
    warnings: list[str] = []
    for field in ("title", "h1", "title_candidates", "meta_description", "warnings"):
        if field in result:
            del result[field]
            repairs.append(f"removed_top_level_{field}")
    result["schema_version"] = "2.3.0"
    lead = result.get("lead") if isinstance(result.get("lead"), dict) else {}
    if lead:
        lead["text"] = normalize_text(lead.get("text"))
    for section in result.get("sections", []):
        if not isinstance(section, dict):
            continue
        section["heading"] = normalize_text(section.get("heading")).rstrip("？?")
        for item in section.get("paragraphs", []):
            if isinstance(item, dict):
                item["text"] = normalize_text(item.get("text"))
    for item in result.get("faq", []):
        if not isinstance(item, dict):
            continue
        question = normalize_text(item.get("question"))
        item["question"] = question if question.endswith("？") else question + "？"
        item["answer"] = normalize_text(item.get("answer"))
    conclusion = result.get("conclusion") if isinstance(result.get("conclusion"), dict) else {}
    for item in conclusion.get("paragraphs", []):
        if isinstance(item, dict):
            item["text"] = normalize_text(item.get("text"))

    facts = {
        str(item.get("fact_id")): item
        for item in (context.get("fact_cards") if isinstance(context.get("fact_cards"), list) else context.get("facts", []))
        if isinstance(item, dict) and item.get("fact_id")
    }
    for location, container in iter_public_containers(result):
        ids = container.get("fact_ids", [])
        unknown = [str(value) for value in ids if str(value) not in facts]
        excluded = [str(value) for value in ids if facts.get(str(value), {}).get("usage_status") == "excluded"]
        if unknown:
            warnings.append(f"unknown_fact_reference:{location}:{','.join(unknown)}")
        if excluded:
            warnings.append(f"excluded_fact_reference:{location}:{','.join(excluded)}")

    reference_repairs, reference_warnings = refresh_references(result, context)
    repairs.extend(reference_repairs)
    warnings.extend(reference_warnings)
    body = visible_text(result)
    for phrase in INTERNAL_PHRASES:
        if phrase in body:
            warnings.append(f"publication_language_requires_E8_rewrite:{phrase}")
    lead_length = len(re.sub(r"\s+", "", str(lead.get("text") or "")))
    if not 180 <= lead_length <= 320:
        warnings.append(f"soft_target:lead_length={lead_length},preferred=200..300")
    if not 5 <= len(result.get("sections", [])) <= 8:
        warnings.append(f"soft_target:section_count={len(result.get('sections', []))},preferred=5..8")
    if not 5 <= len(result.get("faq", [])) <= 8:
        warnings.append(f"soft_target:faq_count={len(result.get('faq', []))},preferred=5..8")
    warnings.extend(f"automatic_rewrite_target:{item}" for item in article_specificity_errors(result))
    warnings.extend(f"automatic_rewrite_target:{item}" for item in material_fact_binding_errors(result, context))
    result["content_status"] = "draft"
    return result, list(dict.fromkeys(repairs)), list(dict.fromkeys(warnings))


def identity_errors(model: dict[str, Any], context: dict[str, Any], blueprint: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for field in ("job_id", "entry_category", "primary_question"):
        values = [value.get(field) for value in (model, context, blueprint) if value.get(field) is not None]
        if len({json.dumps(value, ensure_ascii=False, sort_keys=True) for value in values}) > 1:
            errors.append(f"identity_mismatch:{field}")
    expected = blueprint.get("selected_pattern_id") or blueprint.get("pattern_id")
    if expected and model.get("pattern_id") != expected:
        errors.append("identity_mismatch:pattern_id")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--working-context", type=Path, required=True)
    parser.add_argument("--blueprint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--job-state", type=Path)
    args = parser.parse_args()
    model, context, blueprint = load_object(args.model), load_object(args.working_context), load_object(args.blueprint)
    errors = identity_errors(model, context, blueprint)
    if errors:
        raise ValueError("; ".join(errors))
    normalized, repairs, warnings = normalize(model, context)
    if title_field_paths(normalized):
        raise ValueError("title fields are forbidden in Content Model")
    validate_root(normalized, "content_model.schema.json", "E5 Content Model")
    write_json(args.output, normalized)
    status = "completed_with_limits" if warnings else "completed"
    summary = {
        "schema_version": "2.3.0", "job_id": normalized.get("job_id"), "stage": "E5",
        "status": status, "automatic_repairs": repairs, "warnings": warnings,
    }
    validate_schema(
        summary, Path(__file__).resolve().parents[1] / "templates" / "writing_summary.schema.json",
        "E5 writing summary",
    )
    write_json(args.summary, summary)
    update_job_state(args.job_state, stage="E5", status=status, warnings=warnings,
                     selected_pattern_id=str(normalized.get("pattern_id")))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
