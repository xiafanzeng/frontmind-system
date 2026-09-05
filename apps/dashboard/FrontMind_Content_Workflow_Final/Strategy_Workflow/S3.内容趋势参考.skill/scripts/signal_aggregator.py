#!/usr/bin/env python3
"""Create a trend-reference shell or validate an S3 result."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


def load(path: str) -> Any:
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        return json.load(handle)


def collect_ids(payload: Any, key_names: set[str]) -> set[str]:
    result: set[str] = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in key_names and isinstance(value, str):
                result.add(value)
            result.update(collect_ids(value, key_names))
    elif isinstance(payload, list):
        for value in payload:
            result.update(collect_ids(value, key_names))
    return result


def validate(payload: Any, source_ids: set[str] | None, knowledge_ids: set[str] | None, pattern_ids: set[str] | None, category_ids: set[str] | None) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["root must be an object"]
    if payload.get("schema_version") == "2.3.0":
        if payload.get("status") not in {"completed", "skipped_optional"}:
            errors.append("invalid v2.3 status")
        trends = payload.get("trends")
        if not isinstance(trends, list):
            return errors + ["trends must be an array"]
        if payload.get("status") == "skipped_optional" and trends:
            errors.append("skipped_optional must have an empty trends array")
        for index, trend in enumerate(trends):
            label = f"trends[{index}]"
            if not isinstance(trend, dict):
                errors.append(f"{label} must be an object")
                continue
            for field in ("trend_id", "statement", "what_changed", "observed_at", "geographic_scope", "content_impact", "freshness_rule"):
                if not str(trend.get(field) or "").strip():
                    errors.append(f"{label}.{field} is required")
            source = trend.get("source")
            if not isinstance(source, dict) or not source.get("name") or not source.get("url"):
                errors.append(f"{label}.source needs name and URL")
        return errors
    if payload.get("schema_version") not in {"2.0.0", "2.2.0"}:
        errors.append("schema_version should be 2.0.0 or 2.2.0")
    status = payload.get("status")
    if status not in {"completed", "skipped_not_needed", "skipped_no_reliable_signal"}:
        errors.append("invalid status")
    trends = payload.get("trends")
    if not isinstance(trends, list):
        return errors + ["trends must be an array"]
    if status != "completed" and trends:
        errors.append("skipped status must have an empty trends array")
    seen: set[str] = set()
    for index, trend in enumerate(trends):
        label = f"trends[{index}]"
        if not isinstance(trend, dict):
            errors.append(f"{label} must be an object")
            continue
        trend_id = str(trend.get("trend_id") or "")
        if not trend_id.startswith("trend:") or trend_id in seen:
            errors.append(f"{label}.trend_id must be unique and start with trend:")
        seen.add(trend_id)
        for field in ("statement", "what_changed", "observed_at", "region"):
            if not str(trend.get(field) or "").strip():
                errors.append(f"{label}.{field} is required")
        refs = trend.get("source_ids") or []
        if not isinstance(refs, list) or not refs:
            errors.append(f"{label}.source_ids must not be empty")
            refs = []
        strength = trend.get("source_strength")
        if strength == "independent_multi_source" and len(set(refs)) < 2:
            errors.append(f"{label} needs at least two sources for independent_multi_source")
        if strength not in {"independent_multi_source", "primary_authoritative"}:
            errors.append(f"{label}.source_strength is invalid")
        if source_ids is not None:
            unknown = sorted(set(refs) - source_ids)
            if unknown:
                errors.append(f"{label} has unknown source IDs: {unknown}")
        precision = trend.get("evidence_precision")
        if precision not in {"exact", "claim", "branch", "document", "source", "none", "unknown"}:
            errors.append(f"{label}.evidence_precision is invalid")
        if knowledge_ids is not None:
            unknown_knowledge = sorted(set(trend.get("knowledge_ids") or []) - knowledge_ids)
            if unknown_knowledge:
                errors.append(f"{label} has unknown knowledge IDs: {unknown_knowledge}")
        if not isinstance(trend.get("confidence"), (int, float)) or not 0 <= float(trend["confidence"]) <= 1:
            errors.append(f"{label}.confidence must be 0..1")
        impact = trend.get("content_impact")
        if not isinstance(impact, dict) or not impact.get("changes") or not impact.get("why"):
            errors.append(f"{label}.content_impact needs changes and why")
        if not str(trend.get("freshness_rule") or "").strip():
            errors.append(f"{label}.freshness_rule is required")
        if pattern_ids is not None:
            unknown_patterns = sorted(set(trend.get("pattern_refs") or []) - pattern_ids)
            if unknown_patterns:
                errors.append(f"{label} has unknown pattern refs: {unknown_patterns}")
        if category_ids is not None:
            unknown_categories = sorted(set(trend.get("entry_category_refs") or []) - category_ids)
            if unknown_categories:
                errors.append(f"{label} has unknown canonical categories: {unknown_categories}")
        if "RESEARCH_REQUIRED" in json.dumps(trend, ensure_ascii=False):
            errors.append(f"{label} contains unresolved RESEARCH_REQUIRED placeholders")
    return errors


def build_from_signals(brand: str, category: str | None, signals: Any) -> dict[str, Any]:
    rows = signals if isinstance(signals, list) else signals.get("signals", []) if isinstance(signals, dict) else []
    trends = []
    for index, row in enumerate(item for item in rows if isinstance(item, dict)):
        statement = str(row.get("statement") or row.get("signal") or "").strip()
        if not statement:
            continue
        trend_id = row.get("trend_id") or "trend:" + hashlib.sha256(statement.encode("utf-8")).hexdigest()[:12]
        trends.append({
            "trend_id": trend_id,
            "statement": statement,
            "what_changed": row.get("what_changed") or "RESEARCH_REQUIRED",
            "observed_at": row.get("observed_at") or row.get("date") or "RESEARCH_REQUIRED",
            "region": row.get("region") or "RESEARCH_REQUIRED",
            "source_ids": row.get("source_ids") or [],
            "source_strength": row.get("source_strength") or "independent_multi_source",
            "evidence_precision": row.get("evidence_precision") or "none",
            "confidence": row.get("confidence", 0),
            "knowledge_ids": row.get("knowledge_ids") or [],
            "related_question_refs": row.get("related_question_refs") or [],
            "pattern_refs": row.get("pattern_refs") or [],
            "entry_category_refs": row.get("entry_category_refs") or [],
            "content_impact": row.get("content_impact") or {"changes": ["RESEARCH_REQUIRED"], "why": "RESEARCH_REQUIRED"},
            "freshness_rule": row.get("freshness_rule") or "RESEARCH_REQUIRED",
            "caveats": row.get("caveats") or [],
        })
    return {"schema_version": "2.2.0", "brand": brand, "category": category, "status": "completed" if trends else "skipped_no_reliable_signal", "reason": None if trends else "No supplied signals", "trends": trends}


def main() -> int:
    parser = argparse.ArgumentParser(description="Build or validate S3 content trend references")
    parser.add_argument("--validate")
    parser.add_argument("--source-registry")
    parser.add_argument("--knowledge-registry")
    parser.add_argument("--pattern-registry")
    parser.add_argument("--brand")
    parser.add_argument("--category")
    parser.add_argument("--signals")
    parser.add_argument("--output")
    args = parser.parse_args()

    if args.validate:
        payload = load(args.validate)
    else:
        if not args.brand or not args.output:
            parser.error("creation mode requires --brand and --output")
        signals = load(args.signals) if args.signals else []
        payload = build_from_signals(args.brand, args.category, signals)
        output = Path(args.output).expanduser()
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")

    source_ids = None
    if args.source_registry:
        source_ids = collect_ids(load(args.source_registry), {"source_id"})
    knowledge_ids = collect_ids(load(args.knowledge_registry), {"knowledge_id"}) if args.knowledge_registry else None
    pattern_ids = None
    category_ids = None
    if args.pattern_registry:
        registry = load(args.pattern_registry)
        pattern_ids = collect_ids(registry.get("patterns") or [], {"id"}) if isinstance(registry, dict) else set()
        pattern_ids = {value for value in pattern_ids if value.startswith("P")}
        category_ids = (
            collect_ids(registry.get("canonical_content_entries") or [], {"id"})
            if isinstance(registry, dict)
            else set()
        )
    warnings = validate(payload, source_ids, knowledge_ids, pattern_ids, category_ids)
    errors = [] if isinstance(payload, dict) and isinstance(payload.get("trends"), list) else ["trend reference must be an object with a trends array"]
    print(json.dumps({"valid": not errors, "errors": errors, "warnings": warnings, "trend_count": len(payload.get("trends") or []) if isinstance(payload, dict) else 0, "trend_reference_optional": True}, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
