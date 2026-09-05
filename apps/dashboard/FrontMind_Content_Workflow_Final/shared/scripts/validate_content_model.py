#!/usr/bin/env python3
"""Validate the publishable invariants of a natural v2.3 title-free article."""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from content_route import validate_entry_pattern_route, validate_recommendation_candidate_contract


ENTRIES = {"industry_ranking", "competitor_comparison", "reputation", "product_scenario", "foundation_start"}
SUBINTENTS = {"offering_definition", "feature_mechanism", "scenario_fit", "delivery_usage", "support_boundary", "price_selection"}
FORBIDDEN_MODEL_KEYS = {"title", "h1", "title_candidates", "warnings", "evidence_status"}
FORBIDDEN_PUBLIC_PATTERNS = (
    r"资料较完整", r"相关资料显示", r"以审核为准", r"服务边界", r"信息边界",
    r"保持克制", r"用户提交资料", r"需要说明", r"不构成对", r"待核验候选",
    r"当前团队与产品待核验", r"当前医师与产品待核验", r"当前可公开资料不足",
    r"资料粒度不同", r"(?:待|仍需|需进一步)(?:核验|确认|审核)",
)
OBJECTIVE_RANK_RE = re.compile(
    r"(?:第\s*1\s*名|第一名|榜首|综合第一|得分最高|市场最佳|行业第一|"
    r"最安全|最好|最专业|最权威|顶尖|唯一推荐|首选|"
    r"(?:top|no\.?|number)\s*[-_#]?\s*1(?![A-Za-z0-9_]))",
    flags=re.IGNORECASE,
)


def substantive_length(value: str) -> int:
    return sum(1 for char in value if not char.isspace() and not unicodedata.category(char).startswith(("P", "S")))


def first_sentence(value: str) -> str:
    return re.split(r"[。！？]", value, maxsplit=1)[0].strip()


