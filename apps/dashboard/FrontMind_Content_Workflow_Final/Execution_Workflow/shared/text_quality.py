#!/usr/bin/env python3
"""Natural-prose quality helpers for the v2.3 title-free Content Model.

The checks are editing signals, not runtime approval gates. They understand
``lead.text``, section paragraphs, FAQ answers and conclusion paragraphs and
never require a receipt, evidence ledger or fixed question-shaped headings.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any, Iterable


SUBSTANTIVE_RE = re.compile(r"[\u3400-\u9fffA-Za-z0-9]")
LATIN_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9._+-]{1,}")
HAN_RUN_RE = re.compile(r"[\u3400-\u9fff]{2,}")
STRICT_FACT_TOKEN_RE = re.compile(
    r"(?:\d+(?:\.\d+)?\s*(?:%|％|元|万元|亿元|美元|USD|CNY|RMB|倍|家|项|款|秒|分钟|小时)|"
    r"(?:v(?:ersion)?\s*)?\d+(?:\.\d+){1,3})",
    flags=re.IGNORECASE,
)
DATE_FACT_RE = re.compile(
    r"(?P<year>\d{4})(?:年|[-/])(?P<month>\d{1,2})(?:(?:月|[-/])(?P<day>\d{1,2})(?:日)?)?(?:月)?"
)
PLACEHOLDER_PATTERNS = (
    re.compile(r"该部分|本节将|下文将|下面(?:介绍|说明|分析)|接下来(?:介绍|说明|分析)|本文将"),
    re.compile(r"资料较完整|相关资料显示|以审核为准|服务边界|信息边界|待核验候选"),
)
GENERIC_NGRAMS = {
    "什么", "哪些", "如何", "是否", "怎么", "为什么", "推荐", "对比", "评价", "适合", "需要", "问题",
}


def substantive_chars(value: str) -> list[str]:
    return SUBSTANTIVE_RE.findall(str(value or "").strip())


def question_key_tokens(question: str) -> set[str]:
    tokens = {match.group(0).lower() for match in LATIN_TOKEN_RE.finditer(question)}
    for run in HAN_RUN_RE.findall(question):
        for size in (4, 3, 2):
            for index in range(0, len(run) - size + 1):
                token = run[index:index + size]
                if token not in GENERIC_NGRAMS and not any(value in token for value in GENERIC_NGRAMS):
                    tokens.add(token)
    return tokens


def substantive_text_errors(
    value: str, *, label: str, minimum: int, ratio: float, minimum_unique: int,
) -> list[str]:
    text = str(value or "").strip()
    substantive = substantive_chars(text)
    errors: list[str] = []
    if len(substantive) < minimum:
        errors.append(f"{label}_substantive_chars:{len(substantive)}:preferred_{minimum}")
    actual_ratio = len(substantive) / len(text) if text else 0.0
    if actual_ratio < ratio:
        errors.append(f"{label}_substantive_ratio:{actual_ratio:.3f}:preferred_{ratio:.2f}")
    if len(set(char.casefold() for char in substantive)) < minimum_unique:
        errors.append(f"{label}_substantive_variety:preferred_{minimum_unique}")
    return errors


def _normalize_similarity(value: str) -> str:
    return re.sub(r"[^\u3400-\u9fffA-Za-z0-9]", "", str(value or "")).casefold()


def _paragraphs(model: dict[str, Any]) -> Iterable[tuple[str, str, list[str]]]:
    lead = model.get("lead") if isinstance(model.get("lead"), dict) else {}
    yield "lead", str(lead.get("text") or ""), [str(value) for value in lead.get("fact_ids", [])]
    for section_index, section in enumerate(model.get("sections", [])):
        if not isinstance(section, dict):
            continue
        for paragraph_index, item in enumerate(section.get("paragraphs", [])):
            if isinstance(item, dict):
                yield (
                    f"sections[{section_index}].paragraphs[{paragraph_index}]",
                    str(item.get("text") or ""),
                    [str(value) for value in item.get("fact_ids", [])],
                )
    for faq_index, item in enumerate(model.get("faq", [])):
        if isinstance(item, dict):
            yield f"faq[{faq_index}]", str(item.get("answer") or ""), [str(value) for value in item.get("fact_ids", [])]
    conclusion = model.get("conclusion") if isinstance(model.get("conclusion"), dict) else {}
    for index, item in enumerate(conclusion.get("paragraphs", [])):
        if isinstance(item, dict):
            yield f"conclusion.paragraphs[{index}]", str(item.get("text") or ""), [str(value) for value in item.get("fact_ids", [])]


def article_specificity_errors(model: dict[str, Any]) -> list[str]:
    """Return automatic-edit targets for empty, meta or repeated prose."""
    errors: list[str] = []
    seen: list[tuple[str, str]] = []
    for path, text, _fact_ids in _paragraphs(model):
        normalized = _normalize_similarity(text)
        if len(substantive_chars(text)) < (30 if path == "lead" else 12):
            errors.append(f"thin_public_paragraph:{path}")
        for pattern in PLACEHOLDER_PATTERNS:
            if pattern.search(text):
                errors.append(f"workflow_or_placeholder_language:{path}")
                break
        for previous_path, previous in seen:
            if min(len(normalized), len(previous)) >= 25:
                ratio = SequenceMatcher(None, normalized, previous, autojunk=False).ratio()
                if ratio >= 0.88:
                    errors.append(f"near_duplicate:{previous_path}:{path}:{ratio:.3f}")
                    break
        if normalized:
            seen.append((path, normalized))
    return errors


def _date_tokens(value: str) -> set[str]:
    result: set[str] = set()
    for match in DATE_FACT_RE.finditer(value):
        token = f"{int(match.group('year')):04d}-{int(match.group('month')):02d}"
        if match.group("day"):
            token += f"-{int(match.group('day')):02d}"
        result.add(token)
    return result


def _fact_text(fact: dict[str, Any]) -> str:
    return "\n".join(
        str(value or "") for value in (
            fact.get("statement"), fact.get("qualification"), fact.get("scope"), fact.get("as_of"),
        )
    )


def _fact_supports_text(text: str, fact: dict[str, Any]) -> bool:
    """Conservative semantic alignment check for v2.3 Fact Cards."""
    if fact.get("usage_status") == "excluded":
        return False
    if fact.get("verification_status") and fact.get("verification_status") not in {"verified", "verified_with_limits"}:
        return False
    if fact.get("allowed_usage") and fact.get("allowed_usage") not in {"public_fact", "public_with_qualification"}:
        return False
    source_text = _fact_text(fact)
    if not source_text.strip():
        return False
    field_dates, source_dates = _date_tokens(text), _date_tokens(source_text)
    if any(not any(left == right or left.startswith(right + "-") or right.startswith(left + "-") for right in source_dates)
           for left in field_dates):
        return False
    field_numbers = {
        re.sub(r"\s+", "", value.group(0)).casefold()
        for value in STRICT_FACT_TOKEN_RE.finditer(DATE_FACT_RE.sub("", text))
    }
    source_numbers = {
        re.sub(r"\s+", "", value.group(0)).casefold()
        for value in STRICT_FACT_TOKEN_RE.finditer(DATE_FACT_RE.sub("", source_text))
    }
    if field_numbers - source_numbers:
        return False
    entities = {str(value).strip().casefold() for value in fact.get("about_entities", []) if len(str(value).strip()) >= 2}
    field_lower, source_lower = text.casefold(), source_text.casefold()
    shared_entity = any(value in field_lower and value in source_lower for value in entities)
    shared = question_key_tokens(text) & question_key_tokens(source_text)
    non_generic = {value for value in shared if len(value) >= 3 and value not in entities}
    return len(non_generic) >= (2 if shared_entity else 3)


def material_fact_binding_errors(model: dict[str, Any], context: dict[str, Any]) -> list[str]:
    """Check only facts actually attached to public paragraphs."""
    facts = {
        str(item.get("fact_id")): item
        for item in (context.get("fact_cards") or context.get("facts") or [])
        if isinstance(item, dict) and item.get("fact_id")
    }
    errors: list[str] = []
    for path, text, fact_ids in _paragraphs(model):
        for fact_id in fact_ids:
            fact = facts.get(fact_id)
            if not fact or fact.get("usage_status") == "excluded":
                errors.append(f"unusable_fact_binding:{path}:{fact_id}")
            elif not _fact_supports_text(text, fact):
                errors.append(f"misaligned_fact_binding:{path}:{fact_id}")
    return errors
