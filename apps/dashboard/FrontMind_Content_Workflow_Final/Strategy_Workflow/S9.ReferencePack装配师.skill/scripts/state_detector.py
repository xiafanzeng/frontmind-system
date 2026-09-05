#!/usr/bin/env python3
"""Show lightweight S1-S8 progress without treating optional assets as blockers."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


STAGES = {
    "S1": (True, ("**/S1_*intake.json",)),
    "S2": (True, ("**/S2_*knowledge_registry.json", "**/S2_*source_registry.json", "**/S2_*claim_registry.json", "**/S2_*image_registry.json")),
    "S3": (True, ("**/S3_*trend_reference.json",)),
    "S4": (True, ("**/S4_*information_evidence_architecture.json", "**/S4_*brand_facts.json")),
    "S5": (True, ("**/S5_*voice_contract.json",)),
    "S6": (True, ("**/S6_*visual_reference.json",)),
    "S7": (True, ("**/S7_*question_library.json",)),
    "S8": (True, ("**/S8_*usability.json", "**/S8_*pack_summary.json")),
}


def matches(work_dir: Path, pattern: str) -> list[str]:
    return [path.relative_to(work_dir).as_posix() for path in sorted(work_dir.glob(pattern)) if "compatibility" not in path.parts]


def main() -> int:
    parser = argparse.ArgumentParser(description="Report content-first strategy progress")
    parser.add_argument("--work-dir", type=Path, required=True)
    args = parser.parse_args()
    work_dir = args.work_dir.resolve()
    if not work_dir.is_dir():
        parser.error("--work-dir must be a directory")
    rows = []
    missing_core = []
    for stage, (core, patterns) in STAGES.items():
        found = {pattern: matches(work_dir, pattern) for pattern in patterns}
        complete = all(found[pattern] for pattern in patterns)
        status = "completed" if complete else ("missing_core" if core else "skipped_optional")
        if core and not complete:
            missing_core.append(stage)
        rows.append({"stage": stage, "status": status, "files": found})
    payload = {
        "schema_version": "2.2.0",
        "status": "ready_for_S9" if not missing_core else "needs_core_content",
        "stages": rows,
        "missing_core_stages": missing_core,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if not missing_core else 1


if __name__ == "__main__":
    raise SystemExit(main())
