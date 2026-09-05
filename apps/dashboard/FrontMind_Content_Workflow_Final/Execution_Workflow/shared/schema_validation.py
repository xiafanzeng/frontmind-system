#!/usr/bin/env python3
"""Thin adapter to the root stdlib JSON Schema runtime.

Execution stages import this module; schema semantics remain owned exclusively
by ``FrontMind_Content_Workflow_Final/shared``.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any


WORKFLOW_ROOT = Path(__file__).resolve().parents[2]
ROOT_SHARED = WORKFLOW_ROOT / "shared"
RUNTIME_PATH = ROOT_SHARED / "scripts" / "validate_json_instance.py"


def _runtime():
    module_name = "frontmind_root_schema_runtime"
    if module_name in sys.modules:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, RUNTIME_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"root schema runtime unavailable: {RUNTIME_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def root_schema(name: str) -> Path:
    path = (ROOT_SHARED / name).resolve()
    try:
        path.relative_to(ROOT_SHARED.resolve())
    except ValueError as exc:
        raise ValueError(f"unsafe root schema name: {name}") from exc
    if not path.is_file():
        raise FileNotFoundError(path)
    return path


def validate_schema(instance: Any, schema_path: Path, label: str) -> None:
    runtime = _runtime()
    validator = runtime.JsonSchemaValidator(schema_path)
    errors = validator.validate(instance)
    if errors:
        preview = "; ".join(
            f"{error.json_path} [{error.keyword}] {error.message}" for error in errors[:12]
        )
        suffix = f"; +{len(errors) - 12} more" if len(errors) > 12 else ""
        raise ValueError(f"{label} failed canonical JSON Schema validation: {preview}{suffix}")


def validate_root(instance: Any, schema_name: str, label: str) -> None:
    validate_schema(instance, root_schema(schema_name), label)
