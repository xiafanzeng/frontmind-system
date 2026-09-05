#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest


EXECUTION_ROOT = Path(__file__).resolve().parents[2]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


E5 = load_module("frontmind_e5_v23", EXECUTION_ROOT / "E5.正文制作师.skill" / "scripts" / "build_content_model.py")
E6 = load_module("frontmind_e6_v23", EXECUTION_ROOT / "E6.证据预检师.skill" / "scripts" / "evidence_preflight.py")
E8 = load_module("frontmind_e8_v23", EXECUTION_ROOT / "E8.编辑终审师.skill" / "scripts" / "editorial_audit.py")


def fact(fact_id: str, statement: str, entity: str, source: str, **extra) -> dict:
    return {
        "fact_id": fact_id, "statement": statement, "about_entities": [entity],
        "source_ids": [source], "usage_status": "usable", "qualification": None, **extra,
    }


class NaturalArticleQualityTests(unittest.TestCase):
    def fixture(self) -> tuple[dict, dict]:
        context = {
            "schema_version": "2.3.0", "job_id": "job_quality_p02",
            "brand": {"canonical_name": "示例甲医疗美容机构", "aliases": []},
            "entry_category": "industry_ranking", "primary_question": "杭州打玻尿酸机构有哪些推荐？",
            "question_origin": "external_confirmed",
            "facts": [
                fact("fact_a", "示例甲医疗美容机构提供注射面诊与术后复诊服务。", "示例甲医疗美容机构", "src_a"),
                fact("fact_b", "示例乙医疗美容医院官网介绍玻尿酸注射项目。", "示例乙医疗美容医院", "src_b"),
                fact("fact_c", "示例丙医疗美容医院官网介绍玻尿酸注射项目。", "示例丙医疗美容医院", "src_c"),
                fact("fact_safe", "玻尿酸注射后如出现剧烈疼痛、皮肤颜色异常或视力变化，应及时就医。", "玻尿酸注射", "src_safe"),
            ],
            "sources": [
                {"source_id": "src_a", "title": "示例甲官网", "source_kind": "first_party_official", "url": "https://a.example", "usage_status": "usable"},
                {"source_id": "src_b", "title": "示例乙官网", "source_kind": "third_party_public", "url": "https://b.example", "usage_status": "usable"},
                {"source_id": "src_c", "title": "示例丙官网", "source_kind": "third_party_public", "url": "https://c.example", "usage_status": "usable"},
                {"source_id": "src_safe", "title": "医疗安全资料", "source_kind": "third_party_public", "url": "https://safe.example", "usage_status": "usable"},
            ],
            "brand_priority_angle": {"public_statement": "示例甲把面诊、注射和复诊衔接为连续服务。", "fact_ids": ["fact_a"]},
            "voice_profile": {
                "editorial_stance": "第三方客观报道＋企业品牌宣传稿",
                "rhythm": "长短句交替，禁用审稿腔",
                "forbidden_public_phrases": ["前沿科技"],
            },
            "answer_landscape": {"recurring_dimensions": ["产品验真", "复诊"]},
            "candidate_profiles": [{"display_name": "示例甲医疗美容机构", "evidence_status": "publicly_supported"}],
            "benchmark_moves": [{"move": "先给候选，再讲选择标准"}],
            "medical_or_legal_safety": ["玻尿酸注射后如出现剧烈疼痛、皮肤颜色异常或视力变化，应及时就医。"],
            "images": [],
        }
        contract = {
            "featured_brand_entity_id": "entity_a",
            "ordered_candidates": [
                {"entity_id": "entity_a", "display_name": "示例甲医疗美容机构", "source_ids": ["src_a"], "fact_ids": ["fact_a"], "role": "featured_brand"},
                {"entity_id": "entity_b", "display_name": "示例乙医疗美容医院", "source_ids": ["src_b"], "fact_ids": ["fact_b"], "role": "candidate"},
                {"entity_id": "entity_c", "display_name": "示例丙医疗美容医院", "source_ids": ["src_c"], "fact_ids": ["fact_c"], "role": "candidate"},
            ],
            "common_dimensions": ["机构资质", "实际操作人员", "产品信息", "费用与复诊"],
        }
        blueprint = {
            "schema_version": "2.3.0", "job_id": "job_quality_p02", "entry_category": "industry_ranking",
            "primary_question": "杭州打玻尿酸机构有哪些推荐？", "question_origin": "external_confirmed",
            "product_scenario_subintent": None, "selected_pattern_id": "P02", "candidate_contract": contract,
            "lead_plan": {"fact_ids": ["fact_a", "fact_b", "fact_c"]},
            "sections": [
                {"section_id": "sec_scope_criteria", "display_heading": "选择标准", "fact_ids": []},
                {"section_id": "sec_featured_brand", "display_heading": "示例甲", "fact_ids": ["fact_a"]},
                {"section_id": "sec_other_candidates", "display_heading": "其他机构", "fact_ids": ["fact_b", "fact_c"]},
                {"section_id": "sec_limitations", "display_heading": "安全", "fact_ids": ["fact_safe"]},
            ],
            "faq_plan": ["这份名单是客观排名吗？", "注射后出现哪些情况要及时就医？"],
            "conclusion_plan": {"fact_ids": ["fact_a"]},
        }
        return context, blueprint

    def test_writing_packet_and_natural_model_have_no_legacy_fields(self) -> None:
        context, blueprint = self.fixture()
        packet = E5.build_writing_packet(context, blueprint)
        model = E5.build(context, blueprint)
        self.assertIs(packet["voice_profile"], context["voice_profile"])
        self.assertEqual(packet["answer_landscape"], context["answer_landscape"])
        self.assertEqual(packet["candidate_profiles"], context["candidate_profiles"])
        self.assertEqual(packet["benchmark_moves"], context["benchmark_moves"])
        self.assertEqual(set(model["lead"]), {"text", "fact_ids"})
        self.assertTrue(all(set(item) == {"section_id", "heading", "paragraphs"} for item in model["sections"]))
        self.assertNotIn("direct_answer_sentence", json.dumps(model, ensure_ascii=False))
        self.assertNotIn("micro_answer", json.dumps(model, ensure_ascii=False))
        self.assertNotIn("blocks", json.dumps(model, ensure_ascii=False))
        for name in ("示例甲医疗美容机构", "示例乙医疗美容医院", "示例丙医疗美容医院"):
            self.assertIn(name, model["lead"]["text"])
        self.assertIn("在杭州选择玻尿酸注射机构时", model["lead"]["text"])
        self.assertNotIn("东莞", model["lead"]["text"])
        self.assertIn("示例甲把面诊、注射和复诊衔接为连续服务", json.dumps(model, ensure_ascii=False))
        self.assertTrue(any(
            "fact_safe" in paragraph["fact_ids"]
            for section in model["sections"] for paragraph in section["paragraphs"]
            if "疼痛" in paragraph["text"]
        ))

    def test_e6_never_appends_generic_disclaimer(self) -> None:
        context, blueprint = self.fixture()
        context["facts"][0]["usage_status"] = "qualified"
        context["facts"][0]["qualification"] = "使用时必须保留资料原有范围、时间与条件限定"
        revised, counts, _warnings = E6.auto_revise(E5.build(context, blueprint), context)
        visible = json.dumps(revised, ensure_ascii=False)
        self.assertNotIn("以预约时", visible)
        self.assertNotIn("当前可公开资料不足", visible)
        self.assertNotIn("使用时必须保留资料", visible)
        self.assertGreater(counts["keep"], 0)

    def test_e6_removes_text_when_its_only_fact_binding_is_unusable(self) -> None:
        context, blueprint = self.fixture()
        draft = E5.build(context, blueprint)
        draft["lead"] = {"text": "这家机构行业第一。", "fact_ids": ["fact_missing"]}
        revised, counts, _warnings = E6.auto_revise(draft, context)
        self.assertEqual(revised["lead"]["text"], "")
        self.assertEqual(revised["lead"]["fact_ids"], [])
        self.assertGreater(counts["remove"], 0)

    def test_e8_deterministic_layer_reports_prose_issues_without_rewriting_them(self) -> None:
        context, blueprint = self.fixture()
        draft = E5.build(context, blueprint)
        draft["sections"][0]["paragraphs"].extend([
            {"text": "相关资料显示，需要说明服务边界并保持克制。", "fact_ids": []},
            {"text": "这里采用前沿科技。", "fact_ids": []},
            {"text": "这家机构是综合排名第一，也是市场最佳。", "fact_ids": []},
            {"text": "选择时应核对机构资质、操作人员、产品信息和复诊安排。", "fact_ids": []},
            {"text": "选择机构要核对资质、操作人员、产品资料以及复诊安排。", "fact_ids": []},
        ])
        master, repairs, warnings = E8.normalize(draft, context, blueprint)
        visible = json.dumps(master, ensure_ascii=False)
        self.assertIn("相关资料显示，需要说明服务边界并保持克制", visible)
        self.assertIn("前沿科技", visible)
        self.assertTrue(E8.OBJECTIVE_RANK_RE.search(visible))
        self.assertTrue(any(item.startswith("public_language:") for item in warnings))
        self.assertTrue(any("semantic_duplicate" in item for item in warnings))
        self.assertFalse(any("publication_language" in item or "removed_" in item for item in repairs))


if __name__ == "__main__":
    unittest.main(verbosity=2)
