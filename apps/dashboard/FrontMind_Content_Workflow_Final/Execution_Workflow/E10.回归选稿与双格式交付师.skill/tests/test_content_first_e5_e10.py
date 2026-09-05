#!/usr/bin/env python3
"""v2.3 integration checks for whole-article E5 through E10 behavior."""

from __future__ import annotations

import json
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


EXECUTION = Path(__file__).resolve().parents[2]
PATTERN_REGISTRY = EXECUTION.parent / "shared" / "content-pattern-registry.json"


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


class ContentFirstE5E10Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.job_id = "job_content_first_test"
        self.context = self.root / "working_context.json"
        self.blueprint = self.root / "blueprint.json"
        self.state = self.root / "job_state.json"
        contract = {
            "featured_brand_entity_id": "entity_a",
            "ordered_candidates": [
                {"entity_id": "entity_a", "display_name": "示例甲医疗美容机构", "source_ids": ["src_a"], "fact_ids": ["fact_a"], "role": "featured_brand"},
                {"entity_id": "entity_b", "display_name": "示例乙医疗美容医院", "source_ids": ["src_b"], "fact_ids": ["fact_b"], "role": "candidate"},
                {"entity_id": "entity_c", "display_name": "示例丙医疗美容医院", "source_ids": ["src_c"], "fact_ids": ["fact_c"], "role": "candidate"},
            ],
            "common_dimensions": ["机构资质", "实际操作人员", "产品信息", "费用与复诊"],
        }
        facts = [
            {"fact_id": "fact_a", "statement": "示例甲医疗美容机构提供注射面诊与术后复诊服务。", "about_entities": ["示例甲医疗美容机构"], "source_ids": ["src_a"], "usage_status": "usable", "qualification": None},
            {"fact_id": "fact_b", "statement": "示例乙医疗美容医院官网介绍玻尿酸注射项目。", "about_entities": ["示例乙医疗美容医院"], "source_ids": ["src_b"], "usage_status": "usable", "qualification": None},
            {"fact_id": "fact_c", "statement": "示例丙医疗美容医院官网介绍玻尿酸注射项目。", "about_entities": ["示例丙医疗美容医院"], "source_ids": ["src_c"], "usage_status": "usable", "qualification": None},
            {"fact_id": "fact_safe", "statement": "玻尿酸注射后如出现剧烈疼痛、皮肤颜色异常或视力变化，应及时就医。", "about_entities": ["玻尿酸注射"], "source_ids": ["src_safe"], "usage_status": "usable", "qualification": None},
        ]
        sources = [
            {"source_id": "src_a", "title": "示例甲官网", "source_kind": "first_party_official", "url": "https://a.example", "usage_status": "usable"},
            {"source_id": "src_b", "title": "示例乙官网", "source_kind": "third_party_public", "url": "https://b.example", "usage_status": "usable"},
            {"source_id": "src_c", "title": "示例丙官网", "source_kind": "third_party_public", "url": "https://c.example", "usage_status": "usable"},
            {"source_id": "src_safe", "title": "医疗安全资料", "source_kind": "third_party_public", "url": "https://safe.example", "usage_status": "usable"},
        ]
        write(self.context, {
            "schema_version": "2.3.0", "job_id": self.job_id,
            "brand": {"canonical_name": "示例甲医疗美容机构", "aliases": []},
            "entry_category": "industry_ranking", "primary_question": "杭州打玻尿酸机构有哪些推荐？",
            "question_origin": "external_confirmed", "scope": {}, "facts": facts, "sources": sources,
            "images": [], "brand_priority_angle": {"public_statement": "示例甲把面诊、注射和复诊衔接为连续服务。", "fact_ids": ["fact_a"]},
            "medical_or_legal_safety": [{"text": facts[-1]["statement"], "fact_ids": ["fact_safe"]}],
        })
        write(self.blueprint, {
            "schema_version": "2.3.0", "job_id": self.job_id, "entry_category": "industry_ranking",
            "primary_question": "杭州打玻尿酸机构有哪些推荐？", "question_origin": "external_confirmed",
            "product_scenario_subintent": None, "selected_pattern_id": "P02", "candidate_contract": contract,
            "lead_plan": {"fact_ids": ["fact_a", "fact_b", "fact_c"]},
            "sections": [
                {"section_id": "sec_scope_criteria", "display_heading": "选择标准", "fact_ids": []},
                {"section_id": "sec_featured_brand", "display_heading": "示例甲", "fact_ids": ["fact_a"]},
                {"section_id": "sec_other_candidates", "display_heading": "其他机构", "fact_ids": ["fact_b", "fact_c"]},
                {"section_id": "sec_limitations", "display_heading": "安全", "fact_ids": ["fact_safe"]},
            ],
            "faq_plan": ["玻尿酸费用通常受哪些因素影响？", "注射后出现哪些情况要及时就医？"],
            "conclusion_plan": {"fact_ids": ["fact_a"]}, "visual_plan": [],
        })
        write(self.state, {
            "schema_version": "2.3.0", "job_id": self.job_id, "workflow_mode": "article",
            "current_stage": "E4", "status": "running", "selected_pattern_id": "P02",
            "title_count": None, "warnings": [], "blocker": None,
            "updated_at": "2026-08-17T00:00:00+00:00",
        })
        self.authored = self.root / "E5_authored_model.json"
        write(self.authored, {
            "lead": {
                "text": "在杭州选择玻尿酸注射机构时，可以把示例甲医疗美容机构、示例乙医疗美容医院和示例丙医疗美容医院纳入同一轮面诊比较。示例甲在本文中首先介绍，重点是其面诊、注射与复诊的连续服务；另外两家则可作为公开项目明确的补充候选。以下按编辑顺序展开，不作量化排名。",
                "fact_ids": ["fact_a", "fact_b", "fact_c"],
            },
            "sections": [
                {"section_id": "sec_scope_criteria", "heading": "选择机构时，真正需要看什么", "paragraphs": [{"text": "比较机构时，可以把实际操作人员、产品信息、完整费用、复诊安排和异常处置放到同一套问题里。项目名称相同，并不意味着使用产品、操作方案和后续服务也相同。", "fact_ids": []}]},
                {"section_id": "sec_featured_brand", "heading": "示例甲医疗美容机构的连续服务思路", "paragraphs": [{"text": "示例甲医疗美容机构提供注射面诊与术后复诊服务，把咨询、注射和后续沟通衔接起来。对于更看重过程连续性的人，这一服务路径值得在面诊时重点了解。", "fact_ids": ["fact_a"]}]},
                {"section_id": "sec_other_candidates", "heading": "另外两家候选各有什么特点", "paragraphs": [{"text": "示例乙医疗美容医院官网介绍玻尿酸注射项目；示例丙医疗美容医院官网同样介绍这一项目。两家可作为补充候选，进一步比较具体产品、操作人员和复诊安排。", "fact_ids": ["fact_b", "fact_c"]}]},
                {"section_id": "sec_limitations", "heading": "面诊、产品验真与异常处置", "paragraphs": [{"text": "玻尿酸注射后如出现剧烈疼痛、皮肤颜色异常或视力变化，应及时就医。面诊前还应主动说明既往治疗、过敏史和正在使用的药物。", "fact_ids": ["fact_safe"]}]},
            ],
            "faq": [
                {"question": "玻尿酸费用通常受哪些因素影响？", "answer": "产品规格、使用数量、操作费用和后续复诊都会影响完整报价，比较时应使用同一口径。", "fact_ids": []},
                {"question": "注射后出现哪些情况要及时就医？", "answer": "出现剧烈疼痛、皮肤颜色异常或视力变化时，应及时就医。", "fact_ids": ["fact_safe"]},
            ],
            "conclusion": {"paragraphs": [{"text": "如果更看重从面诊到复诊的连续服务，可以优先了解示例甲医疗美容机构；同时用同一组问题咨询另外两家候选，再结合实际方案作出选择。", "fact_ids": ["fact_a"]}]},
            "references": [], "visual_placements": [], "structured_data_types": ["Article", "FAQPage"],
        })
    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_script(self, stage: str, script: str, *args: str, env: dict | None = None) -> None:
        path = next(EXECUTION.glob(f"{stage}.*.skill/scripts/{script}"))
        merged = os.environ.copy()
        if env:
            merged.update(env)
        python = merged.pop("FRONTMIND_TEST_PYTHON", sys.executable)
        result = subprocess.run([python, str(path), *args], cwd=self.root, text=True,
                                capture_output=True, check=False, env=merged)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def regression_master(self) -> dict:
        return {
            "schema_version": "2.3.0", "job_id": self.job_id, "revision": 1,
            "content_status": "editorial_master", "entry_category": "industry_ranking",
            "primary_question": "杭州打玻尿酸机构有哪些推荐？", "question_origin": "external_confirmed",
            "product_scenario_subintent": None, "pattern_id": "P02",
            "candidate_contract": json.loads(self.blueprint.read_text(encoding="utf-8"))["candidate_contract"],
            "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
            "lead": {
                "text": "示例甲医疗美容机构、示例乙医疗美容医院和示例丙医疗美容医院可以纳入同一轮面诊比较。",
                "fact_ids": ["fact_a", "fact_b", "fact_c"],
            },
            "sections": [
                {
                    "section_id": "sec_candidate_a", "heading": "示例甲的公开信息",
                    "paragraphs": [{
                        "text": "示例甲医疗美容机构官网在2026年介绍3项面诊服务，示例费用为500元。",
                        "fact_ids": ["fact_a"],
                    }],
                },
                {
                    "section_id": "sec_candidate_b", "heading": "示例乙的公开信息",
                    "paragraphs": [{
                        "text": "示例乙医疗美容医院官网介绍玻尿酸注射项目。",
                        "fact_ids": ["fact_b"],
                    }],
                },
                {
                    "section_id": "sec_candidate_c", "heading": "示例丙的公开信息",
                    "paragraphs": [{
                        "text": "示例丙医疗美容医院官网介绍玻尿酸注射项目。",
                        "fact_ids": ["fact_c"],
                    }],
                },
            ],
            "faq": [
                {"question": "怎样核对产品注册信息？", "answer": "查看注册证、批次和有效期。", "fact_ids": []},
                {"question": "出现异常时怎么办？", "answer": "出现剧烈疼痛或视力变化时应及时就医。", "fact_ids": []},
            ],
            "conclusion": {"paragraphs": [{"text": "完成面诊比较后再决定。", "fact_ids": []}]},
            "references": [], "visual_placements": [], "structured_data_types": ["Article", "FAQPage"],
        }

    def assert_e10_whole_e8_fallback(self, label: str, master: dict, candidate: dict) -> dict:
        candidate = json.loads(json.dumps(candidate, ensure_ascii=False))
        candidate["content_status"] = "optimized_candidate"
        master_path = self.root / f"{label}_master.json"
        candidate_path = self.root / f"{label}_candidate.json"
        selected_path = self.root / f"{label}_selected.json"
        summary_path = self.root / f"{label}_summary.json"
        write(master_path, master)
        write(candidate_path, {
            "schema_version": "2.3.0", "job_id": self.job_id, "stage": "E9",
            "source": "harnessgeo_api", "adapter": "xty_openai_chat_completions",
            "model": "gpt-5.6-luna", "raw_markdown": "candidate body",
            "candidate_model": candidate, "issues": [],
        })
        self.run_script(
            "E10", "select_final_body.py", "--editorial-master", str(master_path),
            "--harnessgeo-candidate", str(candidate_path), "--output", str(selected_path),
            "--summary", str(summary_path),
        )
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        self.assertEqual(summary["selected_body"], "editorial_master", summary)
        selected = json.loads(selected_path.read_text(encoding="utf-8"))
        expected = json.loads(json.dumps(master, ensure_ascii=False))
        expected["content_status"] = "final"
        self.assertEqual(selected, expected)
        return summary

    def run_e9_mocked(
        self,
        master_path: Path,
        output_path: Path,
        summary_path: Path,
        transform: object,
        *,
        job_state: Path | None = None,
    ) -> tuple[object, mock.Mock]:
        """Run the E9 entry point in-process while replacing only remote I/O."""
        script = next(EXECUTION.glob("E9.*.skill/scripts/harnessgeo_candidate_optimizer.py"))
        spec = importlib.util.spec_from_file_location(f"harnessgeo_test_{id(output_path)}", script)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        def rewrite(_api_key: str, _master: dict, document: str) -> str:
            return transform(document) if callable(transform) else str(transform)

        arguments = [
            str(script), "--editorial-master", str(master_path),
            "--output", str(output_path), "--summary", str(summary_path),
        ]
        if job_state is not None:
            arguments.extend(("--job-state", str(job_state)))
        with mock.patch.object(module, "call_harnessgeo", side_effect=rewrite) as remote_call:
            with mock.patch.dict(
                os.environ,
                {"FRONTMIND_HARNESSGEO_API_KEY": "fake-harnessgeo-test-key"},
                clear=False,
            ):
                with mock.patch.object(sys, "argv", arguments):
                    self.assertEqual(module.main(), 0)
        return module, remote_call

    def test_whole_article_harnessgeo_selection_and_high_fidelity_delivery(self) -> None:
        draft, packet = self.root / "draft.json", self.root / "writing_packet.json"
        self.run_script("E5", "build_content_model.py", "--working-context", str(self.context),
                        "--blueprint", str(self.blueprint), "--writing-packet", str(packet),
                        "--authored-model", str(self.authored), "--output", str(draft),
                        "--job-state", str(self.state))
        self.assertEqual(json.loads(packet.read_text())["stage"], "E5")
        e5 = self.root / "e5.json"
        self.run_script("E5", "content_model_validator.py", "--model", str(draft),
                        "--working-context", str(self.context), "--blueprint", str(self.blueprint),
                        "--output", str(e5), "--summary", str(self.root / "e5_summary.json"),
                        "--job-state", str(self.state))
        e6 = self.root / "e6.json"
        self.run_script("E6", "evidence_preflight.py", "--draft", str(e5),
                        "--working-context", str(self.context), "--output", str(e6),
                        "--summary", str(self.root / "e6_summary.json"), "--job-state", str(self.state))
        visual_draft, prompt_plan = self.root / "visual_draft.json", self.root / "prompt_plan.json"
        self.run_script("E7", "build_visual_plan.py", "--model", str(e6),
                        "--working-context", str(self.context), "--blueprint", str(self.blueprint),
                        "--output-model", str(visual_draft), "--prompt-plan", str(prompt_plan))
        e7, selection = self.root / "e7.json", self.root / "selection.json"
        self.run_script("E7", "visual_claim_validator.py", "--model", str(visual_draft),
                        "--working-context", str(self.context), "--asset-root", str(self.root),
                        "--output-model", str(e7), "--selection", str(selection), "--job-state", str(self.state))
        self.assertEqual(json.loads(selection.read_text())["status"], "completed")
        e8 = self.root / "e8.json"
        edited = self.root / "e8_edited_model.json"
        edited.write_text(e7.read_text(encoding="utf-8"), encoding="utf-8")
        self.run_script("E8", "editorial_audit.py", "--model", str(e7),
                        "--working-context", str(self.context), "--blueprint", str(self.blueprint),
                        "--editing-brief", str(self.root / "e8_editing_brief.json"),
                        "--edited-model", str(edited),
                        "--output", str(e8), "--summary", str(self.root / "e8_summary.json"),
                        "--job-state", str(self.state))
        e9 = self.root / "e9_candidate.json"
        _module, remote_call = self.run_e9_mocked(
            e8, e9, self.root / "e9_summary.json", lambda document: document,
            job_state=self.state,
        )
        self.assertEqual(remote_call.call_count, 1)
        final_model = self.root / "final.json"
        self.run_script("E10", "select_final_body.py", "--editorial-master", str(e8),
                        "--harnessgeo-candidate", str(e9), "--output", str(final_model),
                        "--summary", str(self.root / "selection_summary.json"),
                        "--working-context", str(self.context), "--job-state", str(self.state))
        self.assertEqual(json.loads((self.root / "selection_summary.json").read_text())["selected_body"], "optimized_candidate")
        self.run_script("E10", "set_title_count.py", "--job-state", str(self.state), "--count", "5")
        title_map = self.root / "title_map.json"
        self.run_script("E10", "generate_title_map.py", "--content-model", str(final_model),
                        "--job-state", str(self.state), "--pattern-registry", str(PATTERN_REGISTRY),
                        "--output", str(title_map))
        options = json.loads(title_map.read_text())["options"]
        self.assertEqual(len(options), 5)
        self.assertEqual(set(options[0]), {
            "title_id", "title_text", "h1_suggestion", "meta_description", "title_formula",
            "angle_tag", "temporal_basis", "referenced_entity_names",
        })
        delivery = self.root / "delivery"
        self.run_script("E10", "render_delivery.py", "--content-model", str(final_model),
                        "--title-map", str(title_map), "--job-state", str(self.state),
                        "--output-dir", str(delivery), "--visual-selection", str(selection),
                        "--asset-root", str(self.root))
        self.assertTrue((delivery / "article_body.docx").is_file())
        html_text = (delivery / "article_body.html").read_text(encoding="utf-8")
        self.assertNotIn("<h1", html_text.casefold())
        self.assertNotIn("data-job-id", html_text.casefold())
        self.assertNotIn(self.job_id, html_text)
        self.assertIn("示例甲医疗美容机构", html_text)
        with zipfile.ZipFile(delivery / "article_body.docx") as archive:
            document = archive.read("word/document.xml").decode("utf-8")
            styles = archive.read("word/styles.xml").decode("utf-8")
            rels = archive.read("word/_rels/document.xml.rels").decode("utf-8")
        self.assertIn("示例甲医疗美容机构", document)
        self.assertIn("eastAsia", document + styles)
        self.assertIn("TargetMode=\"External\"", rels)
        index = json.loads((delivery / "delivery_index.json").read_text())
        self.assertNotIn("fallback", json.dumps(index, ensure_ascii=False).casefold())
        self.assertFalse(any("sha" in json.dumps(item).casefold() for item in index["artifacts"]))

    def test_harnessgeo_semantic_drift_uses_whole_editorial_master(self) -> None:
        master = {
            "schema_version": "2.3.0", "job_id": self.job_id, "revision": 1,
            "content_status": "editorial_master", "entry_category": "industry_ranking",
            "primary_question": "杭州打玻尿酸机构有哪些推荐？", "question_origin": "external_confirmed",
            "product_scenario_subintent": None, "pattern_id": "P02",
            "candidate_contract": json.loads(self.blueprint.read_text())["candidate_contract"],
            "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
            "lead": {"text": "示例甲医疗美容机构、示例乙医疗美容医院和示例丙医疗美容医院可作为候选。", "fact_ids": ["fact_a", "fact_b", "fact_c"]},
            "sections": [{"section_id": "sec_core", "heading": "怎样选择", "paragraphs": [{"text": "报价应比较产品、用量和复诊费用。", "fact_ids": []}]}],
            "faq": [], "conclusion": {"paragraphs": [{"text": "面诊后再决定。", "fact_ids": []}]},
            "references": [], "visual_placements": [], "structured_data_types": ["Article"],
        }
        candidate = json.loads(json.dumps(master, ensure_ascii=False))
        candidate["lead"]["text"] += "价格为9999元。"
        candidate["content_status"] = "optimized_candidate"
        envelope = {"schema_version": "2.3.0", "job_id": self.job_id, "stage": "E9", "source": "harnessgeo_api", "adapter": "xty_openai_chat_completions", "model": "gpt-5.6-luna", "raw_markdown": "candidate body", "candidate_model": candidate, "issues": []}
        write(self.root / "master.json", master)
        write(self.root / "candidate.json", envelope)
        self.run_script("E10", "select_final_body.py", "--editorial-master", str(self.root / "master.json"),
                        "--harnessgeo-candidate", str(self.root / "candidate.json"),
                        "--output", str(self.root / "selected.json"),
                        "--summary", str(self.root / "selected_summary.json"))
        self.assertEqual(json.loads((self.root / "selected_summary.json").read_text())["selected_body"], "editorial_master")
        self.assertNotIn("9999", (self.root / "selected.json").read_text())

    def test_number_movement_and_repetition_return_whole_e8(self) -> None:
        master = self.regression_master()
        moved = json.loads(json.dumps(master, ensure_ascii=False))
        moved["sections"][0]["paragraphs"][0]["text"] = "示例甲医疗美容机构官网介绍面诊服务。"
        moved["sections"][1]["paragraphs"][0]["text"] += "2026年另有3项服务，示例费用为500元。"
        moved_summary = self.assert_e10_whole_e8_fallback("number_moved", master, moved)
        self.assertTrue(any(
            issue.startswith("slot_canonical_fact_entity_or_constraint_changed")
            for issue in moved_summary["issues"]
        ), moved_summary)

        repeated = json.loads(json.dumps(master, ensure_ascii=False))
        repeated["sections"][0]["paragraphs"][0]["text"] += "2026年再列出3项服务和500元示例费用。"
        repeated_summary = self.assert_e10_whole_e8_fallback("number_repeated", master, repeated)
        self.assertIn("canonical_fact_entity_or_constraint_changed", repeated_summary["issues"])

    def test_faq_question_text_and_order_are_locked(self) -> None:
        master = self.regression_master()
        candidate = json.loads(json.dumps(master, ensure_ascii=False))
        candidate["faq"][0]["question"] = "产品登记信息应该怎么查？"
        summary = self.assert_e10_whole_e8_fallback("faq_rewritten", master, candidate)
        self.assertIn("faq_question_text_or_order_changed", summary["issues"])

        reordered = json.loads(json.dumps(master, ensure_ascii=False))
        reordered["faq"] = list(reversed(reordered["faq"]))
        summary = self.assert_e10_whole_e8_fallback("faq_reordered", master, reordered)
        self.assertIn("faq_question_text_or_order_changed", summary["issues"])

    def test_candidate_mention_count_change_returns_whole_e8(self) -> None:
        master = self.regression_master()
        candidate = json.loads(json.dumps(master, ensure_ascii=False))
        candidate["conclusion"]["paragraphs"][0]["text"] += "可再咨询示例甲医疗美容机构。"
        summary = self.assert_e10_whole_e8_fallback("candidate_repeated", master, candidate)
        self.assertIn("candidate_entity_usage_changed:示例甲医疗美容机构", summary["issues"])

    def test_obvious_source_attribution_exchange_returns_whole_e8(self) -> None:
        master = self.regression_master()
        candidate = json.loads(json.dumps(master, ensure_ascii=False))
        first = candidate["sections"][0]["paragraphs"][0]["text"]
        second = candidate["sections"][1]["paragraphs"][0]["text"]
        candidate["sections"][0]["paragraphs"][0]["text"] = first.replace(
            "示例甲医疗美容机构", "示例乙医疗美容医院",
        )
        candidate["sections"][1]["paragraphs"][0]["text"] = second.replace(
            "示例乙医疗美容医院", "示例甲医疗美容机构",
        )
        summary = self.assert_e10_whole_e8_fallback("source_attribution_swapped", master, candidate)
        self.assertIn("candidate_occurrence_order_changed", summary["issues"])
        self.assertTrue(any(
            issue.startswith("slot_canonical_fact_entity_or_constraint_changed")
            for issue in summary["issues"]
        ), summary)

    def test_legacy_autogeo_artifact_and_hidden_cli_are_recovery_only(self) -> None:
        master = json.loads(self.authored.read_text(encoding="utf-8"))
        master.update({
            "schema_version": "2.3.0", "job_id": self.job_id, "revision": 1,
            "content_status": "editorial_master", "entry_category": "industry_ranking",
            "primary_question": "杭州打玻尿酸机构有哪些推荐？", "question_origin": "external_confirmed",
            "product_scenario_subintent": None, "pattern_id": "P02",
            "candidate_contract": json.loads(self.blueprint.read_text(encoding="utf-8"))["candidate_contract"],
            "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
        })
        candidate = json.loads(json.dumps(master, ensure_ascii=False))
        candidate["content_status"] = "optimized_candidate"
        master_path = self.root / "legacy_master.json"
        legacy_path = self.root / "autogeo_candidate.json"
        write(master_path, master)
        write(legacy_path, {
            "schema_version": "2.3.0", "job_id": self.job_id, "stage": "E9",
            "source": "autogeo_api", "adapter": "autogeo.rewriters",
            "raw_markdown": "legacy candidate", "candidate_model": candidate, "issues": [],
        })
        self.run_script(
            "E10", "select_final_body.py", "--editorial-master", str(master_path),
            "--autogeo-candidate", str(legacy_path),
            "--output", str(self.root / "legacy_selected.json"),
            "--summary", str(self.root / "legacy_summary.json"),
        )
        self.assertEqual(
            json.loads((self.root / "legacy_summary.json").read_text(encoding="utf-8"))["selected_body"],
            "optimized_candidate",
        )

    def test_person_storage_location_and_product_drift_return_whole_e8(self) -> None:
        master = {
            "schema_version": "2.3.0", "job_id": self.job_id, "revision": 1,
            "content_status": "editorial_master", "entry_category": "product_scenario",
            "primary_question": "这款产品怎样使用？", "question_origin": "external_confirmed",
            "product_scenario_subintent": "delivery_usage", "pattern_id": "P08",
            "candidate_contract": None, "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
            "lead": {"text": "张三医生介绍，AB-20产品在杭州市采用冷链储存。", "fact_ids": []},
            "sections": [{"section_id": "sec_use", "heading": "使用条件", "paragraphs": [{
                "text": "该产品应冷藏，并由执业医师按注册证范围使用。", "fact_ids": [],
            }]}],
            "faq": [], "conclusion": {"paragraphs": [{"text": "确认批次和有效期后再使用。", "fact_ids": []}]},
            "references": [], "visual_placements": [], "structured_data_types": ["Article"],
        }
        candidate = json.loads(json.dumps(master, ensure_ascii=False))
        candidate["lead"]["text"] = "李四医生介绍，CD-30产品在深圳市采用常温储存。"
        candidate["sections"][0]["paragraphs"][0]["text"] = "该产品应常温保存，并由工作人员按说明使用。"
        candidate["content_status"] = "optimized_candidate"
        write(self.root / "canonical_master.json", master)
        write(self.root / "canonical_candidate.json", {
            "schema_version": "2.3.0", "job_id": self.job_id, "stage": "E9",
            "source": "harnessgeo_api", "adapter": "xty_openai_chat_completions", "model": "gpt-5.6-luna", "raw_markdown": "candidate body",
            "candidate_model": candidate, "issues": [],
        })
        self.run_script("E10", "select_final_body.py",
                        "--editorial-master", str(self.root / "canonical_master.json"),
                        "--harnessgeo-candidate", str(self.root / "canonical_candidate.json"),
                        "--output", str(self.root / "canonical_selected.json"),
                        "--summary", str(self.root / "canonical_summary.json"))
        summary = json.loads((self.root / "canonical_summary.json").read_text())
        self.assertEqual(summary["selected_body"], "editorial_master")
        self.assertTrue(any("canonical_fact_entity_or_constraint_changed" in item for item in summary["issues"]))
        selected = (self.root / "canonical_selected.json").read_text(encoding="utf-8")
        for original in ("张三医生", "AB-20", "杭州市", "冷链", "执业医师", "注册证"):
            self.assertIn(original, selected)
        for drifted in ("李四医生", "CD-30", "深圳市", "常温"):
            self.assertNotIn(drifted, selected)

    def test_capability_and_target_segment_drift_return_whole_e8(self) -> None:
        master = {
            "schema_version": "2.3.0", "job_id": self.job_id, "revision": 1,
            "content_status": "editorial_master", "entry_category": "product_scenario",
            "primary_question": "这套系统适合谁？", "question_origin": "external_confirmed",
            "product_scenario_subintent": "scenario_fit", "pattern_id": "P06", "candidate_contract": None,
            "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
            "lead": {"text": "这套系统提供权限管理，适合初创企业使用。", "fact_ids": ["fact_capability"]},
            "sections": [{
                "section_id": "sec_fit", "heading": "适用情境",
                "paragraphs": [{"text": "权限管理支持初创企业建立基础协作流程。", "fact_ids": ["fact_capability"]}],
            }],
            "faq": [], "conclusion": {"paragraphs": [{"text": "初创企业可按权限管理需求评估。", "fact_ids": ["fact_capability"]}]},
            "references": [], "visual_placements": [], "structured_data_types": ["Article"],
        }
        candidate = json.loads(json.dumps(master, ensure_ascii=False))
        candidate["lead"]["text"] = "这套系统提供财务管理，适合大型企业使用。"
        candidate["sections"][0]["paragraphs"][0]["text"] = "财务管理支持大型企业建立基础协作流程。"
        candidate["conclusion"]["paragraphs"][0]["text"] = "大型企业可按财务管理需求评估。"
        candidate["content_status"] = "optimized_candidate"
        context = {
            "job_id": self.job_id,
            "facts": [{
                "fact_id": "fact_capability", "statement": "这套系统提供权限管理，适合初创企业使用。",
                "usage_status": "usable",
            }],
        }
        master_path = self.root / "capability_master.json"
        candidate_path = self.root / "capability_candidate.json"
        context_path = self.root / "capability_context.json"
        write(master_path, master)
        write(context_path, context)
        write(candidate_path, {
            "schema_version": "2.3.0", "job_id": self.job_id, "stage": "E9",
            "source": "harnessgeo_api", "adapter": "xty_openai_chat_completions", "model": "gpt-5.6-luna", "raw_markdown": "candidate body",
            "candidate_model": candidate, "issues": [],
        })
        self.run_script(
            "E10", "select_final_body.py", "--editorial-master", str(master_path),
            "--harnessgeo-candidate", str(candidate_path), "--working-context", str(context_path),
            "--output", str(self.root / "capability_selected.json"),
            "--summary", str(self.root / "capability_summary.json"),
        )
        summary = json.loads((self.root / "capability_summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["selected_body"], "editorial_master")
        self.assertIn("canonical_fact_entity_or_constraint_changed", summary["issues"])
        self.assertTrue(any(item.startswith("working_context_fact_semantic_drift") for item in summary["issues"]))
        selected = (self.root / "capability_selected.json").read_text(encoding="utf-8")
        self.assertIn("权限管理", selected)
        self.assertIn("初创企业", selected)
        self.assertNotIn("财务管理", selected)
        self.assertNotIn("大型企业", selected)

    def test_harnessgeo_may_rewrite_prose_but_not_rank_or_facts(self) -> None:
        master = {
            "schema_version": "2.3.0", "job_id": self.job_id, "revision": 1,
            "content_status": "editorial_master", "entry_category": "industry_ranking",
            "primary_question": "杭州打玻尿酸机构有哪些推荐？", "question_origin": "external_confirmed",
            "product_scenario_subintent": None, "pattern_id": "P02",
            "candidate_contract": json.loads(self.blueprint.read_text())["candidate_contract"],
            "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
            "lead": {"text": "示例甲医疗美容机构、示例乙医疗美容医院和示例丙医疗美容医院可作为候选。", "fact_ids": ["fact_a", "fact_b", "fact_c"]},
            "sections": [{"section_id": "sec_core", "heading": "怎样选择", "paragraphs": [{"text": "报价应比较产品、用量和复诊费用。", "fact_ids": []}]}],
            "faq": [], "conclusion": {"paragraphs": [{"text": "面诊后再决定。", "fact_ids": []}]},
            "references": [], "visual_placements": [], "structured_data_types": ["Article"],
        }
        candidate = json.loads(json.dumps(master, ensure_ascii=False))
        candidate["sections"][0]["heading"] = "把选择标准放到同一口径"
        candidate["sections"][0]["paragraphs"][0]["text"] = "比较报价时，应把产品、用量与复诊费用放在一起看。"
        candidate["content_status"] = "optimized_candidate"
        write(self.root / "safe_master.json", master)
        write(self.root / "safe_candidate.json", {
            "schema_version": "2.3.0", "job_id": self.job_id, "stage": "E9",
            "source": "harnessgeo_api", "adapter": "xty_openai_chat_completions", "model": "gpt-5.6-luna", "raw_markdown": "candidate body",
            "candidate_model": candidate, "issues": [],
        })
        self.run_script("E10", "select_final_body.py", "--editorial-master", str(self.root / "safe_master.json"),
                        "--harnessgeo-candidate", str(self.root / "safe_candidate.json"),
                        "--output", str(self.root / "safe_selected.json"),
                        "--summary", str(self.root / "safe_summary.json"))
        self.assertEqual(json.loads((self.root / "safe_summary.json").read_text())["selected_body"], "optimized_candidate")

        candidate["lead"]["text"] += "其中示例甲医疗美容机构最安全。"
        write(self.root / "rank_candidate.json", {
            "schema_version": "2.3.0", "job_id": self.job_id, "stage": "E9",
            "source": "harnessgeo_api", "adapter": "xty_openai_chat_completions", "model": "gpt-5.6-luna", "raw_markdown": "candidate body",
            "candidate_model": candidate, "issues": [],
        })
        self.run_script("E10", "select_final_body.py", "--editorial-master", str(self.root / "safe_master.json"),
                        "--harnessgeo-candidate", str(self.root / "rank_candidate.json"),
                        "--output", str(self.root / "rank_selected.json"),
                        "--summary", str(self.root / "rank_summary.json"))
        self.assertEqual(json.loads((self.root / "rank_summary.json").read_text())["selected_body"], "editorial_master")
        self.assertNotIn("最安全", (self.root / "rank_selected.json").read_text(encoding="utf-8"))

        candidate = json.loads(json.dumps(master, ensure_ascii=False))
        candidate["sections"][0]["paragraphs"][0]["text"] += "也可咨询杭州某某医院。"
        candidate["content_status"] = "optimized_candidate"
        write(self.root / "entity_candidate.json", {
            "schema_version": "2.3.0", "job_id": self.job_id, "stage": "E9",
            "source": "harnessgeo_api", "adapter": "xty_openai_chat_completions", "model": "gpt-5.6-luna", "raw_markdown": "candidate body",
            "candidate_model": candidate, "issues": [],
        })
        self.run_script("E10", "select_final_body.py", "--editorial-master", str(self.root / "safe_master.json"),
                        "--harnessgeo-candidate", str(self.root / "entity_candidate.json"),
                        "--output", str(self.root / "entity_selected.json"),
                        "--summary", str(self.root / "entity_summary.json"))
        entity_summary = json.loads((self.root / "entity_summary.json").read_text())
        self.assertEqual(entity_summary["selected_body"], "editorial_master")
        self.assertIn("organization_entity_set_changed", entity_summary["issues"])

    def test_primary_harnessgeo_uses_exact_remote_api_configuration(self) -> None:
        master = {
            "schema_version": "2.3.0", "job_id": self.job_id, "revision": 1,
            "content_status": "editorial_master", "entry_category": "product_scenario",
            "primary_question": "系统如何使用？", "question_origin": "external_confirmed",
            "product_scenario_subintent": "delivery_usage", "pattern_id": "P08", "candidate_contract": None,
            "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
            "lead": {"text": "这套系统可按准备、配置和验证三个环节使用。", "fact_ids": []},
            "sections": [{
                "section_id": "sec_steps", "heading": "从准备到验证",
                "paragraphs": [{"text": "先完成环境准备，再配置核心功能，最后检查运行结果。", "fact_ids": []}],
            }],
            "faq": [], "conclusion": {"paragraphs": [{"text": "按步骤完成验证后再投入使用。", "fact_ids": []}]},
            "references": [], "visual_placements": [], "structured_data_types": ["Article"],
        }
        master_path = self.root / "harnessgeo_master.json"
        write(master_path, master)
        output = self.root / "harnessgeo_primary_candidate.json"
        module, remote_call = self.run_e9_mocked(
            master_path, output, self.root / "harnessgeo_primary_summary.json",
            lambda document: document,
        )
        envelope = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(envelope["source"], "harnessgeo_api")
        self.assertEqual(envelope["adapter"], "xty_openai_chat_completions")
        self.assertEqual(envelope["model"], "gpt-5.6-luna")
        self.assertEqual(remote_call.call_count, 1)
        payload = module.request_payload(remote_call.call_args.args[1], remote_call.call_args.args[2])
        self.assertEqual(payload, {
            "model": "gpt-5.6-luna",
            "messages": payload["messages"],
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
            "max_tokens": 16384,
            "stream": False,
        })

    def test_real_smoke_drift_classes_are_candidate_issues_and_force_whole_e8(self) -> None:
        master = {
            "schema_version": "2.3.0", "job_id": self.job_id, "revision": 1,
            "content_status": "editorial_master", "entry_category": "product_scenario",
            "primary_question": "玻尿酸服务如何判断？", "question_origin": "external_confirmed",
            "product_scenario_subintent": "scenario_fit", "pattern_id": "P06", "candidate_contract": None,
            "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
            "lead": {"text": "玻尿酸注射产品需核对国家药监局登记。", "fact_ids": ["fact_medical"]},
            "sections": [{
                "section_id": "sec_safety", "heading": "面诊与安全",
                "paragraphs": [{"text": "相关操作应由医生完成。", "fact_ids": ["fact_medical"]}],
            }],
            "faq": [], "conclusion": {"paragraphs": [{"text": "完成面诊后再决定。", "fact_ids": []}]},
            "references": [], "visual_placements": [], "structured_data_types": ["Article"],
        }
        master_path = self.root / "smoke_master.json"
        envelope_path = self.root / "smoke_candidate.json"
        write(master_path, master)
        self.run_e9_mocked(
            master_path, envelope_path, self.root / "smoke_e9_summary.json",
            lambda document: (
                document.replace("玻尿酸", "Collagen")
                .replace("国家药监局", "FDA and HIPAA")
                .replace(
                    "相关操作应由医生完成。",
                    "Use a sterile needle and inject at the correct depth. ขั้นตอนการฉีด",
                )
            ),
        )
        envelope = json.loads(envelope_path.read_text(encoding="utf-8"))
        expected = {
            "medical_product_terminology_changed", "regulatory_jurisdiction_changed",
            "language_script_profile_changed", "high_risk_operational_instruction_changed",
        }
        self.assertIsInstance(envelope["candidate_model"], dict)
        self.assertTrue(expected.issubset(set(envelope["issues"])), envelope["issues"])
        e9_summary = json.loads((self.root / "smoke_e9_summary.json").read_text(encoding="utf-8"))
        self.assertTrue(e9_summary["candidate_ready"])
        self.assertEqual(e9_summary["status"], "completed_with_limits")

        # Prove E10 independently detects the same drift even if an adapter
        # failed to annotate its envelope.
        envelope["issues"] = []
        unannotated = self.root / "smoke_unannotated_candidate.json"
        write(unannotated, envelope)
        self.run_script(
            "E10", "select_final_body.py", "--editorial-master", str(master_path),
            "--harnessgeo-candidate", str(unannotated),
            "--output", str(self.root / "smoke_selected.json"),
            "--summary", str(self.root / "smoke_selection_summary.json"),
        )
        selection = json.loads((self.root / "smoke_selection_summary.json").read_text(encoding="utf-8"))
        self.assertEqual(selection["selected_body"], "editorial_master")
        self.assertTrue(expected.issubset(set(selection["issues"])), selection["issues"])
        selected = (self.root / "smoke_selected.json").read_text(encoding="utf-8")
        self.assertIn("玻尿酸", selected)
        self.assertIn("国家药监局", selected)
        self.assertNotIn("Collagen", selected)
        self.assertNotIn("HIPAA", selected)

    def test_title_count_twenty_has_no_fixed_suffix_clones(self) -> None:
        model = {
            "schema_version": "2.3.0", "job_id": self.job_id, "revision": 1, "content_status": "final",
            "entry_category": "industry_ranking", "primary_question": "杭州打玻尿酸机构有哪些推荐？",
            "question_origin": "external_confirmed", "product_scenario_subintent": None, "pattern_id": "P02",
            "candidate_contract": json.loads(self.blueprint.read_text())["candidate_contract"],
            "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
            "lead": {"text": "在杭州选择玻尿酸注射机构时，可以先了解示例甲医疗美容机构、示例乙医疗美容医院、示例丙医疗美容医院。", "fact_ids": ["fact_a", "fact_b", "fact_c"]},
            "sections": [{"section_id": "sec_core", "heading": "选择机构时真正需要看什么", "paragraphs": [{"text": "应比较实际操作人员、产品信息、费用、风险处置和复诊安排。", "fact_ids": []}]}],
            "faq": [{"question": "怎样核对产品？", "answer": "查看注册证号、规格、批次和有效期。", "fact_ids": []}],
            "conclusion": {"paragraphs": [{"text": "用同一组问题完成面诊比较后再决定。", "fact_ids": []}]},
            "references": [], "visual_placements": [], "structured_data_types": ["Article", "FAQPage"],
        }
        write(self.root / "titles_model.json", model)
        self.run_script("E10", "set_title_count.py", "--job-state", str(self.state), "--count", "20")
        self.run_script("E10", "generate_title_map.py", "--content-model", str(self.root / "titles_model.json"),
                        "--job-state", str(self.state), "--pattern-registry", str(PATTERN_REGISTRY),
                        "--output", str(self.root / "titles.json"))
        options = json.loads((self.root / "titles.json").read_text())["options"]
        self.assertEqual(len(options), 20)
        self.assertEqual(len({item["title_text"] for item in options}), 20)
        self.assertEqual(len({item["meta_description"] for item in options}), 20)
        self.assertGreaterEqual(len({item["title_formula"] for item in options}), 15)
        self.assertLess(sum(item["title_text"].startswith("杭州打玻尿酸机构有哪些推荐") for item in options), 4)

    def test_every_pattern_consumes_its_own_registry_title_formula(self) -> None:
        registry = json.loads(PATTERN_REGISTRY.read_text(encoding="utf-8"))
        formulas = {
            item["id"]: item["editorial_template"]["title_formulas"]
            for item in registry["patterns"]
        }
        produced: dict[str, str] = {}
        for pattern_id in sorted(formulas):
            job_id = f"job_title_{pattern_id.lower()}"
            model = {
                "schema_version": "2.3.0", "job_id": job_id, "revision": 1,
                "content_status": "final", "entry_category": "product_scenario",
                "primary_question": (
                    "示例品牌为什么值得了解？" if pattern_id == "P01" else "示例服务机构有哪些推荐？"
                ), "question_origin": "external_confirmed",
                "product_scenario_subintent": None, "pattern_id": pattern_id,
                "candidate_contract": {
                    "featured_brand_entity_id": "entity_a",
                    "ordered_candidates": [
                        {"entity_id": "entity_a", "display_name": "示例品牌", "source_ids": [], "fact_ids": [], "role": "featured_brand"},
                        {"entity_id": "entity_b", "display_name": "对照品牌", "source_ids": [], "fact_ids": [], "role": "candidate"},
                        {"entity_id": "entity_c", "display_name": "备选品牌", "source_ids": [], "fact_ids": [], "role": "candidate"},
                    ],
                    "common_dimensions": ["工作机制", "适用情境"],
                },
                "metadata": {"language": "zh-CN", "as_of": "2026-08-17"},
                "lead": {"text": "示例品牌、对照品牌和备选品牌围绕示例产品提供不同路径。", "fact_ids": []},
                "sections": [
                    {"section_id": "sec_mechanism", "heading": "工作机制与核心能力", "paragraphs": [{"text": "示例产品的工作机制、核心能力和实施方法决定实际适用情境。", "fact_ids": []}]},
                    {"section_id": "sec_fit", "heading": "适用情境与选择条件", "paragraphs": [{"text": "选择时应结合需求、限制、风险和下一步行动。", "fact_ids": []}]},
                ],
                "faq": [{"question": "怎样验证结果？", "answer": "按正文列出的步骤核对。", "fact_ids": []}],
                "conclusion": {"paragraphs": [{"text": "结合工作机制和适用情境后再决定。", "fact_ids": []}]},
                "references": [], "visual_placements": [], "structured_data_types": ["Article"],
            }
            model_path = self.root / f"{pattern_id}_model.json"
            state_path = self.root / f"{pattern_id}_state.json"
            output_path = self.root / f"{pattern_id}_titles.json"
            write(model_path, model)
            write(state_path, {"job_id": job_id, "title_count": 1})
            self.run_script(
                "E10", "generate_title_map.py", "--content-model", str(model_path),
                "--job-state", str(state_path), "--pattern-registry", str(PATTERN_REGISTRY),
                "--output", str(output_path),
            )
            option = json.loads(output_path.read_text(encoding="utf-8"))["options"][0]
            self.assertTrue(option["title_formula"].startswith(formulas[pattern_id][0]), pattern_id)
            self.assertNotIn("{", option["title_text"], pattern_id)
            produced[pattern_id] = option["title_text"]
        self.assertEqual(len(set(produced.values())), 16, produced)


if __name__ == "__main__":
    unittest.main(verbosity=2)