def forbidden_key_paths(value: Any, path: str = "$") -> list[str]:
    hits: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key.lower() in FORBIDDEN_MODEL_KEYS:
                hits.append(child_path)
            hits.extend(forbidden_key_paths(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            hits.extend(forbidden_key_paths(child, f"{path}[{index}]"))
    return hits


def visible_text(model: dict[str, Any]) -> str:
    chunks: list[str] = []
    lead = model.get("lead") if isinstance(model.get("lead"), dict) else {}
    chunks.append(str(lead.get("text") or ""))
    for section in model.get("sections") or []:
        if not isinstance(section, dict):
            continue
        chunks.append(str(section.get("heading") or ""))
        for paragraph in section.get("paragraphs") or []:
            if isinstance(paragraph, dict):
                chunks.append(str(paragraph.get("text") or ""))
    for item in model.get("faq") or []:
        if isinstance(item, dict):
            chunks.extend((str(item.get("question") or ""), str(item.get("answer") or "")))
    conclusion = model.get("conclusion") if isinstance(model.get("conclusion"), dict) else {}
    for paragraph in conclusion.get("paragraphs") or []:
        if isinstance(paragraph, dict):
            chunks.append(str(paragraph.get("text") or ""))
    return "\n".join(chunk for chunk in chunks if chunk)


def public_blocks(model: dict[str, Any]) -> list[str]:
    blocks: list[str] = []
    lead = model.get("lead") if isinstance(model.get("lead"), dict) else {}
    if lead.get("text"):
        blocks.append(str(lead["text"]))
    for section in model.get("sections") or []:
        if isinstance(section, dict):
            blocks.extend(str(item.get("text") or "") for item in section.get("paragraphs") or [] if isinstance(item, dict))
    blocks.extend(str(item.get("answer") or "") for item in model.get("faq") or [] if isinstance(item, dict))
    conclusion = model.get("conclusion") if isinstance(model.get("conclusion"), dict) else {}
    blocks.extend(str(item.get("text") or "") for item in conclusion.get("paragraphs") or [] if isinstance(item, dict))
    return ["".join(re.findall(r"[\u3400-\u9fffA-Za-z0-9]+", item)).casefold() for item in blocks if item.strip()]


def validate(
    model: dict[str, Any],
    pattern_registry: dict[str, Any] | None = None,
    canonical_brand: str | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    if model.get("schema_version") != "2.3.0":
        errors.append("schema_version must be 2.3.0")
    entry = model.get("entry_category")
    if entry not in ENTRIES:
        errors.append("entry_category must be one of the five canonical entries")
    if not isinstance(model.get("primary_question"), str) or not model["primary_question"].strip():
        errors.append("primary_question is required")
    subintent = model.get("product_scenario_subintent")
    if entry == "product_scenario" and subintent not in SUBINTENTS:
        errors.append("product_scenario requires a canonical product_scenario_subintent")
    if entry != "product_scenario" and subintent is not None:
        errors.append("non-product entry must persist product_scenario_subintent as null")

    pattern_id = model.get("pattern_id")
    if "pattern_variant" in model:
        errors.append("pattern_variant is obsolete")
    if (entry == "foundation_start") != (pattern_id == "P14"):
        errors.append("foundation_start and P14 must be a strict two-way mapping")
    if pattern_registry is not None:
        errors.extend(validate_entry_pattern_route(model, pattern_registry))
    errors.extend(validate_recommendation_candidate_contract(model, canonical_brand))

    title_paths = forbidden_key_paths(model)
    if title_paths:
        errors.append(f"title-free/public Content Model contains forbidden fields: {', '.join(title_paths)}")

    lead = model.get("lead") if isinstance(model.get("lead"), dict) else {}
    lead_text = lead.get("text", "")
    if not isinstance(lead_text, str) or substantive_length(lead_text) < 20:
        errors.append("lead.text is empty or not substantive")
        lead_text = ""
    if lead_text and not 200 <= len(lead_text) <= 300:
        warnings.append("lead target is 200–300 characters; E8 should improve it")
    opening = first_sentence(lead_text)
    if opening and not 40 <= len(opening) <= 80:
        warnings.append("opening sentence target is 40–80 characters")

    sections = model.get("sections")
    faq = model.get("faq")
    if not isinstance(sections, list) or not sections:
        errors.append("article requires at least one substantive section")
        sections = []
    if not 5 <= len(sections) <= 8:
        warnings.append("the selected P template usually targets 5–8 sections")
    for index, section in enumerate(sections):
        if not isinstance(section, dict):
            errors.append(f"sections[{index}] must be an object")
            continue
        if not str(section.get("heading") or "").strip():
            errors.append(f"sections[{index}] requires a readable heading")
        paragraphs = section.get("paragraphs")
        if not isinstance(paragraphs, list) or not paragraphs:
            errors.append(f"sections[{index}] has no paragraphs")
    if not isinstance(faq, list):
        errors.append("faq must be an array")
        faq = []
    elif not 5 <= len(faq) <= 8:
        warnings.append("the selected P template usually targets 5–8 FAQ items")
    conclusion = model.get("conclusion") if isinstance(model.get("conclusion"), dict) else {}
    if not conclusion.get("paragraphs"):
        errors.append("conclusion requires at least one natural paragraph")

    body = unicodedata.normalize("NFKC", visible_text(model))
    for pattern in FORBIDDEN_PUBLIC_PATTERNS:
        matches = sorted(set(re.findall(pattern, body, flags=re.IGNORECASE)))
        if matches:
            errors.append(f"public copy exposes internal/report wording: {matches}")
    if pattern_id in {"P01", "P02"}:
        forbidden = sorted({match.group(0) for match in OBJECTIVE_RANK_RE.finditer(body)})
        if forbidden:
            errors.append(f"{pattern_id} uses forbidden objective-rank or absolute-superiority terms: {forbidden}")

    normalized_blocks = [item for item in public_blocks(model) if len(item) >= 16]
    duplicated = [item for item, count in Counter(normalized_blocks).items() if count > 1]
    if duplicated:
        errors.append("article contains repeated publishable paragraphs or FAQ answers")

    structured = set(model.get("structured_data_types") or [])
    if "ItemList" in structured and pattern_id != "P02":
        warnings.append("ItemList is not applicable to this pattern and should be omitted")
    if "HowTo" in structured and pattern_id not in {"P08", "P11"}:
        warnings.append("HowTo is not applicable to this pattern and should be omitted")

    metrics = {
        "opening_sentence_length": len(opening),
        "lead_unicode_length": len(lead_text),
        "section_count": len(sections),
        "faq_count": len(faq),
        "duplicate_block_count": len(duplicated),
    }
    return {"status": "pass" if not errors else "fail", "metrics": metrics, "warnings": warnings, "errors": errors}


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate v2.3 content safety and publishability.")
    parser.add_argument("content_model", type=Path)
    parser.add_argument("--pattern-registry", type=Path, default=Path(__file__).resolve().parents[1] / "content-pattern-registry.json")
    parser.add_argument("--canonical-brand")
    args = parser.parse_args()
    try:
        value = json.loads(args.content_model.read_text(encoding="utf-8"))
        registry = json.loads(args.pattern_registry.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or not isinstance(registry, dict):
            raise ValueError("Content Model and Pattern Registry roots must be objects")
        report = validate(value, registry, args.canonical_brand)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        report = {"status": "fail", "metrics": {}, "warnings": [], "errors": [str(exc)]}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
