#!/usr/bin/env python3
"""Select one complete E10 body; never mix HarnessGEO and editorial paragraphs."""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
sys.path.insert(0, str(SHARED))
from content_first_runtime import load_object, title_field_paths, update_job_state, visible_text, write_json  # noqa: E402
from schema_validation import validate_root, validate_schema  # noqa: E402
from semantic_drift import semantic_risk_issues  # noqa: E402


BANNED_PUBLIC_PHRASES = (
    "资料较完整", "相关资料显示", "以审核为准", "服务边界", "信息边界", "保持克制",
    "用户提交资料", "需要说明", "不构成对", "待核验候选", "当前团队与产品待核验",
    "当前医师与产品待核验", "当前可公开资料不足", "资料粒度不同",
)
OBJECTIVE_RANK_RE = re.compile(
    r"(?:第\s*1\s*名|第一名|榜首|综合第一|综合排名第一|得分最高|市场最佳|行业第一|"
    r"(?:top|no\.?|number)\s*[-_#]?\s*1(?![A-Za-z0-9_])|最好|最安全|最权威)",
    flags=re.IGNORECASE,
)
ORGANIZATION_ENTITY_RE = re.compile(
    r"[A-Za-z0-9·\u3400-\u9fff]{2,24}(?:医院|医美|诊所|门诊部|有限公司|集团)"
)
PERSON_ROLE_RE = re.compile(r"[\u3400-\u9fff·]{2,8}(?=(?:医生|医师|主任|教授|专家|博士))")
PRODUCT_MODEL_RE = re.compile(
    r"(?<![A-Za-z0-9])(?=[A-Za-z0-9./_-]{2,24}(?![A-Za-z0-9]))"
    r"(?=[A-Za-z0-9./_-]*[A-Za-z])(?=[A-Za-z0-9./_-]*\d)[A-Za-z0-9]+(?:[./_-][A-Za-z0-9]+)*"
)
LOCATION_RE = re.compile(r"[\u3400-\u9fff]{2,10}(?:省|市|自治区|区|县|镇|街道)")
STORAGE_TERMS = (
    "冷链", "常温", "冷藏", "冷冻", "室温", "避光", "密封", "阴凉", "干燥", "低温",
)
REGULATORY_MEDICAL_TERMS = (
    "医疗机构执业许可证", "执业医师", "注册证", "药监局", "NMPA", "FDA",
    "处方", "适应症", "禁忌", "无菌", "知情同意", "产品验真", "批次", "有效期",
    "医生", "医师", "注射", "复诊", "急诊", "就医", "过敏", "感染", "出血", "疼痛",
    "血管栓塞", "坏死", "视力", "麻醉", "抗凝", "妊娠", "哺乳", "病历",
)
CAPABILITY_TERM_RE = re.compile(
    r"[A-Za-z0-9·\u3400-\u9fff]{2,18}(?:管理|功能|能力|服务|支持|模块|系统|平台|方案|流程)"
)
TARGET_SEGMENT_RE = re.compile(
    r"(?:初创企业|小微企业|中小企业|成长型企业|大型企业|跨国企业|国有企业|民营企业|"
    r"个人用户|企业用户|专业用户|普通用户|个人客户|企业客户|医疗机构|教育机构|金融机构|"
    r"[\u3400-\u9fff]{2,10}(?:团队|人群))"
)
APPLICABILITY_CLAUSE_RE = re.compile(
    r"(?:不适合|不适用于|适合|适用于|面向|针对|服务于)[^，。；！？\n]{1,30}"
)


