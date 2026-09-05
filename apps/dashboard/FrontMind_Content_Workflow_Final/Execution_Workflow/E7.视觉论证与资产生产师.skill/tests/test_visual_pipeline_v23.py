#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from PIL import Image


SKILL = Path(__file__).resolve().parents[1]


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SKILL / "scripts" / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PLAN = load("frontmind_visual_plan_v23", "build_visual_plan.py")
AIGC = load("frontmind_visual_aigc_v23", "aigc_invoker.py")
FILTER = load("frontmind_visual_filter_v23", "visual_claim_validator.py")


class VisualPipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        Image.new("RGB", (1200, 700), "#ccddee").save(self.root / "brand.jpg")
        Image.new("RGB", (900, 600), "#f5f5ee").save(self.root / "certificate.jpg")
        Image.new("RGBA", (300, 120), (255, 255, 255, 180)).save(self.root / "logo.png")
        self.context = {
            "job_id": "job_visual_test", "facts": [{"fact_id": "fact_service", "usage_status": "usable"}],
            "images": [
                {"image_id": "img_brand", "file_path": "brand.jpg", "asset_kind": "brand_image", "usage_status": "usable", "rights_status": "approved"},
                {"image_id": "img_logo", "file_path": "logo.png", "asset_kind": "logo", "usage_status": "usable", "rights_status": "approved"},
                {"image_id": "img_certificate", "file_path": "certificate.jpg", "asset_kind": "certificate", "usage_status": "usable", "rights_status": "approved"},
            ],
        }
        self.model = {
            "job_id": "job_visual_test", "pattern_id": "P02",
            "sections": [{"section_id": "sec_choice", "heading": "怎样选择", "paragraphs": [{"text": "比较服务流程。", "fact_ids": ["fact_service"]}]}],
            "visual_placements": [],
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_real_asset_first_and_missing_explanation_becomes_prompt(self) -> None:
        blueprint = {"visual_plan": [
            {"role": "brand_editorial", "after_section_id": None, "brief": "品牌封面"},
            {"role": "explain", "after_section_id": "sec_choice", "brief": "解释选择流程"},
        ]}
        planned, prompt = PLAN.build(self.model, self.context, blueprint)
        self.assertEqual(planned["visual_placements"][0]["asset_id"], "img_brand")
        self.assertEqual(prompt["images"][0]["role"], "explain")
        self.assertEqual(prompt["images"][0]["logo_overlay_asset_id"], "img_logo")

    def test_s6_visual_projection_supplies_roles_without_replacing_rights_metadata(self) -> None:
        context = dict(self.context)
        context["visual_assets"] = [{
            "image_id": "img_brand", "file_path": "brand.jpg", "asset_kind": "brand_cover",
            "rights_status": "approved", "usable_for": ["brand_editorial"],
        }]
        assets = PLAN.safe_images(context)
        brand = next(item for item in assets if item["image_id"] == "img_brand")
        self.assertEqual(brand["asset_kind"], "brand_cover")
        self.assertEqual(brand["usage_status"], "usable")

    def test_credited_asset_without_credit_is_not_publishable(self) -> None:
        context = {"images": [{
            "image_id": "img_credit", "file_path": "brand.jpg", "asset_kind": "brand_image",
            "usage_status": "usable", "rights_status": "approved_with_credit", "credit": None,
        }]}
        self.assertEqual(PLAN.safe_images(context), [])

    def test_generated_proof_and_impersonated_real_asset_are_dropped(self) -> None:
        model = dict(self.model, visual_placements=[{
            "visual_id": "vis_prove", "after_section_id": "sec_choice", "asset_id": "img_generated",
            "role": "prove", "alt_text": "证明图", "supports_fact_ids": ["fact_service"],
        }])
        generated = [{
            "image_id": "img_generated", "file_path": "brand.jpg", "asset_kind": "product",
            "origin": "generated", "usage_status": "usable", "rights_status": "approved",
            "width": 1200, "height": 700,
        }]
        filtered, used, dropped, _warnings = FILTER.filter_visuals(model, self.context, self.root, generated)
        self.assertEqual(used, [])
        self.assertEqual(filtered["visual_placements"], [])
        self.assertTrue(any("impersonate" in item["reason"] or "proof" in item["reason"] for item in dropped))

    def test_real_visual_is_dimension_checked_and_selected(self) -> None:
        model = dict(self.model, visual_placements=[{
            "visual_id": "vis_brand", "after_section_id": None, "asset_id": "img_brand",
            "role": "brand_editorial", "alt_text": "品牌编辑视觉", "supports_fact_ids": [],
        }])
        filtered, used, dropped, warnings = FILTER.filter_visuals(model, self.context, self.root, [])
        self.assertEqual(len(used), 1)
        self.assertEqual((used[0]["width"], used[0]["height"]), (1200, 700))
        self.assertEqual(dropped, [])
        self.assertEqual(warnings, [])
        self.assertEqual(len(filtered["visual_placements"]), 1)

    def test_prove_visual_inherits_section_fact_binding(self) -> None:
        blueprint = {
            "sections": [{"section_id": "sec_choice", "fact_ids": ["fact_service"]}],
            "visual_plan": [{
                "role": "prove", "after_section_id": "sec_choice", "brief": "展示真实证明材料",
                "required": False,
            }],
        }
        planned, prompt = PLAN.build(self.model, self.context, blueprint)
        self.assertEqual(prompt["images"], [])
        self.assertEqual(planned["visual_placements"][0]["asset_id"], "img_certificate")
        self.assertEqual(planned["visual_placements"][0]["supports_fact_ids"], ["fact_service"])
        filtered, used, dropped, warnings = FILTER.filter_visuals(planned, self.context, self.root, [])
        self.assertEqual(len(used), 1)
        self.assertEqual(used[0]["role"], "prove")
        self.assertEqual(dropped, [])
        self.assertEqual(warnings, [])
        self.assertEqual(len(filtered["visual_placements"]), 1)

    def test_prompt_tool_output_gets_original_logo_overlay_and_safe_selection(self) -> None:
        blueprint = {"visual_plan": [{
            "role": "explain", "after_section_id": "sec_choice", "brief": "解释选择流程",
        }]}
        planned, prompt = PLAN.build(self.model, self.context, blueprint)
        item = prompt["images"][0]
        generated_source = self.root / "tool-output.png"
        Image.new("RGB", (1200, 700), "#335577").save(generated_source)
        plan_path, context_path = self.root / "prompt_plan.json", self.root / "context.json"
        result_path, output_dir = self.root / "generated_assets.json", self.root / "generated"
        plan_path.write_text(json.dumps(prompt, ensure_ascii=False), encoding="utf-8")
        context_path.write_text(json.dumps(self.context, ensure_ascii=False), encoding="utf-8")
        with patch("sys.argv", [
            "aigc_invoker.py", "--prompt-plan", str(plan_path), "--visual-id", item["visual_id"],
            "--generated-image", str(generated_source), "--working-context", str(context_path),
            "--asset-root", str(self.root), "--output-dir", str(output_dir), "--result", str(result_path),
        ]):
            self.assertEqual(AIGC.main(), 0)
        generated = json.loads(result_path.read_text(encoding="utf-8"))["images"]
        accepted = Path(generated[0]["file_path"])
        width, height = generated[0]["width"], generated[0]["height"]
        filtered, used, dropped, warnings = FILTER.filter_visuals(planned, self.context, self.root, generated)
        self.assertEqual((width, height), (1200, 700))
        self.assertTrue(accepted.is_file())
        self.assertEqual(len(used), 1)
        self.assertEqual(used[0]["role"], "explain")
        self.assertEqual(dropped, [])
        self.assertEqual(warnings, [])
        self.assertEqual(filtered["visual_placements"][0]["asset_id"], "img_generated_01")

    def test_missing_generator_file_drops_slot_without_pause(self) -> None:
        _planned, prompt = PLAN.build(self.model, self.context, {"visual_plan": [{
            "role": "explain", "after_section_id": "sec_choice", "brief": "解释选择流程",
        }]})
        plan_path, result_path = self.root / "prompt_plan.json", self.root / "generated_assets.json"
        plan_path.write_text(json.dumps(prompt, ensure_ascii=False), encoding="utf-8")
        with patch("sys.argv", [
            "aigc_invoker.py", "--prompt-plan", str(plan_path),
            "--visual-id", prompt["images"][0]["visual_id"],
            "--output-dir", str(self.root / "generated"), "--result", str(result_path),
        ]):
            self.assertEqual(AIGC.main(), 0)
        result = json.loads(result_path.read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "completed_with_limits")
        self.assertEqual(result["images"], [])
        self.assertNotIn("awaiting", json.dumps(result))

    def test_provider_results_aggregate_across_visual_slots(self) -> None:
        _planned, prompt = PLAN.build(self.model, self.context, {"visual_plan": [
            {"role": "explain", "after_section_id": "sec_choice", "brief": "解释选择流程"},
            {"role": "navigate", "after_section_id": "sec_choice", "brief": "展示章节路径"},
        ]})
        plan_path, context_path = self.root / "multi_plan.json", self.root / "multi_context.json"
        result_path, output_dir = self.root / "multi_generated.json", self.root / "multi_generated"
        source = self.root / "multi_tool_output.png"
        Image.new("RGB", (1200, 700), "#557799").save(source)
        plan_path.write_text(json.dumps(prompt, ensure_ascii=False), encoding="utf-8")
        context_path.write_text(json.dumps(self.context, ensure_ascii=False), encoding="utf-8")
        for item in prompt["images"]:
            with patch("sys.argv", [
                "aigc_invoker.py", "--prompt-plan", str(plan_path), "--visual-id", item["visual_id"],
                "--generated-image", str(source), "--working-context", str(context_path),
                "--asset-root", str(self.root), "--output-dir", str(output_dir), "--result", str(result_path),
            ]):
                self.assertEqual(AIGC.main(), 0)
        aggregate = json.loads(result_path.read_text(encoding="utf-8"))
        self.assertEqual(len(aggregate["attempts"]), 2)
        self.assertEqual(len(aggregate["images"]), 2)
        self.assertEqual({item["visual_id"] for item in aggregate["images"]}, {"vis_01", "vis_02"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
