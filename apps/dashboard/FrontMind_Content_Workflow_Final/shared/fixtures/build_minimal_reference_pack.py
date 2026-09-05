#!/usr/bin/env python3
"""Build the lightweight, anonymous FrontMind v2.2 Reference Pack fixture.

The wire profile intentionally remains v2.2 while its content-bearing strategy
assets use v2.3. The fixture contains no approval workbook, receipt, reviewer,
files[] inventory, or cross-stage fingerprint. ``--zip`` is optional so normal
source-tree builds do not leave a generated archive behind.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path
from typing import Any


BRAND = "匿名示例企业"
STAMP = "2026-08-17T00:00:00+08:00"
FIXTURE_ROOT = Path(__file__).resolve().parent / "minimal_reference_pack"


def write_json(relative_path: str, value: Any) -> None:
    path = FIXTURE_ROOT / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_text(relative_path: str, value: str) -> None:
    path = FIXTURE_ROOT / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


def build_fixture() -> None:
    # Rebuilding is intentionally exact: stale audit-era files must not survive.
    if FIXTURE_ROOT.exists():
        shutil.rmtree(FIXTURE_ROOT)
    FIXTURE_ROOT.mkdir(parents=True)

    write_text(
        "materials/brand_overview.md",
        "# 匿名示例企业\n\n"
        "匿名示例企业提供内容参考包整理与文章生产支持，适用于需要把企业事实转化为清晰公开内容的团队。\n"
        "其工作包括资料整理、事实提炼、写作结构设计和双格式交付。\n"
        "该匿名样例只用于工作流测试，不代表任何真实企业。\n",
    )
    write_json(
        "materials/index.json",
        {
            "schema_version": "2.2.0",
            "items": [{
                "material_id": "material_brand_overview",
                "path": "materials/brand_overview.md",
                "kind": "first_party_public_text",
                "usage_status": "usable",
            }],
        },
    )

    write_json(
        "registries/knowledge_registry.json",
        {
            "schema_version": "2.2.0",
            "registry_type": "knowledge_registry",
            "knowledge_units": [{
                "knowledge_id": "kn_brand_overview",
                "title": "品牌与服务概览",
                "kind": "brand_overview",
                "content": "匿名示例企业提供资料整理、事实提炼、写作结构设计和双格式交付支持。",
                "package_path": "materials/brand_overview.md",
                "source_ids": ["src_brand_overview"],
                "asset_ids": [],
                "usage_status": "usable",
                "qualification": None,
            }],
        },
    )
    write_json(
        "registries/source_registry.json",
        {
            "schema_version": "2.2.0",
            "registry_type": "source_registry",
            "sources": [{
                "source_id": "src_brand_overview",
                "title": "匿名示例企业公开概览",
                "publisher": BRAND,
                "source_type": "first_party_official",
                "source_origin_class": "first_party_official",
                "url": None,
                "file_path": "materials/brand_overview.md",
                "published_at": None,
                "accessed_at": STAMP,
                "usage_status": "usable",
                "qualification": None,
                "notes": "匿名工作流样例。",
            }],
        },
    )
    write_json(
        "registries/claim_registry.json",
        {
            "schema_version": "2.2.0",
            "registry_type": "claim_registry",
            "claims": [
                {
                    "claim_id": "clm_service_scope",
                    "claim_text": "匿名示例企业提供资料整理、事实提炼、写作结构设计和双格式交付支持。",
                    "claim_type": "capability",
                    "about_entities": [BRAND],
                    "source_ids": ["src_brand_overview"],
                    "usage_status": "usable",
                    "qualification": None,
                    "verification_status": "verified",
                    "allowed_usage": "public_fact",
                    "as_of": STAMP,
                },
                {
                    "claim_id": "clm_fixture_limit",
                    "claim_text": "该匿名样例只用于工作流测试，不代表任何真实企业。",
                    "claim_type": "limitation",
                    "about_entities": [BRAND],
                    "source_ids": ["src_brand_overview"],
                    "usage_status": "usable",
                    "qualification": None,
                    "verification_status": "verified",
                    "allowed_usage": "public_fact",
                    "as_of": STAMP,
                },
            ],
        },
    )
    write_json(
        "registries/image_registry.json",
        {"schema_version": "2.2.0", "registry_type": "image_registry", "images": []},
    )

    positioning = {
        "category_frame": "企业内容生产支持",
        "brand_role": "把已有企业事实整理为清晰、可发布的文章内容",
        "differentiated_value": "让事实、结构与品牌表达在一篇文章中自然衔接",
        "reasons_to_believe": [{
            "statement": "服务范围包括资料整理、事实提炼、结构设计和双格式交付。",
            "claim_ids": ["clm_service_scope"],
            "source_ids": ["src_brand_overview"],
            "usage_status": "usable",
        }],
        "functional_value": ["形成可直接用于写作的企业事实与内容结构"],
        "narrative_hypotheses": [],
    }
    proof = {
        "proof_id": "proof_service_scope",
        "claim": "匿名示例企业提供资料整理、事实提炼、写作结构设计和双格式交付支持。",
        "claim_ids": ["clm_service_scope"],
        "source_ids": ["src_brand_overview"],
        "knowledge_ids": ["kn_brand_overview"],
        "evidence_status": "supported",
        "allowed_wording": "匿名示例企业的服务覆盖资料整理、事实提炼、结构设计和双格式交付。",
        "necessary_qualification": None,
        "applicable_patterns": [f"P{index:02d}" for index in range(1, 17)],
    }
    write_json(
        "brand/brand_facts.json",
        {
            "schema_version": "2.3.0",
            "stage": "S4_brand_facts",
            "brand_identity": {
                "canonical_name": BRAND,
                "aliases": ["匿名品牌"],
                "source_ids": ["src_brand_overview"],
            },
            "positioning": positioning,
            "offerings": [{
                "fact_id": "offering_content_support",
                "statement": "服务包括资料整理、事实提炼、写作结构设计和双格式交付。",
                "claim_ids": ["clm_service_scope"],
                "source_ids": ["src_brand_overview"],
                "usage_status": "usable",
            }],
            "capabilities": [{
                "fact_id": "capability_content_translation",
                "statement": "企业事实可以被整理为文章所需的结构与表达。",
                "claim_ids": ["clm_service_scope"],
                "source_ids": ["src_brand_overview"],
                "usage_status": "usable",
            }],
            "proof_points": [proof],
            "limitations": [{
                "fact_id": "limitation_fixture_only",
                "statement": "该匿名样例只用于工作流测试。",
                "claim_ids": ["clm_fixture_limit"],
                "source_ids": ["src_brand_overview"],
            }],
        },
    )

    entries = [
        ("industry_ranking", "行业排名", ["P01", "P02"]),
        ("competitor_comparison", "竞品对比", ["P03"]),
        ("reputation", "美誉舆情", ["P04", "P16"]),
        ("product_scenario", "产品场景", ["P05", "P06", "P07", "P08", "P09", "P10", "P11", "P12", "P13", "P15"]),
        ("foundation_start", "基础启动", ["P14"]),
    ]
    write_json(
        "writing/information_evidence_architecture.json",
        {
            "schema_version": "2.3.0",
            "stage": "S4_information_evidence_architecture",
            "brand": BRAND,
            "positioning": positioning,
            "information_pillars": [{
                "pillar_id": "pillar_service",
                "name": "内容生产支持",
                "core_message": proof["claim"],
                "proof_refs": ["proof_service_scope"],
            }],
            "differentiation_evidence_map": [{
                "dimension_id": "dimension_service_scope",
                "dimension": "服务内容",
                "brand_fact": proof["claim"],
                "evidence_status": "supported",
                "proof_refs": ["proof_service_scope"],
                "comparison_allowed": False,
                "allowed_wording": proof["allowed_wording"],
                "forbidden_inference": "不得由本品牌事实推导行业领先、客观排名或竞品劣势。",
            }],
            "proof_bundles": [proof],
            "brand_priority_angles": [{
                "angle_id": "angle_content_translation",
                "priority_message": "把已有企业事实转化为结构清晰、适合公开阅读的文章。",
                "editorial_role": "用具体服务动作呈现品牌价值及适用情境。",
                "trigger_conditions": ["企业内容如何形成完整文章"],
                "eligible_entry_categories": [entry[0] for entry in entries],
                "eligible_pattern_ids": [f"P{index:02d}" for index in range(1, 17)],
                "proof_refs": ["proof_service_scope"],
                "claim_ids": ["clm_service_scope"],
                "source_ids": ["src_brand_overview"],
            }],
            "comparison_boundary": {
                "allowed": "只比较有独立公开事实支持的共同维度。",
                "client_first_rule": "客户品牌可以首先出现并重点详写，但编辑顺序不代表客观名次。",
                "prohibited": ["无统一口径的客观排名", "用客户资料推导竞品劣势"],
            },
            "publication_boundary": {
                "first_party_can_support": ["企业身份", "产品与服务", "流程", "公开限制"],
                "first_party_cannot_alone_support": ["市场口碑", "行业领先", "客观排名", "优于竞品"],
            },
            "entry_guidance": [{
                "entry_category": category,
                "entry_label": label,
                "eligible_patterns": patterns,
                "brand_priority_angle_ids": ["angle_content_translation"],
            } for category, label, patterns in entries],
            "research_gaps": [],
        },
    )

    forbidden = [
        "资料较完整", "相关资料显示", "以审核为准", "服务边界", "信息边界", "保持克制",
        "用户提交资料", "需要说明", "不构成对", "待核验候选", "当前团队与产品待核验",
        "当前可公开资料不足", "资料粒度不同",
    ]
    write_json(
        "writing/voice_contract.json",
        {
            "schema_version": "2.3.0",
            "stage": "S5_article_voice_contract",
            "brand": BRAND,
            "voice_mode": "third_party_objective_reporting_plus_brand_promotion",
            "editorial_position": "以第三人称编辑视角直接回答问题，用事实自然呈现品牌价值。",
            "reader_experience": ["答案前置", "实体清楚", "判断标准具体", "品牌价值自然进入"],
            "style": {
                "perspective": "third_person_editorial",
                "tone": "客观、清晰、有判断力",
                "sentence_rhythm": "长短句交替，避免连续同构句",
                "evidence_expression": "已知事实直接写，时效和条件自然写入原句",
                "brand_expression": "按事实—能力意义—适合情境展开",
            },
            "brand_messages": [{
                "angle_id": "angle_content_translation",
                "message": "把已有企业事实转化为结构清晰、适合公开阅读的文章。",
                "proof_refs": ["proof_service_scope"],
            }],
            "publication_language": {
                "supported_fact": "直接陈述",
                "time_sensitive_fact": "在原句自然注明条件",
                "qualified_fact": "缩小主张或明确归因",
                "unsupported_nonessential": "删除",
                "decision_critical_unknown": "改为一次性的具体行动",
            },
            "comparison_style": {
                "minimum_common_dimensions": True,
                "client_brand_first_allowed": True,
                "objective_ranking_without_evidence": False,
                "unknown_competitor_detail": "省略该维度或转为统一选择标准",
            },
            "forbidden_public_phrases": forbidden,
            "forbidden_moves": ["展示内部字段", "解释工作流排序", "反复提示资料缺失"],
            "entry_overrides": [{
                "entry_category": category,
                "eligible_patterns": patterns,
                "tone_adjustment": "保持报道与品牌宣传融合的自然文风。",
            } for category, _label, patterns in entries],
        },
    )
    write_json(
        "writing/visual_reference.json",
        {
            "schema_version": "2.3.0",
            "stage": "S6_visual_reference_system",
            "status": "completed_with_limits",
            "brand": BRAND,
            "delivery_mode": "text_first_no_approved_asset",
            "asset_pool": [],
            "visual_roles": {
                "brand_editorial": "品牌编辑视觉",
                "navigate": "章节导航",
                "explain": "解释流程与关系",
                "prove": "对应公开事实的证明图",
            },
            "brand_rules": {
                "logo": "只使用真实原文件，不生成或重绘",
                "colors": [],
                "font_fallback": ["Noto Sans CJK SC", "PingFang SC", "sans-serif"],
            },
            "aigc_boundaries": ["不得冒充真实产品、团队、客户、病例、证书或现场"],
            "pattern_recipes": [],
            "warnings": ["没有可直接使用的视觉资产，后续按纯文字交付"],
        },
    )
    write_json(
        "writing/question_library.json",
        {
            "schema_version": "2.3.0",
            "stage": "S7_question_faq_reference_library",
            "status": "completed",
            "brand": BRAND,
            "collection_policy": "只保留企业资料中实际出现的问题，不为数量改写问题",
            "questions": [{
                "question_id": "question_service_001",
                "question_text": "匿名示例企业提供哪些内容生产支持？",
                "source_kind": "enterprise_material",
                "knowledge_ids": ["kn_brand_overview"],
                "source_ids": ["src_brand_overview"],
                "entry_category": "product_scenario",
                "suggested_pattern_ids": ["P05", "P06"],
                "answer_boundary": {
                    "answer_thesis": None,
                    "must_cover": ["服务内容", "适用情境"],
                    "must_not_claim": ["行业领先"],
                },
            }],
            "warnings": [],
        },
    )

    write_json(
        "reference_pack.json",
        {
            "schema_version": "2.2.0",
            "profile": "frontmind-content-reference-pack-v2.2",
            "pack_id": "rp_anonymous_fixture",
            "version": 1,
            "created_at": STAMP,
            "brand": {
                "canonical_name": BRAND,
                "aliases": ["匿名品牌"],
                "legal_entity_name": None,
                "official_website": None,
            },
            "material_index_path": "materials/index.json",
            "registries": {
                "knowledge_registry_path": "registries/knowledge_registry.json",
                "source_registry_path": "registries/source_registry.json",
                "claim_registry_path": "registries/claim_registry.json",
                "image_registry_path": "registries/image_registry.json",
            },
            "writing_assets": {
                "information_architecture_path": "writing/information_evidence_architecture.json",
                "trend_viewpoints_path": None,
                "voice_path": "writing/voice_contract.json",
                "visual_rules_path": "writing/visual_reference.json",
                "question_library_path": "writing/question_library.json",
            },
            "warnings": ["匿名夹具没有可直接使用的视觉资产，文章可按纯文字交付"],
        },
    )


def build_zip(destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(FIXTURE_ROOT.rglob("*")):
            if not path.is_file():
                continue
            info = zipfile.ZipInfo(path.relative_to(FIXTURE_ROOT).as_posix(), (2026, 8, 17, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", type=Path, help="optionally write a deterministic ZIP outside the fixture tree")
    args = parser.parse_args()
    build_fixture()
    if args.zip:
        build_zip(args.zip.resolve())
    print(json.dumps({"fixture": str(FIXTURE_ROOT), "zip": str(args.zip.resolve()) if args.zip else None}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    raise SystemExit(main())
