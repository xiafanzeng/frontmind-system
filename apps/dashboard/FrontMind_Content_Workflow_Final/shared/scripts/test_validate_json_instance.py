#!/usr/bin/env python3
"""Positive and negative tests for every active root JSON contract."""

from __future__ import annotations

import copy
import unittest
from pathlib import Path
from typing import Any

from validate_json_instance import JsonSchemaValidator, load_json


SHARED = Path(__file__).resolve().parents[1]
FIXTURE = SHARED / "fixtures/minimal_reference_pack"
STAMP = "2026-08-17T00:00:00Z"


def errors(schema_name: str, value: object) -> list[object]:
    return JsonSchemaValidator(SHARED / schema_name).validate(value)


def valid_job() -> dict[str, Any]:
    return {
        "schema_version": "2.3.0",
        "job_id": "job_schema_001",
        "created_at": STAMP,
        "input_mode": "pack",
        "pack_id": "rp_anonymous_fixture",
        "reference_pack_path": "inputs/reference_pack",
        "material_paths": [],
        "entry_category": "product_scenario",
        "task": {
            "question_text": "匿名示例企业提供哪些内容生产支持？",
            "question_origin": "external_confirmed",
            "foundation_subject": None,
            "product_scenario_subintent": "offering_definition",
        },
        "monitoring_answers_path": "inputs/monitoring_answers.xlsx",
        "source_workbook_path": "inputs/citations.xlsx",
        "user_constraints": [],
    }


def valid_scope() -> dict[str, Any]:
    return {
        "schema_version": "2.3.0",
        "job_id": "job_schema_001",
        "geographic_scope": {"status": "not_applicable", "value": None, "basis": ["正式问题"]},
        "decision_context": {
            "roles": ["企业内容负责人"],
            "problem": "判断服务是否适合当前内容任务",
            "decision_criteria": ["服务内容", "交付方式"],
            "professional_depth": "professional",
        },
        "time_basis": {
            "as_of": "2026-08-17",
            "freshness_class": "stable",
            "valid_until": None,
            "basis": ["企业公开概览"],
        },
        "inference_basis": {
            "knowledge_ids": ["kn_brand_overview"],
            "source_ids": ["src_brand_overview"],
            "monitoring_observation_ids": ["answer_001"],
            "notes": [],
        },
        "clarification": {"status": "not_required", "question": None, "answer": None, "material_effect": None},
    }


def valid_monitoring_context() -> dict[str, Any]:
    landscape = {
        "answer_id": "answer_001",
        "platform": "示例模型",
        "direct_answer": "可从服务内容和交付方式判断。",
        "entities": ["匿名示例企业"],
        "stance": "neutral",
        "dimensions": ["服务内容", "交付方式"],
        "unanswered_subquestions": ["如何启动合作？"],
    }
    return {
        "schema_version": "2.3.0",
        "job_id": "job_schema_001",
        "question": "匿名示例企业提供哪些内容生产支持？",
        "captured_at": STAMP,
        "answers": [{
            "answer_id": "answer_001",
            "platform": "示例模型",
            "model": "model-a",
            "sampled_at": STAMP,
            "answer_text": "可从服务内容和交付方式判断。",
            "citations": [{"url": "https://example.com/article", "title": "示例文章", "publisher": "示例媒体"}],
        }],
        "source_observations": [{"url": "https://example.com/article", "title": "示例文章", "publisher": "示例媒体"}],
        "analysis_status": "available",
        "derived": {
            "answer_landscape": [landscape],
            "competitors": [],
            "candidate_order_signals": [{"entity": "匿名示例企业", "positions": [1]}],
            "recurring_dimensions": ["服务内容", "交付方式"],
            "recurring_subquestions": ["如何启动合作？"],
            "unanswered_subquestions": ["如何启动合作？"],
            "warnings": [],
        },
    }


