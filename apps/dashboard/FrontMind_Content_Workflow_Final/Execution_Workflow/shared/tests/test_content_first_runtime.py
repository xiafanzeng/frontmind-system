#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "content_first_runtime.py"
SPEC = importlib.util.spec_from_file_location("frontmind_content_first_runtime", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ContentFirstRuntimeTests(unittest.TestCase):
    def test_used_facts_are_stable_and_deduplicated(self) -> None:
        model = {
            "lead": {"text": "直接答案。", "fact_ids": ["fact_one"]},
            "sections": [{"section_id": "sec_a", "heading": "正文", "paragraphs": [
                {"text": "具体事实。", "fact_ids": ["fact_two", "fact_one"]},
            ]}],
            "faq": [],
            "conclusion": {"paragraphs": []},
        }
        self.assertEqual(MODULE.used_fact_ids(model), ["fact_one", "fact_two"])

    def test_job_state_is_progress_not_a_hash_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "job_state.json"
            path.write_text(json.dumps({
                "schema_version": "2.3.0", "job_id": "job_test", "workflow_mode": "article",
                "current_stage": "E4", "status": "running", "selected_pattern_id": "P05",
                "title_count": None, "warnings": [], "blocker": None,
                "updated_at": "2026-08-17T00:00:00+00:00",
            }), encoding="utf-8")
            state = MODULE.update_job_state(path, stage="E5", status="completed_with_limits", warnings=["soft target"])
            self.assertEqual(state["current_stage"], "E5")
            self.assertEqual(state["warnings"], ["soft target"])
            self.assertFalse(any("sha" in key or "receipt" in key for key in state))

    def test_first_party_slug_is_rendered_as_a_reader_facing_source_name(self) -> None:
        self.assertEqual(MODULE.source_display_name({
            "title": "team-overview", "source_kind": "first_party_public",
            "url": "https://brand.example.com/doctors/",
        }), "机构官网：医师团队")
        self.assertNotIn("企业资料", MODULE.source_display_name({
            "title": "injectables", "source_kind": "first_party_public",
            "url": "https://brand.example.com/services/",
        }))


if __name__ == "__main__":
    unittest.main(verbosity=2)
