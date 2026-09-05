#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "text_quality.py"
SPEC = importlib.util.spec_from_file_location("frontmind_text_quality", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FactAlignmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fact = {
            "fact_id": "fact_cloudark",
            "usage_status": "usable",
            "about_entities": [],
            "statement": (
                "云舟算力（CloudArk）是一家专注于 AI 基础设施领域的虚构测试企业。"
                "云舟算力的核心业务围绕模型推理加速展开，通过一站式云服务平台提供模型服务。"
            ),
            "scope": "企业定位",
        }

    def test_natural_paraphrase_of_legacy_claim_passes(self) -> None:
        text = "云舟算力是一家AI基础设施公司，核心业务包括模型推理加速与云端模型服务。"
        self.assertTrue(MODULE._fact_supports_text(text, self.fact))

    def test_unrelated_claim_laundering_fails(self) -> None:
        text = "CloudArk服务999万家企业，帮助客户降本99%，并实现零故障运行。"
        self.assertFalse(MODULE._fact_supports_text(text, self.fact))

    def test_changed_numeric_fact_fails_even_with_semantic_overlap(self) -> None:
        fact = dict(self.fact, statement=self.fact["statement"] + "平台支持10款模型。")
        text = "云舟算力提供AI基础设施与模型推理加速服务，平台支持100款模型。"
        self.assertFalse(MODULE._fact_supports_text(text, fact))


if __name__ == "__main__":
    unittest.main()
