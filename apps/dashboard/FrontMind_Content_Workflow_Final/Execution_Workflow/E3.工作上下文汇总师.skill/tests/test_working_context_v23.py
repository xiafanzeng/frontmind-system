from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

from PIL import Image


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_working_context.py"
PACKAGE = Path(__file__).resolve().parents[3]
STRATEGY = PACKAGE / "Strategy_Workflow"
E7_SKILL = PACKAGE / "Execution_Workflow/E7.视觉论证与资产生产师.skill"


def load_script(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkingContextV23Tests(unittest.TestCase):
    question = "杭州打玻尿酸机构有哪些推荐？"

    @staticmethod
    def write(path: Path, value: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def build_inputs(self, root: Path, supplemental: bool = True) -> tuple[Path, Path, Path, Path | None]:
        pack = root / "pack"
        pack.mkdir()
        self.write(pack / "reference_pack.json", {
            "schema_version": "2.2.0", "profile": "frontmind-content-reference-pack-v2.2",
            "brand": {"canonical_name": "客户品牌", "aliases": []},
            "registries": {"sources": "sources.json", "claims": "claims.json", "images": "images.json"},
        })
        self.write(pack / "sources.json", {"sources": [
            {"source_id": "src_brand", "title": "客户品牌官网", "source_kind": "first_party_official", "url": "https://brand.example.com"},
            {"source_id": "src_internal", "title": "内部材料", "source_kind": "first_party_internal", "allowed_usage": "internal_only"},
        ]})
        self.write(pack / "claims.json", {"claims": [
            {"claim_id": "clm_brand_service", "claim_text": "客户品牌在杭州提供公开的注射面诊、产品验真和术后复诊流程。", "about_entities": ["客户品牌"], "source_ids": ["src_brand"], "allowed_usage": "public"},
            {"claim_id": "clm_internal_note", "claim_text": "内部保密培训材料不得公开。", "about_entities": ["客户品牌"], "source_ids": ["src_internal"], "allowed_usage": "internal_only"},
        ]})
        self.write(pack / "images.json", {"images": [
            {"image_id": "img_licensed", "file_path": "assets/licensed.jpg", "asset_kind": "brand_image", "rights_status": "approved_with_credit", "attribution_text": "摄影：示例摄影师"},
            {"image_id": "img_logo", "file_path": "assets/logo.png", "asset_kind": "logo", "rights_status": "approved"},
            {"image_id": "img_missing_credit", "file_path": "assets/missing-credit.jpg", "asset_kind": "brand_photo", "rights_status": "approved_with_credit"},
        ]})
        self.write(pack / "visual.json", {"stage": "S6_visual_reference_system", "asset_pool": [
            {"image_id": "img_licensed", "file_path": "assets/licensed.jpg", "asset_kind": "brand_image", "rights_status": "approved_with_credit", "credit": "摄影：示例摄影师", "allowed_roles": ["brand_editorial", "navigate"]},
            {"image_id": "img_logo", "file_path": "assets/logo.png", "asset_kind": "logo", "rights_status": "approved", "allowed_roles": ["brand_editorial"]},
        ]})
        assets = pack / "assets"
        assets.mkdir()
        Image.new("RGB", (1200, 700), "#ccddee").save(assets / "licensed.jpg")
        Image.new("RGBA", (320, 120), (255, 255, 255, 220)).save(assets / "logo.png")
        Image.new("RGB", (900, 600), "#eeeeee").save(assets / "missing-credit.jpg")
        self.write(pack / "architecture.json", {
            "schema_version": "2.3.0", "stage": "S4_information_evidence_architecture",
            "proof_bundles": [{"proof_id": "proof_001", "claim_ids": ["clm_brand_service"]}],
            "brand_priority_angles": [{
                "angle_id": "angle_01", "priority_message": "把面诊、产品验真和复诊流程作为客户品牌的重点价值",
                "editorial_role": "用具体流程自然引出品牌", "eligible_entry_categories": ["industry_ranking"],
                "eligible_pattern_ids": ["P02"], "proof_refs": ["proof_001"], "claim_ids": ["clm_brand_service"],
            }],
            "publication_boundary": {"first_party_cannot_alone_support": ["市场第一", "优于竞品"]},
        })
        self.write(pack / "voice.json", {
            "schema_version": "2.3.0", "stage": "S5_article_voice_contract",
            "voice_mode": "third_party_objective_reporting_plus_brand_promotion",
            "editorial_position": "以第三人称编辑视角直接回答问题，用事实解释选择价值。",
            "reader_experience": ["答案前置", "实体清楚", "判断标准具体"],
            "style": {"tone": "客观、清晰、有判断力", "sentence_rhythm": "长短句交替", "brand_expression": "事实—能力意义—适合情境"},
            "brand_messages": [{"angle_id": "angle_01", "message": "突出完整服务流程"}],
            "publication_language": {"supported_fact": "直接陈述"},
            "forbidden_public_phrases": ["资料较完整", "待核验候选"],
            "entry_overrides": [{"entry_category": "industry_ranking", "tone_adjustment": "保持编辑推荐感"}],
        })
        job = root / "job.json"
        self.write(job, {
            "job_id": "job_context_test", "entry_category": "industry_ranking", "reference_pack_path": "pack", "material_paths": [],
            "task": {"question_text": self.question, "question_origin": "external_confirmed", "foundation_subject": None},
        })
        monitoring = root / "monitoring.json"
        self.write(monitoring, {
            "question": self.question,
            "answers": [{"answer_id": "answer_001", "platform": "平台甲", "citations": [
                {"url": "https://candidate-a.example.com", "title": "候选甲医院官网", "publisher": "候选甲医院"},
                {"url": "https://candidate-b.example.com", "title": "候选乙医院官网", "publisher": "候选乙医院"},
            ]}],
            "source_observations": [
                {"url": "https://candidate-a.example.com", "title": "候选甲医院官网", "publisher": "候选甲医院"},
                {"url": "https://candidate-b.example.com", "title": "候选乙医院官网", "publisher": "候选乙医院"},
            ],
            "derived": {
                "answer_landscape": [{"answer_id": "answer_001", "platform": "平台甲", "direct_answer": "可关注三家机构。", "entities": ["客户品牌", "候选甲医院", "候选乙医院"], "stance": "positive", "dimensions": ["机构与医生资质"], "unanswered_subquestions": ["费用如何构成？"]}],
                "competitors": [
                    {"name": "候选甲医院", "answer_ids": ["answer_001"]},
                    {"name": "候选乙医院", "answer_ids": ["answer_001"]},
                ],
                "candidate_order_signals": [
                    {"entity": "候选甲医院", "positions": [1]}, {"entity": "候选乙医院", "positions": [2]},
                ],
                "recurring_subquestions": ["费用如何构成？"],
                "unanswered_subquestions": ["异常如何处置？", "尚未回答：是否需要进一步核对三家当前医生？"],
            },
        })
        e2 = root / "e2.json"
        self.write(e2, {
            "question": self.question, "warnings": [],
            "recommendation": {"status": "evidence_supported", "recommended_pattern_id": "P02", "weighted_distribution": [{"pattern_id": "P02", "weighted_share": 1}]},
            "cited_content_pool": [{"raw_rank": 1, "content_title": "杭州医美机构选择指南", "canonical_url": "https://media.example.com/guide", "citation_count": 8}],
            "content_observations": [{
                "raw_rank": 1, "status": "classified_article", "primary_pattern_id": "P02",
                "classification_confidence": .92,
                "matched_structure_component_ids": ["P02_component_scope_criteria"],
                "structure_summary": "Secondary Menu → Main Menu Mega → 选择标准",
                "benchmark_review": {
                    "benchmark_id": "P02-B01",
                    "structure_observation": [
                        "页面先交代候选范围与编辑标准，再按共同维度展开各机构。",
                        "限制与风险集中处理，没有在每个候选段落重复。",
                    ],
                    "subquestions_observed": ["商业关系是否影响候选顺序？"],
                    "evidence_positions_observed": ["每家机构的关键事实紧邻对应来源与时间。"],
                    "visual_observation": ["候选导航不使用分数或名次。"],
                    "faq_observation": "FAQ 只补正文未解决的决策问题。",
                    "strengths": ["方法披露和候选正文分开。"],
                    "weaknesses": ["页面不是医疗机构推荐。"],
                    "do_not_copy": ["不得复制其评分体系。"],
                    "selection_rationale": "用于把候选范围、共同标准和机构事实自然分层。",
                    "research_note": "2026-08-17 逐页复审。",
                },
            }],
        })
        research = None
        if supplemental:
            research = root / "supplemental.json"
            self.write(research, {
                "sources": [
                    {"source_id": "src_candidate_a", "title": "候选甲医院官网", "url": "https://candidate-a.example.com/about"},
                    {"source_id": "src_candidate_b", "title": "候选乙医院官网", "url": "https://candidate-b.example.com/about"},
                ],
                "candidate_facts": [
                    {"fact_id": "fact_candidate_a", "statement": "候选甲医院公开提供注射类医疗美容服务。", "about_entities": ["候选甲医院"], "source_ids": ["src_candidate_a"]},
                    {"fact_id": "fact_candidate_b", "statement": "候选乙医院公开介绍面诊与复诊安排。", "about_entities": ["候选乙医院"], "source_ids": ["src_candidate_b"]},
                ],
            })
        return job, monitoring, e2, research

    def test_s4_s5_monitoring_benchmarks_and_supplemental_facts_enter_editorial_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job, monitoring, e2, research = self.build_inputs(root)
            command = [
                sys.executable, "-B", str(SCRIPT), "--job-root", str(root), "--content-job", str(job),
                "--monitoring-context", str(monitoring), "--e2-analysis", str(e2),
                "--supplemental-research", str(research), "--brand", "客户品牌",
                "--output", str(root / "working_context.json"),
            ]
            result = subprocess.run(command, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            context = json.loads((root / "working_context.json").read_text(encoding="utf-8"))
            self.assertEqual(context["schema_version"], "2.3.0")
            self.assertEqual(context["voice_profile"]["editorial_stance"], "以第三人称编辑视角直接回答问题，用事实解释选择价值。")
            self.assertIn("客观、清晰、有判断力", context["voice_profile"]["style_summary"])
            self.assertIn("待核验候选", context["voice_profile"]["forbidden_public_phrases"])
            self.assertEqual(context["brand_priority_angle"]["angle"], "把面诊、产品验真和复诊流程作为客户品牌的重点价值")
            self.assertEqual(context["brand_priority_angle"]["fact_ids"], ["clm_brand_service"])
            self.assertIn("市场第一", context["brand_priority_angle"]["must_not_claim"])
            self.assertEqual(context["answer_landscape"][0]["direct_answer"], "可关注三家机构。")
            self.assertIn("费用如何构成？", context["reader_questions"])
            self.assertNotIn("尚未回答", "\n".join(context["reader_questions"]))
            self.assertNotIn("Secondary Menu", context["benchmark_moves"][0]["structure_summary"])
            benchmark = context["benchmark_moves"][0]
            self.assertEqual(benchmark["benchmark_id"], "P02-B01")
            self.assertEqual(benchmark["structure_observations"], [
                "页面先交代候选范围与编辑标准，再按共同维度展开各机构。",
                "限制与风险集中处理，没有在每个候选段落重复。",
            ])
            self.assertEqual(benchmark["subquestions"], ["商业关系是否影响候选顺序？"])
            self.assertEqual(benchmark["evidence_positions"], ["每家机构的关键事实紧邻对应来源与时间。"])
            self.assertEqual(benchmark["selection_rationale"], "用于把候选范围、共同标准和机构事实自然分层。")
            self.assertIn("页面先交代候选范围", benchmark["adoptable_moves"][0])
            self.assertIn("每家机构的关键事实", benchmark["adoptable_moves"][-1])
            candidates = {item["display_name"]: item for item in context["candidate_profiles"]}
            self.assertEqual(candidates["候选甲医院"]["evidence_status"], "publicly_supported")
            self.assertEqual(candidates["候选乙医院"]["evidence_status"], "publicly_supported")
            self.assertTrue(candidates["候选甲医院"]["fact_ids"])
            self.assertIn("excluded", {item["usage_status"] for item in context["facts"]})
            images = {item["image_id"]: item for item in context["images"]}
            self.assertEqual(images["img_licensed"]["credit"], "摄影：示例摄影师")
            self.assertEqual(images["img_licensed"]["usage_status"], "usable")
            self.assertTrue(images["img_licensed"]["file_path"].startswith("00_input/reference_assets/"))
            self.assertTrue((root / images["img_licensed"]["file_path"]).is_file())
            self.assertNotIn("img_missing_credit", images)
            visuals = {item["image_id"]: item for item in context["visual_assets"]}
            self.assertEqual(visuals["img_licensed"]["usable_for"], ["brand_editorial", "navigate"])
            self.assertEqual(visuals["img_licensed"]["credit"], "摄影：示例摄影师")
            serialized = json.dumps(context)
            self.assertNotIn("sha256", serialized)
            self.assertNotIn("receipt", serialized)

    def test_v22_zip_materializes_approved_images_for_e7_and_logo_overlay(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job, monitoring, e2, research = self.build_inputs(root)
            archive_path = root / "reference-pack.zip"
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for item in sorted((root / "pack").rglob("*")):
                    if item.is_file():
                        archive.write(item, f"brand-pack/{item.relative_to(root / 'pack').as_posix()}")
            job_payload = json.loads(job.read_text(encoding="utf-8"))
            job_payload["reference_pack_path"] = archive_path.name
            self.write(job, job_payload)
            output = root / "E3/editorial_context.json"
            result = subprocess.run([
                sys.executable, "-B", str(SCRIPT), "--job-root", str(root), "--content-job", str(job),
                "--monitoring-context", str(monitoring), "--e2-analysis", str(e2),
                "--supplemental-research", str(research), "--brand", "客户品牌", "--output", str(output),
            ], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            context = json.loads(output.read_text(encoding="utf-8"))
            by_id = {item["image_id"]: item for item in context["images"]}
            self.assertEqual(set(by_id), {"img_licensed", "img_logo"})
            for image in by_id.values():
                self.assertFalse(Path(image["file_path"]).is_absolute())
                self.assertTrue((root / image["file_path"]).is_file())
                self.assertNotIn("frontmind-e3-", image["file_path"])

            planner = load_script("frontmind_e7_plan_from_pack", E7_SKILL / "scripts/build_visual_plan.py")
            invoker = load_script("frontmind_e7_overlay_from_pack", E7_SKILL / "scripts/aigc_invoker.py")
            model = {
                "job_id": "job_context_test", "pattern_id": "P02", "sections": [{
                    "section_id": "sec_choice", "heading": "怎样选择", "paragraphs": [{"text": "比较服务流程。", "fact_ids": ["clm_brand_service"]}],
                }], "visual_placements": [],
            }
            blueprint = {"visual_plan": [
                {"role": "brand_editorial", "after_section_id": None, "brief": "品牌封面"},
                {"role": "explain", "after_section_id": "sec_choice", "brief": "解释选择流程"},
            ]}
            planned, prompt = planner.build(model, context, blueprint)
            self.assertEqual(planned["visual_placements"][0]["asset_id"], "img_licensed")
            self.assertEqual(prompt["images"][0]["logo_overlay_asset_id"], "img_logo")
            generated = root / "provider.png"
            overlaid = root / "E7/generated/with-logo.jpg"
            Image.new("RGB", (1200, 700), "#335577").save(generated)
            self.assertEqual(invoker.overlay_original_logo(
                generated, overlaid, prompt["images"][0], context, root,
            ), (1200, 700))
            self.assertTrue(overlaid.is_file())

    def test_unsafe_duplicate_symlink_missing_and_unlicensed_visuals_degrade_to_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job, monitoring, e2, research = self.build_inputs(root)
            pack = root / "pack"
            self.write(pack / "images.json", {"images": [
                {"image_id": "img_escape", "file_path": "../escape.png", "asset_kind": "logo", "rights_status": "approved"},
                {"image_id": "img_missing", "file_path": "assets/missing.png", "asset_kind": "brand_image", "rights_status": "approved"},
                {"image_id": "img_bad", "file_path": "assets/bad.png", "asset_kind": "brand_image", "rights_status": "approved"},
                {"image_id": "img_link", "file_path": "assets/link.png", "asset_kind": "logo", "rights_status": "approved"},
                {"image_id": "img_unlicensed", "file_path": "assets/unlicensed.png", "asset_kind": "brand_image", "rights_status": "unknown"},
            ]})
            self.write(pack / "visual.json", {"asset_pool": []})
            Image.new("RGB", (200, 100), "#abcdef").save(pack / "assets/unlicensed.png")
            archive_path = root / "unsafe-visuals.zip"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    for item in sorted(pack.rglob("*")):
                        if item.is_file() and item.name not in {"licensed.jpg", "logo.png", "missing-credit.jpg", "unlicensed.png"}:
                            archive.write(item, f"brand-pack/{item.relative_to(pack).as_posix()}")
                    archive.writestr("brand-pack/assets/bad.png", b"not an image")
                    archive.writestr("brand-pack/assets/bad.png", b"duplicate must not replace the first member")
                    archive.write(pack / "assets/unlicensed.png", "brand-pack/assets/unlicensed.png")
                    symlink = zipfile.ZipInfo("brand-pack/assets/link.png")
                    symlink.create_system = 3
                    symlink.external_attr = 0o120777 << 16
                    archive.writestr(symlink, "../outside.png")
            job_payload = json.loads(job.read_text(encoding="utf-8"))
            job_payload["reference_pack_path"] = archive_path.name
            self.write(job, job_payload)
            output = root / "E3/editorial_context.json"
            result = subprocess.run([
                sys.executable, "-B", str(SCRIPT), "--job-root", str(root), "--content-job", str(job),
                "--monitoring-context", str(monitoring), "--e2-analysis", str(e2),
                "--supplemental-research", str(research), "--brand", "客户品牌", "--output", str(output),
            ], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            context = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(context["images"], [])
            self.assertEqual(context["visual_assets"], [])
            self.assertFalse((root / "escape.png").exists())
            self.assertNotIn("awaiting", result.stdout.casefold())
            stage = json.loads(result.stdout)
            self.assertGreater(stage["visual_warnings"], 0)
            self.assertGreater(stage["archive_warnings"], 0)

    def test_monitoring_mentions_remain_discovery_only_without_public_facts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            job, monitoring, e2, _research = self.build_inputs(root, supplemental=False)
            result = subprocess.run([
                sys.executable, "-B", str(SCRIPT), "--job-root", str(root), "--content-job", str(job),
                "--monitoring-context", str(monitoring), "--e2-analysis", str(e2), "--brand", "客户品牌",
                "--output", str(root / "working_context.json"),
            ], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            context = json.loads((root / "working_context.json").read_text(encoding="utf-8"))
            candidates = [item for item in context["candidate_profiles"] if item["role"] != "featured_brand"]
            self.assertTrue(candidates)
            self.assertTrue(all(item["evidence_status"] == "discovery_only" for item in candidates))
            self.assertTrue(all(not item["fact_ids"] for item in candidates))

    def test_all_excluded_core_content_is_a_real_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "内部资料.md").write_text("内部保密：该段不得公开，仅用于员工培训。", encoding="utf-8")
            self.write(root / "job.json", {
                "job_id": "job_context_block", "entry_category": "foundation_start", "material_paths": ["内部资料.md"],
                "task": {"question_text": None, "question_origin": "foundation_derived", "foundation_subject": "品牌特写"},
            })
            result = subprocess.run([
                sys.executable, "-B", str(SCRIPT), "--job-root", str(root), "--content-job", str(root / "job.json"),
                "--brand", "示例品牌", "--output", str(root / "working_context.json"),
            ], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("restricted_core_dependency", result.stderr)

    def test_actual_v23_reference_pack_projects_s4_and_s5_into_e3(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "working-set.zip"
            bundle = {
                "kind": "frontmind.kb-working-set", "schemaVersion": 1,
                "company": {"name": "示例品牌", "website": "https://example.com"},
                "leaves": [{
                    "leafId": "1.0", "branchId": "identity", "title": "公开服务",
                    "contentPath": "nodes/0001.md", "evidencePaths": ["evidence/1.0/source.md"], "assetIds": [],
                }],
                "evidenceLedger": [{
                    "path": "evidence/1.0/source.md", "leafId": "1.0",
                    "sourceUrl": "https://example.com/about", "retrievedAt": "2026-08-01T00:00:00Z",
                }],
            }
            with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("BUNDLE.json", json.dumps(bundle, ensure_ascii=False))
                archive.writestr("nodes/0001.md", "# 公开服务\n\n示例品牌提供企业内容策划与交付服务。")
                archive.writestr("evidence/1.0/source.md", "# 官网\n\n示例品牌公开介绍企业内容策划与交付服务。")

            intake = root / "S1/intake.json"
            commands = [
                [STRATEGY / "S1.企业资料与知识库接入师.skill/scripts/canonical_kb_intake.py", "--brand", "示例品牌", "--input", source, "--output", intake],
                [STRATEGY / "S2.资料标准化适配器.skill/scripts/kb_v4_adapter.py", "--brand", "示例品牌", "--input", source, "--s1-intake", intake, "--output-dir", root / "S2"],
                [STRATEGY / "scripts/produce_strategy_assets.py", "--brand", "示例品牌", "--work-dir", root],
            ]
            for command in commands:
                result = subprocess.run([sys.executable, "-B", *(str(item) for item in command)], text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            pack = root / "ReferencePack/example.zip"
            result = subprocess.run([
                sys.executable, "-B", str(STRATEGY / "S9.ReferencePack装配师.skill/scripts/pack_builder.py"),
                "--brand", "示例品牌", "--work-dir", str(root), "--output", str(pack),
            ], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

            question = "示例品牌为什么值得推荐？"
            self.write(root / "job.json", {
                "job_id": "job_real_pack", "entry_category": "industry_ranking",
                "reference_pack_path": "ReferencePack/example.zip", "material_paths": [],
                "task": {"question_text": question, "question_origin": "external_confirmed", "foundation_subject": None},
            })
            self.write(root / "monitoring.json", {
                "question": question, "answers": [{"answer_id": "answer_001", "platform": "平台甲", "citations": []}],
                "source_observations": [], "derived": {
                    "answer_landscape": [{"answer_id": "answer_001", "platform": "平台甲", "direct_answer": "应结合服务能力与适用需求判断。", "entities": ["示例品牌"], "stance": "neutral", "dimensions": ["流程与交付"], "unanswered_subquestions": []}],
                    "competitors": [], "candidate_order_signals": [], "recurring_subquestions": ["服务如何交付？"], "unanswered_subquestions": [],
                },
            })
            self.write(root / "e2.json", {
                "question": question, "warnings": [],
                "recommendation": {"status": "partial_support", "recommended_pattern_id": "P01", "weighted_distribution": [{"pattern_id": "P01", "weighted_share": 0}]},
                "cited_content_pool": [], "content_observations": [],
            })
            result = subprocess.run([
                sys.executable, "-B", str(SCRIPT), "--job-root", str(root), "--content-job", str(root / "job.json"),
                "--monitoring-context", str(root / "monitoring.json"), "--e2-analysis", str(root / "e2.json"),
                "--output", str(root / "working_context.json"),
            ], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            context = json.loads((root / "working_context.json").read_text(encoding="utf-8"))
            self.assertEqual(context["brand"]["canonical_name"], "示例品牌")
            self.assertEqual(context["voice_profile"]["editorial_stance"], "以第三人称编辑视角直接回答问题，用可核对事实呈现品牌价值，不暴露资料处理过程")
            self.assertIn("待核验候选", context["voice_profile"]["forbidden_public_phrases"])
            self.assertTrue(context["brand_priority_angle"]["angle"])
            self.assertTrue(context["brand_priority_angle"]["fact_ids"])


if __name__ == "__main__":
    unittest.main()
