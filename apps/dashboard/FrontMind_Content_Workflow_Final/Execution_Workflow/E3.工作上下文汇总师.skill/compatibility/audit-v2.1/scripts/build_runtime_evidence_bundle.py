#!/usr/bin/env python3
"""Build append-only job-local claim/source registries from signed Pack bases."""

from __future__ import annotations

import argparse
import hashlib
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
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "shared"))
from registry_binding import canonical_sha256  # noqa: E402
from schema_validation import validate_root, validate_schema  # noqa: E402
from source_publication import validate_source_publication  # noqa: E402


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_inside(root: Path, stored: str) -> Path:
    path = Path(stored)
    if not stored or path.is_absolute() or ".." in path.parts or "\\" in stored:
        raise ValueError(f"unsafe runtime evidence path: {stored!r}")
    resolved = (root / path).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"runtime evidence path escapes job root: {stored}") from exc
    return resolved


def safe_web_url(value: Any) -> bool:
    if value is None:
        return True
    if not isinstance(value, str) or not value.strip() or any(char.isspace() for char in value):
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.hostname)


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise FileExistsError(f"refusing to overwrite runtime evidence artifact: {path}")
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
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--base-claims", type=Path, required=True)
    parser.add_argument("--base-sources", type=Path, required=True)
    parser.add_argument("--pattern-registry", type=Path, required=True,
                        help="staged Pack shared/content-pattern-registry.json")
    parser.add_argument("--extension", type=Path, required=True,
                        help="object with schema_version/job_id/sources[]/claims[]/evidence_files[]")
    parser.add_argument("--job-package-root", type=Path, required=True)
    parser.add_argument("--runtime-claims", type=Path, required=True)
    parser.add_argument("--runtime-sources", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    job_root = args.job_package_root.resolve()
    if not job_root.is_dir():
        raise FileNotFoundError(job_root)
    for output in (args.runtime_claims, args.runtime_sources, args.receipt):
        try:
            output.resolve(strict=False).relative_to(job_root)
        except ValueError as exc:
            raise ValueError("runtime evidence outputs must be inside --job-package-root") from exc
    base_claims, base_sources, extension = load(args.base_claims), load(args.base_sources), load(args.extension)
    pattern_registry = load(args.pattern_registry)
    publication_contract = pattern_registry.get("first_party_publication_contract")
    if not isinstance(publication_contract, dict):
        raise ValueError("packaged pattern registry lacks first_party_publication_contract")
    validate_root(base_claims, "registries.schema.json", "runtime evidence base claims")
    validate_root(base_sources, "registries.schema.json", "runtime evidence base sources")
    validate_root(extension, "runtime_evidence_extension.schema.json", "runtime evidence extension")
    if base_claims.get("registry_type") != "claim_registry" or base_sources.get("registry_type") != "source_registry":
        raise ValueError("base registries have wrong registry_type")
    base_state_errors = [
        message
        for source in base_sources.get("sources", [])
        for message in validate_source_publication(source, "base_pack", publication_contract)
    ]
    if base_state_errors:
        raise ValueError("base source publication state failure: " + "; ".join(base_state_errors))
    if extension.get("schema_version") != "2.0.0" or extension.get("job_id") != args.job_id:
        raise ValueError("extension schema_version/job_id mismatch")
    new_sources, new_claims = extension.get("sources"), extension.get("claims")
    if not isinstance(new_sources, list) or not isinstance(new_claims, list):
        raise ValueError("extension sources/claims must be arrays")
    source_ids = {str(item.get("source_id")) for item in base_sources.get("sources", []) if isinstance(item, dict)}
    claim_ids = {str(item.get("claim_id")) for item in base_claims.get("claims", []) if isinstance(item, dict)}
    extension_source_ids = [str(item.get("source_id")) for item in new_sources if isinstance(item, dict)]
    extension_claim_ids = [str(item.get("claim_id")) for item in new_claims if isinstance(item, dict)]
    if len(extension_source_ids) != len(new_sources) or len(set(extension_source_ids)) != len(extension_source_ids) or source_ids & set(extension_source_ids):
        raise ValueError("extension source IDs must be unique and append-only")
    if len(extension_claim_ids) != len(new_claims) or len(set(extension_claim_ids)) != len(extension_claim_ids) or claim_ids & set(extension_claim_ids):
        raise ValueError("extension claim IDs must be unique and append-only")
    evidence_files = extension.get("evidence_files")
    if not isinstance(evidence_files, list):
        raise ValueError("extension evidence_files must be an array")
    file_records = {}
    for item in evidence_files:
        if not isinstance(item, dict) or set(item) != {"path", "sha256", "authorization_status"}:
            raise ValueError("each evidence file requires only path/sha256/authorization_status")
        path = resolve_inside(job_root, str(item.get("path") or ""))
        if not path.is_file() or file_sha256(path) != item.get("sha256"):
            raise ValueError(f"runtime evidence file missing/hash mismatch: {item.get('path')}")
        file_records[str(item["path"])] = item
    all_source_ids = source_ids | set(extension_source_ids)
    for source in new_sources:
        # Runtime sources are not covered by the signed Reference Pack.  Even a
        # URL source must therefore carry a job-local snapshot/excerpt file;
        # url/accessed_at alone would let an extension author self-certify an
        # unvisited page as verified evidence.
        path = str(source.get("file_path") or "")
        if path not in file_records:
            raise ValueError(
                f"every runtime source requires a hash-bound job-local evidence file: "
                f"{source.get('source_id')}:{path or '<missing>'}"
            )
        if file_records[path].get("authorization_status") not in {"public_approved", "anonymized_approved"}:
            raise ValueError(f"runtime source evidence file is not approved for article use: {source.get('source_id')}:{path}")
        if source.get("url") and (not source.get("accessed_at") or not str(source.get("origin") or "").strip()):
            raise ValueError(f"runtime URL locator requires accessed_at/origin: {source.get('source_id')}")
        if not safe_web_url(source.get("url")):
            raise ValueError(f"runtime source URL must use http/https: {source.get('source_id')}")
        state_errors = validate_source_publication(source, "runtime", publication_contract)
        if state_errors:
            raise ValueError("runtime source publication state failure: " + "; ".join(state_errors))
    for claim in new_claims:
        if set(str(value) for value in claim.get("source_ids", [])) - all_source_ids:
            raise ValueError(f"runtime claim references unknown source: {claim.get('claim_id')}")
        original = claim.get("original_evidence")
        if isinstance(original, dict):
            for record_ref in original.get("record_refs", []):
                if str(record_ref) not in file_records:
                    raise ValueError(f"runtime original_evidence record_ref lacks hashed evidence file: {record_ref}")
    runtime_sources = {"schema_version": "2.0.0", "registry_type": "source_registry", "sources": [*base_sources["sources"], *new_sources]}
    runtime_claims = {"schema_version": "2.0.0", "registry_type": "claim_registry", "claims": [*base_claims["claims"], *new_claims]}
    validate_root(runtime_sources, "registries.schema.json", "runtime source_registry")
    validate_root(runtime_claims, "registries.schema.json", "runtime claim_registry")
    receipt = {
        "schema_version": "2.0.0", "job_id": args.job_id, "stage": "E3_runtime_evidence_bundle", "status": "passed",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "base_claim_registry_sha256": canonical_sha256(base_claims),
        "base_source_registry_sha256": canonical_sha256(base_sources),
        "runtime_claim_registry_sha256": canonical_sha256(runtime_claims),
        "runtime_source_registry_sha256": canonical_sha256(runtime_sources),
        "base_claim_ids": sorted(claim_ids), "base_source_ids": sorted(source_ids),
        "extension_claim_ids": sorted(extension_claim_ids), "extension_source_ids": sorted(extension_source_ids),
        "evidence_files": evidence_files,
    }
    validate_schema(
        receipt, Path(__file__).resolve().parents[1] / "templates" / "runtime_evidence_bundle_receipt.schema.json",
        "runtime evidence bundle receipt",
    )
    atomic_json(args.runtime_sources, runtime_sources)
    atomic_json(args.runtime_claims, runtime_claims)
    atomic_json(args.receipt, receipt)
    print(json.dumps({"status": "passed", "runtime_claim_registry_sha256": receipt["runtime_claim_registry_sha256"],
                      "runtime_source_registry_sha256": receipt["runtime_source_registry_sha256"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