def valid_e2() -> dict[str, Any]:
    distribution = {
        "pattern_id": "P05",
        "weighted_support": 8.8,
        "weighted_share": 1.0,
        "article_count": 1,
        "average_rank": 1.0,
        "question_trigger_score": 1.0,
        "supporting_ranks": [1],
    }
    return {
        "schema_version": "2.3.0",
        "job_id": "job_schema_001",
        "question": "匿名示例企业提供哪些内容生产支持？",
        "entry_category": "product_scenario",
        "product_scenario_subintent": "offering_definition",
        "completed_at": STAMP,
        "monitoring_summary": {
            "answer_count": 1,
            "platforms": ["示例模型"],
            "mentioned_entities": ["匿名示例企业"],
            "candidate_order_signals": [{"entity": "匿名示例企业", "positions": [1]}],
            "recurring_dimensions": ["服务内容"],
            "recurring_subquestions": ["如何启动合作？"],
            "unanswered_subquestions": ["如何启动合作？"],
        },
        "pool_status": "partial_pool",
        "cited_content_pool": [{
            "raw_rank": 1,
            "content_title": "内容生产服务介绍",
            "canonical_url": "https://example.com/article",
            "media_name": "示例媒体",
            "media_domain": "example.com",
            "citation_date": "2026-08-16",
            "citation_count": 10,
            "citation_share": 1.0,
            "detailed_row_refs": [2],
        }],
        "content_observations": [{
            "observation_id": "observation_001",
            "raw_rank": 1,
            "status": "classified_article",
            "content_form": "official_longform",
            "primary_pattern_id": "P05",
            "alternative_pattern_ids": ["P06"],
            "classification_confidence": 0.88,
            "matched_intent_signal_ids": ["intent_definition"],
            "matched_structure_component_ids": ["component_definition"],
            "negative_signal_ids": [],
            "question_similarity": 0.9,
            "classification_rationale": "正文以服务定义和适用情境为主。",
            "structure_summary": "定义、能力、适用情境、常见问题。",
            "benchmark_review": None,
            "notes": [],
        }],
        "recommendation": {
            "status": "evidence_supported",
            "recommended_pattern_id": "P05",
            "alternative_pattern_ids": ["P06"],
            "weighted_distribution": [distribution],
            "unweighted_distribution": [distribution],
            "supporting_content_ranks": [1],
            "contradicting_content_ranks": [],
            "classification_coverage": 1.0,
            "rationale": "引用最高的可分类文章采用产品定义结构。",
            "advisory_only": True,
        },
        "warnings": [],
    }


