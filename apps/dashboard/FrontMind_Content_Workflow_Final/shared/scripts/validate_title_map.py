#!/usr/bin/env python3
"""Validate publishable v2.3 titles against the final title-free body.

This is a content-safety check, not an approval ledger. It deliberately has
only two inputs: the final body and the generated title map.
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

from validate_json_instance import load_json, validate_instance


FACT_TOKEN_RE = re.compile(
    r"\d+(?:\.\d+)?%?|20\d{2}(?:年|[-/.]\d{1,2})?|"
    r"(?:人民币|美元|元|万元|亿元|¥|￥|\$)\s*\d+(?:\.\d+)?"
)
OBJECTIVE_RANK_RE = re.compile(
    r"(?:第\s*1\s*名|第一名|榜首|综合第一|得分最高|市场最佳|行业第一|"
    r"(?:top|no\.?|number)\s*[-_#]?\s*1(?![A-Za-z0-9_]))",
    flags=re.IGNORECASE,
)
P01_SINGLE_MULTI_PROMISE_RE = re.compile(
    r"(?:"
    r"(?:top\s*[-_#]?\s*(?:[2-9]|[1-9]\d+)(?![A-Za-z0-9_]))|"
    r"(?:(?:[2-9]|[1-9]\d+|[二三四五六七八九十百]+)\s*大\s*(?:品牌|公司|厂商|平台)?)|"
    r"(?:品牌排行(?:榜)?|品牌推荐榜|推荐榜|榜单)|"
    r"(?:有哪些[^，。！？:：]{0,12}(?:品牌|公司|厂商|平台))|"
    r"(?:(?:品牌|公司|厂商|平台)[^，。！？:：]{0,12}有哪些)"
    r")",
    flags=re.IGNORECASE,
)
CHINESE_ENTITY_RE = re.compile(r"[\u4e00-\u9fffA-Za-z0-9·＆&_-]{2,24}(?:品牌|公司|集团|机构|平台)")
LATIN_ENTITY_RE = re.compile(r"(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9&._-]{2,}(?![A-Za-z0-9_])")
GENERIC_LATIN_TOKENS = {"AI", "GEO", "FAQ", "HTML", "DOCX", "API", "TOP", "B2B", "B2C"}
GENERIC_INSTITUTION_TOPIC_RE = re.compile(
    r"(?:玻尿酸|注射|医美|医疗美容|整形|治疗|服务|推荐|候选|选择|哪家|哪些|怎么选)"
)


def normalized_text(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


def body_visible_text(model: dict[str, Any]) -> str:
    """Collect reader-visible body strings while ignoring technical metadata."""

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
    chunks.extend(str(item.get("display_name") or "") for item in model.get("references") or [] if isinstance(item, dict))
    return "\n".join(chunk for chunk in chunks if chunk)


def likely_new_entities(visible: str, body_text: str) -> list[str]:
    """Catch obvious invented names without requiring a claim/entity ledger."""

    normalized_visible = unicodedata.normalize("NFKC", visible)
    normalized_body = normalized_text(body_text)
    findings: set[str] = set()
    for candidate in CHINESE_ENTITY_RE.findall(normalized_visible):
        # A topic such as “某地打玻尿酸机构” is a category phrase, not the
        # proper name of a new organization.  Keep the conservative entity
        # gate for names such as “神奇竞争品牌”, while allowing an article's
        # own region + service + institution question to become a title.
        if candidate.endswith("机构") and GENERIC_INSTITUTION_TOPIC_RE.search(candidate):
            continue
        if normalized_text(candidate) not in normalized_body:
            findings.add(candidate)
    for candidate in LATIN_ENTITY_RE.findall(normalized_visible):
        if candidate.upper() not in GENERIC_LATIN_TOKENS and normalized_text(candidate) not in normalized_body:
            findings.add(candidate)
    return sorted(findings)


def validate(title_map: dict[str, Any], content_model: dict[str, Any]) -> list[str]:
    """Return deterministic content errors; no receipt, reviewer or SHA is used."""

    errors: list[str] = []
    if title_map.get("job_id") != content_model.get("job_id"):
        errors.append("title_map.job_id does not match the final Content Model")

    requested = title_map.get("requested_count")
    options = title_map.get("options")
    if not isinstance(requested, int) or isinstance(requested, bool) or not 1 <= requested <= 20:
        errors.append("requested_count must be a non-boolean integer from 1 through 20")
    if not isinstance(options, list):
        return [*errors, "title_map.options must be an array"]
    if isinstance(requested, int) and not isinstance(requested, bool) and len(options) != requested:
        errors.append(f"title_map contains {len(options)} options; expected exactly {requested}")

    ids = [item.get("title_id") for item in options if isinstance(item, dict)]
    titles = [normalized_text(item.get("title_text")) for item in options if isinstance(item, dict)]
    if len(ids) != len(set(ids)):
        errors.append("title_id values must be unique")
    if len(titles) != len(set(titles)):
        errors.append("title_text values must be unique after Unicode normalization")

    body = body_visible_text(content_model)
    body_tokens = set(FACT_TOKEN_RE.findall(unicodedata.normalize("NFKC", body)))
    pattern_id = content_model.get("pattern_id")
    for index, option in enumerate(options):
        if not isinstance(option, dict):
            errors.append(f"options[{index}] must be an object")
            continue
        visible = " ".join(
            str(option.get(key) or "") for key in ("title_text", "h1_suggestion", "meta_description")
        )
        normalized_visible = unicodedata.normalize("NFKC", visible)
        new_tokens = sorted(set(FACT_TOKEN_RE.findall(normalized_visible)) - body_tokens)
        if new_tokens:
            errors.append(f"options[{index}] introduces numbers, dates or prices absent from the final body: {new_tokens}")
        new_entities = likely_new_entities(visible, body)
        if new_entities:
            errors.append(f"options[{index}] introduces likely entities absent from the final body: {new_entities}")
        if pattern_id in {"P01", "P02"}:
            forbidden = sorted({match.group(0) for match in OBJECTIVE_RANK_RE.finditer(normalized_visible)})
            if forbidden:
                errors.append(f"options[{index}] introduces forbidden objective-rank language: {forbidden}")
        if pattern_id == "P01":
            forbidden = sorted({match.group(0) for match in P01_SINGLE_MULTI_PROMISE_RE.finditer(normalized_visible)})
            if forbidden:
                errors.append(f"options[{index}] makes a forbidden multi-brand or Top-N promise for P01: {forbidden}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate v2.3 titles against the final title-free body.")
    parser.add_argument("title_map", type=Path)
    parser.add_argument("--content-model", type=Path, required=True)
    args = parser.parse_args()
    shared = Path(__file__).resolve().parents[1]
    try:
        title_map = load_json(args.title_map)
        content_model = load_json(args.content_model)
        schema_errors = validate_instance(
            title_map,
            load_json(shared / "title_map.schema.json"),
            shared / "title_map.schema.json",
        )
        errors = [f"schema:{error.json_path}:{error.message}" for error in schema_errors]
        if not errors:
            errors.extend(validate(title_map, content_model))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        errors = [str(exc)]
    print(json.dumps({"status": "pass" if not errors else "fail", "errors": errors}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
