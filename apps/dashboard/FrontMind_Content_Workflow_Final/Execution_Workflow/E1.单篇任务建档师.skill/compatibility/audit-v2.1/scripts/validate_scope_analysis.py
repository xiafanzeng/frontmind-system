#!/usr/bin/env python3
"""Validate the E1 Content Job and its adaptive scope analysis."""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from schema_validation import validate_root  # noqa: E402


PRODUCT_SUBINTENTS = {
    "offering_definition", "feature_mechanism", "scenario_fit",
    "delivery_usage", "support_boundary", "price_selection",
}


def normalized_question(value: object) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip()


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def inside(root: Path, relative: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts or "\\" in relative:
        raise ValueError("scope_analysis_path must be a safe job-root-relative path")
    resolved = (root / candidate).resolve()
    resolved.relative_to(root.resolve())
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--content-job", type=Path, required=True)
    parser.add_argument("--scope-analysis", type=Path, required=True)
    parser.add_argument("--job-root", type=Path, required=True)
    args = parser.parse_args()
    job_root = args.job_root.resolve()
    job, scope = load(args.content_job), load(args.scope_analysis)
    validate_root(job, "content_job.schema.json", "E1 Content Job")
    validate_root(scope, "scope_analysis.schema.json", "E1 scope analysis")
    errors: list[str] = []
    if scope.get("job_id") != job.get("job_id"):
        errors.append("scope_analysis.job_id differs from Content Job")
    expected = inside(job_root, str(job.get("scope_analysis_path") or ""))
    if expected != args.scope_analysis.resolve():
        errors.append("scope_analysis_path does not resolve to supplied file")
    entry, task = job.get("entry_category"), job.get("task", {})
    if entry == "foundation_start":
        if (
            task.get("question_text") is not None
            or job.get("monitoring_input_path") is not None
            or job.get("source_workbook_path") is not None
            or job.get("e2_pattern_analysis_path") is not None
        ):
            errors.append("foundation_start must be title/question-free at E1 and skip all E2 inputs")
    elif not str(task.get("question_text") or "").strip():
        errors.append("ordinary entries require one externally confirmed question")
    elif task.get("question_text") != normalized_question(task.get("question_text")):
        errors.append("ordinary Content Job question_text must be NFKC/whitespace normalized at E1")
    elif (
        job.get("monitoring_input_path") is None
        or job.get("source_workbook_path") is None
        or job.get("e2_pattern_analysis_path") is None
    ):
        errors.append("ordinary entries require monitoring, Dashboard workbook and E2 pattern-analysis paths")
    elif job.get("source_workbook_path") != "01_monitoring/dashboard_source_workbook.xlsx":
        errors.append(
            "ordinary entry source_workbook_path must be "
            "01_monitoring/dashboard_source_workbook.xlsx"
        )
    if "requested_pattern_variant" in task:
        errors.append("v2.1 forbids requested_pattern_variant; E2 recommends and E4 decides P01-P16")
    if entry == "product_scenario" and task.get("product_scenario_subintent") not in PRODUCT_SUBINTENTS:
        errors.append("product_scenario requires one canonical product_scenario_subintent before E2")
    clarification = scope.get("clarification", {})
    if clarification.get("status") == "required":
        errors.append("scope clarification is still required")
    report = {
        "schema_version": "2.1.0", "job_id": job.get("job_id"),
        "stage": "E1_scope_validation", "status": "blocked" if errors else "passed",
        "errors": errors,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
