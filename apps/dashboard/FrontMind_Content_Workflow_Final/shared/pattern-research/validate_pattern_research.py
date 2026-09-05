#!/usr/bin/env python3
"""Validate the FrontMind pattern research library without network access."""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

EXPECTED_PATTERNS = [f"P{index:02d}" for index in range(1, 17)]
MINIMUMS = {pattern_id: (12 if pattern_id in {"P01", "P02", "P14"} else 8)
            for pattern_id in EXPECTED_PATTERNS}
SOURCE_CLASSES = {
    "government_or_intergovernmental",
    "standards_or_nonprofit",
    "vendor_documentation",
    "consumer_editorial",
    "professional_guidance",
    "university_guidance",
    "peer_reviewed_research",
    "academic_preprint",
    "github_repository",
}
BENCHMARK_ARRAY_FIELDS = {
    "structure_observation",
    "subquestions_observed",
    "evidence_positions_observed",
    "visual_observation",
    "strengths",
    "weaknesses",
    "do_not_copy",
}
EDITORIAL_ARRAY_FIELDS = {
    "trigger_conditions",
    "fixed_structure",
    "optional_modules",
    "required_evidence",
    "evidence_downgrade_rules",
    "typical_subquestions",
    "reader_objections",
    "title_formulas",
    "visual_recipe",
    "forbidden_behaviors",
    # v2.3 compatibility aliases used by older E4 readers.
    "recommended_structure",
    "required_subquestions",
    "evidence_placement_rules",
    "visual_roles",
    "faq_topics",
    "quality_gates",
    "anti_patterns",
}
EDITORIAL_TEXT_FIELDS = {
    "template_version",
    "core_question",
    "natural_brand_entry",
    "failure_example",
}
EDITORIAL_FIELDS = EDITORIAL_ARRAY_FIELDS | EDITORIAL_TEXT_FIELDS
FIXED_STRUCTURE_FIELDS = {"component_id", "editorial_job", "reader_takeaway"}
OPTIONAL_MODULE_FIELDS = {
    "module_id", "use_when", "editorial_job", "evidence_requirement",
}
DOWNGRADE_FIELDS = {"missing_condition", "editorial_action"}
VISUAL_RECIPE_FIELDS = {"role", "use_when", "source_policy"}
VISUAL_ROLES = {"brand_editorial", "navigate", "explain", "prove"}
BENCHMARK_FIELDS = {
    "benchmark_id", "title", "url", "domain", "source_class", "accessed_at",
    "access_evidence", "semantic_focus", "structure_observation",
    "subquestions_observed", "evidence_positions_observed", "visual_observation",
    "faq_observation", "strengths", "weaknesses", "do_not_copy",
    "selection_rationale", "research_note",
}
COMPONENT_ROLES = {
    "lead", "context", "evaluation", "evidence", "explanation", "process",
    "comparison", "limitations", "faq", "conclusion",
}
COMPONENT_FIELDS = {
    "component_id", "component_role", "required", "order_band",
    "evidence_requirement", "allowed_merge_targets",
}
CLASSIFICATION_FIELDS = {
    "positive_intent_signals", "typical_structure_signals",
    "required_structure_component_ids", "exclusion_signals",
    "confusable_patterns", "eligible_content_forms",
}
ARTICLE_CONTENT_FORMS = {
    "editorial_article", "brand_feature", "news_article", "comparison_review",
    "tutorial_documentation", "case_study", "research_pdf", "official_longform",
}
MANUAL_SEMANTIC_PATTERNS = set(EXPECTED_PATTERNS)
MANUAL_REVIEW_FIELDS = BENCHMARK_ARRAY_FIELDS | {
    "faq_observation", "selection_rationale", "research_note",
}
GENERATED_REVIEW_FRAGMENTS = {
    "该页围绕",
    "可迁移到“",
    "补足前后关系",
    "有关的判断应紧邻来源、时间或方法",
    "运行时只提取结构动作和读者问题",
    "对P模式价值",
    "未保存网页正文、长引文或原始视觉",
}
TRACKING_KEYS = {"ref", "source", "click", "msockid", "abtest"}
LONG_QUOTE = re.compile(r"[“\"]([^”\"]{160,})[”\"]")