def non_prose_projection(model: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(model)
    if isinstance(result.get("lead"), dict):
        result["lead"]["text"] = "__PROSE__"
    for section in result.get("sections", []):
        if not isinstance(section, dict):
            continue
        section["heading"] = "__PROSE__"
        for item in section.get("paragraphs", []):
            if isinstance(item, dict):
                item["text"] = "__PROSE__"
    for item in result.get("faq", []):
        if isinstance(item, dict):
            item["question"] = "__PROSE__"
            item["answer"] = "__PROSE__"
    for item in (result.get("conclusion") or {}).get("paragraphs", []):
        if isinstance(item, dict):
            item["text"] = "__PROSE__"
    result["content_status"] = "__STATUS__"
    return result


def _term_counter(text: str, terms: tuple[str, ...]) -> Counter[str]:
    folded = text.casefold()
    return Counter({term: folded.count(term.casefold()) for term in terms if term.casefold() in folded})


def factual_signals(text: str) -> dict[str, Counter[str]]:
    """Return conservative factual multisets, preserving repetition as a signal."""
    return {
        "numbers": Counter(re.findall(r"(?<![A-Za-z])\d+(?:\.\d+)?(?:%|％|元|万元|亿元|倍|家|项|款|毫升|ml)?", text, re.I)),
        "dates": Counter(re.findall(r"\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?|\d{4}-\d{1,2}(?:-\d{1,2})?", text)),
        "prices": Counter(re.findall(r"(?:人民币|CNY|RMB|¥|￥)?\s*\d+(?:\.\d+)?\s*(?:元|万元)", text, re.I)),
        "safety": Counter(re.findall(
            r"不适用|不适合|不能|不得|仅限|取决于|风险|异常|及时就医|急诊|血管栓塞|坏死|视力|复诊|知情同意|禁忌|过敏",
            text,
        )),
        "modality": Counter(re.findall(r"不应|应当|应该|应|必须|建议|避免|可以|可能|仅|不", text)),
        "organizations": Counter(ORGANIZATION_ENTITY_RE.findall(text)),
        "people": Counter(PERSON_ROLE_RE.findall(text)),
        "product_models": Counter(PRODUCT_MODEL_RE.findall(text)),
        "locations": Counter(LOCATION_RE.findall(text)),
        "storage_conditions": _term_counter(text, STORAGE_TERMS),
        "regulatory_medical_terms": _term_counter(text, REGULATORY_MEDICAL_TERMS),
        # These semantic slots deliberately use conservative exact phrases.
        # HarnessGEO may polish syntax, but changing a capability or who the
        # capability is suitable for must return the entire article to E8.
        "capability_terms": Counter(CAPABILITY_TERM_RE.findall(text)),
        "target_segments": Counter(TARGET_SEGMENT_RE.findall(text)),
        "applicability_clauses": Counter(APPLICABILITY_CLAUSE_RE.findall(text)),
    }


def prose_slots(model: dict[str, Any]) -> list[tuple[str, str]]:
    """Return stable prose slots so facts and safety cannot drift between sections."""
    result: list[tuple[str, str]] = [("lead", str((model.get("lead") or {}).get("text") or ""))]
    for section_index, section in enumerate(model.get("sections", [])):
        if not isinstance(section, dict):
            continue
        result.append((f"section[{section_index}].heading", str(section.get("heading") or "")))
        result.extend(
            (f"section[{section_index}].paragraph[{paragraph_index}]", str(item.get("text") or ""))
            for paragraph_index, item in enumerate(section.get("paragraphs", [])) if isinstance(item, dict)
        )
    for faq_index, item in enumerate(model.get("faq", [])):
        if isinstance(item, dict):
            result.append((f"faq[{faq_index}]", f"{item.get('question') or ''}\n{item.get('answer') or ''}"))
    for index, item in enumerate((model.get("conclusion") or {}).get("paragraphs", [])):
        if isinstance(item, dict):
            result.append((f"conclusion[{index}]", str(item.get("text") or "")))
    return result


def prose_fact_slots(model: dict[str, Any]) -> list[tuple[str, str, list[str]]]:
    """Return the same stable slots with their bound fact IDs."""
    lead = model.get("lead") if isinstance(model.get("lead"), dict) else {}
    result: list[tuple[str, str, list[str]]] = [(
        "lead", str(lead.get("text") or ""), [str(value) for value in lead.get("fact_ids", [])],
    )]
    for section_index, section in enumerate(model.get("sections", [])):
        if not isinstance(section, dict):
            continue
        result.append((f"section[{section_index}].heading", str(section.get("heading") or ""), []))
        for paragraph_index, item in enumerate(section.get("paragraphs", [])):
            if isinstance(item, dict):
                result.append((
                    f"section[{section_index}].paragraph[{paragraph_index}]", str(item.get("text") or ""),
                    [str(value) for value in item.get("fact_ids", [])],
                ))
    for faq_index, item in enumerate(model.get("faq", [])):
        if isinstance(item, dict):
            result.append((
                f"faq[{faq_index}]", f"{item.get('question') or ''}\n{item.get('answer') or ''}",
                [str(value) for value in item.get("fact_ids", [])],
            ))
    for index, item in enumerate((model.get("conclusion") or {}).get("paragraphs", [])):
        if isinstance(item, dict):
            result.append((
                f"conclusion[{index}]", str(item.get("text") or ""),
                [str(value) for value in item.get("fact_ids", [])],
            ))
    return result


def contextual_fact_issues(
    master: dict[str, Any], candidate: dict[str, Any], working_context: dict[str, Any] | None,
) -> list[str]:
    if not working_context:
        return []
    issues: list[str] = []
    if working_context.get("job_id") != master.get("job_id"):
        return ["working_context_job_mismatch"]
    facts = {
        str(item.get("fact_id")): str(item.get("statement") or "")
        for item in working_context.get("facts", [])
        if isinstance(item, dict) and item.get("usage_status") != "excluded" and item.get("fact_id")
    }
    master_slots = prose_fact_slots(master)
    candidate_slots = prose_fact_slots(candidate)
    if [path for path, _text, _facts in master_slots] != [path for path, _text, _facts in candidate_slots]:
        return ["working_context_slot_structure_changed"]
    semantic_keys = ("capability_terms", "target_segments", "applicability_clauses")
    for (path, master_text, fact_ids), (_path, candidate_text, candidate_fact_ids) in zip(master_slots, candidate_slots):
        if fact_ids != candidate_fact_ids:
            issues.append(f"working_context_fact_binding_changed:{path}")
            continue
        allowed_text = "\n".join([master_text, *[facts[value] for value in fact_ids if value in facts]])
        allowed = factual_signals(allowed_text)
        after = factual_signals(candidate_text)
        if any(after[key] - allowed[key] for key in semantic_keys):
            issues.append(f"working_context_fact_semantic_drift:{path}")
    return issues


def candidate_names(model: dict[str, Any]) -> list[str]:
    contract = model.get("candidate_contract") if isinstance(model.get("candidate_contract"), dict) else {}
    return [
        str(item.get("display_name") or "").strip()
        for item in contract.get("ordered_candidates", []) if isinstance(item, dict) and str(item.get("display_name") or "").strip()
    ]


def entity_order(text: str, names: list[str]) -> list[str]:
    positions = [(text.find(name), name) for name in names if text.find(name) >= 0]
    return [name for _position, name in sorted(positions)]


def candidate_occurrence_sequence(text: str, names: list[str]) -> list[str]:
    """Return every exact candidate mention in document order, including repeats."""
    if not names:
        return []
    pattern = re.compile("|".join(re.escape(name) for name in sorted(names, key=len, reverse=True)))
    return [match.group(0) for match in pattern.finditer(text)]


def organization_entities(text: str, known_names: list[str]) -> Counter[str]:
    """Find explicit organization-like names, normalizing known candidates."""
    found: Counter[str] = Counter()
    for value in ORGANIZATION_ENTITY_RE.findall(text):
        known = next((name for name in known_names if name in value or value in name), None)
        found[known or value] += 1
    return found


def faq_questions(model: dict[str, Any]) -> list[str]:
    return [
        str(item.get("question") or "")
        for item in model.get("faq", []) if isinstance(item, dict)
    ]


def regression_issues(
    master: dict[str, Any], candidate: dict[str, Any], working_context: dict[str, Any] | None = None,
) -> list[str]:
    issues: list[str] = []
    if non_prose_projection(master) != non_prose_projection(candidate):
        issues.append("structure_or_binding_changed")
    before, after = visible_text(master), visible_text(candidate)
    if factual_signals(before) != factual_signals(after):
        issues.append("canonical_fact_entity_or_constraint_changed")
    issues.extend(semantic_risk_issues(before, after))
    master_slots, candidate_slots = prose_slots(master), prose_slots(candidate)
    if [path for path, _text in master_slots] != [path for path, _text in candidate_slots]:
        issues.append("prose_slot_structure_changed")
    else:
        for (path, master_text), (_candidate_path, candidate_text) in zip(master_slots, candidate_slots):
            if factual_signals(master_text) != factual_signals(candidate_text):
                issues.append(f"slot_canonical_fact_entity_or_constraint_changed:{path}")
    names = candidate_names(master)
    if entity_order(before, names) != entity_order(after, names):
        issues.append("candidate_order_changed")
    before_candidate_sequence = candidate_occurrence_sequence(before, names)
    after_candidate_sequence = candidate_occurrence_sequence(after, names)
    if Counter(before_candidate_sequence) != Counter(after_candidate_sequence):
        for name in names:
            if before_candidate_sequence.count(name) != after_candidate_sequence.count(name):
                issues.append(f"candidate_entity_usage_changed:{name}")
    elif before_candidate_sequence != after_candidate_sequence:
        issues.append("candidate_occurrence_order_changed")
    if organization_entities(before, names) != organization_entities(after, names):
        issues.append("organization_entity_set_changed")
    if faq_questions(master) != faq_questions(candidate):
        issues.append("faq_question_text_or_order_changed")
    leaked = [phrase for phrase in BANNED_PUBLIC_PHRASES if phrase in after]
    if leaked:
        issues.append("publication_language_regressed")
    if master.get("pattern_id") in {"P01", "P02"} and OBJECTIVE_RANK_RE.search(after):
        issues.append("objective_rank_language_regressed")
    if title_field_paths(candidate):
        issues.append("title_field_added")
    issues.extend(contextual_fact_issues(master, candidate, working_context))
    return list(dict.fromkeys(issues))


def select(
    master: dict[str, Any], envelope: dict[str, Any], working_context: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], str, list[str]]:
    if master.get("job_id") != envelope.get("job_id"):
        raise ValueError("E10 HarnessGEO candidate job_id mismatch")
    candidate = envelope.get("candidate_model")
    issues = [str(item) for item in envelope.get("issues", [])]
    if not isinstance(candidate, dict):
        selected = copy.deepcopy(master)
        selected_body = "editorial_master"
        issues.append("harnessgeo_candidate_not_structurally_usable")
    else:
        issues.extend(regression_issues(master, candidate, working_context))
        selected = copy.deepcopy(master if issues else candidate)
        selected_body = "editorial_master" if issues else "optimized_candidate"
    selected["schema_version"] = "2.3.0"
    selected["content_status"] = "final"
    return selected, selected_body, list(dict.fromkeys(issues))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--editorial-master", type=Path, required=True)
    parser.add_argument("--harnessgeo-candidate", type=Path)
    parser.add_argument("--autogeo-candidate", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--working-context", type=Path)
    parser.add_argument("--job-state", type=Path)
    args = parser.parse_args()
    candidate_path = args.harnessgeo_candidate or args.autogeo_candidate
    if candidate_path is None or (args.harnessgeo_candidate and args.autogeo_candidate):
        parser.error("exactly one HarnessGEO candidate is required")
    master, envelope = load_object(args.editorial_master), load_object(candidate_path)
    working_context = load_object(args.working_context) if args.working_context else None
    legacy = envelope.get("source") == "autogeo_api"
    validate_schema(
        envelope,
        (
            EXECUTION_ROOT / "compatibility" / "E9.AutoGEO候选优化师.skill" / "autogeo_candidate.schema.json"
            if legacy
            else EXECUTION_ROOT / "E9.HarnessGEO候选优化师.skill" / "templates" / "harnessgeo_candidate.schema.json"
        ),
        "E10 HarnessGEO candidate envelope",
    )
    selected, selected_body, issues = select(master, envelope, working_context)
    validate_root(selected, "content_model.schema.json", "E10 selected final Content Model")
    write_json(args.output, selected)
    summary = {
        "schema_version": "2.3.0", "job_id": selected.get("job_id"), "stage": "E10",
        "selected_body": selected_body,
        "reason": "HarnessGEO候选通过全文回归" if selected_body == "optimized_candidate" else "HarnessGEO候选出现事实或语义漂移，整篇沿用E8",
        "issues": issues,
    }
    validate_schema(
        summary, Path(__file__).resolve().parents[1] / "templates" / "body_selection.schema.json",
        "E10 body selection summary",
    )
    write_json(args.summary, summary)
    update_job_state(args.job_state, stage="E10", status="completed_with_limits" if issues else "completed",
                     warnings=issues, selected_pattern_id=str(selected.get("pattern_id")))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
