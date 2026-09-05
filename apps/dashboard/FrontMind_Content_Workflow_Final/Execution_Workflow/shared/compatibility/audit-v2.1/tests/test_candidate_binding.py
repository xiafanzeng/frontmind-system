#!/usr/bin/env python3

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

SHARED = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SHARED))
from candidate_binding import (  # noqa: E402
    blueprint_candidate_binding_errors,
    model_candidate_binding_errors,
    recommendation_objective_rank_errors,
)
ROOT_SHARED = SHARED.parents[1] / "shared"
sys.path.insert(0, str(ROOT_SHARED))
from content_route import validate_entry_pattern_route  # noqa: E402


def fixture(pattern_id: str):
    names = ["客户品牌", "乙品牌", "丙品牌"] if pattern_id == "P02" else ["客户品牌"]
    candidates = [
        {
            "entity_name": name,
            "role": "featured_brand" if index == 0 else "other_candidate",
            "source_ids": [f"src_{index}abc"],
        }
        for index, name in enumerate(names)
    ]
    contract = {
        "featured_brand_name": "客户品牌",
        "ordered_candidates": candidates,
        "common_dimensions": ["能力", "限制"] if pattern_id == "P02" else [],
        "list_semantics": "editorial_recommendation",
    }
    claims = {
        "schema_version": "2.0.0", "registry_type": "claim_registry",
        "claims": [
            {
                "claim_id": f"clm_{index}abc", "about_entities": [name],
                "source_ids": [f"src_{index}abc"], "claim_type": "capability",
            }
            for index, name in enumerate(names)
        ],
    }
    sources = {
        "schema_version": "2.0.0", "registry_type": "source_registry",
        "sources": [{"source_id": f"src_{index}abc"} for index in range(len(names))],
    }
    lead_text = (
        "客户品牌适合先了解，乙品牌与丙品牌也可按能力和限制共同比较。"
        if pattern_id == "P02" else "客户品牌适合按自身能力、适用条件和公开限制进行单品牌推荐判断。"
    )
    model = {
        "pattern_id": pattern_id, "candidate_contract": contract,
        "entry_category": "industry_ranking", "product_scenario_subintent": None,
        "primary_question": "哪些品牌值得关注？",
        "lead": {
            "direct_answer_sentence": lead_text, "micro_answer": lead_text,
            "claim_ids": [f"clm_{index}abc" for index in range(len(names))],
        },
        "sections": [], "faq": [], "conclusion": {"claim_ids": []},
    }
    blueprint = {"candidate_contract": copy.deepcopy(contract)}
    monitoring = {
        "derived": {
            "competitors": [
                {"name": "乙品牌", "answer_ids": ["a1"]},
                {"name": "丙品牌", "answer_ids": ["a1"]},
            ],
            "answer_landscape": [],
        }
    }
    matrix = {
        "objects": names, "dimensions": copy.deepcopy(contract["common_dimensions"]),
    } if pattern_id == "P02" else None
    return model, blueprint, claims, sources, monitoring, matrix


