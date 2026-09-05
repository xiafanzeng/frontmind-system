#!/usr/bin/env python3
"""Produce the content-bearing S3-S8 strategy assets for Workflow v2.3.

This content producer consumes the lightweight S2 registries and writes the
strategy assets used by the execution layer without adding identity-checking state.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "2.3.0"
STAGE_ORDER = ("S3", "S4", "S5", "S6", "S7", "S8")
PUBLIC_STATUSES = {"usable", "qualified"}
ENTRY_LABELS = {
    "industry_ranking": "行业排名",
    "competitor_comparison": "竞品对比",
    "reputation": "美誉舆情",
    "product_scenario": "产品场景",
    "foundation_start": "基础启动",
}
CLAIM_LABELS = {
    "product": "产品与服务",
    "specification": "规格与版本",
    "price": "价格与选型",
    "capability": "能力与交付",
    "case_result": "项目与案例",
    "event": "品牌动态",
    "limitation": "限制与适用条件",
    "knowledge_statement": "品牌与业务",
}
FORBIDDEN_PUBLIC_PHRASES = [
    "资料较完整",
    "相关资料显示",
    "以审核为准",
    "服务边界",
    "信息边界",
    "保持克制",
    "用户提交资料",
    "需要说明",
    "不构成对",
    "待核验候选",
    "当前团队与产品待核验",
    "当前可公开资料不足",
    "资料粒度不同",
]


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_md(path: Path, lines: Iterable[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def label_for(brand: str) -> str:
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_-]+", "_", brand).strip("_") or "brand"


def find_one(work_dir: Path, pattern: str, required: bool = True) -> Path | None:
    matches = sorted(
        path for path in work_dir.glob(pattern)
        if path.is_file() and "compatibility" not in path.parts
    )
    if not matches and required:
        raise ValueError(f"required strategy input is missing: {pattern}")
    return matches[-1] if matches else None


def load_s2(work_dir: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    knowledge = load_json(find_one(work_dir, "**/S2_*knowledge_registry.json"))
    sources = load_json(find_one(work_dir, "**/S2_*source_registry.json"))
    claims = load_json(find_one(work_dir, "**/S2_*claim_registry.json"))
    images = load_json(find_one(work_dir, "**/S2_*image_registry.json"))
    return knowledge, sources, claims, images


def load_pattern_contract(path: Path) -> tuple[list[str], list[str], dict[str, list[str]]]:
    payload = load_json(path)
    patterns = [str(item.get("id")) for item in payload.get("patterns", []) if isinstance(item, dict) and item.get("id")]
    entries = [str(item.get("id")) for item in payload.get("canonical_content_entries", []) if isinstance(item, dict) and item.get("id")]
    routes: dict[str, list[str]] = {}
    for entry in entries:
        route = (payload.get("routing") or {}).get(entry) or {}
        routes[entry] = list(dict.fromkeys((route.get("primary_patterns") or []) + (route.get("secondary_patterns") or [])))
    return patterns, entries, routes


def public_items(payload: dict[str, Any], key: str) -> list[dict[str, Any]]:
    return [
        item for item in payload.get(key, [])
        if isinstance(item, dict) and item.get("usage_status", "qualified") in PUBLIC_STATUSES
    ]


def clean_text(value: Any, limit: int = 500) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def source_index(sources: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(item.get("source_id")): item
        for item in sources.get("sources", [])
        if isinstance(item, dict) and item.get("source_id")
    }


def usable_claims(claims: dict[str, Any], sources: dict[str, Any]) -> list[dict[str, Any]]:
    known_sources = source_index(sources)
    result: list[dict[str, Any]] = []
    for claim in public_items(claims, "claims"):
        statement = clean_text(claim.get("claim_text"))
        linked = [
            str(source_id) for source_id in claim.get("source_ids", [])
            if str(source_id) in known_sources and known_sources[str(source_id)].get("usage_status", "qualified") in PUBLIC_STATUSES
        ]
        if not statement or not linked:
            continue
        normalized = dict(claim)
        normalized["claim_text"] = statement
        normalized["source_ids"] = linked
        result.append(normalized)
    return result


def produce_s3(brand: str, output_dir: Path, signal_path: Path | None) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    trends: list[dict[str, Any]] = []
    if signal_path:
        raw = load_json(signal_path)
        rows = raw if isinstance(raw, list) else raw.get("signals", []) if isinstance(raw, dict) else []
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                continue
            statement = clean_text(row.get("statement") or row.get("signal"))
            url = clean_text(row.get("url") or row.get("source_url"), 1_000)
            observed_at = clean_text(row.get("observed_at") or row.get("date"), 100)
            if not statement or not url or not observed_at:
                warnings.append(f"trend signal {index + 1} was skipped because statement, source URL, or date was absent")
                continue
            trends.append({
                "trend_id": f"trend_{len(trends) + 1:03d}",
                "statement": statement,
                "what_changed": clean_text(row.get("what_changed") or statement),
                "observed_at": observed_at,
                "geographic_scope": clean_text(row.get("region") or "global", 100),
                "source": {
                    "name": clean_text(row.get("source_name") or row.get("publisher") or "公开来源", 200),
                    "url": url,
                },
                "content_impact": clean_text(row.get("content_impact") or row.get("why_it_matters") or "用于判断相关表述的时效性", 500),
                "freshness_rule": clean_text(row.get("freshness_rule") or "成稿前核对是否仍有效", 300),
            })
    status = "completed" if trends else "skipped_optional"
    reason = None if trends else "未提供会实质改变文章论证的可靠趋势信号"
    payload = {
        "schema_version": SCHEMA_VERSION,
        "stage": "S3_content_trend_reference",
        "status": status,
        "brand": brand,
        "reason": reason,
        "trends": trends,
        "warnings": warnings,
    }
    write_json(output_dir / f"S3_{label_for(brand)}_trend_reference.json", payload)
    lines = [f"# {brand} 内容趋势参考", ""]
    if not trends:
        lines.append("本轮没有发现需要写入 Reference Pack 的可靠趋势信号；后续文章仍可正常制作。")
    for trend in trends:
        lines.extend([f"## {trend['statement']}", "", f"- 变化：{trend['what_changed']}", f"- 时间：{trend['observed_at']}", f"- 对内容的影响：{trend['content_impact']}", f"- 来源：[{trend['source']['name']}]({trend['source']['url']})", ""])
    write_md(output_dir / f"S3_{label_for(brand)}_内容趋势参考.md", lines)
    return payload, warnings


def select_category(knowledge: dict[str, Any], claims: list[dict[str, Any]]) -> str:
    joined = " ".join(clean_text(item.get("claim_text"), 300) for item in claims[:20])
    for signal, category in (
        (("医疗美容", "医美", "整形", "注射"), "医疗美容服务"),
        (("软件", "SaaS", "系统", "平台"), "企业软件与数字化服务"),
        (("设备", "制造", "生产线"), "设备与制造服务"),
        (("教育", "课程", "培训"), "教育与培训服务"),
        (("食品", "餐饮"), "食品与餐饮服务"),
    ):
        if any(token in joined for token in signal):
            return category
    product = next((item for item in claims if item.get("claim_type") in {"product", "specification", "capability"}), None)
    if product:
        return clean_text(product.get("claim_text"), 180)
    units = public_items(knowledge, "knowledge_units")
    if units:
        return clean_text(units[0].get("title") or units[0].get("kind") or "品牌所属业务领域", 180)
    return "品牌所属业务领域"


def produce_s4(
    brand: str,
    output_dir: Path,
    knowledge: dict[str, Any],
    sources: dict[str, Any],
    claims: dict[str, Any],
    patterns: list[str],
    entries: list[str],
    routes: dict[str, list[str]],
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    facts = usable_claims(claims, sources)
    if not facts:
        raise ValueError("S4 cannot be produced because no source-linked usable or qualified fact remains")
    category_frame = select_category(knowledge, facts)
    reasons = [
        {
            "statement": item["claim_text"],
            "claim_ids": [str(item.get("claim_id"))],
            "source_ids": list(item.get("source_ids") or []),
            "usage_status": item.get("usage_status", "qualified"),
        }
        for item in facts[:6]
    ]
    proof_bundles: list[dict[str, Any]] = []
    for index, item in enumerate(facts, start=1):
        qualified = item.get("usage_status") == "qualified" or item.get("allowed_usage") == "public_with_qualification"
        proof_bundles.append({
            "proof_id": f"proof_{index:03d}",
            "claim": item["claim_text"],
            "claim_ids": [str(item.get("claim_id"))],
            "source_ids": list(item.get("source_ids") or []),
            "knowledge_ids": [str(value) for value in item.get("knowledge_ids", []) if value],
            "evidence_status": "qualified" if qualified else "supported",
            "allowed_wording": item["claim_text"],
            "necessary_qualification": clean_text(item.get("reason")) if qualified else None,
            "applicable_patterns": patterns,
        })
    by_type: dict[str, list[dict[str, Any]]] = {}
    for bundle, claim in zip(proof_bundles, facts):
        by_type.setdefault(str(claim.get("claim_type") or "knowledge_statement"), []).append(bundle)
    pillars: list[dict[str, Any]] = []
    for claim_type, bundles in by_type.items():
        pillars.append({
            "pillar_id": f"pillar_{len(pillars) + 1:02d}",
            "name": CLAIM_LABELS.get(claim_type, "品牌与业务"),
            "core_message": bundles[0]["claim"],
            "proof_refs": [item["proof_id"] for item in bundles[:4]],
        })
    knowledge_by_id = {
        str(item.get("knowledge_id")): item
        for item in knowledge.get("knowledge_units", []) if isinstance(item, dict)
    }

    def fact_topic(item: dict[str, Any]) -> tuple[str, str]:
        units = [knowledge_by_id.get(str(value), {}) for value in item.get("knowledge_ids", [])]
        kind = next((str(unit.get("kind") or "") for unit in units if unit), "")
        title = next((clean_text(unit.get("title"), 160) for unit in units if unit), "")
        return kind, title

    # Six reusable brand angles cover positioning, service portfolio, a concrete
    # priority offering, team, operational capability and the service journey.
    # E3 later chooses the one relevant to the article question.
    selectors = (
        lambda item, kind, title: kind == "identity" and any(token in title for token in ("主张", "定位", "总览")),
        lambda item, kind, title: kind == "services" and any(token in title for token in ("总览", "版图", "体系")),
        lambda item, kind, title: kind == "services" and any(token in title for token in ("注射", "填充", "轻医美")),
        lambda item, kind, title: kind == "team" and any(token in title for token in ("总览", "结构", "协同")),
        lambda item, kind, title: kind in {"capability", "differentiation"},
        lambda item, kind, title: kind == "cooperation" and any(token in title for token in ("流程", "预约", "随访", "复诊")),
    )
    priority_sources: list[dict[str, Any]] = []
    chosen_ids: set[str] = set()
    for selector in selectors:
        match = next(
            (
                item for item in facts
                if str(item.get("claim_id")) not in chosen_ids
                and selector(item, *fact_topic(item))
            ),
            None,
        )
        if match:
            priority_sources.append(match)
            chosen_ids.add(str(match.get("claim_id")))
    for item in sorted(
        facts,
        key=lambda value: (
            value.get("claim_type") not in {"product", "capability", "specification", "case_result"},
            value.get("usage_status") != "usable",
        ),
    ):
        if len(priority_sources) >= 6:
            break
        if str(item.get("claim_id")) not in chosen_ids:
            priority_sources.append(item)
            chosen_ids.add(str(item.get("claim_id")))
    brand_priority_angles: list[dict[str, Any]] = []
    for index, item in enumerate(priority_sources, start=1):
        proof = next(bundle for bundle in proof_bundles if bundle["claim_ids"] == [str(item.get("claim_id"))])
        brand_priority_angles.append({
            "angle_id": f"angle_{index:02d}",
            "priority_message": item["claim_text"],
            "editorial_role": "以具体事实自然引出品牌及其适用情境，不产生客观第一名主张",
            "trigger_conditions": [CLAIM_LABELS.get(str(item.get("claim_type")), "品牌相关问题")],
            "eligible_entry_categories": entries,
            "eligible_pattern_ids": patterns,
            "proof_refs": [proof["proof_id"]],
            "claim_ids": proof["claim_ids"],
            "source_ids": proof["source_ids"],
        })
    differentiation = [
        {
            "dimension_id": f"dimension_{index:02d}",
            "dimension": CLAIM_LABELS.get(str(item.get("claim_type")), "品牌与业务"),
            "brand_fact": item["claim_text"],
            "evidence_status": bundle["evidence_status"],
            "proof_refs": [bundle["proof_id"]],
            "comparison_allowed": False,
            "allowed_wording": bundle["allowed_wording"],
            "forbidden_inference": "不得由本品牌事实推导行业第一、市场口碑或竞品劣势",
        }
        for index, (item, bundle) in enumerate(zip(facts[:8], proof_bundles[:8]), start=1)
    ]
    architecture = {
        "schema_version": SCHEMA_VERSION,
        "stage": "S4_information_evidence_architecture",
        "brand": brand,
        "positioning": {
            "category_frame": category_frame,
            "brand_role": facts[0]["claim_text"],
            "differentiated_value": priority_sources[0]["claim_text"],
            "reasons_to_believe": reasons,
            "functional_value": [item["claim_text"] for item in facts[:5]],
            "narrative_hypotheses": [],
        },
        "information_pillars": pillars,
        "differentiation_evidence_map": differentiation,
        "proof_bundles": proof_bundles,
        "brand_priority_angles": brand_priority_angles,
        "comparison_boundary": {
            "allowed": "只在相同时间、地区和定义下比较有独立公开来源支持的共同维度",
            "client_first_rule": "可以先介绍客户品牌并重点详写，但不得把编辑顺序写成客观名次",
            "prohibited": ["由第一方材料推导竞品劣势", "无统一指标的客观排名", "最佳、第一、领先等无依据结论"],
        },
        "publication_boundary": {
            "first_party_can_support": ["企业身份", "产品与服务定义", "规格与版本", "公开价格", "流程与政策", "已确认事件", "明确限制", "有授权的项目记录"],
            "first_party_cannot_alone_support": ["市场口碑", "行业认可", "客观排名", "优于竞品", "独立测试", "专家共识", "最佳、第一或领先"],
        },
        "entry_guidance": [
            {
                "entry_category": entry,
                "entry_label": ENTRY_LABELS.get(entry, entry),
                "eligible_patterns": routes.get(entry, []),
                "brand_priority_angle_ids": [item["angle_id"] for item in brand_priority_angles],
            }
            for entry in entries
        ],
        "research_gaps": [],
    }
    source_ids = unique(source_id for item in facts for source_id in item.get("source_ids", []))
    offerings = [item for item in facts if item.get("claim_type") in {"product", "specification", "price"}]
    capabilities = [item for item in facts if item.get("claim_type") in {"capability", "knowledge_statement"}]
    limitations = [item for item in facts if item.get("claim_type") == "limitation"]
    brand_facts = {
        "schema_version": SCHEMA_VERSION,
        "stage": "S4_brand_facts",
        "brand_identity": {"canonical_name": brand, "aliases": [], "source_ids": source_ids},
        "positioning": architecture["positioning"],
        "offerings": [
            {"fact_id": f"offering_{index:03d}", "statement": item["claim_text"], "claim_ids": [item["claim_id"]], "source_ids": item["source_ids"], "usage_status": item.get("usage_status", "qualified")}
            for index, item in enumerate((offerings or facts[:3]), start=1)
        ],
        "capabilities": [
            {"fact_id": f"capability_{index:03d}", "statement": item["claim_text"], "claim_ids": [item["claim_id"]], "source_ids": item["source_ids"], "usage_status": item.get("usage_status", "qualified")}
            for index, item in enumerate(capabilities[:8], start=1)
        ],
        "proof_points": proof_bundles,
        "limitations": [
            {"fact_id": f"limitation_{index:03d}", "statement": item["claim_text"], "claim_ids": [item["claim_id"]], "source_ids": item["source_ids"]}
            for index, item in enumerate(limitations, start=1)
        ],
    }
    label = label_for(brand)
    write_json(output_dir / f"S4_{label}_information_evidence_architecture.json", architecture)
    write_json(output_dir / f"S4_{label}_brand_facts.json", brand_facts)
    lines = [f"# {brand} 信息与证据架构", "", "## 品牌定位", "", f"- 品类框架：{category_frame}", f"- 品牌角色：{architecture['positioning']['brand_role']}", f"- 差异化价值：{architecture['positioning']['differentiated_value']}", "", "## 品牌优先表达角度", ""]
    lines.extend(f"- {item['priority_message']}" for item in brand_priority_angles)
    lines.extend(["", "## 比较原则", "", f"- {architecture['comparison_boundary']['allowed']}", f"- {architecture['comparison_boundary']['client_first_rule']}"])
    write_md(output_dir / f"S4_{label}_信息与证据架构.md", lines)
    return architecture, brand_facts, []


def produce_s5(brand: str, output_dir: Path, architecture: dict[str, Any], entries: list[str], routes: dict[str, list[str]]) -> tuple[dict[str, Any], list[str]]:
    angles = architecture.get("brand_priority_angles", [])
    contract = {
        "schema_version": SCHEMA_VERSION,
        "stage": "S5_article_voice_contract",
        "brand": brand,
        "voice_mode": "third_party_objective_reporting_plus_brand_promotion",
        "editorial_position": "以第三人称编辑视角直接回答问题，用可核对事实呈现品牌价值，不暴露资料处理过程",
        "reader_experience": ["答案前置", "实体清楚", "判断标准具体", "品牌价值自然进入", "限制和行动建议集中表达"],
        "style": {
            "perspective": "third_person_editorial",
            "tone": "客观、清晰、有判断力，保留品牌宣传的重点与吸引力",
            "sentence_rhythm": "长短句交替，避免连续同构句和机械连接词",
            "evidence_expression": "已知事实直接写；时效和条件自然嵌入；非核心未知省略；决策关键未知转为一次性的读者行动",
            "brand_expression": "按事实—能力意义—适合情境展开，不以形容词代替事实",
        },
        "brand_messages": [
            {"angle_id": item.get("angle_id"), "message": item.get("priority_message"), "proof_refs": item.get("proof_refs", [])}
            for item in angles
        ],
        "publication_language": {
            "supported_fact": "直接陈述",
            "time_sensitive_fact": "在原句自然注明时间、地区、版本或条件",
            "qualified_fact": "缩小主张或明确归因，不打印证据状态",
            "unsupported_nonessential": "删除",
            "decision_critical_unknown": "改写为预约、现场查看或索取完整信息的具体动作，并集中出现一次",
        },
        "comparison_style": {
            "minimum_common_dimensions": True,
            "client_brand_first_allowed": True,
            "objective_ranking_without_evidence": False,
            "unknown_competitor_detail": "省略该维度或转为统一选择标准，不使用待核验标签",
        },
        "forbidden_public_phrases": FORBIDDEN_PUBLIC_PHRASES,
        "forbidden_moves": ["展示 Claim/Source ID", "解释工作流排序", "用免责声明修补先前的越界主张", "反复提示资料缺失", "把第一方材料写成行业共识"],
        "entry_overrides": [
            {
                "entry_category": entry,
                "eligible_patterns": routes.get(entry, []),
                "tone_adjustment": "保持默认报道＋品牌宣传文风，由单篇 P 模式调整信息密度和比较方式",
            }
            for entry in entries
        ],
    }
    label = label_for(brand)
    write_json(output_dir / f"S5_{label}_voice_contract.json", contract)
    write_md(output_dir / f"S5_{label}_文章话语契约.md", [
        f"# {brand} 文章话语契约",
        "",
        "## 默认文风",
        "",
        "第三方客观报道＋企业品牌宣传稿：直接回答问题，以具体事实说明品牌价值，不展示资料审阅、证据缺口或工作流思考。",
        "",
        "## 写作动作",
        "",
        "- 已知事实直接写；时间与适用条件自然写入原句。",
        "- 品牌价值按“事实—能力意义—适合情境”展开。",
        "- 非核心未知直接省略；关键未知转为一次性的读者行动。",
        "- 比较文章覆盖共同最低维度，不用占位符或待核验标签。",
        "",
        "## 禁止公开表达",
        "",
        *[f"- {phrase}" for phrase in FORBIDDEN_PUBLIC_PHRASES],
    ])
    return contract, []


def produce_s6(brand: str, output_dir: Path, images: dict[str, Any], patterns: list[str]) -> tuple[dict[str, Any], list[str]]:
    approved: list[dict[str, Any]] = []
    excluded_count = 0
    for image in images.get("images", []):
        if not isinstance(image, dict):
            continue
        allowed = image.get("usage_status") == "usable" and image.get("rights_status") in {"approved", "approved_with_credit"}
        if not allowed:
            excluded_count += 1
            continue
        approved.append({
            "image_id": image.get("image_id"),
            "asset_kind": image.get("asset_kind", "unknown"),
            "file_path": image.get("file_path"),
            "rights_status": image.get("rights_status"),
            "credit": image.get("credit"),
            "allowed_roles": unique(str(value) for value in image.get("allowed_roles", [])),
            "semantic_tags": image.get("semantic_tags", []),
        })
    payload = {
        "schema_version": SCHEMA_VERSION,
        "stage": "S6_visual_reference_system",
        "status": "completed" if approved else "completed_with_limits",
        "brand": brand,
        "delivery_mode": "visual_enhanced" if approved else "text_first_no_approved_asset",
        "asset_pool": approved,
        "visual_roles": {
            "brand_editorial": "品牌封面、编辑氛围和装饰视觉，不充当事实证据",
            "navigate": "章节识别和信息导航，不充当事实证据",
            "explain": "解释流程、机制、关系或选择逻辑，可绑定章节概念",
            "prove": "产品实图、案例图、证书、截图或数据证据，使用时必须对应可发布事实",
        },
        "brand_rules": {
            "logo": "始终使用真实原文件 overlay；禁止生成、猜测或重绘",
            "colors": [],
            "font_fallback": ["Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "sans-serif"],
        },
        "aigc_boundaries": ["不得冒充企业真实产品", "不得冒充团队或客户", "不得伪造病例、证书或项目现场", "不得生成或重绘 Logo"],
        "pattern_recipes": [
            {
                "pattern_id": pattern,
                "allowed_roles": ["brand_editorial", "navigate", "explain", "prove"],
                "cover_allowed": pattern in {"P01", "P02", "P14"},
                "fixed_image_count": None,
            }
            for pattern in patterns
        ],
        "warnings": [f"{excluded_count} 个视觉资产因公开使用条件不足而未进入可用池"] if excluded_count else (["没有可直接用于成稿的视觉资产；后续可纯文字交付"] if not approved else []),
    }
    label = label_for(brand)
    write_json(output_dir / f"S6_{label}_visual_reference.json", payload)
    write_md(output_dir / f"S6_{label}_视觉参考体系.md", [
        f"# {brand} 视觉参考体系",
        "",
        f"当前可直接使用的视觉资产：{len(approved)} 个。无图时文章继续以纯文字交付。",
        "",
        "- Logo 只使用真实原文件叠加。",
        "- 品牌封面和导航视觉不充当证据。",
        "- 产品、团队、病例、证书和项目现场不得由 AIGC 冒充。",
    ])
    return payload, payload["warnings"]


def observed_questions(knowledge: dict[str, Any]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    splitter = re.compile(r"(?<=[？?])")
    for unit in public_items(knowledge, "knowledge_units"):
        text = str(unit.get("content") or "")
        for piece in splitter.split(text):
            for line in piece.splitlines():
                question = clean_text(re.sub(r"^[#>*\-\d.、\s]+", "", line), 180)
                if not question.endswith(("?", "？")) or len(question) < 4:
                    continue
                normalized = re.sub(r"[\s？?]+", "", question).lower()
                if normalized in seen:
                    continue
                seen.add(normalized)
                results.append({
                    "question_id": f"question_{len(results) + 1:03d}",
                    "question_text": question,
                    "source_kind": "enterprise_material",
                    "knowledge_ids": [str(unit.get("knowledge_id"))],
                    "source_ids": [str(value) for value in unit.get("source_ids", []) if value],
                })
    return results


def question_route(question: str) -> tuple[str, list[str]]:
    if any(token in question for token in ("哪家", "推荐", "排行榜", "排名")):
        return "industry_ranking", ["P01", "P02"]
    if any(token in question for token in ("对比", "区别", "还是")):
        return "competitor_comparison", ["P03"]
    if any(token in question for token in ("靠谱吗", "口碑", "真假", "可信")):
        return "reputation", ["P04", "P16"]
    return "product_scenario", ["P05", "P06", "P07", "P08", "P09", "P11"]


def produce_s7(brand: str, output_dir: Path, knowledge: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    questions = observed_questions(knowledge)
    for item in questions:
        entry, patterns = question_route(item["question_text"])
        item["entry_category"] = entry
        item["suggested_pattern_ids"] = patterns
        item["answer_boundary"] = {
            "answer_thesis": None,
            "must_cover": [],
            "must_not_claim": ["不得超出 Reference Pack 的公开事实"],
        }
    payload = {
        "schema_version": SCHEMA_VERSION,
        "stage": "S7_question_faq_reference_library",
        "status": "completed" if questions else "skipped_optional",
        "brand": brand,
        "collection_policy": "只保留企业资料中实际出现的问题，不靠同义改写凑数量",
        "questions": questions,
        "warnings": [] if questions else ["企业资料中未提取到真实问句；单篇 FAQ 将在执行层根据正式问题生成"],
    }
    label = label_for(brand)
    write_json(output_dir / f"S7_{label}_question_library.json", payload)
    lines = [f"# {brand} 问题与 FAQ 参考库", ""]
    if questions:
        lines.extend(f"- {item['question_text']}" for item in questions)
    else:
        lines.append("当前企业资料中没有可直接复用的真实问句；不为满足数量而生成问题。")
    write_md(output_dir / f"S7_{label}_问题与FAQ参考库.md", lines)
    return payload, payload["warnings"]


def registry_counts(payload: dict[str, Any], key: str) -> dict[str, int]:
    counts = Counter(
        str(item.get("usage_status") or "qualified")
        for item in payload.get(key, []) if isinstance(item, dict)
    )
    return {status: counts.get(status, 0) for status in ("usable", "qualified", "excluded")}


def produce_s8(
    brand: str,
    output_dir: Path,
    knowledge: dict[str, Any],
    sources: dict[str, Any],
    claims: dict[str, Any],
    images: dict[str, Any],
    architecture: dict[str, Any],
    voice: dict[str, Any],
    visual: dict[str, Any],
    questions: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    summaries = {
        "knowledge": registry_counts(knowledge, "knowledge_units"),
        "source": registry_counts(sources, "sources"),
        "claim": registry_counts(claims, "claims"),
        "image": registry_counts(images, "images"),
    }
    usable_text = sum(summaries[kind][status] for kind in ("knowledge", "source", "claim") for status in ("usable", "qualified"))
    if usable_text == 0:
        raise ValueError("S8 cannot continue because no usable or qualifiable text remains")
    exclusions: list[dict[str, str]] = []
    for kind, payload, key, id_key in (
        ("knowledge", knowledge, "knowledge_units", "knowledge_id"),
        ("source", sources, "sources", "source_id"),
        ("claim", claims, "claims", "claim_id"),
        ("image", images, "images", "image_id"),
    ):
        for item in payload.get(key, []):
            if isinstance(item, dict) and item.get("usage_status") == "excluded":
                exclusions.append({
                    "object_type": kind,
                    "object_id": str(item.get(id_key) or "unknown"),
                    "reason": clean_text(item.get("reason") or item.get("notes") or "不进入公开内容", 200),
                })
    usability = {
        "schema_version": SCHEMA_VERSION,
        "stage": "S8_material_usability",
        "status": "completed_with_limits" if exclusions or any(summary["qualified"] for summary in summaries.values()) else "completed",
        "brand": brand,
        "summaries": summaries,
        "exclusions": exclusions,
        "warnings": [],
        "blocker": None,
    }
    facts = architecture.get("positioning") or {}
    offerings_path = find_one(output_dir.parent, "**/S4_*brand_facts.json", False)
    brand_facts = load_json(offerings_path) if offerings_path else {}
    summary = {
        "schema_version": SCHEMA_VERSION,
        "stage": "S8_pack_summary",
        "status": "awaiting_pack_confirmation",
        "brand": {
            "canonical_name": brand,
            "aliases": (brand_facts.get("brand_identity") or {}).get("aliases", []),
            "category_frame": facts.get("category_frame"),
            "brand_role": facts.get("brand_role"),
        },
        "products_and_services": [item.get("statement") for item in brand_facts.get("offerings", []) if item.get("statement")],
        "promotional_priorities": [
            {"angle_id": item.get("angle_id"), "message": item.get("priority_message")}
            for item in architecture.get("brand_priority_angles", [])
        ],
        "qualified_or_prohibited_claims": {
            "qualified": [item.get("claim") for item in architecture.get("proof_bundles", []) if item.get("evidence_status") == "qualified"],
            "prohibited_inferences": (architecture.get("publication_boundary") or {}).get("first_party_cannot_alone_support", []),
        },
        "voice": {
            "mode": voice.get("voice_mode"),
            "editorial_position": voice.get("editorial_position"),
            "forbidden_public_phrases": voice.get("forbidden_public_phrases", []),
        },
        "visuals": {
            "usable_asset_count": len(visual.get("asset_pool", [])),
            "delivery_mode": visual.get("delivery_mode"),
            "warnings": visual.get("warnings", []),
        },
        "question_reference_count": len(questions.get("questions", [])),
        "confirmation_prompt": "请确认以上品牌事实、宣传重点、禁写主张、默认文风和视觉摘要；如需修正，请直接提供修正内容。",
        "warnings": [],
    }
    label = label_for(brand)
    write_json(output_dir / f"S8_{label}_usability.json", usability)
    write_json(output_dir / f"S8_{label}_pack_summary.json", summary)
    write_md(output_dir / f"S8_{label}_ReferencePack确认摘要.md", [
        f"# {brand} Reference Pack 确认摘要",
        "",
        "## 品牌与业务",
        "",
        f"- 品类框架：{summary['brand']['category_frame']}",
        f"- 品牌角色：{summary['brand']['brand_role']}",
        "",
        "## 宣传重点",
        "",
        *[f"- {item['message']}" for item in summary["promotional_priorities"]],
        "",
        "## 默认文风",
        "",
        "第三方客观报道＋企业品牌宣传稿；直接陈述可用事实，不展示资料审阅或工作流思考。",
        "",
        "## 视觉",
        "",
        f"可直接使用资产 {summary['visuals']['usable_asset_count']} 个；无合规图片时继续纯文字。",
        "",
        summary["confirmation_prompt"],
    ])
    return usability, summary, []


def main() -> int:
    parser = argparse.ArgumentParser(description="Produce FrontMind v2.3 strategy assets from S2 content registries")
    parser.add_argument("--brand", required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--pattern-registry", type=Path)
    parser.add_argument("--trend-signals", type=Path)
    parser.add_argument("--through", choices=STAGE_ORDER, default="S8")
    args = parser.parse_args()
    try:
        brand = args.brand.strip()
        if not brand:
            raise ValueError("--brand must be non-empty")
        work_dir = args.work_dir.resolve()
        if not work_dir.is_dir():
            raise ValueError("--work-dir must be a directory")
        package_root = Path(__file__).resolve().parents[2]
        pattern_registry = (args.pattern_registry or package_root / "shared/content-pattern-registry.json").resolve()
        if not pattern_registry.is_file():
            raise ValueError("content Pattern Registry is missing")
        knowledge, sources, claims, images = load_s2(work_dir)
        patterns, entries, routes = load_pattern_contract(pattern_registry)
        if not patterns or not entries:
            raise ValueError("content Pattern Registry has no usable patterns or entries")
        through_index = STAGE_ORDER.index(args.through)
        completed: list[dict[str, Any]] = []

        s3, warnings = produce_s3(brand, work_dir / "S3", args.trend_signals.resolve() if args.trend_signals else None)
        completed.append({"stage": "S3", "status": s3["status"], "warnings": len(warnings)})
        if through_index == 0:
            print(json.dumps({"schema_version": SCHEMA_VERSION, "stages": completed}, ensure_ascii=False))
            return 0

        architecture, _, warnings = produce_s4(brand, work_dir / "S4", knowledge, sources, claims, patterns, entries, routes)
        completed.append({"stage": "S4", "status": "completed", "warnings": len(warnings)})
        if through_index == 1:
            print(json.dumps({"schema_version": SCHEMA_VERSION, "stages": completed}, ensure_ascii=False))
            return 0

        voice, warnings = produce_s5(brand, work_dir / "S5", architecture, entries, routes)
        completed.append({"stage": "S5", "status": "completed", "warnings": len(warnings)})
        if through_index == 2:
            print(json.dumps({"schema_version": SCHEMA_VERSION, "stages": completed}, ensure_ascii=False))
            return 0

        visual, warnings = produce_s6(brand, work_dir / "S6", images, patterns)
        completed.append({"stage": "S6", "status": visual["status"], "warnings": len(warnings)})
        if through_index == 3:
            print(json.dumps({"schema_version": SCHEMA_VERSION, "stages": completed}, ensure_ascii=False))
            return 0

        question_library, warnings = produce_s7(brand, work_dir / "S7", knowledge)
        completed.append({"stage": "S7", "status": question_library["status"], "warnings": len(warnings)})
        if through_index == 4:
            print(json.dumps({"schema_version": SCHEMA_VERSION, "stages": completed}, ensure_ascii=False))
            return 0

        usability, _, warnings = produce_s8(brand, work_dir / "S8", knowledge, sources, claims, images, architecture, voice, visual, question_library)
        completed.append({"stage": "S8", "status": "awaiting_pack_confirmation", "content_status": usability["status"], "warnings": len(warnings)})
        print(json.dumps({"schema_version": SCHEMA_VERSION, "stages": completed}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    sys.exit(main())
