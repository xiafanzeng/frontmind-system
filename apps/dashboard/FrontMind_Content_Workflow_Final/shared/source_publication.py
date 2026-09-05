#!/usr/bin/env python3
"""Content-use policy for v2.3.

This module answers one question at the point of use: may this source inform
the visible article, must it be qualified, or must it be excluded?  It does
not validate approvals, receipts, storage contexts, or file fingerprints.
"""

from __future__ import annotations

from typing import Any


USABLE = "usable"
QUALIFIED = "qualified"
EXCLUDED = "excluded"


def source_usage_status(source: Any) -> str:
    if not isinstance(source, dict):
        return EXCLUDED
    source_type = str(source.get("source_type") or "")
    content_status = str(source.get("content_status") or "")
    confidentiality = str(source.get("confidentiality") or "")
    authorization = str(source.get("publication_authorization") or "")
    notes = " ".join(str(source.get(key) or "") for key in ("title", "notes", "origin")).casefold()
    restricted_markers = (
        "internal", "confidential", "private", "仅限内部", "内部培训",
        "个人信息", "患者", "病历", "禁止发布", "保密",
    )
    if (
        source_type == "first_party_internal"
        or content_status in {"internal_only", "blocked"}
        or confidentiality in {"internal", "confidential", "private", "restricted"}
        or authorization in {"internal_only", "pending", "prohibited"}
        or any(marker in notes for marker in restricted_markers)
    ):
        return EXCLUDED
    explicit = source.get("usage_status")
    if explicit in {USABLE, QUALIFIED, EXCLUDED}:
        return str(explicit)
    if source.get("qualification") or source.get("verification_status") in {"verified_with_limits", "needs_verification"}:
        return QUALIFIED
    return USABLE


def validate_source_publication(source: Any, storage_context: str | None = None, contract: Any = None) -> list[str]:
    """Compatibility API: only excluded sources are unsuitable for visible copy."""

    if not isinstance(source, dict):
        return ["source must be an object"]
    if source_usage_status(source) == EXCLUDED:
        return [f"{source.get('source_id', '<unknown>')}: source is excluded from visible content"]
    return []


def source_is_publishable(source: Any, storage_context: str | None = None, contract: Any = None) -> bool:
    return source_usage_status(source) != EXCLUDED


def content_use_decision(source: Any) -> dict[str, Any]:
    status = source_usage_status(source)
    return {
        "status": status,
        "qualification": source.get("qualification") if isinstance(source, dict) else None,
        "may_appear_in_visible_copy": status != EXCLUDED,
    }
