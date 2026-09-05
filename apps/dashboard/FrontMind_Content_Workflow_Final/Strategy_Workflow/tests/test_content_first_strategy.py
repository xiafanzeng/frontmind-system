from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


PACKAGE = Path(__file__).resolve().parents[2]
STRATEGY = PACKAGE / "Strategy_Workflow"
S1 = STRATEGY / "S1.企业资料与知识库接入师.skill/scripts/canonical_kb_intake.py"
S2 = STRATEGY / "S2.资料标准化适配器.skill/scripts/kb_v4_adapter.py"
S9 = STRATEGY / "S9.ReferencePack装配师.skill/scripts/pack_builder.py"
PRODUCER = STRATEGY / "scripts/produce_strategy_assets.py"
STATE_DETECTOR = STRATEGY / "S9.ReferencePack装配师.skill/scripts/state_detector.py"
S4_VALIDATOR = STRATEGY / "S4.内容价值与证据架构师.skill/scripts/information_evidence_validator.py"
S5_VALIDATOR = STRATEGY / "S5.文章话语契约.skill/scripts/article_voice_contract_validator.py"
S6_VALIDATOR = STRATEGY / "S6.视觉参考体系.skill/scripts/visual_reference_validator.py"
S7_VALIDATOR = STRATEGY / "S7.问题与FAQ参考库.skill/scripts/question_library_validator.py"
PATTERN_REGISTRY = PACKAGE / "shared/content-pattern-registry.json"
PACKAGE_VALIDATOR = PACKAGE / "shared/scripts/validate_package.py"
V21_FIXTURE = PACKAGE / "shared/fixtures/minimal_reference_pack"


