#!/usr/bin/env python3
"""Canonical registry fingerprint handoff shared by E3-E10."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_sha256(value: dict[str, Any]) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def intake_registry_hashes(intake_report: dict[str, Any]) -> dict[str, str]:
    if (
        intake_report.get("schema_version") != "2.1.0"
        or intake_report.get("stage") != "E3_intake"
        or intake_report.get("status") != "passed"
        or intake_report.get("errors")
    ):
        raise ValueError("E3 intake report is not a clean passed receipt")
    hashes = intake_report.get("registry_sha256")
    required = {"knowledge_registry", "source_registry", "claim_registry", "image_registry"}
    if not isinstance(hashes, dict) or set(hashes) != required:
        raise ValueError("E3 intake report lacks the four canonical registry fingerprints")
    if any(not isinstance(value, str) or len(value) != 64 for value in hashes.values()):
        raise ValueError("E3 intake report contains an invalid registry fingerprint")
    return hashes


def validate_registry_binding(
    *, intake_report: dict[str, Any], job_id: Any,
    claim_registry: dict[str, Any] | None = None,
    source_registry: dict[str, Any] | None = None,
    runtime_receipt: dict[str, Any] | None = None,
) -> dict[str, str]:
    hashes = intake_registry_hashes(intake_report)
    if intake_report.get("job_id") != job_id:
        raise ValueError("E3 intake report job_id mismatch")
    if runtime_receipt is None:
        if claim_registry is not None and canonical_sha256(claim_registry) != hashes["claim_registry"]:
            raise ValueError("claim_registry differs from the E3-approved signed Reference Pack")
        if source_registry is not None and canonical_sha256(source_registry) != hashes["source_registry"]:
            raise ValueError("source_registry differs from the E3-approved signed Reference Pack")
        return hashes
    if (
        runtime_receipt.get("schema_version") != "2.0.0"
        or runtime_receipt.get("stage") != "E3_runtime_evidence_bundle"
        or runtime_receipt.get("status") != "passed"
        or runtime_receipt.get("job_id") != job_id
        or runtime_receipt.get("base_claim_registry_sha256") != hashes["claim_registry"]
        or runtime_receipt.get("base_source_registry_sha256") != hashes["source_registry"]
    ):
        raise ValueError("runtime evidence receipt does not bind the E3-approved base registries/job")
    if claim_registry is not None and canonical_sha256(claim_registry) != runtime_receipt.get("runtime_claim_registry_sha256"):
        raise ValueError("claim_registry differs from the approved runtime evidence bundle")
    if source_registry is not None and canonical_sha256(source_registry) != runtime_receipt.get("runtime_source_registry_sha256"):
        raise ValueError("source_registry differs from the approved runtime evidence bundle")
    return hashes