def valid_context() -> dict[str, Any]:
    return {
        "schema_version": "2.3.0",
        "job_id": "job_schema_001",
        "brand": {"canonical_name": "匿名示例企业", "aliases": ["匿名品牌"]},
        "entry_category": "product_scenario",
        "primary_question": "匿名示例企业提供哪些内容生产支持？",
        "question_origin": "external_confirmed",
        "scope": {
            "geographic_scope": "not_applicable",
            "geographic_detail": None,
            "decision_context": "判断服务是否适合当前内容任务",
            "time_basis": "截至 2026-08-17 的企业公开概览",
            "inference_basis": ["正式问题", "企业公开概览", "监控答案"],
        },
        "voice_profile": {
            "style_summary": "第三方客观报道与企业品牌宣传自然融合",
            "editorial_stance": "第三人称编辑视角",
            "brand_promotion_mode": "事实—能力意义—适合情境",
            "preferred_moves": ["答案前置", "具体事实"],
            "forbidden_public_phrases": ["待核验候选"],
        },
        "brand_priority_angle": {
            "angle_id": "angle_content_translation",
            "angle": "把企业事实转化为可发布文章",
            "allowed_wording": "匿名示例企业提供资料整理、事实提炼、结构设计和双格式交付支持。",
            "fact_ids": ["clm_service_scope"],
            "eligible_pattern_ids": ["P05", "P06"],
            "must_not_claim": ["行业领先"],
        },
        "facts": [{
            "fact_id": "clm_service_scope",
            "statement": "匿名示例企业提供资料整理、事实提炼、写作结构设计和双格式交付支持。",
            "about_entities": ["匿名示例企业"],
            "source_ids": ["src_brand_overview"],
            "usage_status": "usable",
            "qualification": None,
        }],
        "sources": [{
            "source_id": "src_brand_overview",
            "title": "匿名示例企业公开概览",
            "source_kind": "first_party_public",
            "url": None,
            "file_path": "materials/brand_overview.md",
            "usage_status": "usable",
            "qualification": None,
        }],
        "images": [{
            "image_id": "img_attributed_editorial",
            "file_path": "assets/attributed-editorial.png",
            "asset_kind": "brand_editorial",
            "usage_status": "usable",
            "rights_status": "approved_with_credit",
            "credit": "图片：匿名素材提供方",
            "notes": "公开使用时保留署名。",
        }],
        "answer_landscape": [{
            "answer_id": "answer_001",
            "platform": "示例模型",
            "direct_answer": "可从服务内容和交付方式判断。",
            "entities": ["匿名示例企业"],
            "stance": "neutral",
            "dimensions": ["服务内容"],
            "unanswered_subquestions": ["如何启动合作？"],
        }],
        "candidate_profiles": [{
            "entity_id": "entity_anonymous_brand",
            "display_name": "匿名示例企业",
            "role": "featured_brand",
            "mention_count": 1,
            "answer_ids": ["answer_001"],
            "source_ids": ["src_brand_overview"],
            "fact_ids": ["clm_service_scope"],
            "evidence_status": "brand_supported",
        }],
        "benchmark_moves": [{
            "rank": 1,
            "title": "内容生产服务介绍",
            "url": "https://example.com/article",
            "pattern_id": "P05",
            "classification_confidence": 0.88,
            "citation_count": 10,
            "benchmark_id": "P05-B01",
            "structure_summary": "定义、能力、适用情境、FAQ。",
            "structure_observations": ["先定义服务，再说明适用情境。"],
            "subquestions": ["适合谁？"],
            "evidence_positions": ["能力事实放在对应服务模块之后。"],
            "selection_rationale": "该页清楚展示定义型文章如何承接决策问题。",
            "adoptable_moves": ["先定义服务，再说明适用情境"],
        }],
        "reader_questions": ["适合谁？", "如何启动合作？"],
        "public_constraints": ["不以第一方事实推导行业领先"],
        "medical_or_legal_safety": [],
        "visual_assets": [{
            "image_id": "img_attributed_editorial",
            "file_path": "assets/attributed-editorial.png",
            "asset_kind": "brand_editorial",
            "usage_status": "usable",
            "rights_status": "approved_with_credit",
            "usable_for": ["brand_editorial"],
            "credit": "图片：匿名素材提供方",
            "notes": "公开使用时保留署名。",
        }],
        "research_summary": {
            "status": "available",
            "recommended_pattern_id": "P05",
            "weighted_pattern_distribution": [{"pattern_id": "P05", "weighted_share": 1.0}],
            "notes": ["同类型标杆支持定义型结构。"],
        },
    }


