#!/usr/bin/env python3
"""Execution-side bindings for the v2.1 P01/P02 recommendation contracts.

The root route helper owns shape and entry compatibility.  This module adds
body/claim/source/matrix bindings that require runtime artifacts.
"""

from __future__ import annotations

import sys
import re
import unicodedata
from pathlib import Path
from typing import Any

ROOT_SHARED = Path(__file__).resolve().parents[2] / "shared"
if str(ROOT_SHARED) not in sys.path:
    sys.path.insert(0, str(ROOT_SHARED))
ROOT_SCRIPTS = ROOT_SHARED / "scripts"
if str(ROOT_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(ROOT_SCRIPTS))

from content_route import (  # noqa: E402
    normalized_name,
    validate_recommendation_candidate_contract,
)
OBJECTIVE_RANK_RE = re.compile(
    r"(?:第\s*1\s*名|第一名|榜首|综合第一|得分最高|市场最佳|行业第一|"
    r"(?:top|no\.?|number)\s*[-_#]?\s*1(?![A-Za-z0-9_]))",
    flags=re.IGNORECASE,
)

# This is deliberately narrower than general-purpose NER.  Recommendation
# contracts only need a deterministic backstop for likely brand/company names
# that an author failed to declare in candidate_contract.  Publisher names of
# sources actually used by the article are allowed separately below.
_ENTITY_SUFFIX_RE = re.compile(
    r"(?:股份有限公司|有限责任公司|有限公司|品牌|公司|集团|厂商|企业)"
)
_ENTITY_CLAUSE_RE = re.compile(r"[\n\r，。；：！？、,;:!?（）()【】\[\]《》<>\"“”'‘’]+")
_ENTITY_BOUNDARY_RE = re.compile(
    r"(?:此外|另外|同时|其中|例如|比如|包括|还有|以及|或者|推荐|选择|考虑|"
    r"关注|比较|对比|评估|使用|采用|根据|来自|替代|作为|成为|和|与|及|或|由|据)"
)
_EXPLICIT_CANDIDATE_CUE_RE = re.compile(
    r"([\u3400-\u9fffA-Za-z0-9·＆&._-]{2,24}?)"
    r"(?:也|亦)?(?:是|可|可以|能|能够)?(?:作为|成为)?"
    r"(?:替代选择|替代方案|候选(?:品牌|公司|厂商|企业)?|竞品|值得关注|值得考虑|可选项)"
)
_LATIN_ENTITY_RE = re.compile(r"(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9&._-]{2,}(?![A-Za-z0-9_])")
_GENERIC_LATIN_TOKENS = {
    "AI", "API", "B2B", "B2C", "CPU", "CRM", "DOCX", "FAQ", "GEO",
    "GPU", "HTML", "HTTP", "HTTPS", "JSON", "LLM", "PDF", "RAG",
    "SaaS", "SDK", "SEO", "SQL", "TOP", "URL", "XML",
}
_GENERIC_ENTITY_STEMS = {
    "", "ai", "geo", "本", "该", "某", "各", "其", "此", "这些", "上述",
    "客户", "目标", "焦点", "单", "多", "其他", "其它", "同类", "同行",
    "行业", "企业", "公司", "产品", "服务", "技术", "软件", "硬件", "平台",
    "主流", "头部", "知名", "领先", "优秀", "推荐", "候选", "合作", "一家",
    "多家", "若干", "相关", "专业", "第三方", "权威", "真实", "现有", "新兴",
    "传统", "竞争", "竞品", "替代", "对标", "参评", "入选", "受访", "样本",
    "云服务", "模型服务", "解决方案", "供应商",
}
_GENERIC_ENTITY_PREFIXES = (
    "某", "该", "本", "此", "各", "其他", "其它", "同类", "同行", "行业",
    "客户", "目标", "焦点", "候选", "主流", "头部", "知名", "领先", "一家",
    "多家", "若干", "相关", "上述", "这些",
)


def model_used_claim_ids(model: dict[str, Any]) -> set[str]:
    result: set[str] = set()
    lead = model.get("lead") if isinstance(model.get("lead"), dict) else {}
    result.update(str(value) for value in lead.get("claim_ids", []))
    for section in model.get("sections", []):
        if not isinstance(section, dict):
            continue
        groups = [section.get("blocks", [])]
        groups.extend(
            item.get("blocks", []) for item in section.get("subsections", [])
            if isinstance(item, dict)
        )
        for group in groups:
            for block in group if isinstance(group, list) else []:
                if isinstance(block, dict):
                    result.update(str(value) for value in block.get("claim_ids", []))
    for item in model.get("faq", []):
        if isinstance(item, dict):
            result.update(str(value) for value in item.get("claim_ids", []))
    conclusion = model.get("conclusion") if isinstance(model.get("conclusion"), dict) else {}
    result.update(str(value) for value in conclusion.get("claim_ids", []))
    return result


