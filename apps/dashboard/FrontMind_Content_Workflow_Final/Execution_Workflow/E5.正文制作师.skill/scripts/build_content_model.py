#!/usr/bin/env python3
"""Build the v2.3 writing packet and normalize one whole authored article.

The publication path gives the packet to the E5 Skill, lets it author the
whole article in one context, then passes the result with ``--authored-model``.
A deterministic draft exists solely for tests and disaster diagnostics; it is
unreachable unless ``--allow-development-fallback`` is explicitly supplied.
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
sys.path.insert(0, str(SHARED))
from content_first_runtime import (  # noqa: E402
    load_object, refresh_references, title_field_paths, update_job_state, write_json,
)
from schema_validation import validate_root, validate_schema  # noqa: E402


AUDIT_LANGUAGE = (
    "资料较完整", "相关资料显示", "以审核为准", "服务边界", "信息边界", "保持克制",
    "用户提交资料", "用户上传资料", "客户资料", "需要说明", "不构成对", "待核验候选",
    "当前团队与产品待核验", "当前医师与产品待核验", "当前可公开资料不足",
    "资料粒度不同", "预研模板", "工作流思考", "审核结果", "审稿", "claim id", "source id",
)
META_FAQ_MARKERS = (
    "客观排名", "为什么先介绍", "编辑顺序", "目前有哪些可核验信息", "待核验",
    "这份名单", "本文为什么", "资料是否", "证据是否",
)


def compact_space(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def article_region(context: dict[str, Any], question: str) -> str:
    """Return a question-grounded region without carrying a fixture locale."""

    scope = context.get("scope") if isinstance(context.get("scope"), dict) else {}
    geographic = scope.get("geographic_scope") if isinstance(scope.get("geographic_scope"), dict) else {}
    if geographic.get("status") == "specific":
        value = compact_space(geographic.get("value")).removesuffix("市")
        if value:
            return value
    match = re.match(r"^([\u3400-\u9fff]{2,7}?)(?:市)?(?=打|做|注射|选择|找)", question)
    return match.group(1) if match else ""


def sentences(value: str) -> list[str]:
    return [item.strip() for item in re.split(r"(?<=[。！？!?])\s*", compact_space(value)) if item.strip()]


def public_text(value: Any) -> str:
    """Remove workflow narration while retaining publishable facts."""
    text = compact_space(value)
    text = re.sub(
        r"^(?:根据|据)?(?:用户(?:上传|提交)?资料|客户资料|客户物料|现有资料|相关资料|企业归档)"
        r"(?:显示|记录|表明|可见)?[，,:：\s]*",
        "",
        text,
    )
    kept: list[str] = []
    for sentence in sentences(text):
        lowered = sentence.casefold()
        if any(marker.casefold() in lowered for marker in AUDIT_LANGUAGE):
            continue
        if re.search(r"(?:仍|均|皆)?(?:待|需)(?:进一步)?(?:核验|确认|补充)", sentence):
            continue
        kept.append(sentence)
    text = "".join(kept).strip()
    if re.search(r"[\u3400-\u9fff]", text):
        text = text.replace(",", "，").replace(";", "；").replace(":", "：")
    return text


def truncate_complete(value: str, maximum: int) -> str:
    text = public_text(value)
    if len(text) <= maximum:
        return text
    result = ""
    for sentence in sentences(text):
        if result and len(result) + len(sentence) > maximum:
            break
        result += sentence
    return result or text[:maximum].rstrip("，；：、") + "。"


def facts_from_context(context: dict[str, Any]) -> list[dict[str, Any]]:
    raw = context.get("fact_cards")
    if not isinstance(raw, list):
        raw = context.get("facts", [])
    return [
        item for item in raw
        if isinstance(item, dict) and item.get("fact_id") and item.get("usage_status") != "excluded"
    ]


def fact_map(context: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item["fact_id"]): item for item in facts_from_context(context)}


def fact_sentence(fact: dict[str, Any]) -> str:
    return public_text(fact.get("statement") or fact.get("claim_text") or fact.get("text") or "")


def select_fact_ids(
    requested: Iterable[Any], facts: dict[str, dict[str, Any]], *, fallback: Iterable[str] = (), limit: int = 4,
) -> list[str]:
    values = [str(value) for value in requested if str(value) in facts]
    if not values:
        values = [str(value) for value in fallback if str(value) in facts]
    return list(dict.fromkeys(values))[:limit]


def candidate_names(blueprint: dict[str, Any]) -> list[str]:
    contract = blueprint.get("candidate_contract")
    if not isinstance(contract, dict):
        return []
    return [
        compact_space(item.get("display_name") or item.get("entity_name"))
        for item in contract.get("ordered_candidates", [])
        if isinstance(item, dict) and compact_space(item.get("display_name") or item.get("entity_name"))
    ]


def candidate_fact_ids(name: str, facts: dict[str, dict[str, Any]], limit: int = 4) -> list[str]:
    key = name.casefold()
    result: list[str] = []
    for fact_id, fact in facts.items():
        entities = [compact_space(item).casefold() for item in fact.get("about_entities", [])]
        statement = fact_sentence(fact).casefold()
        if key in entities or key in statement:
            result.append(fact_id)
    return result[:limit]


def fact_ids_matching_text(text: str, facts: dict[str, dict[str, Any]]) -> list[str]:
    target = re.sub(r"\s+", "", public_text(text))
    if not target:
        return []
    result: list[str] = []
    for fact_id, fact in facts.items():
        candidate = re.sub(r"\s+", "", fact_sentence(fact))
        if candidate and (candidate in target or target in candidate):
            result.append(fact_id)
    return result


def brand_name(context: dict[str, Any]) -> str:
    brand = context.get("brand")
    if isinstance(brand, dict):
        return compact_space(brand.get("canonical_name") or brand.get("name"))
    return compact_space(brand)


def priority_angle(context: dict[str, Any]) -> str:
    raw = context.get("brand_priority_angle") or context.get("priority_angle")
    if isinstance(raw, dict):
        for key in ("allowed_wording", "public_statement", "angle_statement", "angle", "summary", "reason"):
            value = public_text(raw.get(key))
            if value:
                return value
    return public_text(raw)


def priority_angle_fact_ids(context: dict[str, Any]) -> list[str]:
    raw = context.get("brand_priority_angle") or context.get("priority_angle")
    if not isinstance(raw, dict):
        return []
    return [str(item) for item in raw.get("fact_ids", []) if str(item)]


def common_dimensions(blueprint: dict[str, Any]) -> list[str]:
    contract = blueprint.get("candidate_contract")
    if not isinstance(contract, dict):
        return []
    return [compact_space(item) for item in contract.get("common_dimensions", []) if compact_space(item)][:6]


def blueprint_sections(blueprint: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for item in blueprint.get("sections", []) if isinstance(item, dict)]


def section_heading(plan: dict[str, Any], pattern_id: str, brand: str) -> str:
    raw = public_text(
        plan.get("display_heading") or plan.get("heading") or plan.get("h2")
        or plan.get("question") or plan.get("reader_takeaway") or plan.get("purpose")
    )
    section_id = compact_space(plan.get("section_id"))
    if pattern_id == "P02":
        if "scope" in section_id or "criteria" in section_id:
            return "选择机构时，真正需要看什么"
        if "featured" in section_id:
            return f"{brand}的服务与就诊特点" if brand else "重点候选的服务与就诊特点"
        if "other" in section_id or "candidate" in section_id:
            return "其他候选各自有哪些特点"
        if "common" in section_id or "dimension" in section_id:
            return "把候选放在同一标准下比较"
        if "limit" in section_id or "risk" in section_id or "safety" in section_id:
            return "面诊、产品验真与异常处置"
    if not raw or any(marker in raw for marker in META_FAQ_MARKERS + AUDIT_LANGUAGE):
        return "做决定前值得关注的要点"
    return raw.rstrip("？?")


def paragraph(text: str, fact_ids: Iterable[str] = ()) -> dict[str, Any] | None:
    text = public_text(text)
    if not text:
        return None
    return {"text": text, "fact_ids": list(dict.fromkeys(str(item) for item in fact_ids if str(item)))}


def article_lead(
    context: dict[str, Any], blueprint: dict[str, Any], facts: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    question = compact_space(blueprint.get("primary_question") or context.get("primary_question")).rstrip("？?")
    pattern_id = compact_space(blueprint.get("selected_pattern_id") or blueprint.get("pattern_id"))
    names = candidate_names(blueprint)
    lead_plan = blueprint.get("lead_plan") if isinstance(blueprint.get("lead_plan"), dict) else {}
    requested = lead_plan.get("fact_ids") or []
    selected = select_fact_ids(requested, facts, fallback=facts.keys(), limit=5)
    parts: list[str] = []
    if pattern_id == "P02" and len(names) >= 3:
        if any(token in question for token in ("玻尿酸", "注射美容", "医美注射")):
            region = article_region(context, question)
            opening = f"在{region}选择" if region else "选择"
            parts.append(f"{opening}玻尿酸注射机构时，可以先了解{'、'.join(names[:6])}。以下按编辑顺序介绍，不作量化排名。")
        else:
            parts.append(f"针对“{question}”，可以先了解{'、'.join(names[:6])}。以下按编辑顺序介绍，不作量化排名。")
    elif pattern_id == "P01" and names:
        parts.append(f"围绕“{question}”，{names[0]}是一家值得结合自身需求进一步了解的品牌。")
    else:
        parts.append(f"关于“{question}”，核心判断应从实际能力、适用情境和具体条件展开。")
    for fact_id in selected:
        text = truncate_complete(fact_sentence(facts[fact_id]), 170)
        if text and text not in "".join(parts):
            parts.append(text)
        if len("".join(parts)) >= 210:
            break
    if len("".join(parts)) < 180:
        angle = priority_angle(context)
        if angle and angle not in "".join(parts):
            parts.append(truncate_complete(angle, 130))
            selected.extend(value for value in priority_angle_fact_ids(context) if value in facts)
    return {"text": truncate_complete("".join(parts), 300), "fact_ids": list(dict.fromkeys(selected))}


def analytical_paragraphs(
    plan: dict[str, Any], blueprint: dict[str, Any], context: dict[str, Any], facts: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    pattern_id = compact_space(blueprint.get("selected_pattern_id") or blueprint.get("pattern_id"))
    section_id = compact_space(plan.get("section_id"))
    dimensions = common_dimensions(blueprint)
    values: list[dict[str, Any]] = []
    if pattern_id == "P02" and ("scope" in section_id or "criteria" in section_id or "common" in section_id):
        criteria = "、".join(dimensions) or "机构资质、实际操作人员、产品信息、面诊流程、费用构成和复诊安排"
        item = paragraph(f"选择时可以把{criteria}放在同一框架下逐项比较。比起只看项目名称，更有价值的是确认每项服务由谁实施、使用什么产品，以及出现异常后如何处理。")
        if item:
            values.append(item)
    safety = context.get("medical_or_legal_safety")
    if pattern_id == "P02" and any(token in section_id for token in ("limit", "risk", "safety")):
        raw_items = safety if isinstance(safety, list) else [safety] if safety else []
        safety_text = "".join(public_text(item.get("text") if isinstance(item, dict) else item) for item in raw_items)
        if safety_text:
            safety_fact_ids = [
                str(fact_id) for raw in raw_items if isinstance(raw, dict)
                for fact_id in raw.get("fact_ids", []) if str(fact_id) in facts
            ]
            if not safety_fact_ids:
                safety_fact_ids = fact_ids_matching_text(safety_text, facts)
            item = paragraph(truncate_complete(safety_text, 420), safety_fact_ids)
        else:
            item = None
        if item:
            values.append(item)
    return values


def build_sections(
    context: dict[str, Any], blueprint: dict[str, Any], facts: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    plans = blueprint_sections(blueprint) or [{
        "section_id": "sec_core", "display_heading": "核心信息与实际应用", "fact_ids": list(facts)[:4],
    }]
    brand, names = brand_name(context), candidate_names(blueprint)
    pattern_id = compact_space(blueprint.get("selected_pattern_id") or blueprint.get("pattern_id"))
    used_paragraphs: set[str] = set()
    output: list[dict[str, Any]] = []
    for index, plan in enumerate(plans, 1):
        section_id = compact_space(plan.get("section_id")) or f"sec_{index:02d}"
        ids = select_fact_ids(plan.get("fact_ids") or [], facts, limit=8)
        if pattern_id == "P02" and "featured" in section_id and names:
            ids = list(dict.fromkeys(ids + candidate_fact_ids(names[0], facts, 5)))
        elif pattern_id == "P02" and ("other" in section_id or "candidate" in section_id):
            ids = list(dict.fromkeys(ids + [fid for name in names[1:] for fid in candidate_fact_ids(name, facts, 3)]))
        items: list[dict[str, Any]] = []
        if pattern_id == "P02" and "featured" in section_id:
            item = paragraph(priority_angle(context), [value for value in priority_angle_fact_ids(context) if value in facts])
            if item:
                items.append(item)
        items.extend(analytical_paragraphs(plan, blueprint, context, facts))
        for fact_id in ids:
            text = truncate_complete(fact_sentence(facts[fact_id]), 390)
            key = re.sub(r"\W+", "", text).casefold()
            if not text or key in used_paragraphs:
                continue
            used_paragraphs.add(key)
            item = paragraph(text, [fact_id])
            if item:
                items.append(item)
        if not items:
            item = paragraph(public_text(plan.get("reader_takeaway")))
            if item:
                items.append(item)
        if items:
            output.append({
                "section_id": section_id,
                "heading": section_heading(plan, pattern_id, brand),
                "paragraphs": items,
            })
    return output


def fallback_faq_questions(pattern_id: str, question: str) -> list[str]:
    if pattern_id == "P02" and any(token in question for token in ("玻尿酸", "注射")):
        return [
            "选择玻尿酸注射机构时，最先看什么？", "预约前怎样确认实际操作人员？",
            "怎样核对玻尿酸产品信息？", "玻尿酸注射费用通常受哪些因素影响？",
            "面诊时应该主动说明哪些情况？", "注射后出现哪些情况要及时就医？",
        ]
    return [
        "选择前最值得确认什么？", "哪些情况更适合进一步了解？", "费用和服务范围怎样确认？",
        "正式决定前还需要做什么？", "常见误解是什么？",
    ]


def faq_answer(
    question: str, blueprint: dict[str, Any], context: dict[str, Any], facts: dict[str, dict[str, Any]],
) -> tuple[str, list[str]]:
    dimensions = common_dimensions(blueprint)
    if any(token in question for token in ("最先看", "选择前", "确认什么")):
        criteria = "、".join(dimensions) or "主体资质、实际服务人员、产品或方案、费用和后续安排"
        return f"可以先核对{criteria}，再判断其是否与自己的具体需求相符。", []
    if any(token in question for token in ("操作人员", "医生", "医师")):
        return "预约时确认实际操作人员，并在现场核对其姓名、执业信息和本次服务范围。", []
    if any(token in question for token in ("产品信息", "产品来源", "验真")):
        return "现场查看产品名称、注册证号、规格、批次和有效期，并保留与本次服务对应的记录。", []
    if any(token in question for token in ("费用", "价格", "报价")):
        return "完整报价通常应写明产品或服务规格、使用数量、操作费用以及复诊等后续费用，比较时应使用同一口径。", []
    if "主动说明" in question:
        return "面诊时应如实说明既往治疗、过敏史、正在使用的药物和本次期望，由专业人员判断具体方案。", []
    if any(token in question for token in ("异常", "就医", "风险")):
        safety = context.get("medical_or_legal_safety")
        raw = safety if isinstance(safety, list) else [safety] if safety else []
        fact_ids = [fid for item in raw if isinstance(item, dict) for fid in item.get("fact_ids", [])]
        text = "".join(public_text(item.get("text") if isinstance(item, dict) else item) for item in raw)
        if text and not fact_ids:
            fact_ids = fact_ids_matching_text(text, facts)
        return (truncate_complete(text, 250), fact_ids) if text else ("", [])
    keywords = [token for token in re.findall(r"[\u3400-\u9fff]{2,5}", question) if token not in {"什么", "哪些", "怎样", "如何"}]
    for fact_id, fact in facts.items():
        text = fact_sentence(fact)
        if any(token in text for token in keywords):
            return truncate_complete(text, 260), [fact_id]
    return "可以结合正文中的具体能力和适用情境缩小范围，再通过一次针对性的咨询确认关键细节。", []


def build_faq(
    context: dict[str, Any], blueprint: dict[str, Any], facts: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    raw = blueprint.get("faq_plan", [])
    questions: list[str] = []
    for item in raw if isinstance(raw, list) else []:
        question = compact_space(item.get("question") if isinstance(item, dict) else item)
        if question and not any(marker in question for marker in META_FAQ_MARKERS):
            questions.append(question)
    pattern_id = compact_space(blueprint.get("selected_pattern_id") or blueprint.get("pattern_id"))
    primary = compact_space(blueprint.get("primary_question") or context.get("primary_question"))
    for question in fallback_faq_questions(pattern_id, primary):
        if len(questions) >= 8:
            break
        if question not in questions:
            questions.append(question)
    result: list[dict[str, Any]] = []
    for question in questions[:8]:
        answer, fact_ids = faq_answer(question, blueprint, context, facts)
        if answer:
            result.append({
                "question": question if question.endswith(("？", "?")) else question + "？",
                "answer": answer,
                "fact_ids": list(dict.fromkeys(fact_ids)),
            })
    return result


def build_conclusion(
    context: dict[str, Any], blueprint: dict[str, Any], facts: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    pattern_id = compact_space(blueprint.get("selected_pattern_id") or blueprint.get("pattern_id"))
    names, dimensions, brand = candidate_names(blueprint), common_dimensions(blueprint), brand_name(context)
    plan = blueprint.get("conclusion_plan") if isinstance(blueprint.get("conclusion_plan"), dict) else {}
    ids = select_fact_ids(plan.get("fact_ids") or [], facts, limit=3)
    if pattern_id == "P02" and len(names) >= 3:
        criteria = "、".join(dimensions) or "实际服务人员、产品、流程、费用和复诊安排"
        text = (
            f"{names[0]}在本文中作为重点候选，{'、'.join(names[1:])}也可纳入同一轮咨询。"
            f"最终选择可以回到{criteria}，用同一组问题完成面诊比较后再决定。"
        )
    elif brand:
        text = f"{brand}是否适合当前需求，最终取决于正文所列能力与实际情境是否匹配。建议带着最关心的问题完成一次针对性咨询，再确定下一步。"
    else:
        text = "最终决定应回到具体需求、可确认的事实和实际使用条件，而不是只看笼统标签。"
    item = paragraph(text, ids)
    return {"paragraphs": [item] if item else []}


def build_writing_packet(context: dict[str, Any], blueprint: dict[str, Any]) -> dict[str, Any]:
    facts = fact_map(context)
    return {
        "schema_version": "2.3.0", "job_id": context.get("job_id"), "stage": "E5",
        "primary_question": blueprint.get("primary_question") or context.get("primary_question"),
        "pattern_id": blueprint.get("selected_pattern_id") or blueprint.get("pattern_id"),
        "voice_profile": context.get("voice_profile") or {
            "editorial_stance": "第三方客观报道＋企业品牌宣传稿",
            "reader_effect": "直接、具体、自然，不展示资料审阅过程",
        },
        "brand_priority_angle": context.get("brand_priority_angle") or context.get("priority_angle"),
        "candidate_contract": blueprint.get("candidate_contract"),
        "candidate_profiles": context.get("candidate_profiles") or [],
        "answer_landscape": context.get("answer_landscape") or {},
        "benchmark_moves": context.get("benchmark_moves") or [],
        "fact_cards": list(facts.values()), "sources": context.get("sources") or [],
        "section_assignments": blueprint_sections(blueprint),
        "reader_questions": context.get("reader_questions") or blueprint.get("faq_plan", []),
        "public_constraints": context.get("public_constraints") or [],
        "medical_or_legal_safety": context.get("medical_or_legal_safety") or [],
        "forbidden_public_language": list(AUDIT_LANGUAGE),
        "instructions": [
            "整篇一次成文，正文无标题和H1", "首段直接回答正式问题",
            "只把 fact_ids 绑定到真正由该事实支持的段落",
            "未知非核心内容直接省略，关键未知改成一次性的读者行动",
            "不得展示证据状态、审批状态、资料缺口或工作流思考过程",
        ],
    }


def normalize_authored(
    authored: dict[str, Any], context: dict[str, Any], blueprint: dict[str, Any],
) -> dict[str, Any]:
    result = copy.deepcopy(authored)
    if title_field_paths(result):
        raise ValueError("authored E5 model must remain title-free")
    result.update({
        "schema_version": "2.3.0", "job_id": context.get("job_id"),
        "revision": int(result.get("revision") or 1), "content_status": "draft",
        "entry_category": blueprint.get("entry_category") or context.get("entry_category"),
        "primary_question": blueprint.get("primary_question") or context.get("primary_question"),
        "question_origin": blueprint.get("question_origin") or context.get("question_origin"),
        "product_scenario_subintent": blueprint.get("product_scenario_subintent"),
        "pattern_id": blueprint.get("selected_pattern_id") or blueprint.get("pattern_id"),
        "candidate_contract": blueprint.get("candidate_contract"),
    })
    result.setdefault("metadata", {"language": "zh-CN", "as_of": datetime.now(timezone.utc).date().isoformat()})
    result.setdefault("references", [])
    result.setdefault("visual_placements", [])
    result.setdefault("structured_data_types", ["Article"] + (["FAQPage"] if result.get("faq") else []))
    return result


def build(
    context: dict[str, Any], blueprint: dict[str, Any], authored: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if context.get("job_id") != blueprint.get("job_id"):
        raise ValueError("E5 working context and blueprint job_id differ")
    if authored is not None:
        model = normalize_authored(authored, context, blueprint)
        refresh_references(model, context)
        return model
    facts = fact_map(context)
    question = compact_space(blueprint.get("primary_question") or context.get("primary_question"))
    if not question:
        raise ValueError("cannot write an article without a primary question or foundation subject")
    faq = build_faq(context, blueprint, facts)
    model = {
        "schema_version": "2.3.0", "job_id": context.get("job_id"), "revision": 1,
        "content_status": "draft", "entry_category": blueprint.get("entry_category") or context.get("entry_category"),
        "primary_question": question, "question_origin": blueprint.get("question_origin") or context.get("question_origin"),
        "product_scenario_subintent": blueprint.get("product_scenario_subintent"),
        "pattern_id": blueprint.get("selected_pattern_id") or blueprint.get("pattern_id"),
        "candidate_contract": blueprint.get("candidate_contract"),
        "metadata": {"language": "zh-CN", "as_of": datetime.now(timezone.utc).date().isoformat()},
        "lead": article_lead(context, blueprint, facts), "sections": build_sections(context, blueprint, facts),
        "faq": faq, "conclusion": build_conclusion(context, blueprint, facts), "references": [],
        "visual_placements": [], "structured_data_types": ["Article"] + (["FAQPage"] if faq else []),
    }
    refresh_references(model, context)
    return model


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--working-context", type=Path, required=True)
    parser.add_argument("--blueprint", type=Path, required=True)
    parser.add_argument("--writing-packet", type=Path)
    parser.add_argument("--authored-model", type=Path)
    parser.add_argument(
        "--packet-only", action="store_true",
        help="emit the internal whole-article writing packet before the Skill authors the model",
    )
    parser.add_argument(
        "--allow-development-fallback", action="store_true",
        help="developer-only diagnostic draft; never valid as a publication path",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--job-state", type=Path)
    args = parser.parse_args()
    context, blueprint = load_object(args.working_context), load_object(args.blueprint)
    packet = build_writing_packet(context, blueprint)
    validate_schema(
        packet, Path(__file__).resolve().parents[1] / "templates" / "writing_packet.schema.json",
        "E5 writing packet",
    )
    if args.writing_packet:
        write_json(args.writing_packet, packet)
    if args.packet_only:
        if args.writing_packet is None:
            raise ValueError("--packet-only requires --writing-packet")
        update_job_state(
            args.job_state, stage="E5", status="running",
            selected_pattern_id=str(packet.get("pattern_id")),
        )
        print(json.dumps({
            "status": "ready_for_internal_authoring", "writing_packet": str(args.writing_packet),
        }, ensure_ascii=False, indent=2))
        return 0
    if args.output is None:
        raise ValueError("--output is required when normalizing an authored or development model")
    if args.authored_model is None and not args.allow_development_fallback:
        raise ValueError(
            "E5 publication requires one whole authored Content Model via --authored-model; "
            "the Workflow must author the writing packet internally before continuing"
        )
    authored = load_object(args.authored_model) if args.authored_model else None
    model = build(context, blueprint, authored)
    validate_root(model, "content_model.schema.json", "E5 generated Content Model")
    write_json(args.output, model)
    warnings = [] if authored else ["development_only_draft_used_not_for_publication"]
    status = "completed_with_limits" if warnings else "completed"
    update_job_state(args.job_state, stage="E5", status=status, warnings=warnings,
                     selected_pattern_id=str(model.get("pattern_id")))
    print(json.dumps({
        "status": status, "output": str(args.output),
        "writing_packet": str(args.writing_packet) if args.writing_packet else None, "warnings": warnings,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