def _nonempty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _check_text_array(value: Any, label: str, errors: list[str], minimum: int = 1) -> None:
    if not isinstance(value, list) or len(value) < minimum:
        errors.append(f"{label}: expected at least {minimum} items")
        return
    for index, item in enumerate(value):
        if not _nonempty_text(item):
            errors.append(f"{label}[{index}]: expected non-empty text")


def _canonical_url(raw: Any, label: str, errors: list[str]) -> tuple[str, str] | None:
    if not _nonempty_text(raw):
        errors.append(f"{label}: missing URL")
        return None
    parts = urlsplit(raw)
    if parts.scheme != "https":
        errors.append(f"{label}: only https URLs are allowed")
    if not parts.hostname:
        errors.append(f"{label}: hostname is missing")
        return None
    if parts.username or parts.password or parts.port:
        errors.append(f"{label}: credentials and explicit ports are forbidden")
    hostname = parts.hostname.lower().rstrip(".")
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".local"):
        errors.append(f"{label}: local host is forbidden")
    try:
        if ipaddress.ip_address(hostname).is_private:
            errors.append(f"{label}: private IP is forbidden")
    except ValueError:
        pass
    if parts.fragment:
        errors.append(f"{label}: fragments are forbidden; cite the stable page URL")
    for key, _ in parse_qsl(parts.query, keep_blank_values=True):
        if key.lower().startswith("utm_") or key.lower().startswith("hubs_") or key.lower() in TRACKING_KEYS:
            errors.append(f"{label}: tracking parameter {key!r} is forbidden")
    canonical = raw.rstrip("/")
    return canonical, hostname


def _walk_forbidden_quotes(value: Any, label: str, errors: list[str]) -> None:
    if isinstance(value, dict):
        if "quote" in value or "verbatim_quote" in value:
            errors.append(f"{label}: verbatim quote fields are forbidden")
        for key, item in value.items():
            _walk_forbidden_quotes(item, f"{label}.{key}", errors)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _walk_forbidden_quotes(item, f"{label}[{index}]", errors)
    elif isinstance(value, str) and LONG_QUOTE.search(value):
        errors.append(f"{label}: possible long verbatim quotation (160+ chars)")


