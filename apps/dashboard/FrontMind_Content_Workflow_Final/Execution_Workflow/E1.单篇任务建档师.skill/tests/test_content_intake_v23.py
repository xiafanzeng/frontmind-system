from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "content_intake.py"


class ContentIntakeV23Tests(unittest.TestCase):
    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), *arguments],
            text=True, capture_output=True,
        )

    def test_material_only_job_records_research_inputs_as_pending(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "企业资料.md"
            source.write_text("示例品牌提供可核对的产品和交付说明。", encoding="utf-8")
            job_root = root / "job"
            result = self.run_cli(
                "--job-root", str(job_root), "--input", str(source),
                "--entry-category", "product_scenario", "--question", "产品适合什么场景？",
                "--product-scenario-subintent", "scenario_fit",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            job = json.loads((job_root / "00_input/content_job.json").read_text(encoding="utf-8"))
            self.assertEqual(job["schema_version"], "2.3.0")
            self.assertEqual(job["input_mode"], "materials")
            self.assertIsNone(job["monitoring_answers_path"])
            self.assertIsNone(job["source_workbook_path"])
            self.assertNotIn("receipt", json.dumps(job))

    def test_monitoring_answers_and_source_workbook_are_staged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material = root / "企业资料.md"
            answers = root / "answers.csv"
            workbook = root / "citations.xlsx"
            material.write_text("示例品牌提供公开服务。", encoding="utf-8")
            answers.write_text("监控问题,答案\n哪些品牌值得推荐？,示例品牌与候选甲。\n", encoding="utf-8")
            workbook.write_bytes(b"xlsx-placeholder")
            job_root = root / "job"
            result = self.run_cli(
                "--job-root", str(job_root), "--input", str(material),
                "--entry-category", "industry_ranking", "--question", "哪些品牌值得推荐？",
                "--monitoring-answers", str(answers), "--source-workbook", str(workbook),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            job = json.loads((job_root / "00_input/content_job.json").read_text(encoding="utf-8"))
            self.assertTrue(job["monitoring_answers_path"].endswith("answers.csv"))
            self.assertTrue(job["source_workbook_path"].endswith("citations.xlsx"))
            self.assertNotIn("monitoring_input_path", job)

    def test_foundation_start_has_no_question_and_needs_no_e2_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "facts.txt"
            source.write_text("示例企业品牌事实。", encoding="utf-8")
            job_root = root / "job"
            result = self.run_cli(
                "--job-root", str(job_root), "--input", str(source),
                "--entry-category", "foundation_start", "--foundation-subject", "示例企业品牌特写",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            job = json.loads((job_root / "00_input/content_job.json").read_text(encoding="utf-8"))
            self.assertIsNone(job["task"]["question_text"])
            self.assertEqual(job["task"]["question_origin"], "foundation_derived")

    def test_dongguan_question_produces_specific_geographic_scope(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "facts.txt"
            source.write_text("示例机构提供可核对的医疗服务说明。", encoding="utf-8")
            job_root = root / "job"
            result = self.run_cli(
                "--job-root", str(job_root), "--input", str(source),
                "--entry-category", "industry_ranking",
                "--question", "杭州打玻尿酸机构有哪些推荐？",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            scope = json.loads((job_root / "00_input/scope_analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(scope["schema_version"], "2.3.0")
            self.assertEqual(scope["geographic_scope"]["status"], "specific")
            self.assertEqual(scope["geographic_scope"]["value"], "杭州")

    def test_zip_traversal_is_a_real_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "unsafe.zip"
            with zipfile.ZipFile(archive, "w") as handle:
                handle.writestr("../escape.txt", "bad")
            result = self.run_cli(
                "--job-root", str(root / "job"), "--input", str(archive),
                "--entry-category", "reputation", "--question", "示例企业值得信任吗？",
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unsafe_input", result.stderr)


if __name__ == "__main__":
    unittest.main()