def visible_body_text(model: dict[str, Any]) -> str:
    chunks: list[str] = [str(model.get("primary_question") or "")]
    lead = model.get("lead") if isinstance(model.get("lead"), dict) else {}
    chunks.extend(str(lead.get(key) or "") for key in ("direct_answer_sentence", "micro_answer"))
    for section in model.get("sections", []):
        if not isinstance(section, dict):
            continue
        chunks.append(str(section.get("h2_question") or ""))
        groups = [section.get("blocks", [])]
        groups.extend(
            item.get("blocks", []) for item in section.get("subsections", [])
            if isinstance(item, dict)
        )
        for group in groups:
            for block in group if isinstance(group, list) else []:
                if isinstance(block, dict):
                    chunks.append(str(block.get("text") or ""))
                    chunks.extend(str(value) for value in block.get("items", []) or [])
    for item in model.get("faq", []):
        if isinstance(item, dict):
            chunks.extend((str(item.get("question") or ""), str(item.get("answer") or "")))
    conclusion = model.get("conclusion") if isinstance(model.get("conclusion"), dict) else {}
    chunks.extend(str(conclusion.get(key) or "") for key in ("summary", "fit", "next_action"))
    return "\n".join(chunks)


def visible_article_text(model: dict[str, Any]) -> str:
    """Return publishable body text only; the task question is not article order."""

    rendered = visible_body_text(model)
    return rendered.split("\n", 1)[1] if "\n" in rendered else ""


def recommendation_objective_rank_errors(model: dict[str, Any]) -> list[str]:
    """P01/P02 may express editorial priority, never an unsupported objective rank."""

    if model.get("pattern_id") not in {"P01", "P02"}:
        return []
    body = visible_article_text(model)
    normalized = unicodedata.normalize("NFKC", body)
    hits = sorted({match.group(0) for match in OBJECTIVE_RANK_RE.finditer(normalized)})
    return [f"{model.get('pattern_id')} uses forbidden objective-rank terms: {hits}"] if hits else []


def _entity_base(value: Any) -> str:
    normalized = normalized_name(value)
    previous = None
    while normalized and normalized != previous:
        previous = normalized
        normalized = re.sub(
            r"(?:股份有限公司|有限责任公司|有限公司|品牌|公司|集团|厂商|企业)$",
            "", normalized,
        )
    return normalized


def _generic_entity_mention(value: Any) -> bool:
    normalized = normalized_name(value)
    base = _entity_base(normalized)
    if base in _GENERIC_ENTITY_STEMS:
        return True
    if any(base.startswith(prefix) for prefix in _GENERIC_ENTITY_PREFIXES) and len(base) <= 8:
        return True
    if re.fullmatch(r"(?:[一二三四五六七八九十百千万两\d]+家?)?", base):
        return True
    return False


def _entity_tail(value: str) -> str:
    matches = list(_ENTITY_BOUNDARY_RE.finditer(value))
    tail = value[matches[-1].end():] if matches else value
    tail = tail.strip(" \t\u3000")
    tail = re.sub(r"^(?:的|在|对|把|将|从|向|为|以)+", "", tail)
    return tail[-32:]


def likely_named_entity_mentions(text: str) -> set[str]:
    """Extract conservative likely brand/company mentions from visible prose.

    The extractor catches explicit organization suffixes, Latin proper-name
    tokens and unsuffixed Chinese names used in an explicit candidate context.
    Generic phrases such as ``同类品牌`` and ``多家企业`` are excluded.
    """

    normalized_text = unicodedata.normalize("NFKC", text)
    findings: set[str] = set()
    for clause in _ENTITY_CLAUSE_RE.split(normalized_text):
        if not clause:
            continue
        cursor = 0
        for suffix in _ENTITY_SUFFIX_RE.finditer(clause):
            prefix = _entity_tail(clause[cursor:suffix.start()])
            candidate = f"{prefix}{suffix.group(0)}"
            cursor = suffix.end()
            if suffix.group(0) == "品牌" and prefix.endswith(("单", "多")):
                continue
            if prefix and not _generic_entity_mention(candidate):
                findings.add(candidate)
        for match in _EXPLICIT_CANDIDATE_CUE_RE.finditer(clause):
            candidate = _entity_tail(match.group(1))
            if candidate and not _generic_entity_mention(candidate):
                findings.add(candidate)
    for match in _LATIN_ENTITY_RE.finditer(normalized_text):
        candidate = match.group(0)
        if candidate.upper() not in _GENERIC_LATIN_TOKENS:
            findings.add(candidate)
    return findings


