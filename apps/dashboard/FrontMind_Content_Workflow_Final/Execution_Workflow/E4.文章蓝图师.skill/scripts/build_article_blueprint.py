#!/usr/bin/env python3
"""Build a user-confirmed, benchmark-informed E4 v2.3 article blueprint."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from schema_validation import validate_root  # noqa: E402

PATTERN_RE = re.compile(r"P(?:0[1-9]|1[0-6])")
ROLE_KEYWORDS = {
    "context": ("定位", "问题", "场景", "身份", "发展", "范围"),
    "evaluation": ("选择", "标准", "条件", "适用", "价格", "决策"),
    "evidence": ("能力", "产品", "服务", "技术", "团队", "项目", "案例"),
    "comparison": ("对比", "差异", "候选", "品牌", "机构"),
    "process": ("流程", "交付", "使用", "预约", "复诊", "服务"),
    "explanation": ("定义", "机制", "模块", "输入", "输出", "原理"),
    "limitations": ("适合", "不适合", "风险", "限制", "安全", "替代"),
}


def normal(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", str(value or ""))).strip()


def load_object(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            if not content.endswith("\n"):
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def write_json(path: Path, value: dict[str, Any]) -> None:
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2))


def pattern_map(registry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item.get("id")): item for item in registry.get("patterns", [])
            if isinstance(item, dict) and PATTERN_RE.fullmatch(str(item.get("id") or ""))}


def research_map(index: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item.get("pattern_id")): item for item in index.get("patterns", [])
            if isinstance(item, dict) and PATTERN_RE.fullmatch(str(item.get("pattern_id") or ""))}


def allowed_patterns(registry: dict[str, Any], entry: str, subintent: str | None) -> list[str]:
    route = (registry.get("routing") or {}).get(entry) or {}
    if entry == "product_scenario" and subintent:
        values = [*(route.get("subintent_routing") or {}).get(subintent, []), *route.get("secondary_patterns", [])]
    else:
        values = [*route.get("primary_patterns", []), *route.get("secondary_patterns", [])]
    return list(dict.fromkeys(str(item) for item in values if PATTERN_RE.fullmatch(str(item))))


def pause(code: str, message: str, **details: Any) -> int:
    print(json.dumps({
        "stage": "E4", "status": "awaiting_pattern_confirmation", "code": code,
        "message": message, **details,
    }, ensure_ascii=False))
    return 0


def usable_facts(context: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for item in context.get("facts", [])
            if isinstance(item, dict) and item.get("usage_status") in {"usable", "qualified"}]


def fact_ids_for_role(facts: list[dict[str, Any]], role: str, question: str, limit: int = 8) -> list[str]:
    cues = ROLE_KEYWORDS.get(role, ())
    question_terms = re.findall(r"[\u3400-\u9fff]{2,6}", question)
    scored: list[tuple[int, int, str]] = []
    for order, item in enumerate(facts):
        statement = normal(item.get("statement"))
        score = sum(3 for cue in cues if cue in statement) + sum(1 for cue in question_terms if cue in statement)
        score += 2 if item.get("usage_status") == "usable" else 0
        score += min(len(statement) // 50, 3)
        scored.append((-score, order, str(item.get("fact_id"))))
    return [item[2] for item in sorted(scored)[:limit] if item[2].startswith(("fact_", "clm_"))]


def supported_profiles(context: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for item in context.get("candidate_profiles", []):
        if not isinstance(item, dict) or not normal(item.get("display_name")):
            continue
        result.append(dict(item))
    result.sort(key=lambda item: (0 if item.get("role") == "featured_brand" else 1, -int(item.get("mention_count") or 0), normal(item.get("display_name"))))
    return result


def reorder_profiles(profiles: list[dict[str, Any]], requested: list[Any]) -> list[dict[str, Any]]:
    if not requested:
        return profiles
    by_key = {}
    for item in profiles:
        by_key[normal(item.get("entity_id"))] = item
        by_key[normal(item.get("display_name"))] = item
    ordered, seen = [], set()
    for value in requested:
        item = by_key.get(normal(value))
        if item is None:
            raise ValueError(f"blueprint_edit_invalid: unknown candidate {value!r}")
        marker = str(item.get("entity_id"))
        if marker not in seen:
            ordered.append(item)
            seen.add(marker)
    ordered.extend(item for item in profiles if str(item.get("entity_id")) not in seen)
    return ordered


def candidate_contract(pattern_id: str, profiles: list[dict[str, Any]], question: str) -> dict[str, Any] | None:
    if pattern_id not in {"P01", "P02"}:
        return None
    featured = next((item for item in profiles if item.get("role") == "featured_brand"), None)
    if featured is None:
        return None
    selected = [featured] if pattern_id == "P01" else [
        featured,
        *(item for item in profiles if item is not featured
          and item.get("evidence_status") == "publicly_supported"
          and item.get("fact_ids") and item.get("source_ids")),
    ]
    if pattern_id == "P02" and any(token in question for token in ("玻尿酸", "注射", "医美", "整形")):
        dimensions = ["机构与医生资质", "产品来源与验真", "面诊评估与适用需求", "风险告知与异常处置", "费用构成"]
    else:
        dimensions = ["定位与适用情境", "产品或服务能力", "交付流程与重要条件"]
    return {
        "featured_brand_entity_id": str(featured["entity_id"]),
        "ordered_candidates": [{
            "entity_id": str(item["entity_id"]), "display_name": normal(item["display_name"]),
            "source_ids": list(dict.fromkeys(str(value) for value in item.get("source_ids", []))),
            "fact_ids": list(dict.fromkeys(str(value) for value in item.get("fact_ids", []))),
            "role": "featured_brand" if item is featured else "candidate",
        } for item in selected],
        "common_dimensions": [] if pattern_id == "P01" else dimensions,
    }


def readiness_issue(pattern_id: str, profiles: list[dict[str, Any]], facts: list[dict[str, Any]]) -> tuple[str, str] | None:
    featured = [item for item in profiles if item.get("role") == "featured_brand" and item.get("fact_ids")]
    candidates = [
        item for item in profiles
        if item.get("role") != "featured_brand"
        and item.get("evidence_status") == "publicly_supported"
        and item.get("fact_ids") and item.get("source_ids")
    ]
    if pattern_id == "P01" and not featured:
        return "p01_brand_evidence_insufficient", "P01 需要至少一组可用的客户品牌事实。"
    if pattern_id == "P02" and (not featured or len(candidates) < 2):
        return "p02_candidate_evidence_insufficient", "P02 需要客户品牌和至少两个具有公开来源或事实的真实候选。"
    comparison_ready = [*featured, *candidates]
    if pattern_id == "P03" and len(comparison_ready) < 2:
        return "p03_comparison_evidence_insufficient", "P03 需要至少两个明确对象的可比较资料。"
    statements = [normal(item.get("statement")) for item in facts]
    if pattern_id == "P10" and not any(re.search(r"\d", statement) for statement in statements):
        return "p10_research_data_insufficient", "P10 研究与白皮书需要实际研究数据。"
    if pattern_id == "P12" and not any(any(cue in statement for cue in ("案例", "项目", "客户", "实施结果")) for statement in statements):
        return "p12_case_record_insufficient", "P12 需要真实案例或项目记录。"
    return None


def select_benchmarks(context: dict[str, Any], pattern_id: str, ranks: list[Any]) -> list[dict[str, Any]]:
    values = [item for item in context.get("benchmark_moves", [])
              if isinstance(item, dict) and item.get("pattern_id") == pattern_id]
    if ranks:
        selected_ranks = {int(value) for value in ranks if isinstance(value, int) or str(value).isdigit()}
        unknown = selected_ranks - {int(item["rank"]) for item in values}
        if unknown:
            raise ValueError(f"blueprint_edit_invalid: benchmark ranks are not same-pattern Top20 pages: {sorted(unknown)}")
        values = [item for item in values if int(item["rank"]) in selected_ranks]
    values.sort(key=lambda item: (-float(item.get("classification_confidence") or 0), -int(item.get("citation_count") or 0), int(item.get("rank") or 999)))
    return values[:5]


def benchmark_refs(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{
        "rank": int(item["rank"]), "title": normal(item["title"]), "url": str(item["url"]),
        "pattern_id": str(item["pattern_id"]), "classification_confidence": float(item["classification_confidence"]),
        "citation_count": int(item["citation_count"]),
        "benchmark_id": normal(item.get("benchmark_id")) or None,
        "structure_summary": normal(item["structure_summary"]),
        "structure_observations": list(dict.fromkeys(
            normal(value) for value in item.get("structure_observations", []) if normal(value)
        )),
        "subquestions": list(dict.fromkeys(
            normal(value) for value in item.get("subquestions", []) if normal(value)
        )),
        "evidence_positions": list(dict.fromkeys(
            normal(value) for value in item.get("evidence_positions", []) if normal(value)
        )),
        "selection_rationale": normal(item.get("selection_rationale")) or None,
        "benchmark_moves": list(dict.fromkeys(normal(value) for value in item.get("adoptable_moves", []) if normal(value))),
    } for item in values]


def heading_for(pattern_id: str, component_id: str, purpose: str, brand: str, medical: bool) -> str:
    special = {
        "P01_component_selection_criteria": "选择这类品牌，真正应该看什么",
        "P01_component_brand_fit": f"{brand}的定位、能力与适用需求",
        "P01_component_delivery": "从咨询到交付，服务如何展开",
        "P01_component_limitations": "哪些需求更适合，什么情况应选其他路径",
        "P02_component_scope_criteria": "选择玻尿酸注射机构，真正应该看什么" if medical else "这份推荐重点关注哪些选择标准",
        "P02_component_featured_brand": f"{brand}：从专业能力到服务体验的重点观察",
        "P02_component_other_candidates": "其他值得关注的真实候选",
        "P02_component_common_dimensions": "不同需求下，候选之间的差异在哪里",
        "P02_component_limitations": "面诊、产品验真与异常处置" if medical else "按具体需求做条件式选择",
        "P14_component_problem_positioning": "企业正在解决什么问题",
        "P14_component_capabilities": "产品、服务与团队能力如何配合",
        "P14_component_cases": "能力如何落到具体项目",
        "P14_component_limits": "哪些需求与合作情境更匹配",
    }
    return special.get(component_id, purpose or "核心判断与适用情境")


def build_sections(
    pattern: dict[str, Any], research: dict[str, Any], facts: list[dict[str, Any]],
    candidates: dict[str, Any] | None, profiles: list[dict[str, Any]],
    benchmarks: list[dict[str, Any]], question: str, brand: str,
) -> list[dict[str, Any]]:
    components = sorted(
        (item for item in pattern.get("structure_components", []) if isinstance(item, dict)),
        key=lambda item: (int(item.get("order_band") or 99), normal(item.get("component_id"))),
    )
    structure = [normal(item) for item in pattern.get("structure", []) if normal(item)]
    design = research.get("design_contract") if isinstance(research.get("design_contract"), dict) else {}
    recommended = [normal(item) for item in design.get("recommended_structure", []) if normal(item)]
    selected_id = str(pattern.get("id"))
    medical = any(token in question for token in ("玻尿酸", "注射", "医美", "整形"))
    candidate_items = (candidates or {}).get("ordered_candidates", [])
    all_candidate_ids = [str(item["entity_id"]) for item in candidate_items]
    featured_ids = [str(item["entity_id"]) for item in candidate_items if item.get("role") == "featured_brand"]
    other_ids = [str(item["entity_id"]) for item in candidate_items if item.get("role") == "candidate"]
    sections = []
    benchmark_moves_flat = [move for item in benchmarks for move in item.get("adoptable_moves", [])]
    for component in components:
        role = normal(component.get("component_role")).casefold()
        if role in {"lead", "faq", "conclusion"}:
            continue
        component_id = normal(component.get("component_id"))
        order = int(component.get("order_band") or len(sections) + 2)
        purpose = structure[order - 1] if 0 < order <= len(structure) else ""
        template_move = recommended[min(len(sections), len(recommended) - 1)] if recommended else purpose
        role_facts = fact_ids_for_role(facts, role, question)
        candidate_ids = all_candidate_ids
        if component_id.endswith("featured_brand"):
            candidate_ids = featured_ids
            role_facts = list(dict.fromkeys([
                *[fact_id for item in candidate_items if item.get("role") == "featured_brand" for fact_id in item.get("fact_ids", [])],
                *role_facts,
            ]))[:10]
        elif component_id.endswith("other_candidates"):
            candidate_ids = other_ids
            role_facts = list(dict.fromkeys([
                *[fact_id for item in candidate_items if item.get("role") == "candidate" for fact_id in item.get("fact_ids", [])],
                *role_facts,
            ]))[:12]
        elif selected_id == "P03":
            candidate_ids = [
                str(item["entity_id"]) for item in profiles
                if item.get("role") == "featured_brand" or item.get("evidence_status") == "publicly_supported"
            ]
        elif selected_id not in {"P01", "P02"}:
            candidate_ids = []
        if component.get("required") is False and not role_facts:
            continue
        suffix = re.sub(r"^P\d+_component_", "", component_id, flags=re.I)
        suffix = re.sub(r"[^a-z0-9_-]+", "_", suffix.casefold()).strip("_") or f"section_{len(sections) + 1}"
        benchmark_move = benchmark_moves_flat[len(sections) % len(benchmark_moves_flat)] if benchmark_moves_flat else ""
        visual_role = "explain" if role == "explanation" else "navigate" if role == "process" else None
        sections.append({
            "section_id": f"sec_{suffix}",
            "display_heading": heading_for(selected_id, component_id, purpose, brand, medical),
            "editorial_job": f"以“{template_move or purpose}”为预研骨架，回答当前问题；只使用分配的事实与候选资料。",
            "reader_takeaway": f"读者能从本节掌握{purpose or template_move}的具体判断。",
            "fact_ids": list(dict.fromkeys(role_facts[:10])), "candidate_ids": list(dict.fromkeys(candidate_ids)),
            "benchmark_moves": [benchmark_move] if benchmark_move else [], "visual_role": visual_role,
        })
    if not sections:
        sections.append({
            "section_id": "sec_core", "display_heading": "从核心事实看当前问题",
            "editorial_job": "用现有事实完成核心回答。", "reader_takeaway": "读者能够得到明确、具体的决策信息。",
            "fact_ids": [str(item["fact_id"]) for item in facts[:10]], "candidate_ids": [],
            "benchmark_moves": [], "visual_role": None,
        })
    return sections


def faq_plan(
    context: dict[str, Any], research: dict[str, Any], pattern_id: str,
    question: str, benchmarks: list[dict[str, Any]],
) -> list[str]:
    blocked = (
        "这份名单是客观排名吗", "为什么先介绍", "有哪些可核验信息", "尚未回答",
        "是否需要我", "是否需要继续", "是否需要进一步", "是否需要把",
        "Secondary Menu", "Main Menu", "Jump to", "Navigation", "PERMALINK",
        "候选名单依据什么形成", "其他候选各有哪些独立公开特点",
    )
    values = [normal(item) for item in context.get("reader_questions", []) if normal(item)]
    design = research.get("design_contract") if isinstance(research.get("design_contract"), dict) else {}
    # Only manually reviewed benchmark subquestions are promoted.  Raw page
    # headings remain excluded because they can contain navigation chrome.
    values.extend(
        normal(question)
        for benchmark in benchmarks
        if normal(benchmark.get("benchmark_id"))
        for question in benchmark.get("subquestions", [])
        if normal(question)
    )
    medical_p02 = pattern_id == "P02" and any(token in question for token in ("玻尿酸", "注射", "医美", "整形"))
    if medical_p02:
        values.extend([
            "打玻尿酸前怎么查机构和医生资质？", "如何确认玻尿酸产品的注册信息和批次？",
            "额头、鼻唇沟和轮廓改善，为什么不能使用同一种方案？", "玻尿酸注射费用通常由哪些部分构成？",
            "出现剧痛、皮肤颜色异常或视力变化时应该怎么做？", "注射后的观察和复诊应如何安排？",
            "在三家机构之间安排面诊时，应该比较哪些重点？",
        ])
    # Pattern Research supplies professionally reviewed reader questions.
    # Unreviewed runtime page headings are not promoted to FAQ.
    if not medical_p02:
        values.extend(normal(item) for item in design.get("typical_subquestions", []) if normal(item))
    if not medical_p02:
        values.extend([
            "做决定前最应该核对哪些条件？", "哪些需求更适合这类选择？",
            "影响费用或交付结果的因素有哪些？", "开始前应该准备哪些信息？",
            "出现预期外情况时应该如何处理？",
        ])
    def topic_key(value: str) -> str:
        groups = (
            ("资质", ("资质", "执业")),
            ("产品验真", ("产品", "注册", "批次", "验真")),
            ("费用", ("费用", "价格", "收费")),
            ("风险处置", ("剧痛", "颜色异常", "视力", "异常", "风险")),
            ("复诊", ("复诊", "观察")),
            ("部位需求", ("部位", "需求", "适合")),
            ("面诊比较", ("面诊", "三家", "比较")),
        )
        for key, tokens in groups:
            if any(token in value for token in tokens):
                return key
        return value.rstrip("？?").casefold()

    result: list[str] = []
    topic_positions: dict[str, int] = {}
    for value in values:
        if any(token in value for token in blocked):
            continue
        if not re.search(r"[\u3400-\u9fff]", value):
            continue
        if not value.endswith(("？", "?")):
            value += "？"
        topic = topic_key(value)
        if value in result:
            continue
        if topic not in topic_positions:
            topic_positions[topic] = len(result)
            result.append(value)
        else:
            # When a reviewed benchmark contributes a short wording for a
            # topic also covered by the professional template, retain the
            # more specific reader question instead of whichever appeared
            # first.  This preserves reviewed novel questions without
            # degrading medical/product-verification detail.
            position = topic_positions[topic]
            if len(value) > len(result[position]):
                result[position] = value
    return result[:8]


def priority_angle(context: dict[str, Any], selected: str, facts: list[dict[str, Any]], brand: str) -> dict[str, Any] | None:
    item = context.get("brand_priority_angle")
    if isinstance(item, dict):
        eligible = item.get("eligible_pattern_ids") or []
        if not eligible or selected in eligible:
            return {"angle": normal(item.get("allowed_wording") or item.get("angle")), "fact_ids": list(item.get("fact_ids") or []), "editorial_priority_only": True}
    if selected in {"P01", "P02", "P14"}:
        return {
            "angle": f"从{brand}的定位、核心能力与适用需求形成自然重点。",
            "fact_ids": [str(item["fact_id"]) for item in facts[:4]], "editorial_priority_only": True,
        }
    return None


def visual_plan(context: dict[str, Any], sections: list[dict[str, Any]], research: dict[str, Any]) -> list[dict[str, Any]]:
    design = research.get("design_contract") if isinstance(research.get("design_contract"), dict) else {}
    recipe = []
    for item in design.get("visual_recipe", []):
        if isinstance(item, dict):
            summary = "：".join(value for value in (
                normal(item.get("role")), normal(item.get("use_when")), normal(item.get("source_policy")),
            ) if value)
        else:
            summary = normal(item)
        if summary:
            recipe.append(summary)
    recipe_hint = f" 本模式预研建议：{'；'.join(recipe[:3])}" if recipe else ""
    values = [{
        "after_section_id": None, "role": "brand_editorial",
        "brief": f"有合规品牌资产时制作编辑型封面；Logo 必须使用原始文件 overlay。{recipe_hint}", "required": False,
    }]
    if sections:
        values.append({
            "after_section_id": sections[0]["section_id"], "role": "explain",
            "brief": "用流程、关系或选择逻辑图解释本文的核心判断，不将装饰视觉当作证据。", "required": False,
        })
    if any(item.get("rights_status") in {"approved", "approved_with_credit"} and "prove" in item.get("usable_for", []) for item in context.get("visual_assets", [])):
        values.append({
            "after_section_id": sections[-1]["section_id"] if sections else None, "role": "prove",
            "brief": "仅使用能够对应正文事实的真实产品、案例、证书或数据视觉。", "required": False,
        })
    return values


def apply_blueprint_edits(payload: dict[str, Any], edits: dict[str, Any]) -> None:
    if not edits:
        return
    allowed = {"selected_benchmark_ranks", "candidate_order", "section_order", "section_updates", "faq_plan", "priority_angle_text"}
    unknown = set(edits) - allowed
    if unknown:
        raise ValueError(f"blueprint_edit_invalid: unsupported keys {sorted(unknown)}")
    if edits.get("section_order"):
        requested = [normal(item) for item in edits["section_order"]]
        by_id = {item["section_id"]: item for item in payload["sections"]}
        if len(requested) != len(set(requested)) or set(requested) != set(by_id):
            raise ValueError("blueprint_edit_invalid: section_order must contain every existing section exactly once")
        payload["sections"] = [by_id[item] for item in requested]
    by_id = {item["section_id"]: item for item in payload["sections"]}
    for edit in edits.get("section_updates", []):
        if not isinstance(edit, dict) or normal(edit.get("section_id")) not in by_id:
            raise ValueError("blueprint_edit_invalid: section update references an unknown section")
        target = by_id[normal(edit["section_id"])]
        for key in ("display_heading", "editorial_job", "reader_takeaway", "visual_role"):
            if key in edit:
                if key != "visual_role" and not normal(edit[key]):
                    raise ValueError(f"blueprint_edit_invalid: {key} cannot be empty")
                target[key] = edit[key]
    if "faq_plan" in edits:
        values = list(dict.fromkeys(normal(item) for item in edits["faq_plan"] if normal(item)))
        if not 5 <= len(values) <= 8:
            raise ValueError("blueprint_edit_invalid: faq_plan must contain 5–8 unique questions")
        payload["faq_plan"] = values
    if "priority_angle_text" in edits:
        if payload["priority_angle"] is None or not normal(edits["priority_angle_text"]):
            raise ValueError("blueprint_edit_invalid: priority angle is unavailable or empty")
        payload["priority_angle"]["angle"] = normal(edits["priority_angle_text"])


def render_review(payload: dict[str, Any], pattern: dict[str, Any], context: dict[str, Any]) -> str:
    selection = payload["pattern_selection"]
    lines = [
        "# E4 文章蓝图确认", "", f"**正式问题：** {payload['primary_question']}",
        f"**文章类型：** {payload['selected_pattern_id']} {normal(pattern.get('name'))}",
        f"**E2 建议：** {selection['recommended_pattern_id'] or '不适用'}",
        f"**选择说明：** {selection['reason']}", "",
    ]
    if payload.get("priority_angle"):
        lines.extend(["## 客户品牌重点角度", "", payload["priority_angle"]["angle"], ""])
    contract = payload.get("candidate_contract")
    if contract:
        lines.extend(["## 候选顺序", ""])
        lines.extend(f"{index}. {item['display_name']}" for index, item in enumerate(contract["ordered_candidates"], 1))
        lines.append("")
    lines.extend(["## 实时标杆及其影响", ""])
    if payload["benchmark_refs"]:
        for item in payload["benchmark_refs"]:
            lines.append(f"- Top20 第 {item['rank']} 名：[{item['title']}]({item['url']})")
            if item.get("selection_rationale"):
                lines.append(f"  - 选用理由：{item['selection_rationale']}")
            lines.extend(f"  - 结构观察：{value}" for value in item.get("structure_observations", []))
            lines.extend(f"  - 证据位置：{value}" for value in item.get("evidence_positions", []))
            lines.extend(f"  - 读者子问题：{value}" for value in item.get("subquestions", []))
            lines.extend(f"  - {move}" for move in item["benchmark_moves"])
    else:
        lines.append("- 没有同 P 实时标杆，将由预研模板独立承接。")
    lines.extend(["", "## 最终结构", ""])
    for index, section in enumerate(payload["sections"], 1):
        lines.append(f"{index}. **{section['display_heading']}**")
        lines.append(f"   - 读者收获：{section['reader_takeaway']}")
    lines.extend(["", "## FAQ 方向", ""])
    lines.extend(f"- {item}" for item in payload["faq_plan"])
    lines.extend(["", "## 视觉角色", ""])
    lines.extend(f"- {item['role']}：{item['brief']}" for item in payload["visual_plan"])
    if context.get("medical_or_legal_safety"):
        lines.extend(["", "## 必须自然写入的安全信息", ""])
        lines.extend(f"- {item}" for item in context["medical_or_legal_safety"])
    if payload.get("limitations"):
        lines.extend(["", "## 禁写主张与内容底线", ""])
        lines.extend(f"- {item}" for item in payload["limitations"][:12])
    lines.extend(["", "确认后进入 E5 无标题完整成文。"])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build E4 v2.3 confirmed article blueprint")
    parser.add_argument("--content-job", type=Path, required=True)
    parser.add_argument("--working-context", type=Path, required=True)
    parser.add_argument("--pattern-registry", type=Path, required=True)
    parser.add_argument("--pattern-research-index", type=Path, required=True)
    parser.add_argument("--selected-pattern")
    parser.add_argument("--blueprint-edits", type=Path)
    parser.add_argument("--blueprint-review", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    job, context = load_object(args.content_job), load_object(args.working_context)
    registry, research_index = load_object(args.pattern_registry), load_object(args.pattern_research_index)
    patterns, research = pattern_map(registry), research_map(research_index)
    task = job.get("task") if isinstance(job.get("task"), dict) else {}
    entry = str(job.get("entry_category") or "")
    question = normal(task.get("question_text"))
    if entry == "foundation_start":
        subject = normal(task.get("foundation_subject")) or normal(context.get("primary_question"))
        question = f"{subject}如何介绍企业身份、定位、产品服务、实施能力与适用需求？"
        if args.selected_pattern and args.selected_pattern != "P14":
            return pause("foundation_pattern_conflict", "foundation_start 只能使用 P14。", allowed_patterns=["P14"])
        selected, source = "P14", "foundation_template"
    else:
        if not args.selected_pattern:
            return pause("pattern_confirmation_required", "请在 E2 确认一个合法 P 类型后继续。")
        if not PATTERN_RE.fullmatch(args.selected_pattern):
            return pause("pattern_selection_invalid", "selected_pattern 必须是 P01–P16。")
        selected, source = args.selected_pattern, "user_confirmed"
    if not question:
        raise ValueError("unknown_subject: E4 cannot identify the article question")
    subintent = task.get("product_scenario_subintent") if entry == "product_scenario" else None
    allowed = allowed_patterns(registry, entry, subintent)
    if selected not in allowed:
        return pause("entry_route_conflict", f"{selected} 不属于当前入口的合法路由。", allowed_patterns=allowed)
    plural_recommendation = entry == "industry_ranking" and any(
        cue in question for cue in ("有哪些", "哪些", "哪几家", "排行榜", "推荐榜", "榜单", "多家")
    )
    singular_recommendation = entry == "industry_ranking" and any(
        cue in question for cue in ("推荐一家", "一家推荐", "为什么推荐")
    )
    plain_recommendation = not any(
        cue in question for cue in ("价格", "费用", "预算", "风险", "限制", "白皮书", "研究", "案例", "观点", "评论")
    )
    if plural_recommendation and plain_recommendation and selected != "P02":
        return pause(
            "question_pattern_conflict",
            "正式问题明确要求多个推荐对象，当前模式无法完整回答；请确认 P02 或修改正式问题。",
            allowed_patterns=["P02"],
        )
    if singular_recommendation and plain_recommendation and selected != "P01":
        return pause(
            "question_pattern_conflict",
            "正式问题明确只要求一家推荐，当前模式会改变任务范围；请确认 P01 或修改正式问题。",
            allowed_patterns=["P01"],
        )
    if selected not in patterns or selected not in research:
        raise ValueError(f"template_contract_missing: {selected} is absent from Registry or Pattern Research Index")

    edits = load_object(args.blueprint_edits)
    profiles = reorder_profiles(supported_profiles(context), edits.get("candidate_order", []))
    facts = usable_facts(context)
    issue = readiness_issue(selected, profiles, facts)
    if issue:
        code, message = issue
        ready_profiles = [
            item for item in profiles
            if item.get("role") == "featured_brand"
            or (item.get("evidence_status") == "publicly_supported" and item.get("fact_ids") and item.get("source_ids"))
        ]
        return pause(
            code, message, selected_pattern_id=selected,
            eligible_candidate_count=len(ready_profiles),
            eligible_candidates=[normal(item.get("display_name")) for item in ready_profiles],
            discovery_only_candidates=[
                normal(item.get("display_name")) for item in profiles
                if item.get("role") != "featured_brand" and item.get("evidence_status") != "publicly_supported"
            ],
        )
    contract = candidate_contract(selected, profiles, question)
    selected_benchmarks = select_benchmarks(context, selected, edits.get("selected_benchmark_ranks", []))
    pattern, research_contract = patterns[selected], research[selected]
    research_design = research_contract.get("design_contract") if isinstance(research_contract.get("design_contract"), dict) else {}
    refs = benchmark_refs(selected_benchmarks)
    brand = normal((context.get("brand") or {}).get("canonical_name"))
    sections = build_sections(
        pattern, research_contract, facts, contract, profiles, selected_benchmarks, question, brand,
    )
    recommended = (context.get("research_summary") or {}).get("recommended_pattern_id")
    limits = list(dict.fromkeys([
        *[normal(item) for item in context.get("public_constraints", []) if normal(item)],
        *[normal(item) for item in context.get("medical_or_legal_safety", []) if normal(item)],
        *[normal(item) for item in pattern.get("quality_gates", []) if normal(item)],
        *[normal(item) for item in (research_contract.get("design_contract") or {}).get("quality_gates", []) if normal(item)],
        *[f"不得采用：{normal(item)}" for item in (research_contract.get("design_contract") or {}).get("anti_patterns", []) if normal(item)],
    ]))
    lead_candidate_ids = [item["entity_id"] for item in (contract or {}).get("ordered_candidates", [])]
    if selected == "P03":
        lead_candidate_ids = [
            str(item["entity_id"]) for item in profiles
            if item.get("role") == "featured_brand" or item.get("evidence_status") == "publicly_supported"
        ]
    lead_facts = list(dict.fromkeys([
        *[fact_id for item in (contract or {}).get("ordered_candidates", []) for fact_id in item.get("fact_ids", [])],
        *[fact_id for item in profiles if str(item.get("entity_id")) in lead_candidate_ids for fact_id in item.get("fact_ids", [])],
        *fact_ids_for_role(facts, "evidence", question),
    ]))[:8]
    payload = {
        "schema_version": "2.3.0", "job_id": job.get("job_id"), "entry_category": entry,
        "primary_question": question,
        "question_origin": task.get("question_origin") or context.get("question_origin"),
        "product_scenario_subintent": subintent, "selected_pattern_id": selected,
        "pattern_selection": {
            "source": source, "recommended_pattern_id": recommended,
            "changed_from_recommendation": bool(recommended and selected != recommended),
            "reason": (
                f"用户在 E2 确认 {selected}；"
                f"{'E2 原建议与该选择一致。' if selected == recommended else f'E2 建议为 {recommended}，本次按用户确认的合法模式继续。'}"
                if source == "user_confirmed" else "基础启动使用固定 P14 品牌深度特写模板。"
            ),
        },
        "priority_angle": priority_angle(context, selected, facts, brand),
        "candidate_contract": contract, "benchmark_refs": refs,
        "title_formula_plan": list(dict.fromkeys([
            *[normal(item) for item in research_design.get("title_formulas", []) if normal(item)],
            "必要的年份＋自然相关的地区或场景＋核心品类＋推荐/对比/指南＋具体决策问题",
            "E10 根据最终正文单独生成，不反向改写正文",
        ])),
        "lead_plan": {
            "purpose": "用 200–300 字直接回答正式问题，先给出真实候选与条件式判断，不展示工作流程思考。",
            "fact_ids": lead_facts, "candidate_ids": lead_candidate_ids,
            "limitations": limits[:5], "length_target": {"minimum": 200, "maximum": 300},
        },
        "sections": sections,
        "faq_plan": faq_plan(context, research_contract, selected, question, selected_benchmarks),
        "conclusion_plan": {
            "purpose": "回收正文已经展开的差异、适用需求与下一步动作，不新增排名或疗效结论。",
            "fact_ids": lead_facts, "limitations": limits[:6],
        },
        "visual_plan": visual_plan(context, sections, research_contract), "limitations": limits,
    }
    apply_blueprint_edits(payload, edits)
    validate_root(payload, "article_blueprint.schema.json", "E4 article blueprint")
    write_json(args.output, payload)
    review = args.blueprint_review or args.output.with_name("blueprint_review.md")
    atomic_write(review, render_review(payload, pattern, context))
    print(json.dumps({
        "stage": "E4", "status": "completed", "selected_pattern_id": selected,
        "benchmark_count": len(refs), "section_count": len(payload["sections"]),
        "blueprint_review": str(review), "output": str(args.output),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
