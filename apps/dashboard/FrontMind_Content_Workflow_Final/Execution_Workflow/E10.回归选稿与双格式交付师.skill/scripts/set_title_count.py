#!/usr/bin/env python3
"""Store the sole E10 user pause directly in job_state.json."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
sys.path.insert(0, str(SHARED))
from content_first_runtime import load_object, update_job_state  # noqa: E402
from schema_validation import validate_root  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-state", type=Path, required=True)
    parser.add_argument("--count", type=int)
    args = parser.parse_args()
    state = load_object(args.job_state)
    if args.count is None:
        updated = update_job_state(
            args.job_state, stage="E10", status="awaiting_title_count",
            warnings=[], title_count=None,
        )
        assert updated is not None
        validate_root(updated, "job_state.schema.json", "E10 awaiting title count state")
        print("这篇文章需要生成多少个标题选项？请输入 1–20。")
        return 0
    if isinstance(args.count, bool) or not 1 <= args.count <= 20:
        parser.error("--count must be an integer from 1 through 20")
    updated = update_job_state(
        args.job_state, stage="E10", status="running", warnings=[], title_count=args.count,
    )
    assert updated is not None
    validate_root(updated, "job_state.schema.json", "E10 title count state")
    print(json.dumps(updated, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