def _matches_entity_alias(value: Any, aliases: set[str]) -> bool:
    normalized = normalized_name(value)
    base = _entity_base(normalized)
    return normalized in aliases or any(
        base and base == _entity_base(alias) for alias in aliases
    )


def _candidate_names(document: dict[str, Any]) -> list[str]:
    contract = document.get("candidate_contract") if isinstance(document.get("candidate_contract"), dict) else {}
    return [
        str(item.get("entity_name") or "").strip()
        for item in contract.get("ordered_candidates", []) if isinstance(item, dict)
    ]


def monitoring_entity_names(monitoring: dict[str, Any] | None) -> tuple[set[str], set[str]]:
    """Return all observed entities and the stricter competitor subset."""
    if not isinstance(monitoring, dict):
        return set(), set()
    derived = monitoring.get("derived") if isinstance(monitoring.get("derived"), dict) else {}
    competitors = {
        normalized_name(item.get("name")) for item in derived.get("competitors", [])
        if isinstance(item, dict) and normalized_name(item.get("name"))
    }
    entities = set(competitors)
    for item in derived.get("answer_landscape", []):
        if isinstance(item, dict):
            entities.update(
                normalized_name(value) for value in item.get("entities", [])
                if normalized_name(value)
            )
    return entities, competitors


def blueprint_candidate_binding_errors(
    blueprint: dict[str, Any], canonical_brand: str | None,
    monitoring: dict[str, Any] | None = None,
    claim_registry: dict[str, Any] | None = None,
    source_registry: dict[str, Any] | None = None,
) -> list[str]:
    """Validate the blueprint recommendation shape against the signed brand."""

    errors = validate_recommendation_candidate_contract(blueprint, canonical_brand)
    if blueprint.get("pattern_id") == "P02":
        monitored, _ = monitoring_entity_names(monitoring)
        claims = {
            str(item.get("claim_id")): item for item in (claim_registry or {}).get("claims", [])
            if isinstance(item, dict)
        }
        sources = {
            str(item.get("source_id")) for item in (source_registry or {}).get("sources", [])
            if isinstance(item, dict)
        }
        planned_claims = set(str(value) for value in blueprint.get("claim_plan", []))
        candidates = blueprint.get("candidate_contract", {}).get("ordered_candidates", [])
        for candidate in candidates[1:]:
            name = str(candidate.get("entity_name") or "") if isinstance(candidate, dict) else ""
            declared = set(str(value) for value in candidate.get("source_ids", [])) if isinstance(candidate, dict) else set()
            evidence_claims = [
                claim for claim_id, claim in claims.items() if claim_id in planned_claims
                and normalized_name(name) in {
                    normalized_name(value) for value in claim.get("about_entities", [])
                }
            ]
            expected_sources = {
                str(value) for claim in evidence_claims for value in claim.get("source_ids", [])
                if str(value).strip()
            }
            if normalized_name(name) not in monitored and (
                not evidence_claims or not declared or declared != expected_sources
                or not declared <= sources
            ):
                errors.append(
                    "P02 other candidate lacks monitoring or hash-bound claim/source provenance: "
                    + name
                )
    return errors


