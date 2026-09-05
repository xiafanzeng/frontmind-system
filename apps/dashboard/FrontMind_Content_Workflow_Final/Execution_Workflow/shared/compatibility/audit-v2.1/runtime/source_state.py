#!/usr/bin/env python3
"""Bind the root source-publication state machine to runtime registry receipts."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

ROOT_SHARED = Path(__file__).resolve().parents[2] / "shared"
if str(ROOT_SHARED) not in sys.path:
    sys.path.insert(0, str(ROOT_SHARED))

from source_publication import validate_source_publication  # noqa: E402


def source_state_errors(
    source_registry: dict[str, Any], runtime_receipt: dict[str, Any] | None = None,
    used_source_ids: set[str] | None = None,
    pattern_registry: dict[str, Any] | None = None,
) -> list[str]:
    """Validate origin/authorization using receipt-defined storage context."""

    if not isinstance(pattern_registry, dict):
        return ["packaged pattern registry is required for source publication validation"]
    publication_contract = pattern_registry.get("first_party_publication_contract")
    if not isinstance(publication_contract, dict):
        return ["packaged pattern registry lacks first_party_publication_contract"]
    extension_ids = set()
    base_ids = set()
    if isinstance(runtime_receipt, dict):
        extension_ids = {str(value) for value in runtime_receipt.get("extension_source_ids", [])}
        base_ids = {str(value) for value in runtime_receipt.get("base_source_ids", [])}
    records = {
        str(item.get("source_id")): item for item in source_registry.get("sources", [])
        if isinstance(item, dict)
    }
    selected = set(records) if used_source_ids is None else set(used_source_ids)
    errors: list[str] = []
    for source_id in sorted(selected):
        source = records.get(source_id)
        if source is None:
            errors.append(f"{source_id}: source is absent from registry")
            continue
        if runtime_receipt is not None:
            if source_id in extension_ids:
                context = "runtime"
            elif source_id in base_ids:
                context = "base_pack"
            else:
                errors.append(f"{source_id}: source is absent from runtime receipt ID sets")
                continue
        else:
            context = "runtime" if source.get("source_origin_class") == "runtime_approved" else "base_pack"
        errors.extend(validate_source_publication(source, context, publication_contract))
    return errors