def run(*args: object, expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run([sys.executable, "-B", *(str(value) for value in args)], text=True, capture_output=True)
    if result.returncode != expected:
        raise AssertionError(f"command returned {result.returncode}, expected {expected}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return result


def make_working_set(path: Path) -> None:
    bundle = {
        "kind": "frontmind.kb-working-set",
        "schemaVersion": 1,
        "skill": {"name": "socratic-kb-builder", "version": "5"},
        "company": {"name": "示例品牌", "website": "https://example.com/"},
        "leaves": [
            {
                "leafId": "1.0",
                "branchId": "identity",
                "title": "品牌身份",
                "contentPath": "nodes/0001.md",
                "evidencePaths": ["evidence/1.0/source.md"],
                "assetIds": [],
            },
            {
                "leafId": "2.0",
                "branchId": "internal",
                "title": "内部培训",
                "contentPath": "nodes/0002.md",
                "evidencePaths": [],
                "assetIds": [],
            },
        ],
        "evidenceLedger": [
            {
                "path": "evidence/1.0/source.md",
                "leafId": "1.0",
                "sourceUrl": "https://example.com/about",
                "retrievedAt": "2026-08-01T00:00:00Z",
            }
        ],
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("BUNDLE.json", json.dumps(bundle, ensure_ascii=False))
        archive.writestr("nodes/0001.md", "# 品牌身份\n\n示例品牌提供公开的企业内容服务。\n\n这项服务适合哪些内容需求？")
        archive.writestr("nodes/0002.md", "# 内部培训\n\n仅供内部：客户个人信息与操作步骤。")
        archive.writestr("evidence/1.0/source.md", "# 官网来源\n\n示例品牌公开介绍企业内容服务。")


class ContentFirstStrategyTests(unittest.TestCase):
    def test_working_set_continues_through_lightweight_pack(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            source = project / "working-set.zip"
            make_working_set(source)
            intake = project / "S1/S1_example_intake.json"
            run(S1, "--brand", "示例品牌", "--input", source, "--output", intake)
            s1 = json.loads(intake.read_text(encoding="utf-8"))
            self.assertEqual(s1["input"]["input_kind"], "frontmind_kb_working_set_v5")
            self.assertFalse(any(key.startswith("builder_") for key in s1))

            run(S2, "--brand", "示例品牌", "--input", source, "--s1-intake", intake, "--output-dir", project / "S2")
            report = json.loads(next((project / "S2").glob("*adapter_report.json")).read_text(encoding="utf-8"))
            self.assertEqual(report["counts"]["knowledge"], 2)
            self.assertGreaterEqual(report["usage_status_counts"]["usable"], 1)
            self.assertGreaterEqual(report["usage_status_counts"]["excluded"], 1)
            claims = json.loads(next((project / "S2").glob("*claim_registry.json")).read_text(encoding="utf-8"))["claims"]
            public_claim = next(item for item in claims if item["usage_status"] == "usable")
            self.assertEqual(public_claim["claim_text"], "示例品牌提供公开的企业内容服务。")
            self.assertNotEqual(public_claim["claim_text"], "品牌身份")

            result = run(PRODUCER, "--brand", "示例品牌", "--work-dir", project, "--through", "S8")
            stages = json.loads(result.stdout)["stages"]
            self.assertEqual([item["stage"] for item in stages], ["S3", "S4", "S5", "S6", "S7", "S8"])
            self.assertEqual(stages[1]["status"], "completed")
            self.assertEqual(stages[2]["status"], "completed")
            self.assertEqual(stages[-1]["status"], "awaiting_pack_confirmation")

            architecture = next((project / "S4").glob("*information_evidence_architecture.json"))
            brand_facts = next((project / "S4").glob("*brand_facts.json"))
            voice = next((project / "S5").glob("*voice_contract.json"))
            visual = next((project / "S6").glob("*visual_reference.json"))
            questions = next((project / "S7").glob("*question_library.json"))
            pack_summary = next((project / "S8").glob("*pack_summary.json"))

            s4 = json.loads(architecture.read_text(encoding="utf-8"))
            self.assertTrue(s4["positioning"]["reasons_to_believe"])
            self.assertTrue(s4["proof_bundles"])
            self.assertTrue(s4["brand_priority_angles"])
            proof = s4["proof_bundles"][0]
            self.assertTrue(proof["claim_ids"])
            self.assertTrue(proof["source_ids"])

            s5 = json.loads(voice.read_text(encoding="utf-8"))
            self.assertEqual(s5["voice_mode"], "third_party_objective_reporting_plus_brand_promotion")
            self.assertIn("待核验候选", s5["forbidden_public_phrases"])
            self.assertEqual(json.loads(visual.read_text(encoding="utf-8"))["delivery_mode"], "text_first_no_approved_asset")
            self.assertEqual(len(json.loads(questions.read_text(encoding="utf-8"))["questions"]), 1)
            self.assertEqual(json.loads(pack_summary.read_text(encoding="utf-8"))["status"], "awaiting_pack_confirmation")

            run(S4_VALIDATOR, architecture, "--brand-facts", brand_facts, "--knowledge-registry", next((project / "S2").glob("*knowledge_registry.json")), "--claim-registry", next((project / "S2").glob("*claim_registry.json")), "--source-registry", next((project / "S2").glob("*source_registry.json")), "--pattern-registry", PATTERN_REGISTRY)
            run(S5_VALIDATOR, voice, "--architecture", architecture, "--pattern-registry", PATTERN_REGISTRY)
            run(S6_VALIDATOR, visual, "--image-registry", next((project / "S2").glob("*image_registry.json")), "--pattern-registry", PATTERN_REGISTRY)
            run(S7_VALIDATOR, questions, "--pattern-registry", PATTERN_REGISTRY, "--knowledge-registry", next((project / "S2").glob("*knowledge_registry.json")), "--source-registry", next((project / "S2").glob("*source_registry.json")), "--claim-registry", next((project / "S2").glob("*claim_registry.json")), "--architecture", architecture)
            state = json.loads(run(STATE_DETECTOR, "--work-dir", project).stdout)
            self.assertEqual(state["status"], "ready_for_S9")

            pack = project / "ReferencePack/example.zip"
            run(S9, "--brand", "示例品牌", "--work-dir", project, "--output", pack)
            run(PACKAGE_VALIDATOR, pack)
            with zipfile.ZipFile(pack) as archive:
                root = json.loads(archive.read("reference_pack.json"))
                self.assertEqual(root["profile"], "frontmind-content-reference-pack-v2.2")
                self.assertEqual(root["brand"]["canonical_name"], "示例品牌")
                self.assertEqual(root["material_index_path"], "materials/index.json")
                self.assertTrue(all(root["writing_assets"].values()))
                self.assertNotIn("files", root)

    def test_strategy_outputs_do_not_create_audit_bindings(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            source = project / "working-set.zip"
            make_working_set(source)
            intake = project / "S1/S1_example_intake.json"
            run(S1, "--brand", "示例品牌", "--input", source, "--output", intake)
            run(S2, "--brand", "示例品牌", "--input", source, "--s1-intake", intake, "--output-dir", project / "S2")
            run(PRODUCER, "--brand", "示例品牌", "--work-dir", project)
            forbidden_keys = {"receipt", "reviewer", "approved_at", "input_sha256", "body_sha256", "upstream_fingerprints", "confirmation_history"}

            def inspect(value: object) -> None:
                if isinstance(value, dict):
                    self.assertFalse(forbidden_keys & set(value))
                    self.assertFalse(any("sha256" in str(key).lower() or "fingerprint" in str(key).lower() for key in value))
                    for child in value.values():
                        inspect(child)
                elif isinstance(value, list):
                    for child in value:
                        inspect(child)

            for path in sorted(project.glob("S[1-8]/**/*.json")):
                inspect(json.loads(path.read_text(encoding="utf-8")))

    def test_standalone_document_does_not_require_historical_indexes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            document = root / "brand.md"
            document.write_text("# 示例品牌\n\n这是用户提交的公开企业介绍。", encoding="utf-8")
            output = root / "intake.json"
            run(S1, "--brand", "示例品牌", "--input", document, "--output", output)
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema_version"], "2.3.0")
            self.assertEqual(payload["status"], "completed")
            self.assertEqual(payload["input"]["input_kind"], "standalone_document")
            self.assertEqual(payload["input"]["selected_route"], "direct_normalization")
            self.assertIsNone(payload["input"]["optional_indexes"]["manifest_path"])

            enriched = root / "legacy-route.json"
            run(S1, "--brand", "示例品牌", "--input", document, "--intake-route", "legacy_enrichment", "--output", enriched)
            enriched_payload = json.loads(enriched.read_text(encoding="utf-8"))
            self.assertEqual(enriched_payload["input"]["selected_route"], "legacy_s1_enrichment_then_normalization")
            self.assertEqual(enriched_payload["input"]["legacy_enrichment_skill"], "../compatibility/legacy-s1/SKILL.md")

    def test_ooxml_document_is_treated_as_a_document_not_a_generic_zip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            document = root / "brand.docx"
            with zipfile.ZipFile(document, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(
                    "word/document.xml",
                    "<w:document xmlns:w='urn:test'><w:body><w:p><w:r><w:t>示例品牌提供企业内容服务</w:t></w:r></w:p></w:body></w:document>",
                )
            intake = root / "S1/intake.json"
            run(S1, "--brand", "示例品牌", "--input", document, "--output", intake)
            self.assertEqual(json.loads(intake.read_text(encoding="utf-8"))["input"]["input_kind"], "standalone_document")
            run(S2, "--brand", "示例品牌", "--input", document, "--s1-intake", intake, "--output-dir", root / "S2")
            knowledge = json.loads(next((root / "S2").glob("*knowledge_registry.json")).read_text(encoding="utf-8"))
            self.assertEqual(len(knowledge["knowledge_units"]), 1)
            self.assertIn("示例品牌提供企业内容服务", knowledge["knowledge_units"][0]["content"])

    def test_lightweight_reference_pack_is_adapted_without_extra_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            intake = root / "S1/intake.json"
            run(S1, "--brand", "匿名示例企业", "--input", V21_FIXTURE, "--output", intake)
            self.assertEqual(json.loads(intake.read_text(encoding="utf-8"))["input"]["input_kind"], "frontmind_reference_pack")
            run(S2, "--brand", "匿名示例企业", "--input", V21_FIXTURE, "--s1-intake", intake, "--output-dir", root / "S2")
            report = json.loads(next((root / "S2").glob("*adapter_report.json")).read_text(encoding="utf-8"))
            self.assertGreaterEqual(report["counts"]["knowledge"], 1)
            self.assertFalse(report.get("fatal_errors"))
            run(PRODUCER, "--brand", "匿名示例企业", "--work-dir", root)
            self.assertTrue(next((root / "S4").glob("*information_evidence_architecture.json")).is_file())
            self.assertTrue(next((root / "S5").glob("*voice_contract.json")).is_file())

    def test_unsafe_archive_path_remains_a_real_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "unsafe.zip"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("../escape.md", "unsafe")
            result = run(S1, "--brand", "示例品牌", "--input", source, "--output", root / "out.json", expected=2)
            self.assertIn("unsafe archive member path", result.stderr)


if __name__ == "__main__":
    unittest.main()
