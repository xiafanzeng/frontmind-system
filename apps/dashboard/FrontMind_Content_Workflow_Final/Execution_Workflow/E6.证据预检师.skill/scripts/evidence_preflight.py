#!/usr/bin/env python3
"""Revise unsupported claims in-place without publishing evidence commentary."""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
sys.path.insert(0, str(SHARED))
from content_first_runtime import (  # noqa: E402
    load_object, refresh_references, title_field_paths, update_job_state, visible_text, write_json,
)
from schema_validation import validate_root, validate_schema  # noqa: E402


INTERNAL_QUALIFICATIONS = (
    "使用时必须保留", "需保留限定", "以审核为准", "以资料为准", "待核验", "待确认",
    "当前可公开资料不足", "资料粒度", "内部", "工作流", "reviewer", "receipt",
)
OVERCLAIM_RE = re.compile(
    r"(?:行业|市场|综合|公认|绝对)?(?:第一|领先|最佳|最好|最安全|最权威|唯一|榜首|Top\s*1|得分最高)",
    flags=re.I,
)


def fact_cards(context: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = context.get("fact_cards") if isinstance(context.get("fact_cards"), list) else context.get("facts", [])
    return {str(item.get("fact_id")): item for item in raw if isinstance(item, dict) and item.get("fact_id")}


def source_cards(context: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(item.get("source_id")): item
        for item in context.get("sources", []) if isinstance(item, dict) and item.get("source_id")
    }


def public_qualification(value: Any) -> str:
    text = " ".join(str(value or "").split()).strip().rstrip("。")
    if not text or any(marker.casefold() in text.casefold() for marker in INTERNAL_QUALIFICATIONS):
        return ""
    if not re.search(r"(?:截至|\d{4}|地区|区域|版本|适用于|仅限|条件|币种|规格|有效期)", text):
        return ""
    return text


def qualify_naturally(text: str, qualification: str) -> str:
    if not qualification or qualification in text:
        return text
    if qualification.startswith("截至"):
        return qualification.rstrip("，,。") + "，" + text.lstrip("，,")
    return text.rstrip("。") + "；" + qualification + "。"


def first_party_only(fact: dict[str, Any], sources: dict[str, dict[str, Any]]) -> bool:
    source_ids = [str(item) for item in fact.get("source_ids", [])]
    if not source_ids:
        return False
    kinds = {str(sources.get(item, {}).get("source_kind") or "") for item in source_ids}
    return bool(kinds) and kinds <= {"user_upload", "first_party_public", "first_party_official"}


def revise_text(text: str, bound: list[dict[str, Any]], sources: dict[str, dict[str, Any]]) -> tuple[str, str]:
    """Return publishable text and keep/qualify/rewrite/remove."""
    text = " ".join(str(text or "").split()).strip()
    if not text:
        return "", "remove"
    if OVERCLAIM_RE.search(text) and (not bound or all(first_party_only(fact, sources) for fact in bound)):
        kept = [sentence for sentence in re.split(r"(?<=[。！？])\s*", text) if not OVERCLAIM_RE.search(sentence)]
        text = "".join(kept).strip()
        if not text:
            return "", "remove"
        action = "rewrite"
    else:
        action = "keep"
    qualifications = [public_qualification(fact.get("qualification")) for fact in bound]
    qualifications = [item for item in qualifications if item]
    for qualification in qualifications:
        text = qualify_naturally(text, qualification)
        action = "qualify"
    return text, action


def auto_revise(
    draft: dict[str, Any], context: dict[str, Any],
) -> tuple[dict[str, Any], Counter[str], list[str]]:
    result = copy.deepcopy(draft)
    result.pop("warnings", None)
    facts, sources = fact_cards(context), source_cards(context)
    counts: Counter[str] = Counter()
    warnings: list[str] = []

    def revise_container(container: dict[str, Any], key: str, location: str) -> bool:
        original_ids = [str(value) for value in container.get("fact_ids", [])]
        usable_ids = [
            value for value in original_ids
            if value in facts and facts[value].get("usage_status") != "excluded"
        ]
        if usable_ids != original_ids:
            warnings.append(f"removed_unusable_fact_binding:{location}")
        container["fact_ids"] = usable_ids
        if original_ids and not usable_ids:
            container[key] = ""
            counts["remove"] += 1
            return False
        text, action = revise_text(str(container.get(key) or ""), [facts[value] for value in usable_ids], sources)
        counts[action] += 1
        if not text:
            return False
        container[key] = text
        return True

    lead = result.get("lead") if isinstance(result.get("lead"), dict) else None
    if lead is not None:
        revise_container(lead, "text", "lead")
    for section in result.get("sections", []):
        if not isinstance(section, dict):
            continue
        kept = []
        for index, item in enumerate(section.get("paragraphs", [])):
            if isinstance(item, dict) and revise_container(item, "text", f"section:{section.get('section_id')}:{index}"):
                kept.append(item)
        section["paragraphs"] = kept
    result["sections"] = [
        section for section in result.get("sections", [])
        if isinstance(section, dict) and section.get("paragraphs")
    ]
    kept_faq = []
    for index, item in enumerate(result.get("faq", [])):
        if isinstance(item, dict) and revise_container(item, "answer", f"faq:{index}"):
            kept_faq.append(item)
    result["faq"] = kept_faq
    conclusion = result.get("conclusion") if isinstance(result.get("conclusion"), dict) else {"paragraphs": []}
    kept_conclusion = []
    for index, item in enumerate(conclusion.get("paragraphs", [])):
        if isinstance(item, dict) and revise_container(item, "text", f"conclusion:{index}"):
            kept_conclusion.append(item)
    conclusion["paragraphs"] = kept_conclusion
    result["conclusion"] = conclusion
    result["schema_version"] = "2.3.0"
    result["content_status"] = "fact_checked"
    refresh_references(result, context)
    return result, counts, list(dict.fromkeys(warnings))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--draft", type=Path, required=True)
    parser.add_argument("--revised", type=Path, help="optional whole-article revision authored by E6")
    parser.add_argument("--working-context", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--job-state", type=Path)
    parser.add_argument("--core-unanswerable-reason")
    args = parser.parse_args()
    draft, context = load_object(args.draft), load_object(args.working_context)
    if args.revised:
        revised, counts, warnings = auto_revise(load_object(args.revised), context)
        counts["rewrite"] += 1
    else:
        revised, counts, warnings = auto_revise(draft, context)
    if len({draft.get("job_id"), revised.get("job_id"), context.get("job_id")}) != 1:
        raise ValueError("E6 job_id mismatch")
    if title_field_paths(revised):
        raise ValueError("E6 revised Content Model must remain title-free")
    blocker = None
    if args.core_unanswerable_reason:
        blocker = {"code": "unanswerable_core_question", "message": args.core_unanswerable_reason.strip()}
    elif not str((revised.get("lead") or {}).get("text") or "").strip() or not visible_text(revised).strip():
        blocker = {"code": "unanswerable_core_question", "message": "事实修订后已没有可诚实回答核心问题的正文"}
    status = "blocked" if blocker else "completed_with_limits" if warnings or counts["remove"] else "completed"
    summary = {
        "schema_version": "2.3.0", "job_id": revised.get("job_id"), "stage": "E6",
        "status": status, "revision_counts": dict(counts), "warnings": warnings, "blocker": blocker,
    }
    validate_schema(summary, Path(__file__).resolve().parents[1] / "templates" / "fact_revision_report.schema.json",
                    "E6 fact revision summary")
    if blocker is None:
        validate_root(revised, "content_model.schema.json", "E6 revised Content Model")
        write_json(args.output, revised)
    write_json(args.summary, summary)
    update_job_state(args.job_state, stage="E6", status=status, warnings=warnings,
                     selected_pattern_id=str(revised.get("pattern_id")), blocker=blocker)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 2 if blocker else 0


if __name__ == "__main__":
    raise SystemExit(main())
