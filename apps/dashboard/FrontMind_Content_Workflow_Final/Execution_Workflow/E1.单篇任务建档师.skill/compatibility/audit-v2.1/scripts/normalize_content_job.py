#!/usr/bin/env python3
"""Normalize accepted Dashboard import aliases at the E1 boundary."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from schema_validation import validate_root, validate_schema  # noqa: E402


PRODUCT_SUBINTENTS = {
    "offering_definition", "feature_mechanism", "scenario_fit",
    "delivery_usage", "support_boundary", "price_selection",
}


def normalized_question(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: dict[str, Any]) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise FileExistsError(f"refusing to overwrite content-job artifact: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True, help="raw Dashboard/API Content Job JSON")
    parser.add_argument("--output", type=Path, required=True, help="new canonical Content Job JSON")
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    source = args.input.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if len({source, args.output.resolve(strict=False), args.receipt.resolve(strict=False)}) != 3:
        raise ValueError("input, canonical output and receipt must be three distinct paths")
    value = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Content Job must be a JSON object")
    normalized_aliases: list[dict[str, str]] = []
    category = value.get("entry_category")
    if category == "industry":
        value["entry_category"] = "industry_ranking"
        normalized_aliases.append({"path": "entry_category", "from": "industry", "to": "industry_ranking"})
    elif category is None and isinstance(value.get("question"), dict):
        # One controlled migration path for the former Dashboard envelope.  It
        # is deliberately strict: range analysis and P01-P16 selection are never
        # invented by this importer.
        question = value.pop("question")
        legacy_category = question.get("category")
        canonical_category = "industry_ranking" if legacy_category == "industry" else legacy_category
        if legacy_category == "industry":
            normalized_aliases.append({"path": "question.category", "from": "industry", "to": "industry_ranking"})
        if value.pop("requested_pattern_variant", None) is not None:
            raise ValueError(
                "v2.1 no longer accepts requested_pattern_variant: P01 single-brand and P02 multi-brand "
                "are advisory E2 recommendations finalized by E4"
            )
        value["schema_version"] = "2.1.0"
        value["entry_category"] = canonical_category
        value["task"] = {
            "question_text": question.get("text"),
            "question_origin": "external_confirmed",
            "foundation_subject": None,
            "manual_foundation_selection": False,
            "product_scenario_subintent": question.get("product_scenario_subintent"),
        }
        if value.get("deliverables") == {"docx": True, "html": True}:
            value["deliverables"] = {"docx_body": True, "html_body_fragment": True, "title_map": True}
        if not value.get("scope_analysis_path"):
            raise ValueError("legacy Content Job import requires explicit scope_analysis_path; E1 never invents scope")
    if isinstance(value.get("task"), dict) and "requested_pattern_variant" in value["task"]:
        raise ValueError(
            "v2.1 Content Job must remove task.requested_pattern_variant; E2 recommends P01/P02 and E4 decides"
        )
    task = value.get("task") if isinstance(value.get("task"), dict) else {}
    if value.get("entry_category") != "foundation_start":
        original_question = task.get("question_text")
        canonical_question = normalized_question(original_question)
        if original_question != canonical_question:
            task["question_text"] = canonical_question
            normalized_aliases.append({
                "path": "task.question_text", "from": str(original_question), "to": canonical_question,
            })
    if value.get("entry_category") == "product_scenario" and task.get("product_scenario_subintent") not in PRODUCT_SUBINTENTS:
        raise ValueError("product_scenario requires one canonical product_scenario_subintent before E2")
    if (
        value.get("entry_category") != "foundation_start"
        and value.get("source_workbook_path") != "01_monitoring/dashboard_source_workbook.xlsx"
    ):
        raise ValueError(
            "ordinary v2.1 Content Job source_workbook_path must be "
            "01_monitoring/dashboard_source_workbook.xlsx"
        )
    validate_root(value, "content_job.schema.json", "normalized Content Job")
    receipt = {
        "schema_version": "2.1.0", "job_id": value.get("job_id"),
        "stage": "E1_content_job_normalization", "status": "passed",
        "normalized_at": datetime.now(timezone.utc).isoformat(),
        "source_file": source.name, "source_sha256": file_sha256(source),
        "canonical_file": args.output.name, "canonical_sha256": canonical_sha256(value),
        "normalized_aliases": normalized_aliases,
    }
    validate_schema(
        receipt, Path(__file__).resolve().parents[1] / "templates" / "content_job_normalization_receipt.schema.json",
        "Content Job normalization receipt",
    )
    atomic_json(args.output, value)
    atomic_json(args.receipt, receipt)
    print(json.dumps({"status": "passed", "job_id": value.get("job_id"), "normalized_aliases": normalized_aliases}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
