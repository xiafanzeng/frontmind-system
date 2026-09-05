#!/usr/bin/env python3
"""Regression tests for canonical raster/SVG dimensions and the E7 gate."""

from __future__ import annotations

import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


E7_REGISTER = load_module(
    "frontmind_e7_image_register",
    ROOT / "Execution_Workflow" / "E7.视觉论证与资产生产师.skill" / "scripts" / "image_dedup_checker.py",
)
E7_VALIDATE = load_module(
    "frontmind_e7_visual_validate",
    ROOT / "Execution_Workflow" / "E7.视觉论证与资产生产师.skill" / "scripts" / "visual_claim_validator.py",
)


class ImageDimensionTests(unittest.TestCase):
    def test_svg_explicit_dimensions_win_over_viewbox(self) -> None:
        svg = '<svg width="320" height="180" viewBox="0 0 1280 720"></svg>'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "explicit.svg"
            path.write_text(svg, encoding="utf-8")
            self.assertEqual(E7_REGISTER.image_facts(path), ("image/svg+xml", 320, 180))

    def test_svg_viewbox_supplies_positive_dimensions_to_both_registrars(self) -> None:
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640.2 360.1"></svg>'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "responsive.svg"
            path.write_text(svg, encoding="utf-8")
            self.assertEqual(E7_REGISTER.image_facts(path), ("image/svg+xml", 641, 361))

    def test_svg_without_intrinsic_dimensions_remains_unusable(self) -> None:
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "no-dimensions.svg"
            path.write_text(svg, encoding="utf-8")
            self.assertEqual(E7_REGISTER.image_facts(path), ("image/svg+xml", None, None))
        self.assertFalse(E7_VALIDATE.has_positive_dimensions({"width": None, "height": None}))
        self.assertFalse(E7_VALIDATE.has_positive_dimensions({"width": 1, "height": 0}))
        self.assertTrue(E7_VALIDATE.has_positive_dimensions({"width": 1, "height": 1}))


if __name__ == "__main__":
    unittest.main()
