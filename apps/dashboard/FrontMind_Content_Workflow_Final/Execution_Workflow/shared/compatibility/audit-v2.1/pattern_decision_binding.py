#!/usr/bin/env python3
"""Physical file bindings layered on canonical v2.1 pattern-decision semantics."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Any

ROOT_SHARED = Path(__file__).resolve().parents[2] / "shared"
if str(ROOT_SHARED) not in sys.path:
    sys.path.insert(0, str(ROOT_SHARED))

from pattern_decision import (  # noqa: E402
    validate_blueprint_fusion,
    validate_e2_pattern_analysis,
    validate_e4_pattern_decision,
)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _relative_to(root: Path, path: Path) -> str | None:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


def _resolve_inside(root: Path, stored: Any) -> Path | None:
    raw = str(stored or "")
    value = Path(raw)
    if not raw or value.is_absolute() or ".." in value.parts or "\\" in raw:
        return None
    resolved = (root / value).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return None
    return resolved


def _ref_errors(ref: Any, path: Path, package_root: Path, label: str) -> list[str]:
    if not isinstance(ref, dict):
        return [f"{label} must be a fileRef"]
    errors: list[str] = []
    stored = _relative_to(package_root, path)
    if stored is None or ref.get("path") != stored:
        errors.append(f"{label}.path does not resolve to the supplied file inside job root")
    if not path.is_file() or ref.get("sha256") != file_sha256(path):
        errors.append(f"{label}.sha256 does not bind the supplied file bytes")
    return errors


def _research_pattern_ids(index: dict[str, Any]) -> set[str]:
    return {
        str(item.get("canonical_pattern_id") or item.get("pattern_id"))
        for item in index.get("patterns", []) if isinstance(item, dict)
    }


def validate_pattern_decision(
    *, decision: dict[str, Any], content_job: dict[str, Any],
    analysis: dict[str, Any] | None, analysis_path: Path | None,
    registry: dict[str, Any], registry_path: Path,
    research_index: dict[str, Any], research_index_path: Path,
    package_root: Path,
) -> list[str]:
    """Run root semantics, then prove every referenced artifact physically."""

    errors: list[str] = []
    if analysis is not None:
        errors.extend(
            f"E2 semantic authority: {message}"
            for message in validate_e2_pattern_analysis(analysis, registry)
        )
    errors.extend(validate_e4_pattern_decision(
        decision, registry, analysis,
        e2_analysis_sha256=file_sha256(analysis_path) if analysis_path else None,
    ))
    entry = content_job.get("entry_category")
    task = content_job.get("task") if isinstance(content_job.get("task"), dict) else {}
    if decision.get("job_id") != content_job.get("job_id"):
        errors.append("pattern decision job_id differs from Content Job")
    if decision.get("entry_category") != entry:
        errors.append("pattern decision entry_category differs from Content Job")
    if decision.get("product_scenario_subintent") != task.get("product_scenario_subintent"):
        errors.append("pattern decision product_scenario_subintent differs from Content Job")
    errors.extend(_ref_errors(
        decision.get("pattern_registry_ref"), registry_path, package_root, "pattern_registry_ref",
    ))
    errors.extend(_ref_errors(
        decision.get("pattern_research_index_ref"), research_index_path, package_root,
        "pattern_research_index_ref",
    ))
    selected = str(decision.get("selected_pattern_id") or "")
    if selected not in _research_pattern_ids(research_index):
        errors.append("selected_pattern_id has no signed pattern-research entry")

    if entry == "foundation_start":
        if analysis is not None or analysis_path is not None:
            errors.append("foundation_start must not consume an E2 pattern analysis")
        return errors
    if analysis is None or analysis_path is None:
        return [*errors, "ordinary entries require E2 pattern analysis"]
    if _relative_to(package_root, analysis_path) != content_job.get("e2_pattern_analysis_path"):
        errors.append("supplied E2 analysis path differs from Content Job e2_pattern_analysis_path")
    errors.extend(_ref_errors(
        decision.get("e2_pattern_analysis_ref"), analysis_path, package_root,
        "e2_pattern_analysis_ref",
    ))
    if analysis.get("question") != task.get("question_text"):
        errors.append("E2 pattern analysis question differs from Content Job")
    errors.extend(_ref_errors(
        analysis.get("pattern_registry_ref"), registry_path, package_root,
        "E2 pattern_registry_ref",
    ))
    errors.extend(_ref_errors(
        analysis.get("pattern_research_index_ref"), research_index_path, package_root,
        "E2 pattern_research_index_ref",
    ))
    observations = {
        str(item.get("observation_id")): item
        for item in analysis.get("content_observations", []) if isinstance(item, dict)
    }
    for observation_id in decision.get("selected_benchmark_observation_ids", []):
        observation = observations.get(str(observation_id), {})
        receipt = observation.get("retrieval_receipt") if isinstance(observation.get("retrieval_receipt"), dict) else {}
        classification = observation.get("classification") if isinstance(observation.get("classification"), dict) else {}
        snapshot = _resolve_inside(package_root, receipt.get("snapshot_relative_path"))
        if snapshot is None or not snapshot.is_file() or file_sha256(snapshot) != receipt.get("snapshot_sha256"):
            errors.append(f"selected benchmark snapshot is missing, unsafe or changed: {observation_id}")
        if classification.get("snapshot_sha256") != receipt.get("snapshot_sha256"):
            errors.append(f"selected benchmark classification is not bound to its snapshot: {observation_id}")
        if classification.get("registry_sha256") != file_sha256(registry_path):
            errors.append(f"selected benchmark classification is not bound to signed Registry: {observation_id}")
    return errors


def validate_blueprint_decision_handoff(
    *, blueprint: dict[str, Any], decision: dict[str, Any], decision_path: Path,
    package_root: Path,
) -> list[str]:
    errors = _ref_errors(
        blueprint.get("pattern_decision_ref"), decision_path, package_root,
        "blueprint.pattern_decision_ref",
    )
    for blueprint_field, decision_field in (
        ("job_id", "job_id"), ("entry_category", "entry_category"),
        ("product_scenario_subintent", "product_scenario_subintent"),
        ("pattern_id", "selected_pattern_id"),
    ):
        if blueprint.get(blueprint_field) != decision.get(decision_field):
            errors.append(f"blueprint {blueprint_field} differs from E4 decision {decision_field}")
    selected = set(decision.get("selected_benchmark_observation_ids") or [])
    fusion = blueprint.get("benchmark_fusion") if isinstance(blueprint.get("benchmark_fusion"), dict) else {}
    ids = [
        str(item.get("observation_id")) for item in fusion.get("benchmark_decisions", [])
        if isinstance(item, dict)
    ]
    if len(ids) != len(set(ids)) or set(ids) != selected:
        errors.append("blueprint benchmark decisions differ from E4 selected benchmark set")
    return errors


__all__ = [
    "file_sha256", "validate_blueprint_decision_handoff", "validate_blueprint_fusion",
    "validate_pattern_decision",
]
