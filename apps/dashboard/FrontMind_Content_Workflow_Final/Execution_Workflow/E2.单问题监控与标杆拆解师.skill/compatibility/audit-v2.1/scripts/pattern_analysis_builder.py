#!/usr/bin/env python3
"""Validate imported page analysis and build the advisory E2 P01-P16 recommendation."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from e2_pattern_contract import (  # noqa: E402
    compute_e2_recommendation, file_sha256, load_object,
    resolve_artifact, validate_e2_relations,
)
from schema_validation import validate_root  # noqa: E402


PAGE_ANALYSIS_KEYS = {
    "schema_version", "job_id", "question", "classifier_version", "completed_at",
    "source_pool_sha256", "pattern_registry_sha256", "pattern_research_index_sha256",
    "content_observations",
}
REQUIRED_PAGE_ANALYSIS_KEYS = PAGE_ANALYSIS_KEYS - {"completed_at"}
OBSERVATION_DRAFT_KEYS = {
    "observation_id", "raw_rank", "canonical_url", "status", "review_status", "content_form",
    "retrieval_receipt", "classification",
}
PAGE_REVIEW_RECEIPT_KEYS = {
    "schema_version", "job_id", "review_id", "reviewer", "reviewer_role", "reviewed_at",
    "automatic_page_analysis_ref", "review_input_ref", "reviewed_page_analysis_ref",
    "decisions", "attestation",
}


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise FileExistsError(f"refusing to overwrite E2 pattern analysis: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def relative_inside(root: Path, path: Path, label: str) -> str:
    root = root.resolve()
    resolved = path.resolve()
    try:
        return resolved.relative_to(root).as_posix()
    except ValueError as exc:
        raise ValueError(f"{label} must be staged inside --package-root") from exc


def safe_http(url: str) -> bool:
    parsed = urlsplit(url)
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)



def _materialize_observations(
    drafts: list[Any], pool: list[dict[str, Any]], package_root: Path,
    registry_sha256: str, classifier_version: str,
) -> list[dict[str, Any]]:
    pool_by_rank = {int(item["raw_rank"]): item for item in pool}
    seen: set[int] = set()
    result: list[dict[str, Any]] = []
    canonical_first: dict[str, int] = {}
    for raw in drafts:
        if not isinstance(raw, dict):
            raise ValueError("page-analysis content_observations items must be objects")
        extras = set(raw) - OBSERVATION_DRAFT_KEYS
        required = {"raw_rank", "status", "review_status", "content_form", "retrieval_receipt", "classification"}
        if extras or required - set(raw):
            raise ValueError(f"page-analysis observation fields mismatch; missing={sorted(required-set(raw))}, extras={sorted(extras)}")
        rank = raw.get("raw_rank")
        if not isinstance(rank, int) or isinstance(rank, bool) or rank not in pool_by_rank or rank in seen:
            raise ValueError(f"page-analysis raw_rank is unknown or duplicated: {rank!r}")
        seen.add(rank)
        pool_item = pool_by_rank[rank]
        canonical = str(pool_item["canonical_url"])
        first_rank = canonical_first.setdefault(canonical, rank)
        status = raw.get("status")
        review_status = raw.get("review_status")
        if review_status not in {"machine_classified", "human_confirmed", "human_corrected"}:
            raise ValueError(f"rank {rank} has invalid observation review_status")
        if not safe_http(str(pool_item["original_url"])):
            status = "unsafe_url"
            review_status = "machine_classified"
        elif first_rank != rank:
            status = "duplicate_alias"
            review_status = "machine_classified"
        receipt = raw.get("retrieval_receipt")
        if not isinstance(receipt, dict):
            raise ValueError(f"rank {rank} retrieval_receipt must be an object")
        receipt = dict(receipt)
        receipt["original_url"] = pool_item["original_url"]
        for path_key, hash_key in (
            ("snapshot_relative_path", "snapshot_sha256"),
            ("extract_relative_path", "extract_sha256"),
        ):
            stored = receipt.get(path_key)
            if stored is None:
                receipt[hash_key] = None
                continue
            errors: list[str] = []
            artifact = resolve_artifact(package_root, stored, errors, f"rank {rank} {path_key}")
            if errors or artifact is None or not artifact.is_file():
                raise ValueError("; ".join(errors) or f"rank {rank} {path_key} is missing")
            receipt[hash_key] = file_sha256(artifact)
        classification = raw.get("classification")
        if status != "classified_article":
            classification = None
            if status in {"unsafe_url", "duplicate_alias"}:
                receipt.update({
                    "final_url": None, "redirect_chain": [], "http_status": None, "mime_type": None,
                    "accessed_at": None, "page_title": None, "extraction_status": "not_attempted",
                    "snapshot_relative_path": None, "snapshot_sha256": None,
                    "extract_relative_path": None, "extract_sha256": None,
                    "heading_summary": {"h1": [], "h2": [], "h3": []},
                    "failure_reason": "unsafe URL" if status == "unsafe_url" else f"canonical alias of raw rank {first_rank}",
                })
            content_form = raw.get("content_form") if status == "non_article" else None
        else:
            if not isinstance(classification, dict):
                raise ValueError(f"rank {rank} classified_article requires classification")
            classification = dict(classification)
            classification["snapshot_sha256"] = receipt.get("snapshot_sha256")
            classification["registry_sha256"] = registry_sha256
            classification["classifier_version"] = classifier_version
            content_form = raw.get("content_form")
            classification["content_form"] = content_form
            if classification.get("review_status") != review_status:
                raise ValueError(f"rank {rank} observation/classification review_status mismatch")
        result.append({
            "observation_id": f"obs_rank_{rank:02d}",
            "raw_rank": rank,
            "canonical_url": canonical,
            "status": status,
            "review_status": review_status,
            "content_form": content_form,
            "retrieval_receipt": receipt,
            "classification": classification,
        })
    if seen != set(pool_by_rank):
        raise ValueError(f"page-analysis must finalize every raw pool rank; missing={sorted(set(pool_by_rank)-seen)}")
    return sorted(result, key=lambda item: item["raw_rank"])


def _validate_human_review_receipt(
    receipt_path: Path | None, page_analysis_path: Path, page_analysis: dict[str, Any],
    package_root: Path,
) -> dict[str, str] | None:
    human_by_rank = {
        int(item["raw_rank"]): str(item.get("review_status"))
        for item in page_analysis.get("content_observations", []) if isinstance(item, dict)
        and item.get("review_status") in {"human_confirmed", "human_corrected"}
    }
    if not human_by_rank:
        if receipt_path is not None:
            raise ValueError("all-machine page analysis forbids --page-analysis-review-receipt")
        return None
    if receipt_path is None:
        raise ValueError("human-reviewed classifications require --page-analysis-review-receipt")
    receipt = load_object(receipt_path)
    if set(receipt) != PAGE_REVIEW_RECEIPT_KEYS:
        raise ValueError("page-analysis review receipt fields differ from the exact v2.1 contract")
    validate_root(receipt, "e2_human_review_receipt.schema.json", "E2 human review receipt")
    if receipt.get("job_id") != page_analysis.get("job_id"):
        raise ValueError("page-analysis review receipt job_id differs from page analysis")

    def resolve_ref(key: str) -> tuple[Path, dict[str, Any]]:
        ref = receipt.get(key)
        if not isinstance(ref, dict):
            raise ValueError(f"human review receipt {key} must be a fileRef")
        path_errors: list[str] = []
        artifact = resolve_artifact(package_root, ref.get("path"), path_errors, f"human review receipt {key}")
        if path_errors or artifact is None or not artifact.is_file() or file_sha256(artifact) != ref.get("sha256"):
            raise ValueError("; ".join(path_errors) or f"human review receipt {key} hash binding failed")
        return artifact, load_object(artifact)

    automatic_path, automatic = resolve_ref("automatic_page_analysis_ref")
    review_input_path, review_input = resolve_ref("review_input_ref")
    reviewed_path, reviewed = resolve_ref("reviewed_page_analysis_ref")
    if reviewed_path != page_analysis_path.resolve() or reviewed != page_analysis:
        raise ValueError("human review receipt does not bind the exact supplied reviewed page analysis")
    if automatic.get("job_id") != page_analysis.get("job_id") or review_input.get("job_id") != page_analysis.get("job_id"):
        raise ValueError("human review receipt references a different job")
    decisions = receipt.get("decisions")
    decision_by_observation = {
        str(item.get("observation_id")): item
        for item in decisions if isinstance(item, dict)
    } if isinstance(decisions, list) else {}
    expected_observation_ids = {f"obs_rank_{rank:02d}" for rank in human_by_rank}
    if set(decision_by_observation) != expected_observation_ids:
        raise ValueError("human review receipt decisions must exactly cover every human-reviewed classification")
    for rank, review_status in human_by_rank.items():
        decision = decision_by_observation[f"obs_rank_{rank:02d}"]
        expected_decision = "confirmed" if review_status == "human_confirmed" else "corrected"
        page_item = next(item for item in page_analysis["content_observations"] if item.get("raw_rank") == rank)
        final_pattern = (
            page_item.get("classification", {}).get("primary_pattern_id")
            if isinstance(page_item.get("classification"), dict) else None
        )
        if (
            decision.get("decision") != expected_decision
            or decision.get("final_review_status") != review_status
            or decision.get("final_pattern_id") != final_pattern
        ):
            raise ValueError(f"human review receipt action differs from observation review_status at rank {rank}")
    return {
        "path": relative_inside(package_root, receipt_path, "--page-analysis-review-receipt"),
        "sha256": file_sha256(receipt_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-pool", type=Path, required=True)
    parser.add_argument("--page-analysis", type=Path, required=True)
    parser.add_argument("--page-analysis-review-receipt", type=Path)
    parser.add_argument("--pattern-registry", type=Path, required=True)
    parser.add_argument("--pattern-research-index", type=Path, required=True)
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    package_root = args.package_root.resolve()
    for path, label in (
        (args.source_pool, "--source-pool"), (args.page_analysis, "--page-analysis"),
        (args.pattern_registry, "--pattern-registry"),
        (args.pattern_research_index, "--pattern-research-index"),
    ):
        if not path.is_file():
            raise FileNotFoundError(path)
        relative_inside(package_root, path, label)
    if args.page_analysis_review_receipt is not None:
        if not args.page_analysis_review_receipt.is_file():
            raise FileNotFoundError(args.page_analysis_review_receipt)
        relative_inside(package_root, args.page_analysis_review_receipt, "--page-analysis-review-receipt")
    output_relative = relative_inside(package_root, args.output.resolve(strict=False), "--output")
    source_pool = load_object(args.source_pool)
    expected_source_keys = {
        "schema_version", "artifact_type", "job_id", "question", "entry_category",
        "product_scenario_subintent", "created_at", "source_workbook_receipt", "pool_status",
        "cited_content_pool",
    }
    if set(source_pool) != expected_source_keys or source_pool.get("artifact_type") != "E2_dashboard_source_pool":
        raise ValueError("--source-pool is not the exact Dashboard adapter artifact")
    page_analysis = load_object(args.page_analysis)
    if REQUIRED_PAGE_ANALYSIS_KEYS - set(page_analysis) or set(page_analysis) - PAGE_ANALYSIS_KEYS:
        raise ValueError(
            f"page-analysis fields mismatch; missing={sorted(REQUIRED_PAGE_ANALYSIS_KEYS-set(page_analysis))}, "
            f"extras={sorted(set(page_analysis)-PAGE_ANALYSIS_KEYS)}"
        )
    if page_analysis.get("schema_version") != "2.1.0":
        raise ValueError("page-analysis schema_version must be 2.1.0")
    for key in ("job_id", "question", "classifier_version"):
        if page_analysis.get(key) != source_pool.get(key if key != "classifier_version" else "__absent__") and key != "classifier_version":
            raise ValueError(f"page-analysis {key} differs from source pool")
    if page_analysis.get("source_pool_sha256") != file_sha256(args.source_pool):
        raise ValueError("page-analysis source_pool_sha256 mismatch")
    registry_sha256 = file_sha256(args.pattern_registry)
    research_sha256 = file_sha256(args.pattern_research_index)
    if page_analysis.get("pattern_registry_sha256") != registry_sha256:
        raise ValueError("page-analysis pattern_registry_sha256 mismatch")
    if page_analysis.get("pattern_research_index_sha256") != research_sha256:
        raise ValueError("page-analysis pattern_research_index_sha256 mismatch")
    registry, research = load_object(args.pattern_registry), load_object(args.pattern_research_index)
    if registry.get("schema_version") != "2.1.0" or research.get("schema_version") != "2.1.0":
        raise ValueError("E2 requires signed registry and pattern research index schema_version=2.1.0")
    classifier_version = str(page_analysis.get("classifier_version") or "").strip()
    if not classifier_version:
        raise ValueError("page-analysis classifier_version is required")
    pool = source_pool["cited_content_pool"]
    drafts = page_analysis.get("content_observations")
    if not isinstance(drafts, list):
        raise ValueError("page-analysis content_observations must be an array")
    observations = _materialize_observations(drafts, pool, package_root, registry_sha256, classifier_version)
    human_review_receipt_ref = _validate_human_review_receipt(
        args.page_analysis_review_receipt, args.page_analysis, page_analysis, package_root,
    )
    completed_at = page_analysis.get("completed_at") or datetime.now(timezone.utc).isoformat()
    payload = {
        "schema_version": "2.1.0",
        "job_id": source_pool["job_id"],
        "question": source_pool["question"],
        "entry_category": source_pool["entry_category"],
        "product_scenario_subintent": source_pool["product_scenario_subintent"],
        "completed_at": completed_at,
        "classifier_version": classifier_version,
        "source_workbook_receipt": source_pool["source_workbook_receipt"],
        "pool_status": source_pool["pool_status"],
        "cited_content_pool": pool,
        "content_observations": observations,
        "pattern_registry_ref": {
            "path": relative_inside(package_root, args.pattern_registry, "--pattern-registry"),
            "sha256": registry_sha256,
        },
        "pattern_research_index_ref": {
            "path": relative_inside(package_root, args.pattern_research_index, "--pattern-research-index"),
            "sha256": research_sha256,
        },
        "human_review_receipt_ref": human_review_receipt_ref,
        "recommendation": compute_e2_recommendation(
            pool, observations, registry, source_pool["entry_category"],
            source_pool["product_scenario_subintent"], source_pool["question"],
        ),
    }
    validate_root(payload, "e2_pattern_analysis.schema.json", "E2 pattern analysis")
    errors, _ = validate_e2_relations(
        payload, package_root, args.pattern_registry, args.pattern_research_index,
    )
    if errors:
        raise ValueError("E2 relational validation failed: " + "; ".join(errors))
    atomic_json(package_root / output_relative, payload)
    print(json.dumps({
        "status": "passed", "job_id": payload["job_id"], "pool_size": len(pool),
        "classified_articles": sum(item["status"] == "classified_article" for item in observations),
        "recommendation_status": payload["recommendation"]["recommendation_status"],
        "recommended_pattern_id": payload["recommendation"]["recommended_pattern_id"],
        "advisory_only": True, "output": output_relative,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