def _validate_editorial_template(
    value: Any,
    pattern_id: str,
    component_ids: list[str],
    canonical_required_evidence: Any,
    label: str,
    errors: list[str],
) -> None:
    """Validate the E4-consumable v2.3 editorial template."""
    if not isinstance(value, dict):
        errors.append(f"{label}: expected object")
        return
    if set(value) != EDITORIAL_FIELDS:
        errors.append(f"{label}: fields must be exactly {sorted(EDITORIAL_FIELDS)}")
    if value.get("template_version") != "2.3.0":
        errors.append(f"{label}.template_version: expected 2.3.0")
    for field in ("core_question", "natural_brand_entry", "failure_example"):
        if not _nonempty_text(value.get(field)):
            errors.append(f"{label}.{field}: missing")
    for field in EDITORIAL_ARRAY_FIELDS:
        minimum = 3 if field in {
            "typical_subquestions", "reader_objections", "title_formulas",
            "visual_recipe", "forbidden_behaviors",
        } else 2
        candidate = value.get(field)
        if not isinstance(candidate, list) or len(candidate) < minimum:
            errors.append(f"{label}.{field}: expected at least {minimum} items")

    fixed = value.get("fixed_structure")
    if isinstance(fixed, list):
        seen: list[str] = []
        for index, item in enumerate(fixed):
            item_label = f"{label}.fixed_structure[{index}]"
            if not isinstance(item, dict) or set(item) != FIXED_STRUCTURE_FIELDS:
                errors.append(f"{item_label}: invalid fields")
                continue
            component_id = item.get("component_id")
            seen.append(str(component_id))
            if component_id not in component_ids:
                errors.append(f"{item_label}.component_id: unknown {component_id!r}")
            for field in ("editorial_job", "reader_takeaway"):
                if not _nonempty_text(item.get(field)):
                    errors.append(f"{item_label}.{field}: missing")
        if seen != component_ids:
            errors.append(f"{label}.fixed_structure: must follow canonical component order")

    optional_ids: set[str] = set()
    for index, item in enumerate(value.get("optional_modules", [])):
        item_label = f"{label}.optional_modules[{index}]"
        if not isinstance(item, dict) or set(item) != OPTIONAL_MODULE_FIELDS:
            errors.append(f"{item_label}: invalid fields")
            continue
        module_id = item.get("module_id")
        if not isinstance(module_id, str) or not module_id.startswith(f"{pattern_id}_optional_"):
            errors.append(f"{item_label}.module_id: invalid {module_id!r}")
        elif module_id in optional_ids:
            errors.append(f"{item_label}.module_id: duplicate {module_id}")
        optional_ids.add(str(module_id))
        for field in OPTIONAL_MODULE_FIELDS - {"module_id"}:
            if not _nonempty_text(item.get(field)):
                errors.append(f"{item_label}.{field}: missing")

    for index, item in enumerate(value.get("evidence_downgrade_rules", [])):
        item_label = f"{label}.evidence_downgrade_rules[{index}]"
        if not isinstance(item, dict) or set(item) != DOWNGRADE_FIELDS:
            errors.append(f"{item_label}: invalid fields")
            continue
        for field in DOWNGRADE_FIELDS:
            if not _nonempty_text(item.get(field)):
                errors.append(f"{item_label}.{field}: missing")

    for index, item in enumerate(value.get("visual_recipe", [])):
        item_label = f"{label}.visual_recipe[{index}]"
        if not isinstance(item, dict) or set(item) != VISUAL_RECIPE_FIELDS:
            errors.append(f"{item_label}: invalid fields")
            continue
        if item.get("role") not in VISUAL_ROLES:
            errors.append(f"{item_label}.role: unsupported {item.get('role')!r}")
        for field in VISUAL_RECIPE_FIELDS - {"role"}:
            if not _nonempty_text(item.get(field)):
                errors.append(f"{item_label}.{field}: missing")

    for field in (
        "trigger_conditions", "required_evidence", "typical_subquestions",
        "reader_objections", "title_formulas", "forbidden_behaviors",
        "recommended_structure", "required_subquestions", "evidence_placement_rules",
        "visual_roles", "faq_topics", "quality_gates", "anti_patterns",
    ):
        if isinstance(value.get(field), list):
            _check_text_array(value[field], f"{label}.{field}", errors)
    if value.get("required_evidence") != canonical_required_evidence:
        errors.append(f"{label}.required_evidence: must mirror canonical required_evidence")
    if value.get("required_subquestions") != value.get("typical_subquestions"):
        errors.append(f"{label}.required_subquestions: must mirror typical_subquestions")
    expected_structure = [item.get("editorial_job") for item in fixed or [] if isinstance(item, dict)]
    if value.get("recommended_structure") != expected_structure:
        errors.append(f"{label}.recommended_structure: must mirror fixed_structure")