def valid_blueprint() -> dict[str, Any]:
    return {
        "schema_version": "2.3.0",
        "job_id": "job_schema_001",
        "entry_category": "product_scenario",
        "primary_question": "匿名示例企业提供哪些内容生产支持？",
        "question_origin": "external_confirmed",
        "product_scenario_subintent": "offering_definition",
        "selected_pattern_id": "P05",
        "pattern_selection": {
            "source": "user_confirmed",
            "recommended_pattern_id": "P05",
            "changed_from_recommendation": False,
            "reason": "问题和标杆都以服务定义与适用情境为主。",
        },
        "priority_angle": {
            "angle": "把企业事实转化为可发布文章",
            "fact_ids": ["clm_service_scope"],
            "editorial_priority_only": True,
        },
        "candidate_contract": None,
        "benchmark_refs": [{
            "rank": 1,
            "title": "内容生产服务介绍",
            "url": "https://example.com/article",
            "pattern_id": "P05",
            "classification_confidence": 0.88,
            "citation_count": 10,
            "benchmark_id": "P05-B01",
            "structure_summary": "定义、能力、适用情境、FAQ。",
            "structure_observations": ["先定义服务，再说明适用情境。"],
            "subquestions": ["适合谁？"],
            "evidence_positions": ["能力事实放在对应服务模块之后。"],
            "selection_rationale": "该页清楚展示定义型文章如何承接决策问题。",
            "benchmark_moves": ["先定义服务，再说明适用情境"],
        }],
        "title_formula_plan": ["品牌＋服务定义＋适用情境"],
        "lead_plan": {
            "purpose": "直接说明服务和适用对象",
            "fact_ids": ["clm_service_scope"],
            "candidate_ids": ["entity_anonymous_brand"],
            "limitations": [],
            "length_target": {"minimum": 120, "maximum": 300},
        },
        "sections": [{
            "section_id": "sec_service_scope",
            "display_heading": "从资料整理到双格式交付",
            "editorial_job": "解释服务链路",
            "reader_takeaway": "了解服务覆盖哪些生产环节",
            "fact_ids": ["clm_service_scope"],
            "candidate_ids": ["entity_anonymous_brand"],
            "benchmark_moves": ["先定义服务，再说明适用情境"],
            "visual_role": None,
        }],
        "faq_plan": ["这类服务适合什么团队？"],
        "conclusion_plan": {
            "purpose": "按实际任务给出条件式选择建议",
            "fact_ids": ["clm_service_scope"],
            "limitations": [],
        },
        "visual_plan": [],
        "limitations": ["匿名样例不代表真实企业"],
    }


def valid_recommendation_blueprint(pattern_id: str) -> dict[str, Any]:
    value = valid_blueprint()
    candidate_count = 1 if pattern_id == "P01" else 3
    candidates = []
    for index in range(candidate_count):
        candidates.append({
            "entity_id": "entity_anonymous_brand" if index == 0 else f"entity_candidate_{index + 1}",
            "display_name": "匿名示例企业" if index == 0 else f"公开候选{index + 1}",
            "source_ids": ["src_brand_overview" if index == 0 else f"src_candidate_{index + 1}"],
            "fact_ids": ["clm_service_scope" if index == 0 else f"fact_candidate_{index + 1}"],
            "role": "featured_brand" if index == 0 else "candidate",
        })
    value.update({
        "entry_category": "industry_ranking",
        "product_scenario_subintent": None,
        "selected_pattern_id": pattern_id,
        "pattern_selection": {
            "source": "user_confirmed",
            "recommended_pattern_id": pattern_id,
            "changed_from_recommendation": False,
            "reason": "用户已确认编辑推荐结构。",
        },
        "candidate_contract": {
            "featured_brand_entity_id": "entity_anonymous_brand",
            "ordered_candidates": candidates,
            "common_dimensions": ["服务内容", "适用情境"],
        },
    })
    return value