def model_candidate_binding_errors(
    model: dict[str, Any], blueprint: dict[str, Any], claim_registry: dict[str, Any],
    source_registry: dict[str, Any], canonical_brand: str | None,
    canonical_aliases: list[str] | None = None,
    monitoring: dict[str, Any] | None = None,
    competitor_matrix: dict[str, Any] | None = None,
    require_matrix: bool = False,
) -> list[str]:
    """Bind every displayed P01/P02 candidate to used claims and exact sources."""

    errors = validate_recommendation_candidate_contract(model, canonical_brand)
    pattern_id = model.get("pattern_id")
    if pattern_id not in {"P01", "P02"}:
        return errors
    if model.get("candidate_contract") != blueprint.get("candidate_contract"):
        errors.append("Content Model candidate_contract differs from the E4 blueprint")
    contract = model.get("candidate_contract") if isinstance(model.get("candidate_contract"), dict) else {}
    candidates = [item for item in contract.get("ordered_candidates", []) if isinstance(item, dict)]
    names = [str(item.get("entity_name") or "").strip() for item in candidates]
    featured_aliases = {
        normalized_name(value) for value in [canonical_brand, *(canonical_aliases or [])]
        if normalized_name(value)
    }
    claims = {
        str(item.get("claim_id")): item for item in claim_registry.get("claims", [])
        if isinstance(item, dict)
    }
    source_ids = {
        str(item.get("source_id")) for item in source_registry.get("sources", [])
        if isinstance(item, dict)
    }
    used = model_used_claim_ids(model)
    used_source_ids = {
        str(source_id) for claim_id in used for source_id in claims.get(claim_id, {}).get("source_ids", [])
        if str(source_id).strip()
    }
    used_publishers = {
        normalized_name(item.get("publisher"))
        for item in source_registry.get("sources", [])
        if isinstance(item, dict)
        and str(item.get("source_id")) in used_source_ids
        and normalized_name(item.get("publisher"))
    }
    normalized_text = normalized_name(visible_article_text(model))
    evidence_backed_names: set[str] = set()

    for index, candidate in enumerate(candidates):
        name = names[index]
        aliases = featured_aliases if index == 0 else {normalized_name(name)}
        matching_claims = [
            claims[claim_id] for claim_id in used if claim_id in claims
            and aliases & {
                normalized_name(value) for value in claims[claim_id].get("about_entities", [])
                if normalized_name(value)
            }
        ]
        expected_sources = {
            str(value) for claim in matching_claims for value in claim.get("source_ids", [])
            if str(value).strip()
        }
        declared_sources = {str(value) for value in candidate.get("source_ids", [])}
        if not matching_claims:
            errors.append(f"{pattern_id} candidate has no used claim naming it: {name}")
        if declared_sources != expected_sources:
            errors.append(
                f"{pattern_id} candidate source_ids differ from its used-claim source set: "
                f"{name}:declared={sorted(declared_sources)}:expected={sorted(expected_sources)}"
            )
        unknown = sorted(declared_sources - source_ids)
        if unknown:
            errors.append(f"{pattern_id} candidate uses unknown sources: {name}:{unknown}")
        if not any(alias and alias in normalized_text for alias in aliases):
            errors.append(f"{pattern_id} candidate is absent from visible body: {name}")
        if matching_claims and declared_sources == expected_sources and not unknown:
            evidence_backed_names.add(normalized_name(name))

    first_positions: list[tuple[int, int, str]] = []
    for index, name in enumerate(names):
        aliases = featured_aliases if index == 0 else {normalized_name(name)}
        positions = [normalized_text.find(alias) for alias in aliases if alias and alias in normalized_text]
        if positions:
            first_positions.append((min(positions), index, name))
    if first_positions and min(first_positions)[1] != 0:
        errors.append(f"{pattern_id} visible body mentions another candidate before the featured client brand")

    allowed_body_entities = {
        normalized_name(value) for value in names if normalized_name(value)
    } | featured_aliases | used_publishers
    undeclared_likely_entities = sorted(
        value for value in likely_named_entity_mentions(visible_article_text(model))
        if not _matches_entity_alias(value, allowed_body_entities)
    )
    if undeclared_likely_entities:
        errors.append(
            f"{pattern_id} visible body contains likely named entities outside "
            f"candidate_contract: {undeclared_likely_entities}"
        )

    if pattern_id == "P02":
        monitored, competitors = monitoring_entity_names(monitoring)
        normalized_candidates = {normalized_name(value) for value in names}
        for name in names[1:]:
            if normalized_name(name) not in monitored and normalized_name(name) not in evidence_backed_names:
                errors.append(f"P02 other candidate lacks monitoring or used claim/source provenance: {name}")
        extras = sorted(
            value for value in competitors - normalized_candidates - featured_aliases
            if value and value in normalized_text
        )
        if extras:
            errors.append(f"P02 body names monitored competitors absent from candidate_contract: {extras}")
        if require_matrix and not competitor_matrix:
            errors.append("P02 requires an E6 competitor matrix")
        if competitor_matrix:
            if competitor_matrix.get("objects") != names:
                errors.append("P02 matrix objects must exactly preserve ordered_candidates")
            if competitor_matrix.get("dimensions") != contract.get("common_dimensions"):
                errors.append("P02 matrix dimensions must exactly equal candidate common_dimensions")
    else:
        if competitor_matrix:
            errors.append("P01 forbids a competitor matrix")
        _, competitors = monitoring_entity_names(monitoring)
        forbidden = sorted(
            value for value in competitors - featured_aliases if value and value in normalized_text
        )
        if forbidden:
            errors.append(f"P01 visible body names monitored competitors: {forbidden}")
        for claim_id in sorted(used):
            claim = claims.get(claim_id, {})
            other_entities = {
                normalized_name(value) for value in claim.get("about_entities", [])
                if normalized_name(value) and normalized_name(value) not in featured_aliases
            }
            if claim.get("claim_type") in {"comparison", "price", "reputation"} and other_entities:
                errors.append(
                    f"P01 uses a competitor-like claim about another entity: "
                    f"{claim_id}:{sorted(other_entities)}"
                )
    return errors