class CandidateBindingTests(unittest.TestCase):
    def test_p02_positive(self) -> None:
        values = fixture("P02")
        self.assertEqual(model_candidate_binding_errors(
            values[0], values[1], values[2], values[3], "客户品牌", [],
            values[4], values[5], require_matrix=True,
        ), [])

    def test_p01_positive(self) -> None:
        values = fixture("P01")
        self.assertEqual(model_candidate_binding_errors(
            values[0], values[1], values[2], values[3], "客户品牌", [],
            values[4], None, require_matrix=True,
        ), [])

    def test_both_recommendation_patterns_use_unique_root_routes(self) -> None:
        registry = json.loads((ROOT_SHARED / "content-pattern-registry.json").read_text(encoding="utf-8"))
        for pattern_id in ("P01", "P02"):
            model, *_ = fixture(pattern_id)
            self.assertEqual(validate_entry_pattern_route(model, registry), [])

    def test_p03_is_the_explicit_comparison_route(self) -> None:
        registry = json.loads((ROOT_SHARED / "content-pattern-registry.json").read_text(encoding="utf-8"))
        document = {
            "entry_category": "competitor_comparison", "pattern_id": "P03",
            "product_scenario_subintent": None, "candidate_contract": None,
        }
        self.assertEqual(validate_entry_pattern_route(document, registry), [])

    def test_source_and_matrix_laundering_are_rejected(self) -> None:
        model, blueprint, claims, sources, monitoring, matrix = fixture("P02")
        model["candidate_contract"]["ordered_candidates"][1]["source_ids"] = ["src_2abc"]
        matrix["objects"] = ["客户品牌", "丙品牌", "乙品牌"]
        errors = model_candidate_binding_errors(
            model, blueprint, claims, sources, "客户品牌", [], monitoring, matrix,
            require_matrix=True,
        )
        self.assertTrue(any("source_ids" in value for value in errors))
        self.assertTrue(any("matrix objects" in value for value in errors))

    def test_nfkc_objective_rank_spellings_are_rejected_for_both(self) -> None:
        for pattern_id in ("P01", "P02"):
            for attack in ("Ｔｏｐ－１", "No.1", "Top1品牌", "TOP-1品牌", "Number1品牌", "top_1厂商"):
                with self.subTest(pattern_id=pattern_id, attack=attack):
                    model, *_ = fixture(pattern_id)
                    model["lead"]["micro_answer"] += f"该品牌被列为{attack}。"
                    self.assertTrue(recommendation_objective_rank_errors(model))

    def test_p01_rejects_monitored_competitor_in_body(self) -> None:
        model, blueprint, claims, sources, monitoring, _ = fixture("P01")
        model["lead"]["micro_answer"] += "乙品牌也是替代选择。"
        errors = model_candidate_binding_errors(
            model, blueprint, claims, sources, "客户品牌", [], monitoring, None,
            require_matrix=True,
        )
        self.assertTrue(any("visible body names monitored competitors" in value for value in errors))

    def test_p01_rejects_unknown_unmonitored_brand_in_body(self) -> None:
        for attack, entity in (
            ("神奇竞争品牌也是替代选择。", "神奇竞争品牌"),
            ("华为也是替代选择。", "华为"),
            ("PhantomCorp也是替代选择。", "PhantomCorp"),
        ):
            with self.subTest(attack=attack):
                model, blueprint, claims, sources, monitoring, _ = fixture("P01")
                model["lead"]["micro_answer"] += attack
                errors = model_candidate_binding_errors(
                    model, blueprint, claims, sources, "客户品牌", [], monitoring, None,
                    require_matrix=True,
                )
                self.assertTrue(any(
                    "likely named entities outside candidate_contract" in value
                    and entity in value
                    for value in errors
                ))

    def test_p02_rejects_unknown_fourth_brand_in_body(self) -> None:
        model, blueprint, claims, sources, monitoring, matrix = fixture("P02")
        model["lead"]["micro_answer"] += "神奇竞争品牌也可作为第四个候选。"
        errors = model_candidate_binding_errors(
            model, blueprint, claims, sources, "客户品牌", [], monitoring, matrix,
            require_matrix=True,
        )
        self.assertTrue(any(
            "likely named entities outside candidate_contract" in value
            and "神奇竞争品牌" in value
            for value in errors
        ))

    def test_generic_category_terms_and_used_source_publisher_are_not_candidates(self) -> None:
        model, blueprint, claims, sources, monitoring, _ = fixture("P01")
        sources["sources"][0]["publisher"] = "可信研究公司"
        model["lead"]["micro_answer"] += (
            "同类品牌与多家企业应按相同标准判断。可信研究公司发布的资料提供了依据。"
        )
        self.assertEqual(model_candidate_binding_errors(
            model, blueprint, claims, sources, "客户品牌", [], monitoring, None,
            require_matrix=True,
        ), [])

    def test_p02_allows_unmonitored_candidate_with_used_claim_source_provenance(self) -> None:
        model, blueprint, claims, sources, monitoring, matrix = fixture("P02")
        monitoring["derived"]["competitors"] = [{"name": "乙品牌", "answer_ids": ["a1"]}]
        errors = model_candidate_binding_errors(
            model, blueprint, claims, sources, "客户品牌", [], monitoring, matrix,
            require_matrix=True,
        )
        self.assertFalse(any("lacks monitoring or used claim/source provenance" in value for value in errors))

    def test_p02_rejects_candidate_without_monitoring_or_used_evidence(self) -> None:
        model, blueprint, claims, sources, monitoring, matrix = fixture("P02")
        monitoring["derived"]["competitors"] = [{"name": "乙品牌", "answer_ids": ["a1"]}]
        model["lead"]["claim_ids"].remove("clm_2abc")
        errors = model_candidate_binding_errors(
            model, blueprint, claims, sources, "客户品牌", [], monitoring, matrix,
            require_matrix=True,
        )
        self.assertTrue(any("lacks monitoring or used claim/source provenance" in value for value in errors))

    def test_p02_blueprint_aggregates_candidate_sources_across_planned_claims(self) -> None:
        _model, blueprint, claims, sources, _monitoring, _matrix = fixture("P02")
        claims["claims"].append({
            "claim_id": "clm_1extra", "about_entities": ["乙品牌"],
            "source_ids": ["src_1extra"], "claim_type": "limitation",
        })
        sources["sources"].append({"source_id": "src_1extra"})
        blueprint.update({
            "pattern_id": "P02",
            "claim_plan": [item["claim_id"] for item in claims["claims"]],
        })
        blueprint["candidate_contract"]["ordered_candidates"][1]["source_ids"] = [
            "src_1abc", "src_1extra",
        ]
        self.assertEqual(
            blueprint_candidate_binding_errors(
                blueprint, "客户品牌", None, claims, sources,
            ),
            [],
        )

    def test_question_competitor_order_does_not_override_body_customer_first(self) -> None:
        model, blueprint, claims, sources, monitoring, matrix = fixture("P02")
        model["primary_question"] = "乙品牌与客户品牌相比，哪些品牌值得关注？"
        self.assertEqual(model_candidate_binding_errors(
            model, blueprint, claims, sources, "客户品牌", [], monitoring, matrix,
            require_matrix=True,
        ), [])


if __name__ == "__main__":
    unittest.main()
