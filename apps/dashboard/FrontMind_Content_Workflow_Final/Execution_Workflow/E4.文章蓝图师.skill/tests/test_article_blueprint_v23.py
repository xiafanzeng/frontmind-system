from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


STAGE = Path(__file__).resolve().parents[1]
SCRIPT = STAGE / "scripts" / "build_article_blueprint.py"
SHARED = STAGE.parents[1] / "shared"
REGISTRY = SHARED / "content-pattern-registry.json"
RESEARCH = SHARED / "pattern-research" / "index.json"
E3_SCRIPT = STAGE.parent / "E3.工作上下文汇总师.skill" / "scripts" / "build_working_context.py"


def fact(number: int, entity: str, source: str) -> dict:
    return {
        "fact_id": f"fact_item_{number}", "statement": f"{entity}公开介绍其服务能力、流程与适用条件。",
        "about_entities": [entity], "source_ids": [source], "usage_status": "usable", "qualification": None,
    }


def profile(number: int, name: str, role: str, evidence: str) -> dict:
    return {
        "entity_id": f"entity_{number}", "display_name": name, "role": role,
        "mention_count": 4 - number, "answer_ids": ["answer_001"] if number else [],
        "source_ids": [f"src_{number}"], "fact_ids": [f"fact_item_{number}"], "evidence_status": evidence,
    }


