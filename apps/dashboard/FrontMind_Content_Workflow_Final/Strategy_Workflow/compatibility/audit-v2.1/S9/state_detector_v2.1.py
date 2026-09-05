#!/usr/bin/env python3
"""Detect resumable state for the canonical-KB strategy workflow."""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path
from pathlib import PurePosixPath


ROLE_PATTERNS = {
    "s1_intake": ("**/S1_*canonical_kb_intake.json",),
    "s2_report": ("**/S2_*adapter_report.json",),
    "s2_knowledge": ("**/S2_*knowledge_registry.json",),
    "s2_source": ("**/S2_*source_registry.json",),
    "s2_claim": ("**/S2_*claim_registry.json",),
    "s2_image": ("**/S2_*image_registry.json",),
    "s3": ("**/S3_*trend_reference*.json", "**/S3_status.json", "**/S3_*status.json"),
    "s4_architecture": ("**/S4_*information_evidence*.json", "**/S4_*信息与证据架构*.json"),
    "s4_brand_facts": ("**/S4_*brand_facts.json", "**/S4_*canonical_brand_facts*.json"),
    "s5": ("**/S5_*voice_contract*.json", "**/S5_*文章话语契约*.json"),
    "s6": ("**/S6_*visual_reference*.json", "**/S6_*视觉参考体系*.json"),
    "s7": ("**/S7_*question_library*.json", "**/S7_*问题与FAQ参考库*.json"),
    "s8": ("**/S8_*approval.json", "**/S8_*审批记录*.json"),
}

STAGES = [
    ("S1", ["s1_intake"]),
    ("S2", ["s2_report", "s2_knowledge", "s2_source", "s2_claim", "s2_image"]),
    ("S3", ["s3"]),
    ("S4", ["s4_architecture", "s4_brand_facts"]),
    ("S5", ["s5"]),
    ("S6", ["s6"]),
    ("S7", ["s7"]),
    ("S8", ["s8"]),
]


def kb_manifest(path: Path) -> dict:
    if path.is_file() and zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            names = [name for name in archive.namelist() if not name.endswith("/")]
            if len(names) != len(set(names)):
                raise ValueError("canonical KB ZIP contains duplicate paths")
            for name in names:
                pure = PurePosixPath(name)
                if pure.is_absolute() or ".." in pure.parts:
                    raise ValueError(f"unsafe canonical KB ZIP path: {name}")
            manifests = [name for name in names if name == "00_package_manifest.json" or name.endswith("/00_package_manifest.json")]
            if len(manifests) != 1:
                raise ValueError("canonical KB ZIP must contain exactly one 00_package_manifest.json")
            return json.loads(archive.read(manifests[0]))
    if path.is_dir():
        candidate = path / "00_package_manifest.json"
        if not candidate.is_file():
            raise ValueError("canonical KB directory lacks 00_package_manifest.json")
        return json.loads(candidate.read_text(encoding="utf-8"))
    raise ValueError("canonical KB must be a ZIP or directory")


def discover(root: Path, patterns: tuple[str, ...]) -> list[str]:
    files: set[Path] = set()
    for pattern in patterns:
        files.update(path.resolve() for path in root.glob(pattern) if path.is_file())
    return [str(path) for path in sorted(files)]


def main() -> None:
    parser = argparse.ArgumentParser(description="Detect FrontMind Reference Pack workflow state")
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--kb", required=True, help="Canonical KB v4 ZIP or directory")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    root = Path(args.work_dir).expanduser().resolve()
    if not root.is_dir():
        parser.error(f"work directory does not exist: {root}")
    kb_path = Path(args.kb).expanduser().resolve()
    try:
        manifest = kb_manifest(kb_path)
    except (OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
        parser.error(str(exc))
    if manifest.get("schemaVersion") != 4 or manifest.get("profile") != "dashboard-enterprise-v1":
        parser.error("input is not canonical KB v4 profile dashboard-enterprise-v1")

    role_files = {role: discover(root, patterns) for role, patterns in ROLE_PATTERNS.items()}
    rows = []
    next_stage = None
    for stage, roles in STAGES:
        required = stage != "S3"
        missing_roles = [role for role in roles if not role_files[role]]
        if not missing_roles:
            status = "complete"
        elif required:
            status = "missing"
        else:
            status = "optional_not_run"
        rows.append({"stage": stage, "required": required, "status": status, "missing_roles": missing_roles, "files": {role: role_files[role] for role in roles}})
        if required and missing_roles and next_stage is None:
            next_stage = stage
    payload = {
        "schema_version": "2.0.0",
        "stage": "S9_state_detection",
        "work_dir": str(root),
        "canonical_kb": str(kb_path),
        "canonical_kb_profile": manifest.get("profile"),
        "active_sequence": ["S1", "S2", "S3_optional", "S4", "S5", "S6", "S7", "S8", "S9"],
        "next_required_stage": next_stage,
        "ready_for_s9_packaging": next_stage is None,
        "stages": rows,
    }
    if args.as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for row in rows:
            mark = "✓" if row["status"] == "complete" else ("○" if not row["required"] else "✗")
            print(f"{mark} {row['stage']}: {row['status']}")
            if row["missing_roles"]:
                print("  missing:", ", ".join(row["missing_roles"]))
        print("next:", next_stage or "S9 packaging")


if __name__ == "__main__":
    main()
