#!/usr/bin/env python3
"""Regression tests for v2.3 natural-body/title separation."""

from __future__ import annotations

import copy
import unittest

from validate_title_map import validate


LABELS = list("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉")


def content_model(pattern_id: str = "P05") -> dict:
    return {
        "schema_version": "2.3.0",
        "job_id": "job_title_v23",
        "pattern_id": pattern_id,
        "primary_question": "匿名方案适合什么需求？",
        "lead": {
            "text": "匿名方案应根据实际需求、适用条件和实施方式判断，正文将说明选择方法与适合情境。",
            "fact_ids": [],
        },
        "sections": [{
            "section_id": "sec_fit",
            "heading": "先从需求与实施条件判断",
            "paragraphs": [{"text": "先核对自身目标、实施条件与当前信息，再比较能够真正影响选择的差异。", "fact_ids": []}],
        }],
        "faq": [{"question": "如何开始判断？", "answer": "先明确目标，再核对实施条件。", "fact_ids": []}],
        "conclusion": {"paragraphs": [{"text": "最终选择应与自身需求和实际条件相匹配。", "fact_ids": []}]},
        "references": [],
    }


def title_map(count: int) -> dict:
    return {
        "schema_version": "2.3.0",
        "job_id": "job_title_v23",
        "requested_count": count,
        "generated_at": "2026-08-17T00:00:00Z",
        "options": [{
            "title_id": f"title_{index + 1:02d}",
            "title_text": f"匿名方案怎么选：{LABELS[index]}角度的需求判断",
            "h1_suggestion": f"匿名方案选择指南：从{LABELS[index]}角度判断需求与条件",
            "meta_description": "从实际需求、适用条件和实施方式三个方面判断匿名方案，帮助读者找到更匹配当前任务的选择方法。",
            "title_formula": "核心品类＋具体决策问题＋内容角度",
            "angle_tag": f"角度{LABELS[index]}",
            "temporal_basis": None,
            "referenced_entity_names": [],
        } for index in range(count)],
    }


class TitleMapContractTests(unittest.TestCase):
    def test_boundaries_one_and_twenty_pass(self) -> None:
        self.assertEqual(validate(title_map(1), content_model()), [])
        self.assertEqual(validate(title_map(20), content_model()), [])

    def test_requested_count_must_equal_actual_option_count(self) -> None:
        value = title_map(2)
        value["options"].pop()
        errors = validate(value, content_model())
        self.assertTrue(any("expected exactly 2" in error for error in errors), errors)

    def test_unicode_normalized_duplicates_are_rejected(self) -> None:
        value = title_map(2)
        value["options"][0]["title_text"] = "匿名方案推荐指南：A角度"
        value["options"][1]["title_text"] = "匿名方案推荐指南：Ａ角度"
        errors = validate(value, content_model())
        self.assertTrue(any("Unicode normalization" in error for error in errors), errors)

    def test_title_cannot_introduce_a_new_number(self) -> None:
        value = title_map(1)
        value["options"][0]["title_text"] += "：2026版"
        errors = validate(value, content_model())
        self.assertTrue(any("numbers, dates or prices" in error for error in errors), errors)

    def test_title_cannot_introduce_a_new_entity(self) -> None:
        value = title_map(1)
        value["options"][0]["title_text"] += "与火星公司对比"
        errors = validate(value, content_model())
        self.assertTrue(any("entities absent" in error for error in errors), errors)

    def test_medical_institution_topic_is_not_mistaken_for_a_proper_entity(self) -> None:
        body = content_model("P02")
        body["primary_question"] = "杭州打玻尿酸机构有哪些推荐？"
        body["lead"]["text"] = "杭州的玻尿酸注射机构可按资质、产品验真和诊疗流程选择。"
        value = title_map(1)
        value["options"][0]["title_text"] = "杭州打玻尿酸机构有哪些推荐？资质与产品验真指南"
        value["options"][0]["h1_suggestion"] = value["options"][0]["title_text"]
        value["options"][0]["meta_description"] = "杭州打玻尿酸机构怎么选？本文从资质、产品验真、面诊流程和异常处理四个方面给出选择方法。"
        self.assertEqual(validate(value, body), [])

        value["options"][0]["title_text"] += "，并对比神奇竞争品牌"
        errors = validate(value, body)
        self.assertTrue(any("神奇竞争品牌" in error for error in errors), errors)

    def test_p01_blocks_multi_brand_and_objective_rank_promises(self) -> None:
        body = content_model("P01")
        for attack, expected in (
            ("品牌排行榜", "multi-brand or Top-N"),
            ("有哪些品牌", "multi-brand or Top-N"),
            ("第1名", "objective-rank"),
            ("TOP-1", "objective-rank"),
        ):
            with self.subTest(attack=attack):
                value = title_map(1)
                value["options"][0]["title_text"] += f"：{attack}"
                errors = validate(value, body)
                self.assertTrue(any(expected in error for error in errors), errors)

    def test_p02_allows_editorial_recommendation_but_blocks_objective_first(self) -> None:
        body = content_model("P02")
        body["lead"]["text"] += "匿名方案品牌可以按共同维度形成编辑推荐。"
        value = title_map(1)
        value["options"][0]["title_text"] = "匿名方案品牌推荐榜"
        value["options"][0]["h1_suggestion"] = "匿名方案品牌推荐榜"
        self.assertEqual(validate(value, body), [])

        for attack in ("榜首", "综合第一", "Top1"):
            with self.subTest(attack=attack):
                attacked = copy.deepcopy(value)
                attacked["options"][0]["title_text"] += f"：{attack}"
                errors = validate(attacked, body)
                self.assertTrue(any("objective-rank" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main(verbosity=2)