class ArticleBlueprintV23Tests(unittest.TestCase):
    question = "杭州打玻尿酸机构有哪些推荐？"

    def job(self, foundation: bool = False) -> dict:
        return {
            "job_id": "job_blueprint_test", "entry_category": "foundation_start" if foundation else "industry_ranking",
            "task": {
                "question_text": None if foundation else self.question,
                "foundation_subject": "客户品牌深度特写" if foundation else None,
                "question_origin": "foundation_derived" if foundation else "external_confirmed",
                "product_scenario_subintent": None,
            },
        }

    def context(self, public_candidates: bool) -> dict:
        candidates = [
            profile(0, "客户品牌", "featured_brand", "brand_supported"),
            profile(1, "候选甲医院", "candidate", "publicly_supported" if public_candidates else "discovery_only"),
            profile(2, "候选乙医院", "candidate", "publicly_supported" if public_candidates else "discovery_only"),
        ]
        if not public_candidates:
            for item in candidates[1:]:
                item["fact_ids"] = []
        return {
            "brand": {"canonical_name": "客户品牌", "aliases": []},
            "facts": [fact(0, "客户品牌", "src_0"), fact(1, "候选甲医院", "src_1"), fact(2, "候选乙医院", "src_2")],
            "candidate_profiles": candidates,
            "benchmark_moves": [{
                "rank": 1, "title": "杭州医美机构选择指南", "url": "https://media.example.com/guide",
                "pattern_id": "P02", "classification_confidence": .93, "citation_count": 12,
                "benchmark_id": "P02-B01",
                "structure_summary": "机构选择标准 → 三家机构 → 共同维度 → 异常处置",
                "structure_observations": ["先公开候选范围与共同标准，再展开机构事实。"],
                "subquestions": ["如何验真产品？", "异常情况如何处置？"],
                "evidence_positions": ["机构事实紧邻来源与时间条件。"],
                "selection_rationale": "该标杆能把推荐范围、共同标准和医疗安全自然分层。",
                "adoptable_moves": ["吸收其章节推进：机构选择标准 → 三家机构 → 共同维度 → 异常处置"],
            }, {
                "rank": 2, "title": "单品牌特写", "url": "https://media.example.com/single",
                "pattern_id": "P01", "classification_confidence": .99, "citation_count": 20,
                "benchmark_id": None, "structure_summary": "单品牌", "structure_observations": [],
                "subquestions": [], "evidence_positions": [], "selection_rationale": None,
                "adoptable_moves": ["不应被 P02 采用"],
            }],
            "reader_questions": [
                "费用如何构成？", "如何查医生资质？",
                "尚未回答：是否需要进一步核对三家当前医生？", "Secondary Menu",
            ],
            "public_constraints": ["不得把编辑顺序写成客观名次。"],
            "medical_or_legal_safety": ["异常症状出现时应立即联系医疗机构并及时就医。"],
            "visual_assets": [],
            "brand_priority_angle": {
                "angle_id": "angle_01", "angle": "完整面诊、验真与复诊流程", "allowed_wording": "突出完整面诊、验真与复诊流程",
                "fact_ids": ["fact_item_0"], "eligible_pattern_ids": ["P02"], "must_not_claim": ["市场第一"],
            },
            "research_summary": {
                "status": "available", "recommended_pattern_id": "P02",
                "weighted_pattern_distribution": [{"pattern_id": "P02", "weighted_share": 1}], "notes": ["E2 已完成"],
            },
        }

    def run_case(self, job: dict, context: dict, *extra: object) -> tuple[subprocess.CompletedProcess[str], Path, tempfile.TemporaryDirectory[str]]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        (root / "job.json").write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        (root / "context.json").write_text(json.dumps(context, ensure_ascii=False), encoding="utf-8")
        result = subprocess.run([
            sys.executable, "-B", str(SCRIPT), "--content-job", str(root / "job.json"),
            "--working-context", str(root / "context.json"), "--pattern-registry", str(REGISTRY),
            "--pattern-research-index", str(RESEARCH), "--output", str(root / "blueprint.json"),
            *[str(item) for item in extra],
        ], text=True, capture_output=True)
        return result, root, temporary

    def test_selected_pattern_is_an_explicit_confirmation(self) -> None:
        result, root, temporary = self.run_case(self.job(), self.context(True))
        try:
            self.assertEqual(result.returncode, 0, result.stderr)
            status = json.loads(result.stdout)
            self.assertEqual(status["status"], "awaiting_pattern_confirmation")
            self.assertEqual(status["code"], "pattern_confirmation_required")
            self.assertFalse((root / "blueprint.json").exists())
        finally:
            temporary.cleanup()

    def test_p02_does_not_accept_discovery_only_monitoring_mentions(self) -> None:
        result, root, temporary = self.run_case(self.job(), self.context(False), "--selected-pattern", "P02")
        try:
            self.assertEqual(result.returncode, 0, result.stderr)
            status = json.loads(result.stdout)
            self.assertEqual(status["status"], "awaiting_pattern_confirmation")
            self.assertEqual(status["code"], "p02_candidate_evidence_insufficient")
            self.assertEqual(status["eligible_candidate_count"], 1)
            self.assertCountEqual(status["discovery_only_candidates"], ["候选甲医院", "候选乙医院"])
            self.assertFalse((root / "blueprint.json").exists())
        finally:
            temporary.cleanup()

    def test_p02_uses_only_same_pattern_benchmarks_and_natural_sections(self) -> None:
        result, root, temporary = self.run_case(self.job(), self.context(True), "--selected-pattern", "P02")
        try:
            self.assertEqual(result.returncode, 0, result.stderr)
            blueprint = json.loads((root / "blueprint.json").read_text(encoding="utf-8"))
            self.assertEqual(blueprint["selected_pattern_id"], "P02")
            self.assertEqual([item["display_name"] for item in blueprint["candidate_contract"]["ordered_candidates"]], ["客户品牌", "候选甲医院", "候选乙医院"])
            self.assertEqual([item["rank"] for item in blueprint["benchmark_refs"]], [1])
            self.assertEqual(blueprint["benchmark_refs"][0]["benchmark_id"], "P02-B01")
            self.assertEqual(blueprint["benchmark_refs"][0]["selection_rationale"], "该标杆能把推荐范围、共同标准和医疗安全自然分层。")
            self.assertTrue(any("机构选择标准" in move for section in blueprint["sections"] for move in section["benchmark_moves"]))
            headings = "\n".join(item["display_heading"] for item in blueprint["sections"])
            self.assertNotIn("需要说明", headings)
            self.assertNotIn("可核验信息", headings)
            self.assertTrue(5 <= len(blueprint["faq_plan"]) <= 8)
            self.assertIn("如何确认玻尿酸产品的注册信息和批次？", blueprint["faq_plan"])
            self.assertFalse(any("尚未回答" in item or "Secondary Menu" in item for item in blueprint["faq_plan"]))
            review = (root / "blueprint_review.md").read_text(encoding="utf-8")
            self.assertNotIn("Secondary Menu", review)
            self.assertIn("completed", result.stdout)
            self.assertTrue((root / "blueprint_review.md").is_file())
            review = (root / "blueprint_review.md").read_text(encoding="utf-8")
            self.assertIn("禁写主张与内容底线", review)
            self.assertIn("不得把编辑顺序写成客观名次", review)
        finally:
            temporary.cleanup()

    def test_manual_e2_review_survives_e3_transform_and_e4_blueprint(self) -> None:
        spec = importlib.util.spec_from_file_location("e3_benchmark_bridge_v23", E3_SCRIPT)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        exact_structure = "先交代入选口径，再按相同决策维度展开三家机构。"
        exact_question = "商业合作关系会不会影响候选顺序？"
        exact_evidence = "资质与产品事实紧邻各机构段落，风险证据集中放入安全章节。"
        exact_rationale = "该页展示了编辑推荐如何在不量化排名的前提下完成多候选比较。"
        e2 = {
            "cited_content_pool": [{
                "raw_rank": 1, "content_title": "真实复审标杆", "canonical_url": "https://media.example.com/manual-review",
                "citation_count": 18,
            }],
            "content_observations": [{
                "raw_rank": 1, "status": "classified_article", "primary_pattern_id": "P02",
                "classification_confidence": .97, "structure_summary": "Secondary Menu → Candidates",
                "matched_structure_component_ids": [],
                "benchmark_review": {
                    "benchmark_id": "P02-B09", "structure_observation": [exact_structure],
                    "subquestions_observed": [exact_question], "evidence_positions_observed": [exact_evidence],
                    "selection_rationale": exact_rationale,
                },
            }],
        }
        context = self.context(True)
        context["benchmark_moves"] = module.benchmark_moves(e2)
        result, root, temporary = self.run_case(self.job(), context, "--selected-pattern", "P02")
        try:
            self.assertEqual(result.returncode, 0, result.stderr)
            blueprint = json.loads((root / "blueprint.json").read_text(encoding="utf-8"))
            reference = blueprint["benchmark_refs"][0]
            self.assertEqual(reference["benchmark_id"], "P02-B09")
            self.assertEqual(reference["structure_observations"], [exact_structure])
            self.assertEqual(reference["subquestions"], [exact_question])
            self.assertEqual(reference["evidence_positions"], [exact_evidence])
            self.assertEqual(reference["selection_rationale"], exact_rationale)
            self.assertIn(exact_question, blueprint["faq_plan"])
            review = (root / "blueprint_review.md").read_text(encoding="utf-8")
            for value in (exact_structure, exact_question, exact_evidence, exact_rationale):
                self.assertIn(value, review)
        finally:
            temporary.cleanup()

    def test_blueprint_edits_apply_without_changing_pattern(self) -> None:
        context = self.context(True)
        with tempfile.TemporaryDirectory() as directory:
            edits = Path(directory) / "edits.json"
            edits.write_text(json.dumps({
                "priority_angle_text": "以面诊、验真和复诊的连续体验形成品牌重点",
                "faq_plan": ["资质怎么查？", "产品怎么验真？", "费用怎么构成？", "异常怎么办？", "复诊如何安排？"],
            }, ensure_ascii=False), encoding="utf-8")
            result, root, temporary = self.run_case(self.job(), context, "--selected-pattern", "P02", "--blueprint-edits", edits)
            try:
                self.assertEqual(result.returncode, 0, result.stderr)
                blueprint = json.loads((root / "blueprint.json").read_text(encoding="utf-8"))
                self.assertEqual(blueprint["selected_pattern_id"], "P02")
                self.assertEqual(blueprint["priority_angle"]["angle"], "以面诊、验真和复诊的连续体验形成品牌重点")
                self.assertEqual(len(blueprint["faq_plan"]), 5)
            finally:
                temporary.cleanup()

    def test_foundation_is_fixed_p14_without_e2(self) -> None:
        context = self.context(True)
        context["research_summary"] = {"status": "not_applicable", "recommended_pattern_id": "P14", "weighted_pattern_distribution": [], "notes": ["基础启动"]}
        result, root, temporary = self.run_case(self.job(foundation=True), context)
        try:
            self.assertEqual(result.returncode, 0, result.stderr)
            blueprint = json.loads((root / "blueprint.json").read_text(encoding="utf-8"))
            self.assertEqual(blueprint["selected_pattern_id"], "P14")
            self.assertEqual(blueprint["pattern_selection"]["source"], "foundation_template")
        finally:
            temporary.cleanup()


if __name__ == "__main__":
    unittest.main()
