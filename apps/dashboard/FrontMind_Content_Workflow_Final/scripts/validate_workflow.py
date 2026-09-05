#!/usr/bin/env python3
"""Stable root entrypoint for the canonical shared workflow validator."""

from __future__ import annotations

import runpy
from pathlib import Path


if __name__ == "__main__":
    validator = Path(__file__).resolve().parents[1] / "shared" / "scripts" / "validate_workflow.py"
    runpy.run_path(str(validator), run_name="__main__")
