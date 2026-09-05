#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location(
    "pattern_validator", ROOT / "validate_pattern_research.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)

MANUAL_SPEC = importlib.util.spec_from_file_location(
    "manual_semantic_reviews", ROOT / "manual_semantic_reviews_v23.py"
)
MANUAL = importlib.util.module_from_spec(MANUAL_SPEC)
assert MANUAL_SPEC.loader
MANUAL_SPEC.loader.exec_module(MANUAL)

REBUILD_SPEC = importlib.util.spec_from_file_location(
    "pattern_rebuild", ROOT / "rebuild_v23.py"
)
REBUILD = importlib.util.module_from_spec(REBUILD_SPEC)
assert REBUILD_SPEC.loader
REBUILD_SPEC.loader.exec_module(REBUILD)


class PatternResearchValidatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.canonical = json.loads((ROOT / "index.json").read_text(encoding="utf-8"))

    def validate_mutation(self, mutate):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "pattern-research"
            target.mkdir()
            data = copy.deepcopy(self.canonical)
            mutate(data)
            (target / "index.json").write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            (target.parent / "content-pattern-registry.json").write_text(
                (ROOT.parent / "content-pattern-registry.json").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            for pattern in data["patterns"]:
                source = ROOT / pattern["dossier_path"]
                if source.exists():
                    (target / pattern["dossier_path"]).write_text(
                        source.read_text(encoding="utf-8"), encoding="utf-8"
                    )
            return MODULE.validate_index(target / "index.json", target)

    def test_canonical_library_passes(self):
        self.assertEqual(MODULE.validate_index(ROOT / "index.json", ROOT), [])

    def test_v23_quota_and_template_contract(self):
        self.assertEqual(self.canonical["schema_version"], "2.3.0")
        counts = {
            pattern["pattern_id"]: len(pattern["benchmarks"])
            for pattern in self.canonical["patterns"]
        }
        self.assertEqual(counts["P01"], 12)
        self.assertEqual(counts["P02"], 12)
        self.assertEqual(counts["P14"], 12)
        self.assertEqual(counts["P13"], 8)
        self.assertEqual(counts["P15"], 8)
        self.assertEqual(counts["P16"], 8)
        for pattern in self.canonical["patterns"]:
            design = pattern["design_contract"]
            self.assertEqual(design["template_version"], "2.3.0")
            self.assertGreaterEqual(len(design["title_formulas"]), 3)
            self.assertGreaterEqual(len(design["visual_recipe"]), 3)
            self.assertGreaterEqual(len(design["optional_modules"]), 2)
            self.assertGreaterEqual(len(design["evidence_downgrade_rules"]), 2)
            self.assertTrue(design["failure_example"])
            self.assertGreaterEqual(len(design["forbidden_behaviors"]), 3)

    def test_quota_underflow_fails(self):
        errors = self.validate_mutation(lambda data: data["patterns"][2]["benchmarks"].pop())
        self.assertTrue(any("below minimum" in error for error in errors), errors)

    def test_global_duplicate_url_fails(self):
        def mutate(data):
            data["patterns"][2]["benchmarks"][0]["url"] = data["patterns"][0]["benchmarks"][0]["url"]
            data["patterns"][2]["benchmarks"][0]["domain"] = data["patterns"][0]["benchmarks"][0]["domain"]
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("duplicate of" in error for error in errors), errors)

    def test_http_or_private_url_fails(self):
        def mutate(data):
            item = data["patterns"][3]["benchmarks"][0]
            item["url"] = "http://127.0.0.1/private"
            item["domain"] = "127.0.0.1"
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("only https" in error for error in errors), errors)
        self.assertTrue(any("private IP" in error for error in errors), errors)

    def test_missing_required_field_fails(self):
        def mutate(data):
            del data["patterns"][4]["benchmarks"][0]["visual_observation"]
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("visual_observation" in error for error in errors), errors)

    def test_source_diversity_fails(self):
        def mutate(data):
            pattern = data["patterns"][5]
            for item in pattern["benchmarks"]:
                item["source_class"] = "vendor_documentation"
            pattern["source_class_summary"] = ["vendor_documentation"]
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("need >=3 source classes" in error for error in errors), errors)

    def test_statistics_tampering_fails(self):
        def mutate(data):
            data["statistics"]["benchmark_count"] = 139
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("root.statistics" in error for error in errors), errors)

    def test_structure_component_identity_must_equal_registry(self):
        def mutate(data):
            data["patterns"][0]["structure_components"][0]["component_id"] = "P01_component_spoofed"
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("structure_components" in error for error in errors), errors)

    def test_classification_contract_must_equal_registry(self):
        def mutate(data):
            data["patterns"][1]["classification_contract"]["eligible_content_forms"] = ["research_pdf"]
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("classification_contract" in error for error in errors), errors)

    def test_editorial_template_must_equal_registry(self):
        def mutate(data):
            data["patterns"][1]["design_contract"]["natural_brand_entry"] = "静默替换"
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("canonical editorial_template" in error for error in errors), errors)

    def test_template_required_field_fails(self):
        def mutate(data):
            del data["patterns"][13]["design_contract"]["title_formulas"]
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("title_formulas" in error for error in errors), errors)

    def test_fixed_structure_order_fails(self):
        def mutate(data):
            fixed = data["patterns"][4]["design_contract"]["fixed_structure"]
            fixed[0], fixed[1] = fixed[1], fixed[0]
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("canonical component order" in error for error in errors), errors)

    def test_duplicate_semantic_review_fails(self):
        def mutate(data):
            source = data["patterns"][2]["benchmarks"][0]
            target = data["patterns"][2]["benchmarks"][1]
            for field in (
                "semantic_focus", "structure_observation", "subquestions_observed",
                "strengths", "weaknesses",
            ):
                target[field] = copy.deepcopy(source[field])
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("duplicate within" in error for error in errors), errors)
        self.assertTrue(any("benchmark-specific review required" in error for error in errors), errors)

    def test_priority_reviews_match_protected_human_source(self):
        patterns = {
            pattern["pattern_id"]: pattern for pattern in self.canonical["patterns"]
        }
        self.assertEqual(
            set(REBUILD.LOCKED_PATTERN_IDS),
            {f"P{number:02d}" for number in range(1, 17)},
        )
        self.assertIn("apply_manual_reviews", REBUILD.rebuild.__code__.co_names)
        for pattern_id in MANUAL.LOCKED_PATTERN_IDS:
            for benchmark in patterns[pattern_id]["benchmarks"]:
                expected = MANUAL.MANUAL_REVIEWS[benchmark["benchmark_id"]]
                actual = {field: benchmark[field] for field in MANUAL.REVIEW_FIELDS}
                self.assertEqual(actual, expected, benchmark["benchmark_id"])

    def test_priority_generated_review_boilerplate_fails(self):
        def mutate(data):
            item = data["patterns"][0]["benchmarks"][0]
            item["structure_observation"][0] = "该页围绕焦点组织信息，可迁移到“固定结构”。"
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("generated review boilerplate" in error for error in errors), errors)

    def test_priority_review_marker_fails_when_removed(self):
        def mutate(data):
            data["patterns"][1]["benchmarks"][0]["research_note"] = "普通批量说明"
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("human page-review marker" in error for error in errors), errors)

    def test_priority_dossiers_mirror_all_review_fields(self):
        patterns = {
            pattern["pattern_id"]: pattern for pattern in self.canonical["patterns"]
        }
        for pattern_id in MANUAL.LOCKED_PATTERN_IDS:
            dossier = (ROOT / f"{pattern_id}.md").read_text(encoding="utf-8")
            for benchmark in patterns[pattern_id]["benchmarks"]:
                for field in MANUAL.REVIEW_FIELDS:
                    value = benchmark[field]
                    values = value if isinstance(value, list) else [value]
                    for item in values:
                        self.assertIn(item, dossier, f"{benchmark['benchmark_id']}.{field}")

    def test_manual_sync_restores_all_locked_reviews(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp_root = Path(tmp)
            data = copy.deepcopy(self.canonical)
            data["patterns"][0]["benchmarks"][0]["strengths"] = ["tampered", "tampered again"]
            data["patterns"][2]["benchmarks"][0]["strengths"] = ["tampered P03", "tampered again"]
            data["patterns"][7]["benchmarks"][0]["strengths"] = ["tampered P08", "tampered again"]
            index_path = temp_root / "index.json"
            index_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            old_root, old_index = REBUILD.ROOT, REBUILD.INDEX_PATH
            try:
                REBUILD.ROOT = temp_root
                REBUILD.INDEX_PATH = index_path
                REBUILD.sync_manual_reviews()
            finally:
                REBUILD.ROOT = old_root
                REBUILD.INDEX_PATH = old_index
            synced = json.loads(index_path.read_text(encoding="utf-8"))
            self.assertEqual(
                synced["patterns"][0]["benchmarks"][0]["strengths"],
                MANUAL.MANUAL_REVIEWS["P01-B01"]["strengths"],
            )
            self.assertEqual(
                synced["patterns"][2]["benchmarks"][0]["strengths"],
                MANUAL.MANUAL_REVIEWS["P03-B01"]["strengths"],
            )
            self.assertEqual(
                synced["patterns"][7]["benchmarks"][0]["strengths"],
                MANUAL.MANUAL_REVIEWS["P08-B01"]["strengths"],
            )
            self.assertEqual(
                sorted(path.name for path in temp_root.glob("P*.md")),
                [
                    "P01.md", "P02.md", "P03.md", "P04.md", "P05.md",
                    "P06.md", "P07.md", "P08.md", "P09.md", "P10.md",
                    "P11.md", "P12.md", "P13.md", "P14.md", "P15.md", "P16.md",
                ],
            )

    def test_full_rebuild_cannot_overwrite_locked_human_reviews(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp_root = Path(tmp) / "pattern-research"
            temp_root.mkdir()
            original = copy.deepcopy(self.canonical)
            (temp_root / "index.json").write_text(
                json.dumps(original, ensure_ascii=False), encoding="utf-8"
            )
            registry_path = temp_root.parent / "content-pattern-registry.json"
            registry_path.write_text(
                (ROOT.parent / "content-pattern-registry.json").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            old_root = REBUILD.ROOT
            old_index = REBUILD.INDEX_PATH
            old_registry = REBUILD.REGISTRY_PATH
            try:
                REBUILD.ROOT = temp_root
                REBUILD.INDEX_PATH = temp_root / "index.json"
                REBUILD.REGISTRY_PATH = registry_path
                REBUILD.rebuild()
            finally:
                REBUILD.ROOT = old_root
                REBUILD.INDEX_PATH = old_index
                REBUILD.REGISTRY_PATH = old_registry
            rebuilt = json.loads((temp_root / "index.json").read_text(encoding="utf-8"))
            patterns = {item["pattern_id"]: item for item in rebuilt["patterns"]}
            originals = {item["pattern_id"]: item for item in original["patterns"]}
            for pattern_id in MANUAL.LOCKED_PATTERN_IDS:
                for position, benchmark in enumerate(patterns[pattern_id]["benchmarks"]):
                    benchmark_id = benchmark["benchmark_id"]
                    self.assertEqual(
                        {field: benchmark[field] for field in MANUAL.REVIEW_FIELDS},
                        MANUAL.MANUAL_REVIEWS[benchmark_id],
                    )
                    before = originals[pattern_id]["benchmarks"][position]
                    metadata_fields = set(before) - set(MANUAL.REVIEW_FIELDS)
                    self.assertEqual(
                        {field: benchmark[field] for field in metadata_fields},
                        {field: before[field] for field in metadata_fields},
                    )

    def test_audit_field_is_not_part_of_v23_benchmark(self):
        def mutate(data):
            item = data["patterns"][0]["benchmarks"][0]
            item["audit_note"] = item["research_note"]
        errors = self.validate_mutation(mutate)
        self.assertTrue(any("fields must be exactly" in error for error in errors), errors)

    def test_dossier_traceability_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "pattern-research"
            target.mkdir()
            data = copy.deepcopy(self.canonical)
            (target / "index.json").write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            (target.parent / "content-pattern-registry.json").write_text(
                (ROOT.parent / "content-pattern-registry.json").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            for pattern in data["patterns"]:
                text = (ROOT / pattern["dossier_path"]).read_text(encoding="utf-8")
                if pattern["pattern_id"] == "P02":
                    text = text.replace(pattern["benchmarks"][0]["url"], "URL_REMOVED")
                (target / pattern["dossier_path"]).write_text(text, encoding="utf-8")
            errors = MODULE.validate_index(target / "index.json", target)
            self.assertTrue(any("dossier must contain" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
