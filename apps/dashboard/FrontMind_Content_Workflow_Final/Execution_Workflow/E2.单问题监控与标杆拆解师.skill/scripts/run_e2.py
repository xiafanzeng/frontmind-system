#!/usr/bin/env python3
"""Run the complete E2 v2.3 single-question research sequence."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run E2 monitoring, Top20 and P-pattern analysis")
    parser.add_argument("--content-job", type=Path, required=True)
    parser.add_argument("--pattern-registry", type=Path, required=True)
    parser.add_argument("--pattern-research-index", type=Path, required=True)
    parser.add_argument("--monitoring-answers", type=Path)
    parser.add_argument("--source-workbook", type=Path)
    parser.add_argument("--corrections", type=Path)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--monitoring-context-output", type=Path)
    parser.add_argument("--research-brief-output", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()

    job = json.loads(args.content_job.read_text(encoding="utf-8"))
    if job.get("entry_category") == "foundation_start":
        print(json.dumps({"stage": "E2", "status": "skipped_optional", "reason": "foundation_start uses P14"}, ensure_ascii=False))
        return 0
    missing = [
        label for label, path in (
            ("monitoring_answers", args.monitoring_answers),
            ("source_workbook", args.source_workbook),
        ) if path is None or not path.is_file()
    ]
    if missing:
        raise ValueError(f"research_inputs_missing: ordinary E2 requires {', '.join(missing)}")

    scripts = Path(__file__).resolve().parent
    args.work_dir.mkdir(parents=True, exist_ok=True)
    monitoring_context = args.monitoring_context_output or args.work_dir / "monitoring_context.json"
    source_pool = args.work_dir / "source_pool.json"
    page_analysis = args.work_dir / "page_structure_analysis.json"
    research_brief = args.research_brief_output or args.work_dir / "research_brief.md"

    run([
        sys.executable, "-B", str(scripts / "monitoring_answers_adapter.py"),
        "--content-job", str(args.content_job),
        "--monitoring-answers", str(args.monitoring_answers),
        "--output", str(monitoring_context),
    ])
    run([
        sys.executable, "-B", str(scripts / "dashboard_source_adapter.py"),
        "--content-job", str(args.content_job),
        "--workbook", str(args.source_workbook),
        "--output", str(source_pool),
    ])
    analyzer = [
        sys.executable, "-B", str(scripts / "page_structure_analyzer.py"),
        "--source-pool", str(source_pool),
        "--pattern-registry", str(args.pattern_registry),
        "--pattern-research-index", str(args.pattern_research_index),
        "--output", str(page_analysis),
    ]
    if args.offline:
        analyzer.append("--offline")
    run(analyzer)
    builder = [
        sys.executable, "-B", str(scripts / "pattern_analysis_builder.py"),
        "--content-job", str(args.content_job),
        "--pattern-registry", str(args.pattern_registry),
        "--monitoring-context", str(monitoring_context),
        "--source-pool", str(source_pool),
        "--page-analysis", str(page_analysis),
        "--research-brief", str(research_brief),
        "--output", str(args.output),
    ]
    if args.corrections:
        builder.extend(["--corrections", str(args.corrections)])
    run(builder)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
