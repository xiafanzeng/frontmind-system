#!/usr/bin/env python3
"""Apply an auditable human confirmation/correction layer to E2 page analysis."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from e2_pattern_contract import file_sha256, load_object  # noqa: E402
from schema_validation import validate_root  # noqa: E402


REVIEW_KEYS = {
    "schema_version", "job_id", "review_id", "reviewer", "reviewer_role",
    "reviewed_at", "decisions", "attestation",
}
DECISION_KEYS = {
    "raw_rank", "action", "replacement_status", "replacement_content_form",
    "classification", "rationale",
}
CLASSIFICATION_EDIT_KEYS = {
    "primary_pattern_id", "alternative_pattern_ids", "classification_confidence",
    "matched_intent_signal_ids", "matched_structure_component_ids", "negative_signal_ids",
    "question_similarity", "classification_rationale",
}


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise FileExistsError(f"refusing to overwrite human-review artifact: {path}")
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
    try:
        return path.resolve(strict=False).relative_to(root.resolve()).as_posix()
    except ValueError as exc:
        raise ValueError(f"{label} must remain inside --package-root") from exc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auto-page-analysis", type=Path, required=True)
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    package_root = args.package_root.resolve()
    for path, label in ((args.auto_page_analysis, "--auto-page-analysis"), (args.review, "--review")):
        if not path.is_file():
            raise FileNotFoundError(path)
        relative_inside(package_root, path, label)
    output_relative = relative_inside(package_root, args.output, "--output")
    receipt_relative = relative_inside(package_root, args.receipt, "--receipt")
    automatic, review = load_object(args.auto_page_analysis), load_object(args.review)
    if set(review) != REVIEW_KEYS or review.get("schema_version") != "2.1.0":
        raise ValueError("human review must use the exact v2.1 review envelope")
    if review.get("job_id") != automatic.get("job_id"):
        raise ValueError("human review job_id differs from automatic page analysis")
    reviewer = str(review.get("reviewer") or "").strip()
    if not reviewer or len(reviewer) > 200:
        raise ValueError("human review requires a reviewer identifier up to 200 characters")
    reviewer_role = str(review.get("reviewer_role") or "").strip()
    attestation = str(review.get("attestation") or "").strip()
    if not reviewer_role or len(reviewer_role) > 200 or not 20 <= len(attestation) <= 2000:
        raise ValueError("human review requires reviewer_role and a 20-2000 character attestation")
    observations = automatic.get("content_observations")
    if not isinstance(observations, list):
        raise ValueError("automatic page analysis has no content_observations array")
    if any(
        isinstance(item, dict)
        and (
            item.get("review_status") != "machine_classified"
            or (
                isinstance(item.get("classification"), dict)
                and item["classification"].get("review_status") != "machine_classified"
            )
        )
        for item in observations
    ):
        raise ValueError("human review must start from a purely machine-classified page analysis")
    by_rank = {item.get("raw_rank"): item for item in observations if isinstance(item, dict)}
    decisions = review.get("decisions")
    if not isinstance(decisions, list) or not decisions:
        raise ValueError("human review decisions must be a non-empty array")
    seen: set[int] = set()
    applied: list[dict[str, Any]] = []
    for decision in decisions:
        if not isinstance(decision, dict) or set(decision) != DECISION_KEYS:
            raise ValueError("each human review decision must use the exact v2.1 fields")
        rank = decision.get("raw_rank")
        if not isinstance(rank, int) or isinstance(rank, bool) or rank not in by_rank or rank in seen:
            raise ValueError(f"human review raw_rank is unknown or duplicated: {rank!r}")
        seen.add(rank)
        target = by_rank[rank]
        automatic_pattern_id = (
            target.get("classification", {}).get("primary_pattern_id")
            if isinstance(target.get("classification"), dict) else None
        )
        action = decision.get("action")
        rationale = str(decision.get("rationale") or "").strip()
        if not 10 <= len(rationale) <= 2000:
            raise ValueError(f"rank {rank} human review rationale must contain 10-2000 characters")
        if action == "confirm":
            if any(decision.get(key) is not None for key in ("replacement_status", "replacement_content_form", "classification")):
                raise ValueError(f"rank {rank} confirm decision must not include replacements")
            if target.get("status") != "classified_article" or not isinstance(target.get("classification"), dict):
                raise ValueError(f"rank {rank} can only confirm an automatic classified_article")
            target["review_status"] = "human_confirmed"
            target["classification"]["review_status"] = "human_confirmed"
        elif action == "correct":
            status = decision.get("replacement_status")
            form = decision.get("replacement_content_form")
            edits = decision.get("classification")
            if status not in {"classified_article", "non_article"}:
                raise ValueError(f"rank {rank} correction may only select classified_article or non_article")
            if status == "non_article":
                if edits is not None:
                    raise ValueError(f"rank {rank} non_article correction must set classification=null")
                target["status"], target["review_status"] = status, "human_corrected"
                target["content_form"], target["classification"] = form, None
            else:
                if not isinstance(edits, dict) or set(edits) != CLASSIFICATION_EDIT_KEYS:
                    raise ValueError(f"rank {rank} classified correction fields are incomplete or contain extras")
                base = target.get("classification") if isinstance(target.get("classification"), dict) else {}
                target["status"], target["review_status"], target["content_form"] = status, "human_corrected", form
                target["classification"] = {
                    **base, **edits, "content_form": form, "review_status": "human_corrected",
                }
        else:
            raise ValueError(f"rank {rank} action must be confirm or correct")
        final_pattern_id = (
            target.get("classification", {}).get("primary_pattern_id")
            if isinstance(target.get("classification"), dict) else None
        )
        applied.append({
            "observation_id": str(target.get("observation_id") or f"obs_rank_{rank:02d}"),
            "decision": "confirmed" if action == "confirm" else "corrected",
            "automatic_pattern_id": automatic_pattern_id,
            "final_pattern_id": final_pattern_id,
            "final_review_status": target["review_status"],
            "rationale": rationale,
        })
    reviewed_at = review.get("reviewed_at") or datetime.now(timezone.utc).isoformat()
    automatic["completed_at"] = reviewed_at
    atomic_json(package_root / output_relative, automatic)
    receipt = {
        "schema_version": "2.1.0", "job_id": automatic.get("job_id"),
        "review_id": review.get("review_id"), "reviewer": reviewer,
        "reviewer_role": reviewer_role, "reviewed_at": reviewed_at,
        "automatic_page_analysis_ref": {
            "path": relative_inside(package_root, args.auto_page_analysis, "--auto-page-analysis"),
            "sha256": file_sha256(args.auto_page_analysis),
        },
        "review_input_ref": {
            "path": relative_inside(package_root, args.review, "--review"),
            "sha256": file_sha256(args.review),
        },
        "reviewed_page_analysis_ref": {
            "path": output_relative,
            "sha256": file_sha256(package_root / output_relative),
        },
        "decisions": sorted(applied, key=lambda item: item["observation_id"]),
        "attestation": attestation,
    }
    validate_root(receipt, "e2_human_review_receipt.schema.json", "E2 human review receipt")
    atomic_json(package_root / receipt_relative, receipt)
    print(json.dumps({
        "status": "passed", "job_id": automatic.get("job_id"),
        "decision_count": len(applied), "output": output_relative, "receipt": receipt_relative,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