def validate_index(index_path: Path, dossier_root: Path | None = None, require_dossiers: bool = True) -> list[str]:
    errors: list[str] = []
    dossier_root = dossier_root or index_path.parent
    try:
        data = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"{index_path}: cannot read valid JSON: {exc}"]

    if data.get("schema_version") != "2.3.0":
        errors.append("root.schema_version: expected 2.3.0")
    if data.get("authority") != "research_reference_only":
        errors.append("root.authority: must remain research_reference_only")
    if data.get("canonical_runtime_authority") != "../content-pattern-registry.json":
        errors.append("root.canonical_runtime_authority: unexpected runtime authority")
    registry_path = (index_path.parent / str(data.get("canonical_runtime_authority", ""))).resolve()
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return errors + [f"root.canonical_runtime_authority: cannot read registry: {exc}"]
    if registry.get("schema_version") != "2.3.0":
        errors.append("root.canonical_runtime_authority: registry must be v2.3.0")
    registry_patterns = {
        item.get("id"): item for item in registry.get("patterns", []) if isinstance(item, dict)
    }
    try:
        date.fromisoformat(data.get("accessed_at", ""))
    except (TypeError, ValueError):
        errors.append("root.accessed_at: expected ISO date")
    try:
        date.fromisoformat(data.get("semantic_reviewed_at", ""))
    except (TypeError, ValueError):
        errors.append("root.semantic_reviewed_at: expected ISO date")
    if data.get("required_pattern_ids") != EXPECTED_PATTERNS:
        errors.append("root.required_pattern_ids: exact ordered pattern set required")

    patterns = data.get("patterns")
    if not isinstance(patterns, list):
        return errors + ["root.patterns: expected array"]
    ids = [item.get("pattern_id") for item in patterns if isinstance(item, dict)]
    if ids != EXPECTED_PATTERNS:
        errors.append(f"root.patterns: expected exact order {EXPECTED_PATTERNS}, got {ids}")

    seen_urls: dict[str, str] = {}
    seen_domains: set[str] = set()
    seen_ids: set[str] = set()

    for p_index, pattern in enumerate(patterns):
        label = f"patterns[{p_index}]"
        if not isinstance(pattern, dict):
            errors.append(f"{label}: expected object")
            continue
        pattern_id = pattern.get("pattern_id")
        if pattern_id not in MINIMUMS:
            errors.append(f"{label}.pattern_id: unknown value {pattern_id!r}")
            continue
        if pattern.get("canonical_pattern_id") != pattern_id:
            errors.append(f"{label}.canonical_pattern_id: expected {pattern_id}")
        if pattern.get("minimum_benchmarks") != MINIMUMS[pattern_id]:
            errors.append(f"{label}.minimum_benchmarks: expected {MINIMUMS[pattern_id]}")
        if not _nonempty_text(pattern.get("pattern_name")):
            errors.append(f"{label}.pattern_name: missing")
        if not _nonempty_text(pattern.get("research_scope")):
            errors.append(f"{label}.research_scope: missing")

        components = pattern.get("structure_components")
        component_ids: set[str] = set()
        required_component_ids: set[str] = set()
        if not isinstance(components, list) or not components:
            errors.append(f"{label}.structure_components: expected non-empty array")
        else:
            for c_index, component in enumerate(components):
                c_label = f"{label}.structure_components[{c_index}]"
                if not isinstance(component, dict):
                    errors.append(f"{c_label}: expected object")
                    continue
                if set(component) != COMPONENT_FIELDS:
                    errors.append(f"{c_label}: fields must be exactly {sorted(COMPONENT_FIELDS)}")
                component_id = component.get("component_id")
                if not isinstance(component_id, str) or not component_id.startswith(f"{pattern_id}_component_"):
                    errors.append(f"{c_label}.component_id: must use {pattern_id}_component_ prefix")
                elif component_id in component_ids:
                    errors.append(f"{c_label}.component_id: duplicate {component_id}")
                else:
                    component_ids.add(component_id)
                if component.get("component_role") not in COMPONENT_ROLES:
                    errors.append(f"{c_label}.component_role: unsupported")
                if not isinstance(component.get("required"), bool):
                    errors.append(f"{c_label}.required: expected boolean")
                elif component["required"]:
                    required_component_ids.add(str(component_id))
                if not isinstance(component.get("order_band"), int) or component["order_band"] < 1:
                    errors.append(f"{c_label}.order_band: expected positive integer")
                if not _nonempty_text(component.get("evidence_requirement")):
                    errors.append(f"{c_label}.evidence_requirement: missing")
                if not isinstance(component.get("allowed_merge_targets"), list):
                    errors.append(f"{c_label}.allowed_merge_targets: expected array")
            for c_index, component in enumerate(components):
                if not isinstance(component, dict):
                    continue
                for target in component.get("allowed_merge_targets", []):
                    if target not in component_ids:
                        errors.append(f"{label}.structure_components[{c_index}].allowed_merge_targets: unknown {target!r}")

        classification = pattern.get("classification_contract")
        if not isinstance(classification, dict):
            errors.append(f"{label}.classification_contract: expected object")
        else:
            if set(classification) != CLASSIFICATION_FIELDS:
                errors.append(f"{label}.classification_contract: fields must be exactly {sorted(CLASSIFICATION_FIELDS)}")
            for field in ("positive_intent_signals", "typical_structure_signals", "exclusion_signals", "confusable_patterns", "eligible_content_forms"):
                if not isinstance(classification.get(field), list) or not classification[field]:
                    errors.append(f"{label}.classification_contract.{field}: expected non-empty array")
            declared_required = classification.get("required_structure_component_ids")
            if set(declared_required or []) != required_component_ids:
                errors.append(f"{label}.classification_contract.required_structure_component_ids: must equal required components")
            for item in classification.get("typical_structure_signals", []):
                if not isinstance(item, dict) or item.get("component_id") not in component_ids:
                    errors.append(f"{label}.classification_contract.typical_structure_signals: unknown component")
                elif set(item) != {"component_id", "cues"}:
                    errors.append(f"{label}.classification_contract.typical_structure_signals: invalid fields")
                else:
                    _check_text_array(item.get("cues"), f"{label}.classification_contract.typical_structure_signals.cues", errors)
            seen_signal_ids: set[str] = set()
            for group, prefix in (("positive_intent_signals", "intent"), ("exclusion_signals", "exclude")):
                for item in classification.get(group, []):
                    if not isinstance(item, dict) or set(item) != {"signal_id", "cues"}:
                        errors.append(f"{label}.classification_contract.{group}: invalid signal object")
                        continue
                    signal_id = item.get("signal_id")
                    if not isinstance(signal_id, str) or not signal_id.startswith(f"{pattern_id}_{prefix}_"):
                        errors.append(f"{label}.classification_contract.{group}: invalid signal_id {signal_id!r}")
                    elif signal_id in seen_signal_ids:
                        errors.append(f"{label}.classification_contract: duplicate signal_id {signal_id}")
                    seen_signal_ids.add(str(signal_id))
                    _check_text_array(item.get("cues"), f"{label}.classification_contract.{group}.{signal_id}.cues", errors)
            seen_confusable: set[str] = set()
            for item in classification.get("confusable_patterns", []):
                if not isinstance(item, dict) or set(item) != {"pattern_id", "decision_rule"}:
                    errors.append(f"{label}.classification_contract.confusable_patterns: invalid object")
                    continue
                adjacent = item.get("pattern_id")
                if adjacent not in EXPECTED_PATTERNS or adjacent == pattern_id or adjacent in seen_confusable:
                    errors.append(f"{label}.classification_contract.confusable_patterns: invalid/duplicate {adjacent!r}")
                seen_confusable.add(str(adjacent))
                if not _nonempty_text(item.get("decision_rule")):
                    errors.append(f"{label}.classification_contract.confusable_patterns: decision_rule missing")
            if not set(classification.get("eligible_content_forms", [])) <= ARTICLE_CONTENT_FORMS:
                errors.append(f"{label}.classification_contract.eligible_content_forms: unsupported form")
        canonical_pattern = registry_patterns.get(pattern_id, {})
        if pattern.get("structure_components") != canonical_pattern.get("structure_components"):
            errors.append(f"{label}.structure_components: must exactly mirror canonical Registry")
        if pattern.get("classification_contract") != canonical_pattern.get("classification_contract"):
            errors.append(f"{label}.classification_contract: must exactly mirror canonical Registry")
        if pattern.get("template_version") != "2.3.0":
            errors.append(f"{label}.template_version: expected 2.3.0")
        if canonical_pattern.get("template_version") != "2.3.0":
            errors.append(f"{label}: canonical Registry template_version must be 2.3.0")
        component_order = [
            item.get("component_id") for item in components or []
            if isinstance(item, dict) and item.get("required") is True
        ]
        _validate_editorial_template(
            pattern.get("design_contract"),
            pattern_id,
            component_order,
            canonical_pattern.get("required_evidence"),
            f"{label}.design_contract",
            errors,
        )
        if pattern.get("design_contract") != canonical_pattern.get("editorial_template"):
            errors.append(f"{label}.design_contract: must exactly mirror canonical editorial_template")

        dossier_path = pattern.get("dossier_path")
        if dossier_path != f"{pattern_id}.md":
            errors.append(f"{label}.dossier_path: expected {pattern_id}.md")
        dossier_text = ""
        if require_dossiers:
            dossier = dossier_root / str(dossier_path)
            try:
                dossier_text = dossier.read_text(encoding="utf-8")
            except OSError as exc:
                errors.append(f"{label}.dossier_path: cannot read {dossier}: {exc}")

        benchmarks = pattern.get("benchmarks")
        if not isinstance(benchmarks, list):
            errors.append(f"{label}.benchmarks: expected array")
            continue
        if len(benchmarks) < MINIMUMS[pattern_id]:
            errors.append(
                f"{label}.benchmarks: {len(benchmarks)} is below minimum {MINIMUMS[pattern_id]}"
            )

        actual_classes: set[str] = set()
        seen_semantic_focus: set[str] = set()
        seen_semantic_arrays: dict[str, str] = {}
        seen_manual_fields: dict[str, dict[str, str]] = {
            field: {} for field in MANUAL_REVIEW_FIELDS
        }
        for b_index, benchmark in enumerate(benchmarks):
            b_label = f"{label}.benchmarks[{b_index}]"
            if not isinstance(benchmark, dict):
                errors.append(f"{b_label}: expected object")
                continue
            if set(benchmark) != BENCHMARK_FIELDS:
                errors.append(f"{b_label}: fields must be exactly {sorted(BENCHMARK_FIELDS)}")
            expected_id = f"{pattern_id}-B{b_index + 1:02d}"
            benchmark_id = benchmark.get("benchmark_id")
            if benchmark_id != expected_id:
                errors.append(f"{b_label}.benchmark_id: expected {expected_id}")
            if benchmark_id in seen_ids:
                errors.append(f"{b_label}.benchmark_id: duplicate {benchmark_id}")
            seen_ids.add(str(benchmark_id))
            if not _nonempty_text(benchmark.get("title")):
                errors.append(f"{b_label}.title: missing")
            parsed = _canonical_url(benchmark.get("url"), f"{b_label}.url", errors)
            if parsed:
                canonical, hostname = parsed
                prior = seen_urls.get(canonical)
                if prior:
                    errors.append(f"{b_label}.url: duplicate of {prior}: {canonical}")
                else:
                    seen_urls[canonical] = benchmark_id
                if benchmark.get("domain") != hostname.removeprefix("www."):
                    errors.append(f"{b_label}.domain: expected {hostname.removeprefix('www.')}")
                seen_domains.add(hostname.removeprefix("www."))
            source_class = benchmark.get("source_class")
            if source_class not in SOURCE_CLASSES:
                errors.append(f"{b_label}.source_class: unsupported {source_class!r}")
            else:
                actual_classes.add(source_class)
            try:
                date.fromisoformat(benchmark.get("accessed_at", ""))
            except (TypeError, ValueError):
                errors.append(f"{b_label}.accessed_at: expected ISO date")
            access = benchmark.get("access_evidence")
            if not isinstance(access, dict):
                errors.append(f"{b_label}.access_evidence: expected object")
            else:
                if access.get("verified_via") not in {"web_search_result", "page_open"}:
                    errors.append(f"{b_label}.access_evidence.verified_via: unsupported")
                if access.get("status") not in {"indexed_and_metadata_reviewed", "page_opened"}:
                    errors.append(f"{b_label}.access_evidence.status: unsupported")
                try:
                    date.fromisoformat(access.get("checked_at", ""))
                except (TypeError, ValueError):
                    errors.append(f"{b_label}.access_evidence.checked_at: expected ISO date")
            for field in BENCHMARK_ARRAY_FIELDS:
                _check_text_array(benchmark.get(field), f"{b_label}.{field}", errors, 2)
            for field in (
                "semantic_focus", "faq_observation", "selection_rationale", "research_note",
            ):
                if not _nonempty_text(benchmark.get(field)):
                    errors.append(f"{b_label}.{field}: missing")
            semantic_focus = str(benchmark.get("semantic_focus", "")).strip()
            if semantic_focus in seen_semantic_focus:
                errors.append(f"{b_label}.semantic_focus: duplicate within {pattern_id}")
            seen_semantic_focus.add(semantic_focus)
            semantic_signature = json.dumps(
                {
                    field: benchmark.get(field)
                    for field in (
                        "structure_observation", "subquestions_observed",
                        "strengths", "weaknesses",
                    )
                },
                ensure_ascii=False,
                sort_keys=True,
            )
            prior_signature = seen_semantic_arrays.get(semantic_signature)
            if prior_signature:
                errors.append(
                    f"{b_label}: semantic observations duplicate {prior_signature}; "
                    "benchmark-specific review required"
                )
            seen_semantic_arrays[semantic_signature] = str(benchmark_id)
            if dossier_text and (
                str(benchmark_id) not in dossier_text or str(benchmark.get("url")) not in dossier_text
            ):
                errors.append(f"{b_label}: dossier must contain benchmark id and exact URL")
            if pattern_id in MANUAL_SEMANTIC_PATTERNS:
                research_note = str(benchmark.get("research_note", ""))
                if not research_note.startswith("2026-08-17 逐页复审："):
                    errors.append(
                        f"{b_label}.research_note: priority benchmark requires human page-review marker"
                    )
                for field in MANUAL_REVIEW_FIELDS:
                    value = benchmark.get(field)
                    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True)
                    prior = seen_manual_fields[field].get(serialized)
                    if prior:
                        errors.append(
                            f"{b_label}.{field}: duplicates {prior}; priority review must be page-specific"
                        )
                    seen_manual_fields[field][serialized] = str(benchmark_id)
                    for fragment in GENERATED_REVIEW_FRAGMENTS:
                        if fragment in serialized:
                            errors.append(
                                f"{b_label}.{field}: generated review boilerplate is forbidden: {fragment}"
                            )
                    if dossier_text:
                        values = value if isinstance(value, list) else [value]
                        for item in values:
                            if isinstance(item, str) and item not in dossier_text:
                                errors.append(
                                    f"{b_label}.{field}: dossier must mirror the complete manual review"
                                )

        if len(actual_classes) < 3:
            errors.append(f"{label}.benchmarks: need >=3 source classes, got {sorted(actual_classes)}")
        summary = pattern.get("source_class_summary")
        if summary != sorted(actual_classes):
            errors.append(f"{label}.source_class_summary: must equal sorted actual classes")

    if len(seen_urls) < sum(MINIMUMS.values()):
        errors.append(
            f"root: only {len(seen_urls)} globally unique URLs; expected at least {sum(MINIMUMS.values())}"
        )
    actual_statistics = {
        "dossier_count": len(patterns),
        "benchmark_count": sum(
            len(pattern.get("benchmarks", []))
            for pattern in patterns
            if isinstance(pattern, dict) and isinstance(pattern.get("benchmarks"), list)
        ),
        "unique_url_count": len(seen_urls),
        "unique_domain_count": len(seen_domains),
    }
    if data.get("statistics") != actual_statistics:
        errors.append(
            f"root.statistics: expected computed values {actual_statistics}, "
            f"got {data.get('statistics')!r}"
        )
    _walk_forbidden_quotes(data, "root", errors)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "index",
        nargs="?",
        type=Path,
        default=Path(__file__).with_name("index.json"),
    )
    parser.add_argument("--dossier-root", type=Path)
    parser.add_argument("--index-only", action="store_true", help="validate the complete machine index without requiring Markdown dossiers")
    args = parser.parse_args()
    errors = validate_index(args.index.resolve(), args.dossier_root, require_dossiers=not args.index_only)
    if errors:
        print(f"FAIL: {len(errors)} validation error(s)", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    data = json.loads(args.index.read_text(encoding="utf-8"))
    count = sum(len(pattern["benchmarks"]) for pattern in data["patterns"])
    print(
        f"PASS: {len(data['patterns'])} dossiers, {count} globally unique benchmarks, "
        "all quotas/fields/URLs/source-diversity checks satisfied"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