def valid_model(pattern_id: str = "P05") -> dict[str, Any]:
    return {
        "schema_version": "2.3.0",
        "job_id": "job_schema_001",
        "revision": 1,
        "content_status": "editorial_master",
        "entry_category": "product_scenario",
        "primary_question": "匿名示例企业提供哪些内容生产支持？",
        "question_origin": "external_confirmed",
        "product_scenario_subintent": "offering_definition",
        "pattern_id": pattern_id,
        "candidate_contract": None,
        "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
        "lead": {
            "text": "匿名示例企业提供资料整理、事实提炼、写作结构设计和双格式交付支持，适合希望把已有企业信息转化为完整文章的团队。",
            "fact_ids": ["clm_service_scope"],
        },
        "sections": [{
            "section_id": "sec_service_scope",
            "heading": "从资料整理到双格式交付",
            "paragraphs": [{
                "text": "服务先梳理企业事实，再围绕读者问题安排结构，最终形成可用于发布的正文。",
                "fact_ids": ["clm_service_scope"],
            }],
        }],
        "faq": [{
            "question": "这类服务适合什么团队？",
            "answer": "已有企业资料、希望形成完整公开文章的团队，可以按当前选题启动内容制作。",
            "fact_ids": ["clm_service_scope"],
        }],
        "conclusion": {"paragraphs": [{
            "text": "如果当前任务需要同时整理事实、设计结构并完成双格式交付，这类服务可以直接承接完整生产链路。",
            "fact_ids": ["clm_service_scope"],
        }]},
        "references": [{"source_id": "src_brand_overview", "display_name": "匿名示例企业公开概览", "url": None}],
        "visual_placements": [{
            "visual_id": "vis_service_flow",
            "after_section_id": "sec_service_scope",
            "asset_id": "img_service_flow",
            "role": "explain",
            "alt_text": "从资料整理到双格式交付的内容生产流程",
            "supports_fact_ids": ["clm_service_scope"],
        }],
        "structured_data_types": ["Article", "FAQPage"],
    }


def valid_title_map(count: int = 1) -> dict[str, Any]:
    return {
        "schema_version": "2.3.0",
        "job_id": "job_schema_001",
        "requested_count": count,
        "generated_at": STAMP,
        "options": [{
            "title_id": f"title_{index + 1:02d}",
            "title_text": f"匿名示例企业提供哪些内容生产支持？角度{index + 1}",
            "h1_suggestion": f"匿名示例企业内容生产支持指南：角度{index + 1}",
            "meta_description": "从资料整理、事实提炼、文章结构到双格式交付，介绍匿名示例企业的内容生产支持与适用情境。",
            "title_formula": "品牌＋服务内容＋适用情境",
            "angle_tag": f"服务角度{index + 1}",
            "temporal_basis": None,
            "referenced_entity_names": ["匿名示例企业"],
        } for index in range(count)],
    }


def schema_instances() -> dict[str, list[dict[str, Any]]]:
    instances: dict[str, list[dict[str, Any]]] = {
        "article_blueprint.schema.json": [
            valid_blueprint(),
            valid_recommendation_blueprint("P01"),
            valid_recommendation_blueprint("P02"),
        ],
        "brand_facts.schema.json": [load_json(FIXTURE / "brand/brand_facts.json")],
        "content_job.schema.json": [valid_job()],
        "content_model.schema.json": [valid_model()],
        "delivery_index.schema.json": [{
            "schema_version": "2.3.0",
            "job_id": "job_schema_001",
            "created_at": STAMP,
            "artifacts": [{"role": "article_body_html", "path": "article_body.html", "media_type": "text/html"}],
            "warnings": [],
        }],
        "e2_pattern_analysis.schema.json": [valid_e2()],
        "information_evidence_architecture.schema.json": [load_json(FIXTURE / "writing/information_evidence_architecture.json")],
        "job_state.schema.json": [{
            "schema_version": "2.3.0",
            "job_id": "job_schema_001",
            "workflow_mode": "article",
            "current_stage": "E2",
            "status": "awaiting_pattern_confirmation",
            "selected_pattern_id": None,
            "title_count": None,
            "warnings": [],
            "blocker": None,
            "updated_at": STAMP,
        }],
        "reference_pack.schema.json": [load_json(FIXTURE / "reference_pack.json")],
        "registries.schema.json": [
            load_json(FIXTURE / f"registries/{kind}_registry.json")
            for kind in ("knowledge", "source", "claim")
        ] + [{
            "schema_version": "2.2.0",
            "registry_type": "image_registry",
            "images": [{
                "image_id": "img_service_flow",
                "file_path": "assets/service-flow.png",
                "asset_kind": "process_diagram",
                "usage_status": "usable",
                "rights_status": "approved",
                "allowed_roles": ["explain"],
                "attribution_text": None,
                "width": 1200,
                "height": 800,
            }],
        }],
        "scope_analysis.schema.json": [valid_scope()],
        "title_map.schema.json": [valid_title_map()],
        "working_context.schema.json": [valid_context()],
    }
    monitoring_names = sorted(path.name for path in SHARED.glob("monitoring*.schema.json"))
    for name in monitoring_names:
        instances[name] = [valid_monitoring_context()]
    return instances


