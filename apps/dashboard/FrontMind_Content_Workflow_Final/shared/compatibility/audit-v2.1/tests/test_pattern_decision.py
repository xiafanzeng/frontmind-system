#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path


SHARED = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SHARED))
sys.path.insert(0, str(SHARED / "scripts"))

from pattern_decision import (  # noqa: E402
    compute_e2_recommendation,
    validate_blueprint_fusion,
    validate_e2_pattern_analysis,
    validate_e4_pattern_decision,
)
from test_validate_json_instance import (  # noqa: E402
    HASH,
    valid_blueprint,
    valid_e2_human_review_receipt,
    valid_e2_pattern_analysis,
    valid_e4_pattern_decision,
)
from validate_json_instance import JsonSchemaValidator  # noqa: E402


class PatternDecisionContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.registry = json.loads((SHARED / "content-pattern-registry.json").read_text(encoding="utf-8"))
        cls.research = json.loads((SHARED / "pattern-research/index.json").read_text(encoding="utf-8"))

    def test_canonical_e2_e4_and_blueprint_pass(self) -> None:
        e2 = valid_e2_pattern_analysis()
        e4 = valid_e4_pattern_decision()
        blueprint = valid_blueprint()
        self.assertEqual(validate_e2_pattern_analysis(e2, self.registry), [])
        self.assertEqual(validate_e4_pattern_decision(e4, self.registry, e2), [])
        self.assertEqual(validate_blueprint_fusion(blueprint, self.registry, self.research, e4, e2), [])

    def test_dashboard_two_decimal_percent_rounding_is_accepted(self) -> None:
        e2 = valid_e2_pattern_analysis()
        e2["source_workbook_receipt"]["dashboard_total_citation_count"] = 619
        e2["source_workbook_receipt"]["top20_citation_count"] = 5
        e2["cited_content_pool"][0]["citation_count"] = 5
        e2["cited_content_pool"][0]["citation_share"] = 0.0081  # displayed 0.81%
        e2["recommendation"] = compute_e2_recommendation(
            e2["cited_content_pool"], e2["content_observations"], self.registry,
            e2["entry_category"], e2["product_scenario_subintent"], e2["question"],
        )
        self.assertEqual(validate_e2_pattern_analysis(e2, self.registry), [])

    def test_human_review_receipt_is_bijective_with_observation_status(self) -> None:
        schema = JsonSchemaValidator(SHARED / "e2_pattern_analysis.schema.json")
        e2 = valid_e2_pattern_analysis()
        observation = e2["content_observations"][0]
        observation["review_status"] = "human_confirmed"
        observation["classification"]["review_status"] = "human_confirmed"
        self.assertTrue(schema.validate(e2))
        self.assertTrue(any("human_review_receipt_ref" in error for error in validate_e2_pattern_analysis(e2, self.registry)))
        e2["human_review_receipt_ref"] = {"path": "review/human_receipt.json", "sha256": HASH}
        self.assertEqual(schema.validate(e2), [])
        receipt = valid_e2_human_review_receipt()
        self.assertEqual(validate_e2_pattern_analysis(e2, self.registry, receipt), [])
        forged = copy.deepcopy(receipt)
        forged["decisions"][0]["final_pattern_id"] = "P16"
        self.assertTrue(validate_e2_pattern_analysis(e2, self.registry, forged))

        machine = valid_e2_pattern_analysis()
        machine["human_review_receipt_ref"] = {"path": "review/spoof.json", "sha256": HASH}
        self.assertTrue(schema.validate(machine))
        self.assertTrue(any("all-machine" in error for error in validate_e2_pattern_analysis(machine, self.registry)))

    def test_recommendation_is_exact_canonical_recomputation(self) -> None:
        attacks = []
        duplicated = valid_e2_pattern_analysis()
        duplicated["recommendation"]["weighted_distribution"].append(
            copy.deepcopy(duplicated["recommendation"]["weighted_distribution"][0])
        )
        attacks.append(duplicated)
        false_fallback = valid_e2_pattern_analysis()
        false_fallback["recommendation"]["recommendation_status"] = "template_fallback"
        attacks.append(false_fallback)
        fake_alternative = valid_e2_pattern_analysis()
        fake_alternative["recommendation"]["alternative_recommendations"] = [
            copy.deepcopy(fake_alternative["recommendation"]["weighted_distribution"][0])
        ]
        attacks.append(fake_alternative)
        reordered = valid_e2_pattern_analysis()
        reordered["recommendation"]["supporting_content_ranks"] = []
        attacks.append(reordered)
        for index, attack in enumerate(attacks):
            with self.subTest(index=index):
                self.assertTrue(validate_e2_pattern_analysis(attack, self.registry))

    def test_question_trigger_breaks_numeric_tie_before_stable_id(self) -> None:
        pool = [{"raw_rank": rank, "citation_count": 1} for rank in range(1, 5)]
        assignments = [(1, "P04"), (2, "P16"), (3, "P16"), (4, "P04")]
        observations = [
            {
                "raw_rank": rank,
                "status": "classified_article",
                "classification": {"primary_pattern_id": pattern_id, "classification_confidence": 1},
            }
            for rank, pattern_id in assignments
        ]
        triggered = compute_e2_recommendation(
            pool, observations, self.registry, "reputation", None, "如何进行官方澄清与事实回应？"
        )
        self.assertEqual(triggered["recommended_pattern_id"], "P16")
        self.assertFalse(triggered["ambiguous"])
        tied = compute_e2_recommendation(pool, observations, self.registry, "reputation", None, "应该如何判断？")
        self.assertEqual(tied["recommended_pattern_id"], "P04")
        self.assertTrue(tied["ambiguous"])

    def test_product_subintent_keeps_signed_secondary_routes(self) -> None:
        recommendation = compute_e2_recommendation(
            [{"raw_rank": 1, "citation_count": 3}],
            [{
                "raw_rank": 1,
                "status": "classified_article",
                "classification": {"primary_pattern_id": "P10", "classification_confidence": 0.9},
            }],
            self.registry,
            "product_scenario",
            "scenario_fit",
            "这个场景有哪些研究证据？",
        )
        self.assertEqual(recommendation["recommended_pattern_id"], "P10")
        self.assertNotEqual(recommendation["recommendation_status"], "template_fallback")

    def test_empty_page_pool_uses_signed_template_without_blocking(self) -> None:
        recommendation = compute_e2_recommendation(
            [], [], self.registry, "industry_ranking", None, "有哪些品牌推荐榜？"
        )
        self.assertEqual(recommendation["recommendation_status"], "template_fallback")
        self.assertEqual(recommendation["recommended_pattern_id"], "P02")
        self.assertEqual(recommendation["classification_coverage"], 0)
        self.assertEqual(recommendation["weighted_distribution"], [])

    def test_template_fallback_cannot_switch_pattern_or_claim_benchmarks(self) -> None:
        e2 = valid_e2_pattern_analysis()
        observation = e2["content_observations"][0]
        observation.update({"status": "non_article", "content_form": "homepage", "classification": None})
        observation["review_status"] = "machine_classified"
        e2["recommendation"] = compute_e2_recommendation(
            e2["cited_content_pool"], e2["content_observations"], self.registry,
            e2["entry_category"], None, e2["question"],
        )
        decision = valid_e4_pattern_decision()
        decision.update({
            "recommended_pattern_id": e2["recommendation"]["recommended_pattern_id"],
            "selected_pattern_id": "P16",
            "decision": "template_fallback",
            "selected_benchmark_ranks": [],
            "selected_benchmark_observation_ids": [],
        })
        errors = validate_e4_pattern_decision(decision, self.registry, e2)
        self.assertTrue(any("requires overridden" in error for error in errors), errors)

    def test_non_foundation_e4_requires_structured_e2_reference(self) -> None:
        e2 = valid_e2_pattern_analysis()
        decision = valid_e4_pattern_decision()
        decision["e2_pattern_analysis_ref"] = None
        errors = validate_e4_pattern_decision(decision, self.registry, e2)
        self.assertTrue(any("structured e2_pattern_analysis_ref" in error for error in errors), errors)

    def test_blueprint_component_and_rejection_sets_are_exact(self) -> None:
        e2 = valid_e2_pattern_analysis()
        e4 = valid_e4_pattern_decision()
        blueprint = valid_blueprint()

        missing_component = copy.deepcopy(blueprint)
        missing_component["template_component_decisions"].pop()
        self.assertTrue(validate_blueprint_fusion(missing_component, self.registry, self.research, e4, e2))

        fake_adopted = copy.deepcopy(blueprint)
        fake_adopted["benchmark_fusion"]["benchmark_elements_adopted"].append("未由任何标杆决策采用")
        self.assertTrue(validate_blueprint_fusion(fake_adopted, self.registry, self.research, e4, e2))

        omitted_rejection = copy.deepcopy(blueprint)
        omitted_rejection["benchmark_fusion"]["elements_rejected"].pop()
        self.assertTrue(validate_blueprint_fusion(omitted_rejection, self.registry, self.research, e4, e2))


if __name__ == "__main__":
    unittest.main(verbosity=2)
