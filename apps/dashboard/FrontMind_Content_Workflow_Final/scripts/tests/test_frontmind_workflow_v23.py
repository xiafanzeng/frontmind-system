#!/usr/bin/env python3
"""Focused recovery and controller-handoff tests for the v2.3 runner."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("frontmind_workflow_v23", ROOT / "scripts/frontmind_workflow.py")
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def state(stage: str = "E6", status: str = "completed") -> dict:
    return {
        "schema_version": "2.3.0",
        "job_id": "job_runner_recovery",
        "workflow_mode": "article",
        "current_stage": stage,
        "status": status,
        "selected_pattern_id": "P02",
        "title_count": None,
        "warnings": [],
        "blocker": None,
        "updated_at": "2026-08-17T00:00:00+00:00",
    }


class RunnerV23Tests(unittest.TestCase):
    def test_explicit_p02_supplemental_research_is_consumed_without_provider_call(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E2", "completed"))
            write(root / "00_input/content_job.json", {"task": {"question_text": "有哪些推荐？"}})
            write(root / "E2/monitoring_context.json", {})
            write(root / "E2/e2_pattern_analysis.json", {})
            supplied = root / "provided_research.json"
            write(supplied, {"sources": [], "facts": []})
            observed_arguments: list[str] = []

            def fake(_stage_name: str, script: Path, arguments: list[str]) -> dict:
                self.assertEqual(script, RUNNER.E3_SCRIPT)
                observed_arguments.extend(arguments)
                write(root / "E3/editorial_context.json", {
                    "brand": {"canonical_name": "客户品牌", "aliases": []},
                    "candidate_profiles": [
                        {"role": "featured_brand", "evidence_status": "brand_supported", "fact_ids": ["f0"], "source_ids": ["s0"]},
                        {"role": "candidate", "evidence_status": "publicly_supported", "fact_ids": ["f1"], "source_ids": ["s1"]},
                        {"role": "candidate", "evidence_status": "publicly_supported", "fact_ids": ["f2"], "source_ids": ["s2"]},
                    ],
                })
                return {"status": "completed"}

            with patch.object(RUNNER, "run_script", side_effect=fake), \
                 patch.object(RUNNER, "invoke_provider", side_effect=AssertionError("provider must not run")), \
                 redirect_stdout(StringIO()):
                self.assertEqual(RUNNER.run_e3(root, "客户品牌", supplied, "P02"), root / "E3/editorial_context.json")
            self.assertIn("--supplemental-research", observed_arguments)
            self.assertIn(str(supplied.resolve()), observed_arguments)
            self.assertFalse((root / "E3/controller_action.json").exists())

    def test_p02_missing_research_provider_does_not_invent_candidates_and_returns_p2(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E2", "completed"))
            write(root / "00_input/content_job.json", {
                "job_id": "job_runner_recovery",
                "entry_category": "industry_ranking",
                "task": {"question_text": "本地服务机构有哪些推荐？"},
            })
            write(root / "E2/monitoring_context.json", {
                "derived": {
                    "competitors": [{"name": "候选甲", "answer_ids": ["answer_01"]}],
                    "candidate_order_signals": [],
                    "recurring_dimensions": ["公开服务范围"],
                },
            })
            write(root / "E2/e2_pattern_analysis.json", {
                "cited_content_pool": [], "content_observations": [],
            })

            def fake(_stage_name: str, script: Path, _arguments: list[str]) -> dict:
                if script == RUNNER.E3_SCRIPT:
                    write(root / "E3/editorial_context.json", {
                        "brand": {"canonical_name": "客户品牌", "aliases": []},
                        "facts": [{"fact_id": "fact_client", "statement": "仅有客户品牌事实。"}],
                        "candidate_profiles": [
                            {
                                "display_name": "客户品牌", "role": "featured_brand",
                                "evidence_status": "brand_supported", "fact_ids": ["fact_client"],
                                "source_ids": ["src_client"],
                            },
                            {
                                "display_name": "候选甲", "role": "candidate",
                                "evidence_status": "discovery_only", "fact_ids": [], "source_ids": [],
                            },
                        ],
                    })
                    return {"status": "completed"}
                if script == RUNNER.E4_SCRIPT:
                    context = json.loads((root / "E3/editorial_context.json").read_text(encoding="utf-8"))
                    self.assertEqual(RUNNER.p02_public_candidate_count(context), 0)
                    self.assertEqual(len(context["facts"]), 1)
                    return {
                        "status": "awaiting_pattern_confirmation",
                        "code": "p02_candidate_evidence_insufficient",
                        "message": "P02 需要至少两个公开候选。",
                    }
                return {"status": "completed"}

            with patch.dict(os.environ, {RUNNER.PROVIDER_ENV: ""}, clear=False), \
                 patch.object(RUNNER, "run_script", side_effect=fake), redirect_stdout(StringIO()):
                self.assertEqual(RUNNER.finish_blueprint_proposal(root, "P02", brand="客户品牌"), 0)
            state_payload = json.loads((root / "job_state.json").read_text(encoding="utf-8"))
            self.assertEqual((state_payload["current_stage"], state_payload["status"]), (
                "E2", "awaiting_pattern_confirmation",
            ))
            self.assertTrue(any("candidate_research_provider_unavailable" in item for item in state_payload["warnings"]))
            self.assertFalse((root / "E3/controller_action.json").exists())

    def test_p02_provider_research_enters_e3_facts_and_e4_candidate_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pack = root / "00_input/reference_pack"
            write(pack / "brand.json", {"company": {"name": "客户品牌"}})
            write(pack / "sources.json", {"sources": [{
                "source_id": "src_client_official",
                "title": "客户品牌官网",
                "source_type": "first_party_official",
                "url": "https://client.example.com/about",
                "allowed_usage": "public_facing",
            }]})
            write(pack / "claims.json", {"claims": [{
                "claim_id": "clm_client_service",
                "claim_text": "客户品牌提供与正式问题相关的公开服务，并设置预约咨询流程。",
                "about_entities": ["客户品牌"],
                "source_ids": ["src_client_official"],
                "allowed_usage": "public_facing",
            }]})
            write(root / "job_state.json", state("E2", "completed"))
            write(root / "00_input/content_job.json", {
                "schema_version": "2.3.0",
                "job_id": "job_runner_recovery",
                "reference_pack_path": "00_input/reference_pack",
                "material_paths": [],
                "entry_category": "industry_ranking",
                "task": {
                    "question_text": "本地服务机构有哪些推荐？",
                    "question_origin": "external_confirmed",
                    "foundation_subject": None,
                    "product_scenario_subintent": None,
                },
            })
            write(root / "00_input/scope_analysis.json", {})
            write(root / "E2/monitoring_context.json", {
                "question": "本地服务机构有哪些推荐？",
                "derived": {
                    "answer_landscape": [{
                        "answer_id": "answer_01",
                        "platform": "acceptance_fixture",
                        "direct_answer": "监控答案同时提及客户品牌、候选甲和候选乙。",
                        "entities": ["客户品牌", "候选甲", "候选乙"],
                        "stance": "neutral",
                        "dimensions": ["公开服务范围", "预约流程"],
                        "unanswered_subquestions": [],
                    }],
                    "competitors": [
                        {"name": "客户品牌", "answer_ids": ["answer_01"]},
                        {"name": "候选甲", "answer_ids": ["answer_01"]},
                        {"name": "候选乙", "answer_ids": ["answer_01"]},
                    ],
                    "candidate_order_signals": [
                        {"entity": "候选甲", "positions": [2]},
                        {"entity": "候选乙", "positions": [3]},
                    ],
                    "recurring_dimensions": ["公开服务范围", "预约流程"],
                    "recurring_subquestions": [],
                    "unanswered_subquestions": [],
                },
                "source_observations": [],
                "answers": [],
            })
            write(root / "E2/e2_pattern_analysis.json", {
                "question": "本地服务机构有哪些推荐？",
                "recommendation": {
                    "status": "evidence_supported",
                    "recommended_pattern_id": "P02",
                    "weighted_distribution": [],
                    "rationale": "监控与引用结构支持多品牌编辑推荐。",
                },
                "cited_content_pool": [{
                    "raw_rank": 1,
                    "content_title": "本地服务选择指南",
                    "canonical_url": "https://guide.example.com/local-services",
                    "media_name": "示例指南",
                    "citation_count": 5,
                }, {
                    "raw_rank": 2,
                    "content_title": "不安全链接样例",
                    "canonical_url": "http://127.0.0.1/private",
                    "media_name": "不安全来源",
                    "citation_count": 4,
                }],
                "content_observations": [{
                    "raw_rank": 1,
                    "status": "classified_article",
                    "primary_pattern_id": "P02",
                    "classification_confidence": 0.9,
                    "structure_summary": "先列候选，再按共同维度解释适用情境。",
                }, {
                    "raw_rank": 2,
                    "status": "unsafe_url",
                    "primary_pattern_id": None,
                }],
                "warnings": [],
            })
            provider = root / "candidate_provider.py"
            provider.write_text(
                "import argparse, json\n"
                "from pathlib import Path\n"
                "p=argparse.ArgumentParser(); p.add_argument('--request'); p.add_argument('--response'); a=p.parse_args()\n"
                "r=json.load(open(a.request, encoding='utf-8')); i=r['inputs']\n"
                "assert r['action']=='research_candidates' and r['user_pause'] is False\n"
                "assert i['formal_question']=='本地服务机构有哪些推荐？' and i['customer_brand']=='客户品牌'\n"
                "assert [x['name'] for x in i['monitoring_candidates']]==['候选甲','候选乙']\n"
                "assert i['already_supported_candidates']==[] and i['research_goal']['required_additional_candidates']==2\n"
                "assert i['top20_discovery_sources'][0]['url']=='https://guide.example.com/local-services'\n"
                "assert i['top20_discovery_sources'][1]['url'] is None and i['top20_discovery_sources'][1]['access_allowed'] is False\n"
                "assert i['common_dimensions']==['公开服务范围','预约流程']\n"
                "out=Path(r['expected_output']['path']); out.parent.mkdir(parents=True, exist_ok=True)\n"
                "payload={'sources':[\n"
                " {'source_id':'src_candidate_a','title':'候选甲官网','url':'https://a.example.com/services','source_kind':'first_party_public'},\n"
                " {'source_id':'src_candidate_b','title':'候选乙官网','url':'https://b.example.com/booking','source_kind':'first_party_public'}],\n"
                " 'facts':[\n"
                " {'fact_id':'fact_candidate_a','statement':'候选甲官网列出公开服务范围与线上预约入口。','about_entities':['候选甲'],'source_ids':['src_candidate_a'],'candidate':True},\n"
                " {'fact_id':'fact_candidate_b','statement':'候选乙官网公布服务项目，并提供预约咨询方式。','about_entities':['候选乙'],'source_ids':['src_candidate_b'],'candidate':True}]}\n"
                "json.dump(payload, open(out,'w',encoding='utf-8'), ensure_ascii=False)\n"
                "json.dump({'contract':r['contract'],'action':r['action'],'status':'completed','output_path':str(out)}, open(a.response,'w',encoding='utf-8'))\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {
                RUNNER.PROVIDER_ENV: json.dumps([sys.executable, "-B", str(provider)]),
            }, clear=False), redirect_stdout(StringIO()):
                self.assertEqual(
                    RUNNER.finish_blueprint_proposal(root, "P02", brand="客户品牌"),
                    0,
                )
            context = json.loads((root / "E3/editorial_context.json").read_text(encoding="utf-8"))
            candidates = {
                item["display_name"]: item for item in context["candidate_profiles"]
            }
            for name in ("候选甲", "候选乙"):
                self.assertEqual(candidates[name]["evidence_status"], "publicly_supported")
                self.assertTrue(candidates[name]["fact_ids"])
                self.assertTrue(candidates[name]["source_ids"])
            fact_text = "\n".join(item["statement"] for item in context["facts"])
            self.assertIn("候选甲官网列出公开服务范围", fact_text)
            self.assertIn("候选乙官网公布服务项目", fact_text)
            blueprint = json.loads((root / "E4/article_blueprint.json").read_text(encoding="utf-8"))
            ordered = [item["display_name"] for item in blueprint["candidate_contract"]["ordered_candidates"]]
            self.assertEqual(ordered[0], "客户品牌")
            self.assertEqual(set(ordered[1:]), {"候选甲", "候选乙"})
            self.assertEqual(
                json.loads((root / "job_state.json").read_text(encoding="utf-8"))["status"],
                "awaiting_blueprint_confirmation",
            )
            self.assertFalse((root / "E3/controller_action.json").exists())

    def test_legacy_enrichment_provider_is_invoked_and_s2_consumes_its_material(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "brand.md"
            source.write_text("# 示例品牌\n\n原始材料中的基础介绍。", encoding="utf-8")
            work = root / "work"
            marker = root / "provider-invoked.json"
            provider = root / "provider.py"
            provider.write_text(
                "import argparse, json, zipfile\n"
                "from pathlib import Path\n"
                "p=argparse.ArgumentParser(); p.add_argument('--request'); p.add_argument('--response'); a=p.parse_args()\n"
                "r=json.load(open(a.request, encoding='utf-8'))\n"
                "assert r['action']=='legacy_enrich_materials' and r['user_pause'] is False\n"
                "legacy=Path(r['inputs']['legacy_s1_skill']); builder=Path(r['inputs']['kb_builder_skill'])\n"
                "legacy_bytes=legacy.read_bytes(); builder_bytes=builder.read_bytes()\n"
                f"Path({str(marker)!r}).write_text(json.dumps({{'legacy_s1_bytes':len(legacy_bytes),'kb_builder_bytes':len(builder_bytes)}}), encoding='utf-8')\n"
                "out=Path(r['expected_output']['path']); out.parent.mkdir(parents=True, exist_ok=True)\n"
                "with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as z:\n"
                "    z.writestr('enriched.md', '# 示例品牌深度知识库\\n\\n兼容增强链实际产出的可用品牌事实。')\n"
                "json.dump({'contract':r['contract'],'action':r['action'],'status':'completed','output_path':str(out)}, open(a.response,'w',encoding='utf-8'))\n",
                encoding="utf-8",
            )
            # Keep the release test self-contained: deployments may point at an
            # installed KB Builder Skill, but validating an unpacked Workflow
            # must not depend on a sibling private-workflows checkout.
            builder = root / "kb-builder.skill" / "SKILL.md"
            builder.parent.mkdir(parents=True)
            builder.write_text(
                "---\nname: test-kb-builder\ndescription: Portable provider fixture.\n---\n",
                encoding="utf-8",
            )
            self.assertTrue(RUNNER.LEGACY_S1_SKILL.is_file())
            self.assertTrue(builder.is_file())
            args = SimpleNamespace(
                work_dir=work, job_id="job_prepare_enriched", input=[source], brand="示例品牌",
                intake_route="legacy_enrichment", trend_signals=None,
            )
            with patch.dict(os.environ, {
                RUNNER.PROVIDER_ENV: json.dumps([sys.executable, "-B", str(provider)]),
                RUNNER.KB_BUILDER_ENV: str(builder),
            }, clear=False), redirect_stdout(StringIO()):
                self.assertEqual(RUNNER.prepare(args), 0)
            invocation = json.loads(marker.read_text(encoding="utf-8"))
            self.assertGreater(invocation["legacy_s1_bytes"], 0)
            self.assertGreater(invocation["kb_builder_bytes"], 0)
            intake = json.loads((work / "S1/intake.json").read_text(encoding="utf-8"))
            self.assertEqual(intake["input"]["input_name"], "legacy_enriched_material.zip")
            self.assertEqual(intake["input"]["selected_route"], "legacy_s1_enrichment_then_normalization")
            knowledge_path = next((work / "S2").glob("*knowledge_registry.json"))
            knowledge = json.loads(knowledge_path.read_text(encoding="utf-8"))
            self.assertIn(
                "兼容增强链实际产出的可用品牌事实",
                "\n".join(str(item.get("content") or "") for item in knowledge["knowledge_units"]),
            )
            self.assertFalse((work / "S1/controller_action.json").exists())
            self.assertEqual(json.loads((work / "job_state.json").read_text())["status"], "awaiting_pack_confirmation")

    def test_legacy_enrichment_failure_warns_and_keeps_readable_original_material(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "brand.md"
            source.write_text("# 示例品牌\n\n原始资料在增强不可用时仍由 S2 消费。", encoding="utf-8")
            work = root / "work"
            args = SimpleNamespace(
                work_dir=work, job_id="job_prepare_fallback", input=[source], brand="示例品牌",
                intake_route="legacy_enrichment", trend_signals=None,
            )
            with patch.dict(os.environ, {RUNNER.PROVIDER_ENV: ""}, clear=False), redirect_stdout(StringIO()):
                self.assertEqual(RUNNER.prepare(args), 0)
            intake = json.loads((work / "S1/intake.json").read_text(encoding="utf-8"))
            self.assertEqual(intake["status"], "completed_with_limits")
            self.assertTrue(any("legacy_enrichment_unavailable" in item for item in intake["warnings"]))
            knowledge_path = next((work / "S2").glob("*knowledge_registry.json"))
            knowledge = json.loads(knowledge_path.read_text(encoding="utf-8"))
            self.assertIn(
                "原始资料在增强不可用时仍由 S2 消费",
                "\n".join(str(item.get("content") or "") for item in knowledge["knowledge_units"]),
            )
            self.assertFalse((work / "S1/controller_action.json").exists())
            state_payload = json.loads((work / "job_state.json").read_text(encoding="utf-8"))
            self.assertEqual(state_payload["status"], "awaiting_pack_confirmation")
            self.assertTrue(any("legacy_enrichment_unavailable" in item for item in state_payload["warnings"]))

    def test_completed_nonterminal_state_advances_from_latest_content(self) -> None:
        cases = [
            (("E5/writing_packet.json",), ("E5", "running")),
            (("E5/generated_draft.json",), ("E5", "running")),
            (("E5/content_model.json",), ("E6", "running")),
            (("E6/fact_checked.json",), ("E7", "running")),
            (("E7/prompt_plan.json",), ("E7", "running")),
            (("E7/content_with_visuals.json",), ("E8", "running")),
            (("E8/editing_brief.json",), ("E8", "running")),
            (("E8/editorial_master.json",), ("E9", "running")),
            (("E8/editorial_master.json", "E9/harnessgeo_candidate.json"), ("E10", "running")),
            (("E10/final_content_model.json",), ("E10", "awaiting_title_count")),
            (("delivery/delivery_index.json",), ("E10", "completed")),
        ]
        for artifacts, expected in cases:
            with self.subTest(artifacts=artifacts), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                write(root / "job_state.json", state())
                for relative in artifacts:
                    write(root / relative, {})
                recovered = RUNNER.recover_state(root)
                self.assertEqual((recovered["current_stage"], recovered["status"]), expected)

    def test_pause_is_preserved_without_newer_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E2", "awaiting_pattern_confirmation"))
            write(root / "E2/e2_pattern_analysis.json", {})
            recovered = RUNNER.recover_state(root)
            self.assertEqual(recovered["status"], "awaiting_pattern_confirmation")

    def test_accepted_blueprint_crash_does_not_repeat_user_confirmation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E5", "completed"))
            write(root / "E4/article_blueprint.json", {"selected_pattern_id": "P02"})
            recovered = RUNNER.recover_state(root)
            self.assertEqual((recovered["current_stage"], recovered["status"]), ("E5", "running"))

    def test_e9_resume_requires_only_its_direct_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E9", "running"))
            write(root / "E8/editorial_master.json", {"job_id": "job_runner_recovery"})
            write(root / "E3/editorial_context.json", {"job_id": "job_runner_recovery"})
            calls: list[str] = []

            def fake(stage_name: str, script: Path, arguments: list[str]) -> dict:
                calls.append(stage_name)
                if script == RUNNER.E9_SCRIPT:
                    write(root / "E9/harnessgeo_candidate.json", {})
                    return {"status": "completed"}
                if script == RUNNER.E10_SELECT:
                    self.assertIn("--working-context", arguments)
                    self.assertIn(str(root / "E3/editorial_context.json"), arguments)
                    write(root / "E10/final_content_model.json", {})
                    return {"selected_body": "editorial_master"}
                return {"status": "completed"}

            with patch.object(RUNNER, "run_script", side_effect=fake):
                self.assertEqual(RUNNER.run_content_stages(root, start_stage="E9"), 0)
            self.assertEqual(calls, ["E9", "E10", "E10"])
            self.assertEqual(json.loads((root / "job_state.json").read_text())["status"], "awaiting_title_count")

    def test_e7_no_file_is_an_attempt_and_does_not_loop(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E7", "running"))
            for relative in ("E3/editorial_context.json", "E4/article_blueprint.json", "E6/fact_checked.json"):
                write(root / relative, {})
            aigc_calls = 0

            def fake(stage_name: str, script: Path, arguments: list[str]) -> dict:
                nonlocal aigc_calls
                if script == RUNNER.E7_PLAN:
                    write(root / "E7/content_visual_planned.json", {})
                    write(root / "E7/prompt_plan.json", {
                        "images": [{"visual_id": "vis_01", "role": "explain"}],
                    })
                elif script == RUNNER.E7_AIGC:
                    aigc_calls += 1
                    self.assertNotIn("--generated-image", arguments)
                    write(root / "E7/generated_assets.json", {
                        "attempts": [{"visual_id": "vis_01", "status": "completed_with_limits"}],
                    })
                elif script == RUNNER.E7_SELECT:
                    write(root / "E7/content_with_visuals.json", {})
                elif script == RUNNER.E8_SCRIPT:
                    write(root / "E8/editing_brief.json", {})
                    return {"status": "ready_for_internal_editing"}
                return {"status": "completed"}

            with patch.dict(os.environ, {RUNNER.PROVIDER_ENV: ""}, clear=False), \
                 patch.object(RUNNER, "run_script", side_effect=fake), redirect_stdout(StringIO()):
                self.assertEqual(
                    RUNNER.run_content_stages(root, generated_images=["vis_01=NO_FILE"], start_stage="E7"),
                    0,
                )
            self.assertEqual(aigc_calls, 1)
            self.assertEqual(json.loads((root / "job_state.json").read_text())["current_stage"], "E8")

    def test_controller_handoff_is_machine_readable_and_not_a_pause(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E5", "running"))
            write(root / "E3/editorial_context.json", {})
            write(root / "E4/article_blueprint.json", {})

            def fake(_stage_name: str, script: Path, _arguments: list[str]) -> dict:
                if script == RUNNER.E5_BUILD:
                    write(root / "E5/writing_packet.json", {})
                return {"status": "ready_for_internal_authoring"}

            output = StringIO()
            with patch.dict(os.environ, {RUNNER.PROVIDER_ENV: ""}, clear=False), \
                 patch.object(RUNNER, "run_script", side_effect=fake), redirect_stdout(output):
                self.assertEqual(RUNNER.run_content_stages(root, start_stage="E5"), 0)
            action = json.loads((root / "E5/controller_action.json").read_text())
            self.assertEqual(action["contract"], "frontmind-controller-provider/v1")
            self.assertEqual(action["action"], "author_article")
            self.assertFalse(action["user_pause"])
            self.assertEqual(json.loads((root / "job_state.json").read_text())["status"], "running")
            self.assertIn('"status": "controller_handoff"', output.getvalue())

    def test_controller_authored_output_resumes_without_another_user_pause(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E5", "running"))
            write(root / "E3/editorial_context.json", {})
            write(root / "E4/article_blueprint.json", {})
            write(root / "E5/writing_packet.json", {})
            authored = root / "E5/provider_authored_model.json"
            write(authored, {})
            used_authored = False

            def fake(_stage_name: str, script: Path, arguments: list[str]) -> dict:
                nonlocal used_authored
                if script == RUNNER.E5_BUILD:
                    used_authored = "--authored-model" in arguments and str(authored.resolve()) in arguments
                    write(root / "E5/generated_draft.json", {})
                elif script == RUNNER.E5_VALIDATE:
                    write(root / "E5/content_model.json", {})
                elif script == RUNNER.E6_SCRIPT:
                    write(root / "E6/fact_checked.json", {})
                elif script == RUNNER.E7_PLAN:
                    write(root / "E7/content_visual_planned.json", {})
                    write(root / "E7/prompt_plan.json", {"images": []})
                elif script == RUNNER.E7_SELECT:
                    write(root / "E7/content_with_visuals.json", {})
                elif script == RUNNER.E8_SCRIPT:
                    write(root / "E8/editing_brief.json", {})
                    return {"status": "ready_for_internal_editing"}
                return {"status": "completed"}

            with patch.dict(os.environ, {RUNNER.PROVIDER_ENV: ""}, clear=False), \
                 patch.object(RUNNER, "run_script", side_effect=fake), redirect_stdout(StringIO()):
                self.assertEqual(RUNNER.run_content_stages(root, start_stage="E5"), 0)
            self.assertTrue(used_authored)
            resumed = json.loads((root / "job_state.json").read_text())
            self.assertEqual((resumed["current_stage"], resumed["status"]), ("E8", "running"))

    def test_fixed_provider_callback_uses_request_response_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E5", "running"))
            expected = root / "E5/provider_authored_model.json"
            request_path, request = RUNNER.controller_action(
                root,
                stage="E5",
                action="author_article",
                inputs={"writing_packet": str(root / "E5/writing_packet.json")},
                expected_kind="content_model_json",
                expected_path=expected,
            )
            provider = root / "provider.py"
            provider.write_text(
                "import argparse, json\n"
                "p=argparse.ArgumentParser(); p.add_argument('--request'); p.add_argument('--response'); a=p.parse_args()\n"
                "r=json.load(open(a.request, encoding='utf-8')); out=r['expected_output']['path']\n"
                "open(out, 'w', encoding='utf-8').write('{}')\n"
                "json.dump({'contract':r['contract'],'action':r['action'],'status':'completed','output_path':out}, open(a.response,'w',encoding='utf-8'))\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {
                RUNNER.PROVIDER_ENV: json.dumps([sys.executable, "-B", str(provider)]),
            }, clear=False):
                response = RUNNER.invoke_provider(request_path, request)
            self.assertIsNotNone(response)
            assert response is not None
            self.assertEqual(response["status"], "completed")
            self.assertEqual(RUNNER.provider_output_path(response, root), expected.resolve())

    def test_controller_edited_output_resumes_through_body_selection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E8", "running"))
            for relative in (
                "E3/editorial_context.json",
                "E4/article_blueprint.json",
                "E7/content_with_visuals.json",
                "E8/editing_brief.json",
                "E8/provider_edited_model.json",
            ):
                write(root / relative, {})
            used_edited = False

            def fake(_stage_name: str, script: Path, arguments: list[str]) -> dict:
                nonlocal used_edited
                if script == RUNNER.E8_SCRIPT:
                    used_edited = (
                        "--edited-model" in arguments
                        and str((root / "E8/provider_edited_model.json").resolve()) in arguments
                    )
                    write(root / "E8/editorial_master.json", {})
                elif script == RUNNER.E9_SCRIPT:
                    write(root / "E9/harnessgeo_candidate.json", {})
                elif script == RUNNER.E10_SELECT:
                    write(root / "E10/final_content_model.json", {})
                    return {"selected_body": "editorial_master"}
                return {"status": "completed"}

            with patch.object(RUNNER, "run_script", side_effect=fake), redirect_stdout(StringIO()):
                self.assertEqual(RUNNER.run_content_stages(root, start_stage="E8"), 0)
            self.assertTrue(used_edited)
            self.assertEqual(json.loads((root / "job_state.json").read_text())["status"], "awaiting_title_count")

    def test_e9_runtime_maps_key_and_discards_all_local_or_override_settings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.dict(os.environ, {
                "XTY_API_KEY": "fake-runner-key",
                "GOOGLE_API_KEY": "obsolete-google-key",
                "FRONTMIND_HARNESSGEO_PYTHON": str(root / "missing-python"),
                "FRONTMIND_HARNESSGEO_ROOT": str(root / "missing-root"),
                "FRONTMIND_AUTOGEO_MODEL_PATH": "/must/not/be/used",
                "FRONTMIND_HARNESSGEO_MODEL": "caller-must-not-override",
                "FRONTMIND_HARNESSGEO_ENDPOINT": "https://caller.invalid/v1",
            }, clear=False):
                executable, environment = RUNNER.script_runtime("E9")
            self.assertEqual(executable, Path(sys.executable).resolve())
            self.assertEqual(environment["FRONTMIND_HARNESSGEO_API_KEY"], "fake-runner-key")
            for name in (
                "XTY_API_KEY", "GOOGLE_API_KEY", "FRONTMIND_HARNESSGEO_PYTHON",
                "FRONTMIND_HARNESSGEO_ROOT", "FRONTMIND_AUTOGEO_MODEL_PATH",
                "FRONTMIND_HARNESSGEO_MODEL", "FRONTMIND_HARNESSGEO_ENDPOINT",
            ):
                self.assertNotIn(name, environment)

    def test_e9_runtime_rejects_missing_managed_key(self) -> None:
        with patch.dict(os.environ, {
            "FRONTMIND_HARNESSGEO_API_KEY": "", "XTY_API_KEY": "",
            "FRONTMIND_HARNESSGEO_KEYS_FILE": "",
        }, clear=False):
            with self.assertRaisesRegex(RuntimeError, "FRONTMIND_HARNESSGEO_API_KEY"):
                RUNNER.script_runtime("E9")

    def test_recovery_accepts_legacy_autogeo_candidate_without_making_it_active(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E9", "completed"))
            write(root / "E8/editorial_master.json", {})
            write(root / "E9/autogeo_candidate.json", {})
            recovered = RUNNER.recover_state(root)
            self.assertEqual((recovered["current_stage"], recovered["status"]), ("E10", "running"))

    def test_title_delivery_passes_the_canonical_pattern_registry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write(root / "job_state.json", state("E10", "awaiting_title_count"))
            write(root / "E10/final_content_model.json", {})
            title_arguments: list[str] = []

            def fake(_stage_name: str, script: Path, arguments: list[str]) -> dict:
                if script == RUNNER.E10_TITLES:
                    title_arguments.extend(arguments)
                    write(root / "E10/title_map.json", {})
                return {"status": "completed"}

            with patch.object(RUNNER, "run_script", side_effect=fake), redirect_stdout(StringIO()):
                result = RUNNER.deliver_titles(SimpleNamespace(title_count=5), root)
            self.assertEqual(result, 0)
            self.assertIn("--pattern-registry", title_arguments)
            self.assertIn(str(RUNNER.PATTERN_REGISTRY), title_arguments)


if __name__ == "__main__":
    unittest.main(verbosity=2)
