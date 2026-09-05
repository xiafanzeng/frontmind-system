#!/usr/bin/env python3
"""Inspect an optional S7 question and FAQ reference library."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


FORBIDDEN_KEYS = {
    "standard_answer", "full_answer", "complete_answer", "answer_html",
    "content_calendar", "publication_calendar", "publish_date",
    "landing_page", "landing_page_blueprint", "faqpage_json_ld", "schema_markup",
}
PROVENANCE_TYPES = {"user_supplied", "first_party_observed", "external_observed", "source_derived", "research_hypothesis"}


def load(path: str) -> Any:
    with Path(path).expanduser().open("r", encoding="utf-8") as handle:
        return json.load(handle)


def known_ids(payload: Any, keys: set[str]) -> set[str]:
    result: set[str] = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in keys and isinstance(value, str):
                result.add(value)
            result.update(known_ids(value, keys))
    elif isinstance(payload, list):
        for value in payload:
            result.update(known_ids(value, keys))
    return result


def find_forbidden(payload: Any, path: str = "") -> list[str]:
    hits: list[str] = []
    if isinstance(payload, dict):
        for key, value in payload.items():
            child = f"{path}.{key}" if path else key
            if key in FORBIDDEN_KEYS:
                hits.append(child)
            hits.extend(find_forbidden(value, child))
    elif isinstance(payload, list):
        for index, value in enumerate(payload):
            hits.extend(find_forbidden(value, f"{path}[{index}]"))
    return hits


def registry_contract(registry: Any) -> tuple[set[str], set[str], set[str], set[str], dict[str, set[str]], dict[str, set[str]]]:
    if not isinstance(registry, dict):
        return set(), set(), set(), set(), {}, {}
    tags = {str(item.get("id")) for item in registry.get("question_intent_tags", []) if isinstance(item, dict) and item.get("id")}
    categories = {
        str(item.get("id"))
        for item in registry.get("canonical_content_entries", [])
        if isinstance(item, dict) and item.get("id")
    }
    subintents = {str(item.get("id")) for item in registry.get("product_scenario_subintents", []) if isinstance(item, dict) and item.get("id")}
    patterns = {str(item.get("id")) for item in registry.get("patterns", []) if isinstance(item, dict) and item.get("id")}
    category_routes: dict[str, set[str]] = {}
    subintent_routes: dict[str, set[str]] = {}
    routing = registry.get("routing") or {}
    if isinstance(routing, dict):
        for category, route in routing.items():
            if not isinstance(route, dict):
                continue
            category_routes[str(category)] = set(route.get("primary_patterns") or []) | set(route.get("secondary_patterns") or [])
            for subintent, route_patterns in (route.get("subintent_routing") or {}).items():
                subintent_routes[str(subintent)] = set(route_patterns or [])
    return tags, categories, subintents, patterns, category_routes, subintent_routes


def normalize_question(text: str) -> str:
    return re.sub(r"[\s？?，,。.!！:：;；]+", "", text).lower()


def validate(payload: Any, registry: Any, knowledge_ids: set[str] | None, source_ids: set[str] | None, claim_ids: set[str] | None, context_ids: set[str] | None, proof_ids: set[str] | None) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["root must be an object"]
    if payload.get("schema_version") == "2.3.0":
        if payload.get("status") not in {"completed", "skipped_optional"}:
            errors.append("invalid v2.3 status")
        questions = payload.get("questions")
        if not isinstance(questions, list):
            return errors + ["questions must be an array"]
        if payload.get("status") == "skipped_optional" and questions:
            errors.append("skipped_optional must have an empty questions array")
        seen: set[str] = set()
        for index, question in enumerate(questions):
            label = f"questions[{index}]"
            if not isinstance(question, dict):
                errors.append(f"{label} must be an object")
                continue
            text = str(question.get("question_text") or "").strip()
            if not text.endswith(("?", "？")):
                errors.append(f"{label}.question_text must be an observed question")
            normalized = normalize_question(text)
            if normalized in seen:
                errors.append(f"{label}.question_text is duplicated")
            seen.add(normalized)
            if not question.get("knowledge_ids") and not question.get("source_ids"):
                errors.append(f"{label} needs an observed material reference")
        return errors
    if payload.get("schema_version") not in {"2.0.0", "2.2.0"}:
        errors.append("schema_version should be 2.0.0 or 2.2.0")
    if payload.get("pattern_registry_ref") != "shared/content-pattern-registry.json":
        errors.append("pattern_registry_ref must be shared/content-pattern-registry.json")
    forbidden = find_forbidden(payload)
    if forbidden:
        errors.append(f"forbidden full-answer/calendar/landing-page fields: {forbidden}")

    intent_tags, categories, subintents, patterns, category_routes, subintent_routes = registry_contract(registry)
    if len(intent_tags) != 7:
        errors.append(f"shared registry must expose seven question_intent_tags; found {len(intent_tags)}")
    if len(categories) != 5:
        errors.append(f"shared registry must expose five content entries; found {len(categories)}")
    if patterns != {f"P{index:02d}" for index in range(1, 17)}:
        errors.append(f"shared registry must expose P01-P16 exactly; found {sorted(patterns)}")

    questions = payload.get("questions")
    if not isinstance(questions, list):
        return errors + ["questions must be an array"]
    if not 30 <= len(questions) <= 50:
        errors.append(f"question count must be 30..50; found {len(questions)}")
    seen_ids: set[str] = set()
    seen_text: set[str] = set()
    used_tags: set[str] = set()
    used_categories: set[str] = set()

    for index, question in enumerate(questions):
        label = f"questions[{index}]"
        if not isinstance(question, dict):
            errors.append(f"{label} must be an object")
            continue
        question_id = str(question.get("question_id") or "")
        if not question_id.startswith("q:") or question_id in seen_ids:
            errors.append(f"{label}.question_id must be unique and start with q:")
        seen_ids.add(question_id)
        text = str(question.get("canonical_question") or "").strip()
        normalized = normalize_question(text)
        if len(normalized) < 6:
            errors.append(f"{label}.canonical_question is too short")
        if normalized in seen_text:
            errors.append(f"{label}.canonical_question duplicates another normalized question")
        seen_text.add(normalized)

        primary = str(question.get("primary_intent_tag") or "")
        secondary = {str(value) for value in question.get("secondary_intent_tags") or []}
        if primary not in intent_tags:
            errors.append(f"{label}.primary_intent_tag is unknown: {primary}")
        else:
            used_tags.add(primary)
        unknown_secondary = secondary - intent_tags
        if unknown_secondary:
            errors.append(f"{label} has unknown secondary intent tags: {sorted(unknown_secondary)}")
        if primary in secondary:
            errors.append(f"{label} repeats primary intent in secondary_intent_tags")

        category = str(question.get("entry_category") or "")
        if category not in categories:
            errors.append(f"{label}.entry_category is unknown: {category}")
        else:
            used_categories.add(category)
        subintent = question.get("product_scenario_subintent_ref")
        if category == "product_scenario":
            if not subintent or str(subintent) not in subintents:
                errors.append(f"{label} needs a valid product_scenario_subintent_ref")
        elif subintent:
            errors.append(f"{label} cannot set product_scenario_subintent_ref outside product_scenario")

        pattern_refs = {str(value) for value in question.get("pattern_refs") or []}
        if not pattern_refs:
            errors.append(f"{label}.pattern_refs must not be empty")
        unknown_patterns = pattern_refs - patterns
        if unknown_patterns:
            errors.append(f"{label} has unknown pattern refs: {sorted(unknown_patterns)}")
        allowed_patterns = category_routes.get(category)
        if allowed_patterns is not None and pattern_refs - allowed_patterns:
            errors.append(
                f"{label}.pattern_refs contain patterns outside entry routing: "
                f"{sorted(pattern_refs - allowed_patterns)}"
            )
        if subintent and str(subintent) in subintent_routes and not pattern_refs & subintent_routes[str(subintent)]:
            errors.append(f"{label}.pattern_refs do not follow product subintent routing")

        provenance = question.get("provenance") or []
        if not provenance:
            errors.append(f"{label}.provenance must not be empty")
        for prov_index, item in enumerate(provenance):
            prov_label = f"{label}.provenance[{prov_index}]"
            if not isinstance(item, dict) or item.get("type") not in PROVENANCE_TYPES:
                errors.append(f"{prov_label}.type is invalid")
                continue
            has_locator = any(item.get(key) for key in ("source_id", "knowledge_id", "url", "file", "locator", "rationale"))
            if not has_locator:
                errors.append(f"{prov_label} needs a locator/ref or hypothesis rationale")
            if item.get("type") == "research_hypothesis" and not item.get("rationale"):
                errors.append(f"{prov_label} research_hypothesis needs rationale")
            if source_ids is not None and item.get("source_id") and item.get("source_id") not in source_ids:
                errors.append(f"{prov_label} references unknown source_id: {item.get('source_id')}")
            if knowledge_ids is not None and item.get("knowledge_id") and item.get("knowledge_id") not in knowledge_ids:
                errors.append(f"{prov_label} references unknown knowledge_id: {item.get('knowledge_id')}")

        answerability = question.get("answerability")
        if answerability not in {"answerable", "answerable_with_attribution", "research_required", "blocked"}:
            errors.append(f"{label}.answerability is invalid")
        boundary = question.get("answer_boundary") or {}
        thesis = boundary.get("answer_thesis")
        if thesis and (len(str(thesis)) > 160 or "\n" in str(thesis)):
            errors.append(f"{label}.answer_thesis must be one short line (<=160 chars)")
        proof_refs = set(boundary.get("proof_refs") or [])
        if answerability in {"answerable", "answerable_with_attribution"} and not proof_refs:
            errors.append(f"{label} is answerable but has no proof_refs")
        if answerability in {"research_required", "blocked"} and thesis:
            errors.append(f"{label} cannot provide answer_thesis when answerability={answerability}")
        for field in ("must_cover", "must_not_claim", "freshness_rule"):
            if not boundary.get(field):
                errors.append(f"{label}.answer_boundary.{field} is required")
        if not question.get("audience_context_refs"):
            errors.append(f"{label}.audience_context_refs must not be empty")
        if context_ids is not None:
            unknown = set(question.get("audience_context_refs") or []) - context_ids
            if unknown:
                errors.append(f"{label} has unknown audience context refs: {sorted(unknown)}")
        if proof_ids is not None:
            unknown = proof_refs - proof_ids
            if unknown:
                errors.append(f"{label} has unknown proof refs: {sorted(unknown)}")
        if source_ids is not None:
            unknown = set(question.get("source_ids") or []) - source_ids
            if unknown:
                errors.append(f"{label} has unknown source IDs: {sorted(unknown)}")
        if claim_ids is not None:
            unknown = set(question.get("claim_ids") or []) - claim_ids
            if unknown:
                errors.append(f"{label} has unknown claim IDs: {sorted(unknown)}")
        if knowledge_ids is not None:
            unknown = set(question.get("knowledge_ids") or []) - knowledge_ids
            if unknown:
                errors.append(f"{label} has unknown knowledge IDs: {sorted(unknown)}")
        if question.get("faq_relevance") not in {"core", "supporting", "edge"}:
            errors.append(f"{label}.faq_relevance is invalid")
        if not str(question.get("relevance_reason") or "").strip():
            errors.append(f"{label}.relevance_reason is required")

    missing_tags = intent_tags - used_tags
    missing_categories = categories - used_categories
    if missing_tags:
        errors.append(f"seven-intent coverage incomplete: {sorted(missing_tags)}")
    if missing_categories:
        errors.append(f"five-entry reference coverage incomplete: {sorted(missing_categories)}")
    coverage = payload.get("coverage") or {}
    expected_tag_counts = {tag: 0 for tag in intent_tags}
    expected_category_counts = {category: 0 for category in categories}
    for question in questions:
        if not isinstance(question, dict):
            continue
        primary = question.get("primary_intent_tag")
        category = question.get("entry_category")
        if primary in expected_tag_counts:
            expected_tag_counts[primary] += 1
        if category in expected_category_counts:
            expected_category_counts[category] += 1
    if coverage.get("primary_intent_tag_counts") != expected_tag_counts:
        errors.append("coverage.primary_intent_tag_counts does not match questions")
    if coverage.get("entry_category_counts") != expected_category_counts:
        errors.append("coverage.entry_category_counts does not match questions")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate S7 question and FAQ reference library")
    parser.add_argument("question_library")
    parser.add_argument("--pattern-registry", required=True)
    parser.add_argument("--knowledge-registry")
    parser.add_argument("--source-registry")
    parser.add_argument("--claim-registry")
    parser.add_argument("--architecture")
    args = parser.parse_args()
    payload = load(args.question_library)
    registry = load(args.pattern_registry)
    knowledge_ids = known_ids(load(args.knowledge_registry), {"knowledge_id"}) if args.knowledge_registry else None
    source_ids = known_ids(load(args.source_registry), {"source_id"}) if args.source_registry else None
    claim_ids = known_ids(load(args.claim_registry), {"claim_id"}) if args.claim_registry else None
    architecture = load(args.architecture) if args.architecture else None
    context_ids = known_ids(architecture, {"context_id"}) if architecture else None
    proof_ids = known_ids(architecture, {"proof_id"}) if architecture else None
    warnings = validate(payload, registry, knowledge_ids, source_ids, claim_ids, context_ids, proof_ids)
    errors = [] if isinstance(payload, dict) else ["question library root must be an object"]
    print(json.dumps({
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "question_count": len(payload.get("questions") or []) if isinstance(payload, dict) else 0,
        "question_library_optional": True,
    }, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
