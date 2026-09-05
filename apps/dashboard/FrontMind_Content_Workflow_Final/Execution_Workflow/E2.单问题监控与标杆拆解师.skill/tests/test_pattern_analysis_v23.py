from __future__ import annotations

import json
import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


STAGE = Path(__file__).resolve().parents[1]
SCRIPT = STAGE / "scripts" / "pattern_analysis_builder.py"
REGISTRY = STAGE.parents[1] / "shared" / "content-pattern-registry.json"
ANALYZER = STAGE / "scripts" / "page_structure_analyzer.py"
RESEARCH = STAGE.parents[1] / "shared" / "pattern-research" / "index.json"


class PatternAnalysisV23Tests(unittest.TestCase):
    def write(self, path: Path, value: dict) -> None:
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def job(self) -> dict:
        return {
            "schema_version": "2.3.0", "job_id": "job_pattern_test",
            "entry_category": "industry_ranking",
            "task": {"question_text": "杭州打玻尿酸机构有哪些推荐？", "product_scenario_subintent": None},
        }

    def monitoring(self) -> dict:
        return {
            "schema_version": "2.3.0", "job_id": "job_pattern_test",
            "question": "杭州打玻尿酸机构有哪些推荐？",
            "captured_at": "2026-08-17T00:00:00+08:00", "analysis_status": "available",
            "answers": [{
                "answer_id": "answer_001", "platform": "测试平台", "model": "测试模型",
                "sampled_at": "2026-08-16T00:00:00+08:00",
                "answer_text": "可关注客户机构、候选甲医院和候选乙医院，并核对资质、产品批次与异常处置。",
                "citations": [],
            }],
            "source_observations": [],
            "derived": {
                "answer_landscape": [{
                    "answer_id": "answer_001", "platform": "测试平台",
                    "direct_answer": "可关注三家机构。", "entities": ["候选甲医院", "候选乙医院"],
                    "stance": "positive", "dimensions": ["机构与医生资质", "产品与设备来源"],
                    "unanswered_subquestions": ["费用如何构成？"],
                }],
                "competitors": [
                    {"name": "候选甲医院", "answer_ids": ["answer_001"]},
                    {"name": "候选乙医院", "answer_ids": ["answer_001"]},
                ],
                "candidate_order_signals": [
                    {"entity": "候选甲医院", "positions": [1]},
                    {"entity": "候选乙医院", "positions": [2]},
                ],
                "recurring_dimensions": ["机构与医生资质", "产品与设备来源"],
                "recurring_subquestions": ["费用如何构成？"],
                "unanswered_subquestions": ["异常情况如何处理？"], "warnings": [],
            },
        }

    @staticmethod
    def observation(rank: int, pattern: str, confidence: float, structure: str) -> dict:
        return {
            "observation_id": f"obs_rank_{rank:02d}", "raw_rank": rank,
            "status": "classified_article", "content_form": "comparison_review",
            "primary_pattern_id": pattern, "alternative_pattern_ids": [],
            "classification_confidence": confidence,
            "matched_intent_signal_ids": [f"{pattern}_intent"],
            "matched_structure_component_ids": [f"{pattern}_component_scope"],
            "negative_signal_ids": [], "question_similarity": .8,
            "classification_rationale": f"命中 {pattern} 结构", "structure_summary": structure,
            "benchmark_review": None, "notes": ["正文已分类"],
        }

    def test_weighted_recommendation_and_human_brief_consume_both_research_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root / "job.json", self.job())
            self.write(root / "monitoring.json", self.monitoring())
            self.write(root / "pool.json", {
                "question": "杭州打玻尿酸机构有哪些推荐？", "pool_status": "partial_pool", "warnings": [],
                "cited_content_pool": [
                    {"raw_rank": 1, "content_title": "多机构推荐", "canonical_url": "https://example.com/a", "media_name": "A", "media_domain": "example.com", "citation_date": "2026-08-16", "citation_count": 20, "citation_share": .8, "detailed_row_refs": [2]},
                    {"raw_rank": 2, "content_title": "单机构推荐", "canonical_url": "https://example.com/b", "media_name": "B", "media_domain": "example.com", "citation_date": "2026-08-16", "citation_count": 5, "citation_share": .2, "detailed_row_refs": [3]},
                ],
            })
            page_observations = [
                self.observation(1, "P02", .9, "选择标准 → 三家机构 → 共同维度"),
                self.observation(2, "P01", .9, "选择标准 → 单机构特写"),
            ]
            # Pre-release v2.3 page analysis had no benchmark_review member.
            page_observations[1].pop("benchmark_review")
            self.write(root / "pages.json", {"content_observations": page_observations})
            result = subprocess.run([
                sys.executable, "-B", str(SCRIPT), "--content-job", str(root / "job.json"),
                "--pattern-registry", str(REGISTRY), "--monitoring-context", str(root / "monitoring.json"),
                "--source-pool", str(root / "pool.json"), "--page-analysis", str(root / "pages.json"),
                "--research-brief", str(root / "research_brief.md"), "--output", str(root / "analysis.json"),
            ], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            analysis = json.loads((root / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(analysis["schema_version"], "2.3.0")
            self.assertEqual(analysis["monitoring_summary"]["answer_count"], 1)
            self.assertIn("候选甲医院", analysis["monitoring_summary"]["mentioned_entities"])
            self.assertEqual(analysis["recommendation"]["recommended_pattern_id"], "P02")
            p02 = next(item for item in analysis["recommendation"]["weighted_distribution"] if item["pattern_id"] == "P02")
            self.assertEqual(p02["weighted_support"], 18)
            self.assertEqual(p02["supporting_ranks"], [1])
            self.assertIsNone(analysis["content_observations"][1]["benchmark_review"])
            brief = (root / "research_brief.md").read_text(encoding="utf-8")
            self.assertIn("候选甲医院", brief)
            self.assertIn("选择标准 → 三家机构", brief)
            serialized = json.dumps(analysis)
            self.assertNotIn("sha256", serialized)
            self.assertNotIn("receipt", serialized)

    def test_missing_research_inputs_cannot_be_silently_replaced_by_template(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root / "job.json", self.job())
            result = subprocess.run([
                sys.executable, "-B", str(SCRIPT), "--content-job", str(root / "job.json"),
                "--pattern-registry", str(REGISTRY), "--output", str(root / "analysis.json"),
            ], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "analysis.json").exists())

    def test_article_classifier_emits_full_p02_observation_signals(self) -> None:
        spec = importlib.util.spec_from_file_location("page_structure_analyzer_v23", ANALYZER)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        result = module.classify(
            registry,
            "杭州打玻尿酸机构有哪些推荐？",
            "comparison_review",
            "杭州医美机构推荐榜",
            ["推荐范围与入选标准", "品牌推荐与候选介绍", "共同维度与选择建议"],
            "本文介绍多家候选机构，并按推荐范围、品牌推荐、共同维度和选择建议展开。",
        )
        self.assertEqual(result["primary_pattern_id"], "P02")
        self.assertGreater(result["classification_confidence"], .5)
        self.assertTrue(result["matched_intent_signal_ids"])
        self.assertTrue(result["matched_structure_component_ids"])
        self.assertIn("P02", result["classification_rationale"])

    def test_open_recommendation_is_not_misclassified_as_technical_document(self) -> None:
        spec = importlib.util.spec_from_file_location("page_structure_analyzer_v23_adjacent", ANALYZER)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        result = module.classify(
            registry,
            "杭州打玻尿酸机构有哪些推荐？",
            "comparison_review",
            "杭州打玻尿酸机构有哪些推荐",
            ["候选机构", "产品验真与安全", "选择建议"],
            "文章介绍多家候选，也提到预约系统架构、安全验证和异常处置。",
        )
        self.assertEqual(result["primary_pattern_id"], "P02")
        self.assertNotEqual(result["primary_pattern_id"], "P11")

    def test_unique_research_benchmark_url_maps_to_signed_pattern_after_fetch(self) -> None:
        spec = importlib.util.spec_from_file_location("page_structure_analyzer_v23_benchmark", ANALYZER)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        research = json.loads(RESEARCH.read_text(encoding="utf-8"))
        benchmark = next(item for pattern in research["patterns"] if pattern["pattern_id"] == "P02" for item in pattern["benchmarks"])
        body = (
            b"<html><title>Technical safety architecture</title><h1>System architecture</h1>"
            b"<h2>API deployment and validation</h2><p>" + b"API deployment integration safety " * 100 + b"</p></html>"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root / "pool.json", {
                "job_id": "job_pattern_test", "question": "杭州打玻尿酸机构有哪些推荐？",
                "cited_content_pool": [{"raw_rank": 1, "canonical_url": benchmark["url"], "content_title": benchmark["title"]}],
            })
            argv = [
                "page_structure_analyzer.py", "--source-pool", str(root / "pool.json"),
                "--pattern-registry", str(REGISTRY), "--pattern-research-index", str(RESEARCH),
                "--output", str(root / "out.json"),
            ]
            final_url = benchmark["url"] + ("&" if "?" in benchmark["url"] else "?") + "utm_source=test"
            with patch.object(module, "fetch", return_value=(final_url, "text/html", body)), patch.object(sys, "argv", argv):
                self.assertEqual(module.main(), 0)
            observation = json.loads((root / "out.json").read_text(encoding="utf-8"))["content_observations"][0]
            self.assertEqual(observation["status"], "classified_article")
            self.assertEqual(observation["primary_pattern_id"], "P02")
            self.assertEqual(observation["classification_confidence"], .97)
            self.assertIn(benchmark["benchmark_id"], observation["classification_rationale"])
            self.assertIn(benchmark["structure_observation"][0], observation["structure_summary"])
            self.assertEqual(observation["benchmark_review"]["benchmark_id"], benchmark["benchmark_id"])
            self.assertEqual(
                observation["benchmark_review"]["selection_rationale"], benchmark["selection_rationale"],
            )
            self.assertEqual(
                observation["benchmark_review"]["subquestions_observed"], benchmark["subquestions_observed"],
            )

    def test_unavailable_benchmark_url_is_never_classified_from_title(self) -> None:
        spec = importlib.util.spec_from_file_location("page_structure_analyzer_v23_unavailable", ANALYZER)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        research = json.loads(RESEARCH.read_text(encoding="utf-8"))
        benchmark = next(item for pattern in research["patterns"] if pattern["pattern_id"] == "P02" for item in pattern["benchmarks"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root / "pool.json", {
                "job_id": "job_pattern_test", "question": "杭州打玻尿酸机构有哪些推荐？",
                "cited_content_pool": [{"raw_rank": 1, "canonical_url": benchmark["url"], "content_title": "推荐榜与候选名单"}],
            })
            argv = [
                "page_structure_analyzer.py", "--source-pool", str(root / "pool.json"),
                "--pattern-registry", str(REGISTRY), "--pattern-research-index", str(RESEARCH),
                "--output", str(root / "out.json"),
            ]
            with patch.object(module, "fetch", side_effect=ValueError("page unavailable: timeout")), patch.object(sys, "argv", argv):
                self.assertEqual(module.main(), 0)
            observation = json.loads((root / "out.json").read_text(encoding="utf-8"))["content_observations"][0]
            self.assertEqual(observation["status"], "unavailable")
            self.assertIsNone(observation["primary_pattern_id"])
            self.assertEqual(observation["classification_confidence"], 0)

    def test_page_analyzer_emits_complete_contract_for_all_five_statuses(self) -> None:
        spec = importlib.util.spec_from_file_location("page_structure_analyzer_v23_statuses", ANALYZER)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        research = json.loads(RESEARCH.read_text(encoding="utf-8"))
        benchmark = next(
            item for pattern in research["patterns"] if pattern["pattern_id"] == "P02"
            for item in pattern["benchmarks"]
        )
        article_body = (
            b"<html><title>Editorial recommendation</title><h1>Selection criteria</h1>"
            b"<h2>Candidates</h2><p>" + b"candidate selection evidence " * 120 + b"</p></html>"
        )
        homepage_body = (
            b"<html><title>Home</title><h1>Welcome</h1><p>"
            + b"company home page navigation and corporate introduction " * 80
            + b"</p></html>"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [
                (1, benchmark["url"]),
                (2, benchmark["url"]),
                (3, "https://example.com/homepage"),
                (4, "https://example.com/timeout"),
                (5, "https://example.com/unsafe"),
            ]
            self.write(root / "pool.json", {
                "job_id": "job_pattern_test", "question": "杭州打玻尿酸机构有哪些推荐？",
                "cited_content_pool": [
                    {"raw_rank": rank, "canonical_url": url, "content_title": f"页面 {rank}"}
                    for rank, url in rows
                ],
            })

            def fake_fetch(url: str, _timeout: float, _max_bytes: int) -> tuple[str, str, bytes]:
                if url.endswith("/timeout"):
                    raise ValueError("page unavailable: timeout")
                if url.endswith("/unsafe"):
                    raise ValueError("unsafe URL target")
                if url.endswith("/homepage"):
                    return url, "text/html", homepage_body
                return url, "text/html", article_body

            def fake_form(final_url: str, *_args: object) -> str:
                return "homepage" if final_url.endswith("/homepage") else "comparison_review"

            argv = [
                "page_structure_analyzer.py", "--source-pool", str(root / "pool.json"),
                "--pattern-registry", str(REGISTRY), "--pattern-research-index", str(RESEARCH),
                "--output", str(root / "out.json"),
            ]
            with (
                patch.object(module, "fetch", side_effect=fake_fetch),
                patch.object(module, "detect_form", side_effect=fake_form),
                patch.object(sys, "argv", argv),
            ):
                self.assertEqual(module.main(), 0)
            observations = json.loads((root / "out.json").read_text(encoding="utf-8"))["content_observations"]
            self.assertEqual(
                [item["status"] for item in observations],
                ["classified_article", "duplicate_alias", "non_article", "unavailable", "unsafe_url"],
            )
            self.assertIsInstance(observations[0]["benchmark_review"], dict)
            for observation in observations[1:]:
                self.assertIn("benchmark_review", observation)
                self.assertIsNone(observation["benchmark_review"])
                self.assertIsNone(observation["primary_pattern_id"])
                self.assertEqual(observation["classification_confidence"], 0)


if __name__ == "__main__":
    unittest.main()
