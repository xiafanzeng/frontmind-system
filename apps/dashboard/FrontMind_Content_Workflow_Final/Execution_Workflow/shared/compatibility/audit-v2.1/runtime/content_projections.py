#!/usr/bin/env python3
"""Canonical cross-stage projections for evidence and visual receipts."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def evidence_projection(model: dict[str, Any]) -> dict[str, Any]:
    """All evidence-relevant content except E7-owned visuals and revision."""
    return {key: value for key, value in model.items() if key not in {"revision", "visual_placements"}}


def evidence_projection_sha256(model: dict[str, Any]) -> str:
    return canonical_sha256(evidence_projection(model))


def _block_binding(block: dict[str, Any]) -> dict[str, Any]:
    return {
        "block_id": block.get("block_id"),
        "type": block.get("type"),
        "content_function": block.get("content_function"),
        "claim_ids": sorted(str(value) for value in block.get("claim_ids", [])),
    }


def visual_projection(model: dict[str, Any]) -> dict[str, Any]:
    """Immutable visual topology; reviewed wording is deliberately excluded."""
    sections: list[dict[str, Any]] = []
    for section in model.get("sections", []):
        if not isinstance(section, dict):
            continue
        sections.append({
            "section_id": section.get("section_id"),
            "blocks": [_block_binding(item) for item in section.get("blocks", []) if isinstance(item, dict)],
            "subsections": [
                {
                    "blocks": [_block_binding(block) for block in item.get("blocks", []) if isinstance(block, dict)],
                }
                for item in section.get("subsections", []) if isinstance(item, dict)
            ],
        })
    return {
        "schema_version": model.get("schema_version"),
        "job_id": model.get("job_id"),
        "entry_category": model.get("entry_category"),
        "primary_question": model.get("primary_question"),
        "question_origin": model.get("question_origin"),
        "product_scenario_subintent": model.get("product_scenario_subintent"),
        "pattern_id": model.get("pattern_id"),
        "lead_claim_ids": sorted(str(value) for value in (model.get("lead") or {}).get("claim_ids", [])),
        "sections": sections,
        "faq": [
            {
                "content_function": item.get("content_function"),
                "claim_ids": sorted(str(value) for value in item.get("claim_ids", [])),
            }
            for item in model.get("faq", []) if isinstance(item, dict)
        ],
        "conclusion_claim_ids": sorted(str(value) for value in (model.get("conclusion") or {}).get("claim_ids", [])),
        "references": model.get("references", []),
        "visual_placements": sorted(
            (item for item in model.get("visual_placements", []) if isinstance(item, dict)),
            key=lambda item: str(item.get("visual_id", "")),
        ),
    }


def visual_projection_sha256(model: dict[str, Any]) -> str:
    return canonical_sha256(visual_projection(model))