class V23RootSchemaTests(unittest.TestCase):
    def test_every_active_root_schema_has_a_positive_instance(self) -> None:
        instances = schema_instances()
        root_schemas = {path.name for path in SHARED.glob("*.schema.json")}
        self.assertEqual(set(instances), root_schemas)
        for schema_name, values in instances.items():
            for index, value in enumerate(values):
                with self.subTest(schema=schema_name, variant=index):
                    self.assertEqual(errors(schema_name, value), [])

    def test_every_active_root_schema_rejects_a_negative_instance(self) -> None:
        for schema_name, values in schema_instances().items():
            schema = load_json(SHARED / schema_name)
            for index, value in enumerate(values):
                invalid = copy.deepcopy(value)
                required = schema.get("required") if isinstance(schema, dict) else None
                if isinstance(required, list) and required:
                    invalid.pop(required[0], None)
                elif schema_name == "reference_pack.schema.json":
                    invalid["profile"] = "obsolete-profile"
                elif schema_name == "registries.schema.json":
                    invalid = {"schema_version": "9.9.9", "registry_type": "source_registry"}
                else:
                    self.fail(f"no negative mutation is defined for {schema_name}")
                with self.subTest(schema=schema_name, variant=index):
                    self.assertTrue(errors(schema_name, invalid))

    def test_content_model_rejects_embedded_title_and_legacy_report_fields(self) -> None:
        for field in ("title", "warnings"):
            value = valid_model()
            value[field] = "不应进入正文模型"
            with self.subTest(field=field):
                self.assertTrue(errors("content_model.schema.json", value))
        value = valid_model()
        value["lead"]["direct_answer_sentence"] = "旧式重复首句"
        self.assertTrue(errors("content_model.schema.json", value))

    def test_title_count_is_a_non_boolean_integer_from_one_through_twenty(self) -> None:
        for invalid in (0, 21, True, 1.5):
            value = valid_title_map(1)
            value["requested_count"] = invalid
            with self.subTest(value=invalid):
                self.assertTrue(errors("title_map.schema.json", value))

    def test_foundation_is_strictly_p14(self) -> None:
        blueprint = valid_blueprint()
        blueprint["entry_category"] = "foundation_start"
        blueprint["question_origin"] = "foundation_derived"
        self.assertTrue(errors("article_blueprint.schema.json", blueprint))

        model = valid_model()
        model["entry_category"] = "foundation_start"
        model["question_origin"] = "foundation_derived"
        self.assertTrue(errors("content_model.schema.json", model))

    def test_blueprint_enforces_p01_and_p02_candidate_counts(self) -> None:
        p01 = valid_recommendation_blueprint("P01")
        self.assertEqual(errors("article_blueprint.schema.json", p01), [])
        p01["candidate_contract"]["ordered_candidates"].append({
            "entity_id": "entity_extra",
            "display_name": "额外候选",
            "source_ids": ["src_extra"],
            "fact_ids": ["fact_extra"],
            "role": "candidate",
        })
        self.assertTrue(errors("article_blueprint.schema.json", p01))

        p02 = valid_recommendation_blueprint("P02")
        self.assertEqual(errors("article_blueprint.schema.json", p02), [])
        p02["candidate_contract"]["ordered_candidates"].pop()
        self.assertTrue(errors("article_blueprint.schema.json", p02))

        missing_contract = valid_recommendation_blueprint("P02")
        missing_contract["candidate_contract"] = None
        self.assertTrue(errors("article_blueprint.schema.json", missing_contract))

    def test_e2_observation_contract_covers_all_five_page_statuses(self) -> None:
        for status in ("non_article", "unavailable", "duplicate_alias", "unsafe_url"):
            value = valid_e2()
            observation = value["content_observations"][0]
            observation.update({
                "status": status,
                "content_form": "homepage" if status == "non_article" else None,
                "primary_pattern_id": None,
                "alternative_pattern_ids": [],
                "classification_confidence": 0,
                "matched_intent_signal_ids": [],
                "matched_structure_component_ids": [],
                "negative_signal_ids": [],
                "question_similarity": 0,
                "classification_rationale": f"{status} does not participate in classification",
                "structure_summary": None,
                "benchmark_review": None,
            })
            with self.subTest(status=status):
                self.assertEqual(errors("e2_pattern_analysis.schema.json", value), [])

        invalid = valid_e2()
        observation = invalid["content_observations"][0]
        observation.update({
            "status": "unavailable", "content_form": None, "primary_pattern_id": None,
            "alternative_pattern_ids": [], "classification_confidence": 0,
            "matched_intent_signal_ids": [], "matched_structure_component_ids": [],
            "negative_signal_ids": [], "structure_summary": None,
            "benchmark_review": {
                "benchmark_id": "P05-B01",
                "structure_observation": ["真实结构观察"],
                "subquestions_observed": ["读者问题？"],
                "evidence_positions_observed": ["证据紧邻事实"],
                "visual_observation": ["视觉说明关系"],
                "faq_observation": "FAQ 补充正文缺口",
                "strengths": ["结构清楚"], "weaknesses": ["证据较少"],
                "do_not_copy": ["不复制原文"], "selection_rationale": "结构可迁移",
                "research_note": "已逐页复审",
            },
        })
        self.assertTrue(errors("e2_pattern_analysis.schema.json", invalid))

        invalid = valid_e2()
        invalid["content_observations"][0]["content_form"] = "homepage"
        self.assertTrue(errors("e2_pattern_analysis.schema.json", invalid))

    def test_reviewed_benchmark_semantics_are_required_in_context_and_blueprint(self) -> None:
        context = valid_context()
        self.assertEqual(errors("working_context.schema.json", context), [])
        broken_context = copy.deepcopy(context)
        broken_context["benchmark_moves"][0].pop("selection_rationale")
        self.assertTrue(errors("working_context.schema.json", broken_context))

        blueprint = valid_blueprint()
        self.assertEqual(errors("article_blueprint.schema.json", blueprint), [])
        broken_blueprint = copy.deepcopy(blueprint)
        broken_blueprint["benchmark_refs"][0].pop("evidence_positions")
        self.assertTrue(errors("article_blueprint.schema.json", broken_blueprint))

    def test_approved_with_credit_visuals_require_nonempty_credit(self) -> None:
        value = valid_context()
        self.assertEqual(errors("working_context.schema.json", value), [])

        missing_image_credit = copy.deepcopy(value)
        missing_image_credit["images"][0].pop("credit")
        self.assertTrue(errors("working_context.schema.json", missing_image_credit))

        missing_visual_credit = copy.deepcopy(value)
        missing_visual_credit["visual_assets"][0].pop("credit")
        self.assertTrue(errors("working_context.schema.json", missing_visual_credit))

    def test_pause_states_are_tied_only_to_their_content_stage(self) -> None:
        state = schema_instances()["job_state.schema.json"][0]
        state = copy.deepcopy(state)
        state["current_stage"] = "E3"
        self.assertTrue(errors("job_state.schema.json", state))

    def test_reference_pack_contract_contains_no_audit_ledger_fields(self) -> None:
        pack = load_json(FIXTURE / "reference_pack.json")
        serialized = str(pack)
        for forbidden in ("approval", "receipt", "reviewer", "sha256", "fingerprint", "files"):
            self.assertNotIn(forbidden, serialized)


if __name__ == "__main__":
    unittest.main(verbosity=2)
