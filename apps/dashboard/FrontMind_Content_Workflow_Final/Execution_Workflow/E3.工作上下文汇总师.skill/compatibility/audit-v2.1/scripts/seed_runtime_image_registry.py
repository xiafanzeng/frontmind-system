#!/usr/bin/env python3
"""Seed a job-local image registry without mutating the signed Reference Pack."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from schema_validation import validate_root, validate_schema  # noqa: E402
from content_projections import canonical_sha256  # noqa: E402


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--base-registry", type=Path, required=True)
    parser.add_argument("--runtime-registry", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if args.base_registry.resolve() == args.runtime_registry.resolve():
        raise ValueError("runtime registry must not overwrite the signed base registry")
    base = load(args.base_registry)
    validate_root(base, "registries.schema.json", "E3 base image_registry")
    if base.get("registry_type") != "image_registry":
        raise ValueError("--base-registry must be a canonical image_registry")
    if args.runtime_registry.exists() or args.receipt.exists():
        raise FileExistsError("runtime registry/receipt already exists; create a new job-local path")
    args.runtime_registry.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.runtime_registry.write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8")
    base_hash = canonical_sha256(base)
    receipt = {
        "schema_version": "2.0.0",
        "job_id": args.job_id,
        "stage": "E3_runtime_image_registry_seed",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "base_registry_file": args.base_registry.name,
        "base_registry_sha256": base_hash,
        "runtime_registry_file": args.runtime_registry.name,
        "seeded_runtime_sha256": base_hash,
        "base_asset_ids": sorted(
            str(item.get("asset_id")) for item in base.get("images", []) if isinstance(item, dict)
        ),
    }
    validate_schema(
        receipt, Path(__file__).resolve().parents[1] / "templates" / "runtime_image_registry_receipt.schema.json",
        "E3 runtime image registry receipt",
    )
    args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": "passed", "runtime_registry": args.runtime_registry.name,
                      "receipt": args.receipt.name, "base_registry_sha256": base_hash}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
