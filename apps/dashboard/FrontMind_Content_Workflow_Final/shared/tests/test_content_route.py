#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

SHARED = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SHARED))
from content_route import validate_entry_pattern_route, validate_recommendation_candidate_contract

REGISTRY = json.loads((SHARED / "content-pattern-registry.json").read_text(encoding="utf-8"))


def recommendation(pattern_id: str, names: list[str], dimensions: list[str]) -> dict:
    return {
        "entry_category": "industry_ranking",
        "pattern_id": pattern_id,
        "product_scenario_subintent": None,
        "candidate_contract": {
            "featured_brand_entity_id": "brand_0",
            "ordered_candidates": [
                {"entity_id": f"brand_{index}", "display_name": name, "source_ids": [f"src_{index}abc"]}
                for index, name in enumerate(names)
            ],
            "common_dimensions": dimensions,
        },
    }


class ContentRouteTests(unittest.TestCase):
    def test_illegal_entry_pattern_is_rejected(self) -> None:
        attack = {"entry_category": "industry_ranking", "pattern_id": "P03", "product_scenario_subintent": None}
        self.assertTrue(validate_entry_pattern_route(attack, REGISTRY))

    def test_foundation_is_strict_two_way(self) -> None:
        self.assertEqual(validate_entry_pattern_route({"entry_category": "foundation_start", "pattern_id": "P14", "product_scenario_subintent": None}, REGISTRY), [])
        self.assertTrue(validate_entry_pattern_route({"entry_category": "reputation", "pattern_id": "P14", "product_scenario_subintent": None}, REGISTRY))

    def test_product_subintent_constrains_primary_but_not_approved_secondary_patterns(self) -> None:
        wrong_primary = {
            "entry_category": "product_scenario",
            "pattern_id": "P05",
            "product_scenario_subintent": "price_selection",
        }
        allowed_secondary = {
            "entry_category": "product_scenario",
            "pattern_id": "P10",
            "product_scenario_subintent": "price_selection",
        }
        self.assertTrue(validate_entry_pattern_route(wrong_primary, REGISTRY))
        self.assertEqual(validate_entry_pattern_route(allowed_secondary, REGISTRY), [])

    def test_p01_and_p02_positive(self) -> None:
        multi = recommendation("P02", ["示例品牌", "乙品牌", "丙品牌"], ["功能", "限制"])
        single = recommendation("P01", ["示例品牌"], [])
        self.assertEqual(validate_entry_pattern_route(multi, REGISTRY), [])
        self.assertEqual(validate_recommendation_candidate_contract(multi, "示例品牌"), [])
        self.assertEqual(validate_recommendation_candidate_contract(single, "示例品牌"), [])

    def test_p01_customer_first_and_candidate_counts_are_hard_gates(self) -> None:
        wrong_first = recommendation("P02", ["乙品牌", "示例品牌", "丙品牌"], ["功能"])
        self.assertTrue(validate_recommendation_candidate_contract(wrong_first, "示例品牌"))
        too_few = recommendation("P02", ["示例品牌", "乙品牌"], ["功能"])
        self.assertTrue(validate_recommendation_candidate_contract(too_few, "示例品牌"))
        single_with_competitor = recommendation("P01", ["示例品牌", "乙品牌"], [])
        self.assertTrue(validate_recommendation_candidate_contract(single_with_competitor, "示例品牌"))


if __name__ == "__main__":
    unittest.main()
