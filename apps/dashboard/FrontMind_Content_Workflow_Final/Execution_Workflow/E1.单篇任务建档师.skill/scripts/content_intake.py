#!/usr/bin/env python3
"""FrontMind E1 v2.3: normalize one article task without receipt gates.

The script accepts an existing Reference Pack, loose materials, or both.  Input
files outside the job directory are copied into the job-local uploads folder;
this is ordinary input handling, not an approval or hash-binding ceremony.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
import uuid
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from schema_validation import validate_root  # noqa: E402


ENTRIES = {
    "industry_ranking",
    "competitor_comparison",
    "reputation",
    "product_scenario",
    "foundation_start",
}
ENTRY_ALIASES = {
    "industry": "industry_ranking",
    "行业排名": "industry_ranking",
    "竞品对比": "competitor_comparison",
    "美誉舆情": "reputation",
    "产品场景": "product_scenario",
    "基础启动": "foundation_start",
}
SUBINTENTS = {
    "offering_definition",
    "feature_mechanism",
    "scenario_fit",
    "delivery_usage",
    "support_boundary",
    "price_selection",
}
PACK_MARKERS = {"reference_pack.json", "reference-pack.json"}
MATERIAL_SUFFIXES = {
    ".docx", ".pptx", ".xlsx", ".xls", ".pdf", ".html", ".htm",
    ".md", ".txt", ".csv", ".json", ".png", ".jpg", ".jpeg",
    ".webp", ".gif", ".svg",
}


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", str(value or ""))).strip()


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def relative_to_job(job_root: Path, path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(job_root.resolve()).as_posix()
    except ValueError as exc:
        raise ValueError(f"input path was not staged inside the job root: {path}") from exc


def validate_zip_container(path: Path) -> None:
    """Reject traversal, links and obvious decompression bombs without unpacking."""
    with zipfile.ZipFile(path) as archive:
        total_compressed = 0
        total_uncompressed = 0
        if len(archive.infolist()) > 20_000:
            raise ValueError("unsafe_input: ZIP contains too many entries")
        for item in archive.infolist():
            member = PurePosixPath(item.filename.replace("\\", "/"))
            if member.is_absolute() or ".." in member.parts:
                raise ValueError(f"unsafe_input: ZIP path traversal: {item.filename}")
            mode = (item.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise ValueError(f"unsafe_input: ZIP symlink is not allowed: {item.filename}")
            total_compressed += max(item.compress_size, 1)
            total_uncompressed += item.file_size
        if total_uncompressed > 4 * 1024 * 1024 * 1024:
            raise ValueError("unsafe_input: ZIP expands beyond the 4 GiB limit")
        if total_uncompressed > 100 * 1024 * 1024 and total_uncompressed / total_compressed > 200:
            raise ValueError("unsafe_input: suspicious ZIP compression ratio")


def validate_directory(path: Path) -> None:
    count = 0
    total = 0
    for item in path.rglob("*"):
        count += 1
        if count > 50_000:
            raise ValueError("unsafe_input: input directory contains too many entries")
        if item.is_symlink():
            raise ValueError(f"unsafe_input: directory symlink is not allowed: {item}")
        if item.is_file():
            total += item.stat().st_size
            if total > 4 * 1024 * 1024 * 1024:
                raise ValueError("unsafe_input: input directory exceeds 4 GiB")


def looks_like_pack(path: Path) -> bool:
    if path.is_dir():
        return any((path / marker).is_file() for marker in PACK_MARKERS)
    if path.suffix.lower() == ".zip":
        validate_zip_container(path)
        with zipfile.ZipFile(path) as archive:
            names = {PurePosixPath(name).name.casefold() for name in archive.namelist()}
            return bool(names & PACK_MARKERS)
    if path.suffix.lower() == ".json":
        try:
            value = read_object(path)
        except (OSError, ValueError, json.JSONDecodeError):
            return False
        profile = str(value.get("profile") or value.get("package_profile") or "").casefold()
        return bool(value.get("pack_id") or "reference-pack" in profile or "reference_pack" in profile)
    return False


def unique_target(upload_dir: Path, source: Path) -> Path:
    target = upload_dir / source.name
    counter = 2
    while target.exists() or target.is_symlink():
        target = upload_dir / f"{source.stem}-{counter}{source.suffix}"
        counter += 1
    return target


def stage_input(job_root: Path, source: Path) -> Path:
    if source.is_symlink() or not source.exists():
        raise ValueError(f"unsafe_input: missing input or symlink: {source}")
    source = source.resolve()
    if source.is_dir():
        validate_directory(source)
    try:
        source.relative_to(job_root.resolve())
        if source.suffix.lower() == ".zip":
            validate_zip_container(source)
        return source
    except ValueError:
        pass
    upload_dir = job_root / "00_input" / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = unique_target(upload_dir, source)
    if source.is_dir():
        shutil.copytree(source, target, symlinks=False)
    elif source.is_file():
        if source.suffix.lower() not in MATERIAL_SUFFIXES | {".zip"}:
            raise ValueError(f"unsupported input file type: {source.suffix or '(none)'}")
        if source.suffix.lower() == ".zip":
            validate_zip_container(source)
        shutil.copy2(source, target)
    else:
        raise ValueError(f"unsupported input type: {source}")
    return target


def pack_id_from(path: Path | None) -> str | None:
    if path is None:
        return None
    candidates: list[dict[str, Any]] = []
    try:
        if path.is_dir():
            for name in PACK_MARKERS:
                manifest = path / name
                if manifest.is_file():
                    candidates.append(read_object(manifest))
        elif path.suffix.lower() == ".json":
            candidates.append(read_object(path))
        elif path.suffix.lower() == ".zip":
            with zipfile.ZipFile(path) as archive:
                for name in archive.namelist():
                    if PurePosixPath(name).name.casefold() in PACK_MARKERS:
                        value = json.loads(archive.read(name).decode("utf-8"))
                        if isinstance(value, dict):
                            candidates.append(value)
                        break
    except (OSError, ValueError, KeyError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    for value in candidates:
        found = normalize_text(value.get("pack_id"))
        if found:
            return found
    return None


def infer_scope(job_id: str, question: str, entry: str) -> dict[str, Any]:
    today = date.today()
    region_terms = [
        "中国", "大陆", "香港", "澳门", "台湾", "北京", "上海", "广州", "深圳",
        "东莞", "佛山", "珠海", "惠州", "中山", "杭州", "南京", "成都", "重庆",
        "武汉", "西安", "苏州", "天津", "美国", "欧洲", "欧盟", "英国", "日本",
        "东南亚", "全球",
    ]
    region = next((item for item in region_terms if item in question), None)
    if region == "全球":
        geographic = {"status": "global", "value": "全球", "basis": ["问题明确包含全球范围"]}
    elif region:
        geographic = {"status": "specific", "value": region, "basis": [f"问题明确包含地区：{region}"]}
    else:
        geographic = {
            "status": "not_applicable", "value": None,
            "basis": ["当前问题未显示地区会改变候选池、政策或结论，采用不限定地区的保守范围"],
        }
    volatile = any(token in question.casefold() for token in ("价格", "最新", "排行", "榜", "政策", "截至", "202"))
    valid_until = None
    if volatile:
        valid_until = date(today.year + (1 if today.month == 12 else 0), 1 if today.month == 12 else today.month + 1, 1).isoformat()
    return {
        "schema_version": "2.3.0",
        "job_id": job_id,
        "geographic_scope": geographic,
        "decision_context": {
            "roles": ["相关决策者"],
            "problem": question,
            "decision_criteria": ["事实准确性", "适用条件", "实际决策价值"],
            "professional_depth": "professional",
        },
        "time_basis": {
            "as_of": today.isoformat(),
            "freshness_class": "volatile" if volatile else "moderate",
            "valid_until": valid_until,
            "basis": ["依据任务问题与当前可用资料自动推断；正文仅在时间确实影响结论时自然说明"],
        },
        "inference_basis": {
            "knowledge_ids": [], "source_ids": [], "monitoring_observation_ids": [],
            "notes": [f"由 E1 根据 {entry} 任务和可用输入自动推断，不要求用户填写地区、受众或时间表单"],
        },
        "clarification": {
            "status": "not_required", "question": None, "answer": None,
            "material_effect": None,
        },
    }


def value_from(cli: Any, raw: dict[str, Any], key: str, default: Any = None) -> Any:
    value = getattr(cli, key, None)
    return value if value not in (None, []) else raw.get(key, default)


def resolve_raw_path(value: Any, job_root: Path, raw_job: Path | None) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(value)
    if path.is_absolute():
        return path
    candidates = [job_root / path]
    if raw_job is not None:
        candidates.append(raw_job.resolve().parent / path)
    candidates.append(Path.cwd() / path)
    return next((item for item in candidates if item.exists()), candidates[0])


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a content-first E1 job without receipts")
    parser.add_argument("--job-root", type=Path, required=True)
    parser.add_argument("--raw-job", type=Path)
    parser.add_argument("--input", action="append", type=Path, default=[], help="Auto-detect Pack or material")
    parser.add_argument("--reference-pack", type=Path)
    parser.add_argument("--material", action="append", type=Path, default=[])
    parser.add_argument("--monitoring-answers", type=Path)
    parser.add_argument("--monitoring-input", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--source-workbook", type=Path)
    parser.add_argument("--job-id")
    parser.add_argument("--entry-category")
    parser.add_argument("--question")
    parser.add_argument("--question-origin", choices=["external_confirmed", "upload_inferred", "foundation_derived"])
    parser.add_argument("--foundation-subject")
    parser.add_argument("--product-scenario-subintent")
    parser.add_argument("--user-constraint", action="append", default=[])
    parser.add_argument("--content-job-output", type=Path)
    parser.add_argument("--scope-output", type=Path)
    args = parser.parse_args()

    job_root = args.job_root.resolve()
    job_root.mkdir(parents=True, exist_ok=True)
    if args.raw_job:
        raw = read_object(args.raw_job)
    else:
        raw = {}

    task_raw = raw.get("task") if isinstance(raw.get("task"), dict) else {}
    job_id = normalize_text(value_from(args, raw, "job_id")) or f"job_{uuid.uuid4().hex[:12]}"
    if not re.fullmatch(r"job_[a-z0-9][a-z0-9_-]{2,80}", job_id):
        raise ValueError("job_id must match job_[a-z0-9][a-z0-9_-]{2,80}")
    entry = normalize_text(value_from(args, raw, "entry_category"))
    entry = ENTRY_ALIASES.get(entry, entry)
    if entry not in ENTRIES:
        raise ValueError(f"entry_category must be one of {sorted(ENTRIES)}")

    question = normalize_text(args.question if args.question is not None else task_raw.get("question_text")) or None
    foundation = normalize_text(
        args.foundation_subject if args.foundation_subject is not None else task_raw.get("foundation_subject")
    ) or None
    subintent = normalize_text(
        args.product_scenario_subintent
        if args.product_scenario_subintent is not None
        else task_raw.get("product_scenario_subintent")
    ) or None
    if subintent is not None and subintent not in SUBINTENTS:
        raise ValueError(f"unknown product_scenario_subintent: {subintent}")
    if entry != "product_scenario":
        subintent = None
    if entry == "foundation_start":
        if not foundation:
            raise ValueError("foundation_start requires foundation_subject")
        question = None
        question_origin = "foundation_derived"
        subintent = None
    else:
        if not question:
            raise ValueError("a non-foundation article requires a concrete question")
        foundation = None
        question_origin = args.question_origin or task_raw.get("question_origin") or "external_confirmed"
        if question_origin == "foundation_derived":
            question_origin = "upload_inferred"

    explicit_pack = args.reference_pack or resolve_raw_path(
        raw.get("reference_pack_path"), job_root, args.raw_job,
    )
    pack_inputs: list[Path] = []
    material_inputs: list[Path] = list(args.material)
    if explicit_pack:
        pack_inputs.append(explicit_pack)
    raw_materials = raw.get("material_paths") if isinstance(raw.get("material_paths"), list) else []
    material_inputs.extend(
        path for item in raw_materials
        if (path := resolve_raw_path(item, job_root, args.raw_job)) is not None
    )
    for supplied in args.input:
        (pack_inputs if looks_like_pack(supplied) else material_inputs).append(supplied)
    if not pack_inputs and not material_inputs:
        raise ValueError("no_usable_content: provide a Reference Pack or at least one material")
    if len(pack_inputs) > 1:
        material_inputs.extend(pack_inputs[1:])
        pack_inputs = pack_inputs[:1]

    staged_pack = stage_input(job_root, pack_inputs[0]) if pack_inputs else None
    staged_materials = [stage_input(job_root, item) for item in material_inputs]
    monitoring_source = args.monitoring_answers or args.monitoring_input or resolve_raw_path(
        raw.get("monitoring_answers_path") or raw.get("monitoring_input_path"),
        job_root,
        args.raw_job,
    )
    workbook_source = args.source_workbook or resolve_raw_path(
        raw.get("source_workbook_path"), job_root, args.raw_job,
    )
    staged_monitoring = stage_input(job_root, monitoring_source) if monitoring_source else None
    staged_workbook = stage_input(job_root, workbook_source) if workbook_source else None

    input_mode = "mixed" if staged_pack and staged_materials else "pack" if staged_pack else "materials"
    constraints = args.user_constraint or raw.get("user_constraints") or []
    constraints = [normalize_text(item) for item in constraints if normalize_text(item)]
    content_job = {
        "schema_version": "2.3.0",
        "job_id": job_id,
        "created_at": raw.get("created_at") or datetime.now(timezone.utc).isoformat(),
        "input_mode": input_mode,
        "pack_id": pack_id_from(staged_pack) or raw.get("pack_id"),
        "reference_pack_path": relative_to_job(job_root, staged_pack) if staged_pack else None,
        "material_paths": [relative_to_job(job_root, item) for item in staged_materials],
        "entry_category": entry,
        "task": {
            "question_text": question,
            "question_origin": question_origin,
            "foundation_subject": foundation,
            "product_scenario_subintent": subintent,
        },
        "monitoring_answers_path": relative_to_job(job_root, staged_monitoring) if staged_monitoring else None,
        "source_workbook_path": relative_to_job(job_root, staged_workbook) if staged_workbook else None,
        "user_constraints": constraints,
    }
    scope_question = question or foundation or "品牌基础深度特写"
    scope = infer_scope(job_id, scope_question, entry)
    content_output = args.content_job_output or job_root / "00_input" / "content_job.json"
    scope_output = args.scope_output or job_root / "00_input" / "scope_analysis.json"
    if not content_output.is_absolute():
        content_output = job_root / content_output
    if not scope_output.is_absolute():
        scope_output = job_root / scope_output
    relative_to_job(job_root, content_output)
    relative_to_job(job_root, scope_output)
    validate_root(content_job, "content_job.schema.json", "E1 Content Job")
    validate_root(scope, "scope_analysis.schema.json", "E1 automatic scope analysis")
    write_json(content_output, content_job)
    write_json(scope_output, scope)
    print(json.dumps({
        "stage": "E1", "status": "completed", "job_id": job_id,
        "input_mode": input_mode, "reference_pack": content_job["reference_pack_path"],
        "material_count": len(staged_materials),
        "monitoring_available": staged_monitoring is not None,
        "source_workbook_available": staged_workbook is not None,
        "content_job": relative_to_job(job_root, content_output),
        "scope_analysis": relative_to_job(job_root, scope_output),
        "warnings": [],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
