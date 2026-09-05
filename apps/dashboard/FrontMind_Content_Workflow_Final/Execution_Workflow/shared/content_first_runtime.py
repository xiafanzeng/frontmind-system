#!/usr/bin/env python3
"""Small v2.3 helpers shared by the content-first E5-E10 stages.

The module intentionally contains no receipt, fingerprint, registry-copy, or
cross-stage hash logic.  ``job_state.json`` is progress state, not evidence.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import urlparse


TITLE_FIELDS = {"title", "h1", "title_candidates", "meta_description"}


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def update_job_state(
    path: Path | None,
    *,
    stage: str,
    status: str,
    warnings: Iterable[str] = (),
    selected_pattern_id: str | None = None,
    title_count: int | None | object = ...,
    blocker: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    if path is None:
        return None
    state = load_object(path)
    state["current_stage"] = stage
    state["status"] = status
    state["warnings"] = list(dict.fromkeys(str(value) for value in warnings if str(value).strip()))
    state["blocker"] = blocker if status == "blocked" else None
    if selected_pattern_id is not None:
        state["selected_pattern_id"] = selected_pattern_id
    if title_count is not ...:
        state["title_count"] = title_count
    state["updated_at"] = now()
    write_json(path, state)
    return state


def iter_blocks(model: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    """Iterate v2.3 public section paragraphs."""
    for section_index, section in enumerate(model.get("sections", [])):
        if not isinstance(section, dict):
            continue
        section_id = str(section.get("section_id") or f"section_{section_index}")
        paragraphs = section.get("paragraphs", [])
        for block_index, block in enumerate(paragraphs):
            if isinstance(block, dict):
                yield f"sections/{section_id}/paragraphs/{block_index}", block


def iter_public_containers(model: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    lead = model.get("lead")
    if isinstance(lead, dict):
        yield "lead", lead
    yield from iter_blocks(model)
    for index, faq in enumerate(model.get("faq", [])):
        if isinstance(faq, dict):
            yield f"faq/{index}", faq
    conclusion = model.get("conclusion")
    if isinstance(conclusion, dict):
        yield "conclusion", conclusion


def used_fact_ids(model: dict[str, Any]) -> list[str]:
    result: list[str] = []
    for _location, container in iter_public_containers(model):
        values = container.get("fact_ids", [])
        for value in values:
            if isinstance(value, str) and value not in result:
                result.append(value)
    return result


def refresh_references(model: dict[str, Any], context: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Replace visible references with sources for currently used, usable facts."""
    facts = {
        str(item.get("fact_id")): item
        for item in context.get("facts", [])
        if isinstance(item, dict) and item.get("fact_id")
    }
    sources = {
        str(item.get("source_id")): item
        for item in context.get("sources", [])
        if isinstance(item, dict) and item.get("source_id")
    }
    source_order: list[str] = []
    warnings: list[str] = []
    for fact_id in used_fact_ids(model):
        fact = facts.get(fact_id)
        if not fact or fact.get("usage_status") == "excluded":
            continue
        for raw_source_id in fact.get("source_ids", []):
            source_id = str(raw_source_id)
            if source_id not in source_order:
                source_order.append(source_id)
    references: list[dict[str, Any]] = []
    for source_id in source_order:
        source = sources.get(source_id)
        if not source or source.get("usage_status") == "excluded":
            warnings.append(f"source_omitted:{source_id}")
            continue
        references.append({
            "source_id": source_id,
            "display_name": source_display_name(source),
            "url": source.get("url"),
        })
    changed = model.get("references") != references
    model["references"] = references
    return (["references:auto_generated_from_used_facts"] if changed else []), warnings


def source_display_name(source: dict[str, Any]) -> str:
    title = str(source.get("title") or "").strip()
    kind = str(source.get("source_kind") or "")
    if not title:
        return "企业资料" if kind in {"user_upload", "first_party_public"} else "公开资料"
    stem = re.sub(r"\.(?:md|txt|json|csv|html?)$", "", title, flags=re.IGNORECASE)
    if re.fullmatch(r"[0-9_-]+", stem):
        return "企业资料"
    if re.fullmatch(r"[a-z0-9_-]+", stem, flags=re.IGNORECASE):
        concepts = {
            "brand-naming": "品牌与机构信息",
            "parent-hospital": "母院与科室背景",
            "team-overview": "医师团队",
            "followup": "服务流程与随访",
            "injectables": "注射项目与医师信息",
            "service-process": "服务流程",
            "pricing": "费用说明",
            "contact": "预约与联系方式",
        }
        readable = concepts.get(stem.casefold())
        if readable:
            host = urlparse(str(source.get("url") or "")).hostname
            return f"机构官网：{readable}" if host else f"企业提供：{readable}"
        if kind not in {"user_upload", "first_party_public", "first_party_official"}:
            return title
        readable = re.sub(r"[-_]+", " ", stem).strip().title()
        return f"机构官网：{readable}" if source.get("url") else (f"企业提供：{readable}" if readable else "企业提供")
    return title


def visible_text(model: dict[str, Any]) -> str:
    values: list[str] = []
    lead = model.get("lead", {})
    if isinstance(lead, dict):
        values.append(str(lead.get("text", "")))
    for section in model.get("sections", []):
        if not isinstance(section, dict):
            continue
        values.append(str(section.get("heading", "")))
        for _location, block in iter_blocks({"sections": [section]}):
            values.append(str(block.get("text", "")))
            values.extend(str(item) for item in block.get("items", []) if isinstance(item, str))
    for faq in model.get("faq", []):
        if isinstance(faq, dict):
            values.extend((str(faq.get("question", "")), str(faq.get("answer", ""))))
    conclusion = model.get("conclusion", {})
    if isinstance(conclusion, dict):
        values.extend(
            str(item.get("text", "")) for item in conclusion.get("paragraphs", []) if isinstance(item, dict)
        )
    return "\n".join(value for value in values if value)


def title_field_paths(value: Any, prefix: str = "$") -> list[str]:
    paths: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{prefix}.{key}"
            if key in TITLE_FIELDS:
                paths.append(child_path)
            paths.extend(title_field_paths(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(title_field_paths(child, f"{prefix}[{index}]"))
    return paths


def resolve_input_file(asset_root: Path, raw_path: str) -> Path:
    candidate = Path(raw_path)
    root = asset_root.resolve()
    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        resolved = (root / candidate).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"asset path escapes --asset-root: {raw_path}") from exc
    return resolved
