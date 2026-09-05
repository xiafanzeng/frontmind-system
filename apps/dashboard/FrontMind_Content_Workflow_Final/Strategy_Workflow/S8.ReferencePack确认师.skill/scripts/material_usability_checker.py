#!/usr/bin/env python3
"""Low-level S8 content usability summary used by the v2.3 producer."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


REGISTRY_SPECS = {
    "knowledge": ("*knowledge_registry.json", "knowledge_units", "knowledge_id"),
    "source": ("*source_registry.json", "sources", "source_id"),
    "claim": ("*claim_registry.json", "claims", "claim_id"),
    "image": ("*image_registry.json", "images", "image_id"),
}


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def find_registry(work_dir: Path, pattern: str) -> Path | None:
    matches = sorted(path for path in work_dir.rglob(pattern) if "compatibility" not in path.parts)
    return matches[-1] if matches else None


def infer_status(kind: str, item: dict[str, Any]) -> tuple[str, str | None]:
    explicit = item.get("usage_status")
    if explicit in {"usable", "qualified", "excluded"}:
        return str(explicit), item.get("reason") or item.get("notes")
    if kind == "source":
        if item.get("source_origin_class") == "first_party_internal" or item.get("publication_authorization") in {"internal_only", "prohibited"}:
            return "excluded", "internal_or_nonpublic_source"
        return "usable", None
    if kind == "claim":
        usage = item.get("allowed_usage")
        if usage in {"internal_only", "do_not_use"}:
            return "excluded", "claim_not_safe_for_public_use"
        if usage == "public_with_qualification" or item.get("verification_status") in {"verified_with_limits", "needs_verification"}:
            return "qualified", item.get("reason") or "claim_requires_qualification"
        return "usable", None
    if kind == "image":
        if item.get("rights_status") not in {"approved", "approved_with_credit"}:
            return "excluded", "image_rights_not_confirmed"
        return "usable", None
    if item.get("content_status") in {"internal_only", "blocked"}:
        return "excluded", "content_not_public"
    if item.get("evidence_status") in {"partial", "unverified"}:
        return "qualified", "content_requires_qualification"
    return "usable", None


def main() -> int:
    parser = argparse.ArgumentParser(description="Run automatic S8 material usability checks")
    parser.add_argument("--brand", required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        brand = args.brand.strip()
        if not brand:
            raise ValueError("--brand must be non-empty")
        work_dir = args.work_dir.resolve()
        summaries: dict[str, dict[str, int]] = {}
        exclusions: list[dict[str, str]] = []
        warnings: list[str] = []
        usable_text = 0
        for kind, (pattern, collection_key, id_key) in REGISTRY_SPECS.items():
            path = find_registry(work_dir, pattern)
            counts = {"usable": 0, "qualified": 0, "excluded": 0}
            if path is None:
                warnings.append(f"{kind} registry is absent; continuing with available content")
                summaries[kind] = counts
                continue
            payload = load(path)
            items = payload.get(collection_key) if isinstance(payload, dict) else None
            if not isinstance(items, list):
                warnings.append(f"{path.name} has no readable {collection_key} array")
                summaries[kind] = counts
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                status, reason = infer_status(kind, item)
                counts[status] += 1
                if kind in {"knowledge", "source", "claim"} and status in {"usable", "qualified"}:
                    usable_text += 1
                if status == "excluded":
                    exclusions.append({
                        "object_type": kind,
                        "object_id": str(item.get(id_key) or "unknown"),
                        "reason": str(reason or "not_usable"),
                    })
            summaries[kind] = counts
        blocker = None
        if usable_text == 0:
            blocker = "No usable or qualifiable text remains after safety exclusions."
        status = "blocked" if blocker else ("completed_with_limits" if warnings or exclusions or any(value["qualified"] for value in summaries.values()) else "completed")
        payload = {
            "schema_version": "2.3.0",
            "stage": "S8_material_usability",
            "status": status,
            "brand": brand,
            "summaries": summaries,
            "exclusions": exclusions,
            "warnings": warnings,
            "blocker": blocker,
        }
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print(json.dumps({"stage": "S8", "status": status, "excluded": len(exclusions), "warnings": len(warnings)}, ensure_ascii=False))
    return 1 if blocker else 0


if __name__ == "__main__":
    raise SystemExit(main())
