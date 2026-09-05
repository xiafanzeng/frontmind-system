#!/usr/bin/env python3
"""Compatibility CLI for jobs that still invoke the retired E9 filename."""

import runpy
from pathlib import Path


ACTIVE_SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "E9.HarnessGEO候选优化师.skill/scripts/harnessgeo_candidate_optimizer.py"
)


def main() -> int:
    namespace = runpy.run_path(str(ACTIVE_SCRIPT))
    return int(namespace["main"]())


if __name__ == "__main__":
    raise SystemExit(main())
