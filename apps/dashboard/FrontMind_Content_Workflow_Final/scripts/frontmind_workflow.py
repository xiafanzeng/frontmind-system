#!/usr/bin/env python3
"""Resumable FrontMind GEO content workflow runner (execution contract v2.3).

The runner keeps S1-S9 and E1-E10 visible while pausing only for decisions that
materially change content: Pack summary, research inputs, P type, blueprint and
title count. It carries no reviewer, receipt, approval or cross-stage hash ledger.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
STRATEGY = ROOT / "Strategy_Workflow"
EXECUTION = ROOT / "Execution_Workflow"
SHARED = ROOT / "shared"
PATTERN_REGISTRY = SHARED / "content-pattern-registry.json"
PATTERN_RESEARCH = SHARED / "pattern-research/index.json"

S1_SCRIPT = STRATEGY / "S1.企业资料与知识库接入师.skill/scripts/canonical_kb_intake.py"
LEGACY_S1_SKILL = STRATEGY / "compatibility/legacy-s1/SKILL.md"
S2_SCRIPT = STRATEGY / "S2.资料标准化适配器.skill/scripts/kb_v4_adapter.py"
STRATEGY_PRODUCER = STRATEGY / "scripts/produce_strategy_assets.py"
S9_SCRIPT = STRATEGY / "S9.ReferencePack装配师.skill/scripts/pack_builder.py"
E1_SCRIPT = EXECUTION / "E1.单篇任务建档师.skill/scripts/content_intake.py"
E2_SCRIPT = EXECUTION / "E2.单问题监控与标杆拆解师.skill/scripts/run_e2.py"
E3_SCRIPT = EXECUTION / "E3.工作上下文汇总师.skill/scripts/build_working_context.py"
E4_SCRIPT = EXECUTION / "E4.文章蓝图师.skill/scripts/build_article_blueprint.py"
E5_BUILD = EXECUTION / "E5.正文制作师.skill/scripts/build_content_model.py"
E5_VALIDATE = EXECUTION / "E5.正文制作师.skill/scripts/content_model_validator.py"
E6_SCRIPT = EXECUTION / "E6.证据预检师.skill/scripts/evidence_preflight.py"
E7_PLAN = EXECUTION / "E7.视觉论证与资产生产师.skill/scripts/build_visual_plan.py"
E7_AIGC = EXECUTION / "E7.视觉论证与资产生产师.skill/scripts/aigc_invoker.py"
E7_SELECT = EXECUTION / "E7.视觉论证与资产生产师.skill/scripts/visual_claim_validator.py"
E8_SCRIPT = EXECUTION / "E8.编辑终审师.skill/scripts/editorial_audit.py"
E9_SCRIPT = EXECUTION / "E9.HarnessGEO候选优化师.skill/scripts/harnessgeo_candidate_optimizer.py"
E10_SELECT = EXECUTION / "E10.回归选稿与双格式交付师.skill/scripts/select_final_body.py"
E10_COUNT = EXECUTION / "E10.回归选稿与双格式交付师.skill/scripts/set_title_count.py"
E10_TITLES = EXECUTION / "E10.回归选稿与双格式交付师.skill/scripts/generate_title_map.py"
E10_RENDER = EXECUTION / "E10.回归选稿与双格式交付师.skill/scripts/render_delivery.py"

PATTERN_RE = re.compile(r"^P(?:0[1-9]|1[0-6])$")
STATE_VERSION = "2.3.0"
PROVIDER_CONTRACT = "frontmind-controller-provider/v1"
PROVIDER_ENV = "FRONTMIND_CONTROLLER_PROVIDER"
KB_BUILDER_ENV = "FRONTMIND_KB_BUILDER_SKILL"
UNSET = object()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def make_state(job_id: str, mode: str, stage: str) -> dict[str, Any]:
    return {
        "schema_version": STATE_VERSION,
        "job_id": job_id,
        "workflow_mode": mode,
        "current_stage": stage,
        "status": "running",
        "selected_pattern_id": None,
        "title_count": None,
        "warnings": [],
        "blocker": None,
        "updated_at": now(),
    }


def update_state(
    state_path: Path,
    stage: str,
    status: str,
    *,
    warnings: list[str] | None = None,
    selected_pattern_id: str | None | object = UNSET,
    title_count: int | None | object = UNSET,
    blocker: dict[str, str] | None = None,
) -> None:
    state = read_json(state_path)
    state.update({"schema_version": STATE_VERSION, "current_stage": stage, "status": status})
    if warnings:
        state["warnings"] = list(dict.fromkeys([*state.get("warnings", []), *warnings]))
    if selected_pattern_id is not UNSET:
        state["selected_pattern_id"] = selected_pattern_id
    if title_count is not UNSET:
        state["title_count"] = title_count
    state["blocker"] = blocker if status == "blocked" else None
    state["updated_at"] = now()
    write_json(state_path, state)


def announce(stage: str, status: str, details: str = "") -> None:
    suffix = f" — {details}" if details else ""
    print(f"{stage} {status}{suffix}", flush=True)


def parse_last_json(stdout: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    stripped = stdout.strip()
    try:
        value = json.loads(stripped)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass
    values: list[tuple[int, int, dict[str, Any]]] = []
    for index, char in enumerate(stdout):
        if char != "{":
            continue
        try:
            value, end = decoder.raw_decode(stdout[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            values.append((index + end, end, value))
    return max(values, key=lambda item: (item[0], item[1]))[2] if values else {}


def script_runtime(stage: str) -> tuple[Path, dict[str, str]]:
    """Return the stage interpreter and environment.

    E9 calls the fixed XTY-hosted HarnessGEO HTTPS contract with the ordinary
    Workflow interpreter.  The formal credential name is deployment-only; the
    provider-native alias is mapped only inside this child process.  Historical
    Google/AutoGEO/local-model settings are discarded and can never influence the
    request endpoint, model or prompt.
    """

    environment = dict(os.environ)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    interpreter = Path(sys.executable).resolve()
    if stage != "E9":
        return interpreter, environment
    formal_key = environment.get("FRONTMIND_HARNESSGEO_API_KEY", "").strip()
    compatibility_key = environment.get("XTY_API_KEY", "").strip()
    if not formal_key and compatibility_key:
        environment["FRONTMIND_HARNESSGEO_API_KEY"] = compatibility_key
    keys_file = environment.get("FRONTMIND_HARNESSGEO_KEYS_FILE", "").strip()
    if not environment.get("FRONTMIND_HARNESSGEO_API_KEY", "").strip():
        if not keys_file:
            raise RuntimeError(
                "E9: HarnessGEO deployment requires FRONTMIND_HARNESSGEO_API_KEY "
                "or FRONTMIND_HARNESSGEO_KEYS_FILE"
            )
        key_path = Path(keys_file).expanduser()
        if not key_path.is_absolute():
            key_path = (ROOT / key_path).absolute()
        if key_path.is_symlink() or not key_path.is_file():
            raise RuntimeError("E9: FRONTMIND_HARNESSGEO_KEYS_FILE is not a readable regular file")
        environment["FRONTMIND_HARNESSGEO_KEYS_FILE"] = str(key_path)
    for obsolete in (
        "GOOGLE_API_KEY",
        "FRONTMIND_HARNESSGEO_PYTHON", "FRONTMIND_HARNESSGEO_ROOT",
        "FRONTMIND_AUTOGEO_PYTHON", "FRONTMIND_AUTOGEO_ROOT", "FRONTMIND_AUTOGEO_MODEL_PATH",
        "FRONTMIND_AUTOGEO_DATASET", "FRONTMIND_AUTOGEO_ENGINE_LLM", "FRONTMIND_HARNESSGEO_MODEL_PATH",
        "FRONTMIND_HARNESSGEO_ENDPOINT", "FRONTMIND_HARNESSGEO_MODEL",
    ):
        environment.pop(obsolete, None)
    environment.pop("XTY_API_KEY", None)
    return interpreter, environment


def run_script(stage: str, script: Path, arguments: list[str]) -> dict[str, Any]:
    if not script.is_file():
        raise RuntimeError(f"{stage}: active script is missing: {script}")
    interpreter, environment = script_runtime(stage)
    result = subprocess.run(
        [str(interpreter), "-B", str(script), *arguments],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=environment,
        check=False,
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or f"{stage} failed").strip()
        raise RuntimeError(f"{stage}: {message}")
    return parse_last_json(result.stdout)


def provider_command() -> list[str] | None:
    """Read the optional deployment callback as a JSON argv array.

    Shell strings are deliberately rejected.  This keeps callback execution
    deterministic and prevents the environment value from becoming an
    implicit shell program.
    """

    raw = os.environ.get(PROVIDER_ENV, "").strip()
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{PROVIDER_ENV} must be a JSON argv array") from exc
    if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
        raise RuntimeError(f"{PROVIDER_ENV} must be a non-empty JSON array of non-empty strings")
    return value


def controller_action(
    job_root: Path,
    *,
    stage: str,
    action: str,
    inputs: dict[str, Any],
    expected_kind: str,
    expected_path: Path | None = None,
) -> tuple[Path, dict[str, Any]]:
    """Persist a machine-readable, non-user-pause handoff instruction."""

    state = read_json(job_root / "job_state.json")
    request = {
        "contract": PROVIDER_CONTRACT,
        "action": action,
        "user_pause": False,
        "job_id": state.get("job_id"),
        "stage": stage,
        "inputs": inputs,
        "expected_output": {
            "kind": expected_kind,
            "path": str(expected_path) if expected_path else None,
        },
    }
    request_path = job_root / stage / "controller_action.json"
    write_json(request_path, request)
    return request_path, request


def invoke_provider(request_path: Path, request: dict[str, Any]) -> dict[str, Any] | None:
    """Invoke the fixed deployment callback, if configured.

    Contract: the callback receives ``--request`` and ``--response``.  It must
    return a response with the same contract/action and one of ``completed``,
    ``no_file`` or ``unavailable``.  No callback is a controller handoff, not a
    user pause and not a blocker.
    """

    command = provider_command()
    if command is None:
        return None
    response_path = request_path.with_name(f".controller_response.{uuid.uuid4().hex}.tmp")
    environment = dict(os.environ)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    completed = subprocess.run(
        [*command, "--request", str(request_path), "--response", str(response_path)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=environment,
        check=False,
    )
    if completed.returncode != 0 or not response_path.is_file():
        return {
            "contract": PROVIDER_CONTRACT,
            "action": request["action"],
            "status": "unavailable",
            "reason": (completed.stderr or completed.stdout or "provider returned no response")[-1000:],
        }
    response = read_json(response_path)
    response_path.unlink(missing_ok=True)
    if response.get("contract") != PROVIDER_CONTRACT or response.get("action") != request.get("action"):
        raise RuntimeError("controller provider returned a mismatched contract or action")
    if response.get("status") not in {"completed", "no_file", "unavailable"}:
        raise RuntimeError("controller provider returned an unsupported status")
    return response


def provider_output_path(response: dict[str, Any], job_root: Path) -> Path | None:
    raw = response.get("output_path")
    if not isinstance(raw, str) or not raw.strip():
        return None
    path = Path(raw)
    path = path.resolve() if path.is_absolute() else (job_root / path).resolve()
    try:
        path.relative_to(job_root.resolve())
    except ValueError:
        return None
    if path.is_symlink() or not path.is_file():
        return None
    return path


def kb_builder_skill_path() -> Path | None:
    """Locate the fixed Socratic KB Builder without exposing a user CLI option."""

    configured = os.environ.get(KB_BUILDER_ENV, "").strip()
    if configured:
        candidate = Path(configured).expanduser()
        candidate = candidate if candidate.is_absolute() else (ROOT.parent / candidate)
        if candidate.is_dir():
            candidate = candidate / "SKILL.md"
        return candidate.resolve() if candidate.is_file() and not candidate.is_symlink() else None
    candidates = (
        ROOT.parent / "private-workflows/socratic-kb-builder/SKILL.md",
        ROOT.parent / "private-workflows/socratic-kb-builder.skill",
    )
    return next((path.resolve() for path in candidates if path.is_file() and not path.is_symlink()), None)


def add_intake_warning(intake_path: Path, warning: str) -> None:
    payload = read_json(intake_path)
    payload["status"] = "completed_with_limits"
    payload["warnings"] = list(dict.fromkeys([*payload.get("warnings", []), warning]))
    write_json(intake_path, payload)


def attempt_legacy_enrichment(
    *, work_dir: Path, material_input: Path, intake_path: Path, brand: str,
) -> tuple[Path, list[str]]:
    """Run the byte-preserved legacy S1 + KB Builder through the controller.

    Both instruction sources are Agent Skills rather than standalone generators,
    so the unified runner delegates this optional content transformation through
    the same fixed controller-provider contract used by E5/E7/E8. A missing or
    failed provider never creates a user pause: the already-readable original
    material remains the S2 input and the limitation is recorded as a warning.
    """

    action_path: Path | None = None

    def fall_back(code: str, detail: str) -> tuple[Path, list[str]]:
        if action_path is not None:
            action_path.unlink(missing_ok=True)
        clean = " ".join(detail.split())[:600]
        warning = f"{code}: {clean}"
        add_intake_warning(intake_path, warning)
        return material_input, [warning]

    if not LEGACY_S1_SKILL.is_file():
        return fall_back("legacy_enrichment_unavailable", "byte-preserved legacy S1 Skill is missing")
    builder = kb_builder_skill_path()
    if builder is None:
        return fall_back("legacy_enrichment_unavailable", "Socratic KB Builder is not installed in the deployment")
    expected = work_dir / "S1/legacy_enriched_material.zip"
    action_path, action = controller_action(
        work_dir,
        stage="S1",
        action="legacy_enrich_materials",
        inputs={
            "brand": brand,
            "material_input": str(material_input),
            "legacy_s1_skill": str(LEGACY_S1_SKILL.resolve()),
            "kb_builder_skill": str(builder),
            "execution_policy": {
                "batch_mode": True,
                "user_pause": False,
                "preserve_unknowns": True,
                "forbid_audit_gates": True,
                "output_must_be_readable_by_s2": True,
            },
        },
        expected_kind="canonical_kb_or_readable_material_zip",
        expected_path=expected,
    )
    try:
        response = invoke_provider(action_path, action)
        if response is None:
            return fall_back(
                "legacy_enrichment_unavailable",
                "fixed controller provider is not configured; continued with readable original material",
            )
        if response.get("status") != "completed":
            return fall_back(
                "legacy_enrichment_failed",
                str(response.get("reason") or response.get("status") or "provider produced no enriched material"),
            )
        enriched = provider_output_path(response, work_dir)
        if enriched is None:
            return fall_back(
                "legacy_enrichment_failed",
                "provider output is missing, unsafe, outside the work directory, or not a file",
            )
        validated_intake = work_dir / "S1/enriched_intake.json"
        run_script("S1", S1_SCRIPT, [
            "--brand", brand, "--input", str(enriched), "--output", str(validated_intake),
            "--intake-route", "direct",
        ])
        payload = read_json(validated_intake)
        payload["input"]["selected_route"] = "legacy_s1_enrichment_then_normalization"
        payload["input"]["legacy_enrichment_skill"] = "../compatibility/legacy-s1/SKILL.md"
        write_json(intake_path, payload)
        validated_intake.unlink(missing_ok=True)
        action_path.unlink(missing_ok=True)
        return enriched, []
    except Exception as exc:
        return fall_back("legacy_enrichment_failed", f"{type(exc).__name__}: {exc}")


def stage_inputs(inputs: list[Path], destination: Path) -> Path:
    if len(inputs) == 1:
        return inputs[0].resolve()
    destination.mkdir(parents=True, exist_ok=True)
    for index, source in enumerate(inputs, 1):
        source = source.resolve()
        if source.is_symlink() or not source.exists():
            raise ValueError(f"unsafe_input: input is missing or a symlink: {source}")
        target = destination / f"{index:03d}_{source.name}"
        if source.is_dir():
            shutil.copytree(source, target, symlinks=False)
        else:
            shutil.copy2(source, target)
    return destination


def job_path(job_root: Path, relative: Any) -> Path | None:
    if not isinstance(relative, str) or not relative.strip():
        return None
    path = Path(relative)
    return path if path.is_absolute() else job_root / path


def next_action(job_root: Path, state: dict[str, Any]) -> str:
    status = state.get("status")
    root = str(job_root)
    if status == "awaiting_pack_confirmation":
        return f"continue --job-dir {root!r} --confirm-pack"
    if status == "awaiting_research_inputs":
        return f"continue --job-dir {root!r} --monitoring-answers ANSWERS.xlsx --source-workbook CITATIONS.xlsx"
    if status == "awaiting_pattern_confirmation":
        return f"continue --job-dir {root!r} --accept-pattern（或 --selected-pattern Pxx）"
    if status == "awaiting_blueprint_confirmation":
        return f"continue --job-dir {root!r} --accept-blueprint（或 --blueprint-edits FILE.json）"
    if status == "awaiting_title_count":
        return f"continue --job-dir {root!r} --title-count 1..20"
    return "没有等待中的用户操作。"


def preserve_with_hint(job_root: Path, state: dict[str, Any], message: str) -> int:
    print(json.dumps({
        "status": state.get("status"), "message": message,
        "next_action": next_action(job_root, state),
    }, ensure_ascii=False, indent=2))
    return 0


def prepare(args: argparse.Namespace) -> int:
    work_dir = args.work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    job_id = args.job_id or f"job_prepare_{uuid.uuid4().hex[:12]}"
    state_path = work_dir / "job_state.json"
    write_json(state_path, make_state(job_id, "prepare", "S1"))
    supplied = [path.resolve() for path in args.input]
    if not supplied:
        raise ValueError("no_usable_content: provide at least one input")
    material_input = stage_inputs(supplied, work_dir / "inputs")

    s1_output = work_dir / "S1/intake.json"
    run_script("S1", S1_SCRIPT, [
        "--brand", args.brand, "--input", str(material_input), "--output", str(s1_output),
        "--intake-route", args.intake_route,
    ])
    normalization_input = material_input
    enrichment_warnings: list[str] = []
    if read_json(s1_output).get("input", {}).get("selected_route") == "legacy_s1_enrichment_then_normalization":
        normalization_input, enrichment_warnings = attempt_legacy_enrichment(
            work_dir=work_dir, material_input=material_input, intake_path=s1_output, brand=args.brand,
        )
    intake = read_json(s1_output)
    s1_status = str(intake.get("status") or "completed")
    s1_warnings = [str(item) for item in intake.get("warnings", []) if str(item).strip()]
    update_state(state_path, "S1", s1_status, warnings=[*s1_warnings, *enrichment_warnings])
    announce("S1", s1_status, "legacy enrichment applied" if normalization_input != material_input else "")

    s2_dir = work_dir / "S2"
    result = run_script("S2", S2_SCRIPT, [
        "--brand", args.brand, "--input", str(normalization_input), "--s1-intake", str(s1_output),
        "--output-dir", str(s2_dir),
    ])
    s2_status = str(result.get("status") or "completed")
    update_state(state_path, "S2", s2_status)
    announce("S2", s2_status)

    producer_arguments = [
        "--brand", args.brand, "--work-dir", str(work_dir),
        "--pattern-registry", str(PATTERN_REGISTRY), "--through", "S8",
    ]
    if args.trend_signals:
        producer_arguments.extend(("--trend-signals", str(args.trend_signals.resolve())))
    produced = run_script("S3-S8", STRATEGY_PRODUCER, producer_arguments)
    for item in produced.get("stages", []):
        if not isinstance(item, dict):
            continue
        stage = str(item.get("stage") or "")
        status = str(item.get("status") or "completed")
        if stage == "S8":
            status = "awaiting_pack_confirmation"
        if stage:
            update_state(state_path, stage, status)
            announce(stage, status)
    update_state(state_path, "S8", "awaiting_pack_confirmation")
    summaries = sorted((work_dir / "S8").glob("S8_*_ReferencePack确认摘要.md"))
    announce("S8", "awaiting_pack_confirmation", str(summaries[-1] if summaries else work_dir / "S8"))
    print(f"下一步：{next_action(work_dir, read_json(state_path))}")
    return 0


def continue_prepare(args: argparse.Namespace, state: dict[str, Any]) -> int:
    job_root = args.job_dir.resolve()
    if state.get("status") != "awaiting_pack_confirmation" or not args.confirm_pack:
        return preserve_with_hint(job_root, state, "当前只接受 Pack 摘要确认。")
    summaries = sorted((job_root / "S8").glob("S8_*_pack_summary.json"))
    if not summaries:
        raise ValueError("no_usable_content: S8 Pack summary is missing")
    brand = str((read_json(summaries[-1]).get("brand") or {}).get("canonical_name") or "").strip()
    if not brand:
        raise ValueError("unknown_subject: S8 Pack summary has no canonical brand")
    output = args.output.resolve() if args.output else job_root / f"S9_{brand}_reference_pack_v{args.version}.zip"
    result = run_script("S9", S9_SCRIPT, [
        "--brand", brand, "--work-dir", str(job_root), "--version", str(args.version),
        "--output", str(output),
    ])
    status = str(result.get("status") or "completed")
    update_state(job_root / "job_state.json", "S9", status)
    announce("S9", status, str(output))
    return 0


def e1_arguments(args: argparse.Namespace, job_root: Path, job_id: str) -> list[str]:
    values = ["--job-root", str(job_root), "--job-id", job_id, "--entry-category", args.entry]
    for source in args.input:
        values.extend(("--input", str(source.resolve())))
    if args.question:
        values.extend(("--question", args.question))
    if args.foundation_subject:
        values.extend(("--foundation-subject", args.foundation_subject))
    if args.product_scenario_subintent:
        values.extend(("--product-scenario-subintent", args.product_scenario_subintent))
    if args.monitoring_answers:
        values.extend(("--monitoring-answers", str(args.monitoring_answers.resolve())))
    if args.source_workbook:
        values.extend(("--source-workbook", str(args.source_workbook.resolve())))
    for value in args.constraint:
        values.extend(("--user-constraint", value))
    return values


def run_e2(job_root: Path, *, offline: bool = False) -> dict[str, Any]:
    content_job_path = job_root / "00_input/content_job.json"
    job = read_json(content_job_path)
    monitoring = job_path(job_root, job.get("monitoring_answers_path"))
    workbook = job_path(job_root, job.get("source_workbook_path"))
    if not monitoring or not workbook or not monitoring.is_file() or not workbook.is_file():
        raise ValueError("research_inputs_missing: monitoring answers and source workbook are both required")
    output = job_root / "E2/e2_pattern_analysis.json"
    values = [
        "--content-job", str(content_job_path), "--pattern-registry", str(PATTERN_REGISTRY),
        "--pattern-research-index", str(PATTERN_RESEARCH),
        "--monitoring-answers", str(monitoring), "--source-workbook", str(workbook),
        "--work-dir", str(job_root / "E2/cache"),
        "--monitoring-context-output", str(job_root / "E2/monitoring_context.json"),
        "--research-brief-output", str(job_root / "E2/research_brief.md"),
        "--output", str(output),
    ]
    if offline:
        values.append("--offline")
    run_script("E2", E2_SCRIPT, values)
    return read_json(output)


def pause_for_pattern(job_root: Path, analysis: dict[str, Any]) -> int:
    recommendation = analysis.get("recommendation") if isinstance(analysis.get("recommendation"), dict) else {}
    update_state(job_root / "job_state.json", "E2", "awaiting_pattern_confirmation", selected_pattern_id=None)
    recommended = str(recommendation.get("recommended_pattern_id") or "")
    alternatives = ", ".join(str(item) for item in recommendation.get("alternative_pattern_ids", [])) or "无"
    announce("E2", "awaiting_pattern_confirmation", f"建议 {recommended}；合法备选 {alternatives}")
    print(f"研究简报：{job_root / 'E2/research_brief.md'}")
    print(f"下一步：{next_action(job_root, read_json(job_root / 'job_state.json'))}")
    return 0


def p02_public_candidate_count(context: dict[str, Any]) -> int:
    """Count non-client candidates that have facts bound to public sources."""

    return sum(
        1 for item in context.get("candidate_profiles", [])
        if isinstance(item, dict)
        and item.get("role") != "featured_brand"
        and item.get("evidence_status") == "publicly_supported"
        and bool(item.get("fact_ids"))
        and bool(item.get("source_ids"))
    )


def p02_candidate_research_inputs(job_root: Path, context: dict[str, Any]) -> dict[str, Any]:
    """Build the compact research packet used by the fixed controller provider.

    Monitoring mentions and Top20 titles are discovery signals only.  The
    provider must return independently sourced public facts before E3 can mark
    a competitor as ``publicly_supported``.
    """

    job = read_json(job_root / "00_input/content_job.json")
    task = job.get("task") if isinstance(job.get("task"), dict) else {}
    monitoring_path = job_root / "E2/monitoring_context.json"
    analysis_path = job_root / "E2/e2_pattern_analysis.json"
    monitoring = read_json(monitoring_path) if monitoring_path.is_file() else {}
    analysis = read_json(analysis_path) if analysis_path.is_file() else {}
    derived = monitoring.get("derived") if isinstance(monitoring.get("derived"), dict) else {}
    brand_block = context.get("brand") if isinstance(context.get("brand"), dict) else {}
    customer_brand = str(brand_block.get("canonical_name") or "").strip()
    brand_alias_values = brand_block.get("aliases") if isinstance(brand_block.get("aliases"), list) else []

    def entity_key(value: Any) -> str:
        text = re.sub(r"[^0-9a-z\u3400-\u9fff]+", "", str(value or "").casefold())
        for suffix in (
            "医疗美容医院", "整形美容医院", "医疗美容门诊部", "医疗美容", "整形美容",
            "有限责任公司", "股份有限公司", "有限公司", "医美", "医院", "门诊部", "集团",
        ):
            if text.endswith(suffix) and len(text) > len(suffix) + 1:
                text = text[:-len(suffix)]
                break
        return text

    aliases = {
        entity_key(value) for value in (customer_brand, *brand_alias_values) if entity_key(value)
    }
    position_map = {
        str(item.get("entity") or "").strip(): [
            int(value) for value in item.get("positions", []) if isinstance(value, int)
        ]
        for item in derived.get("candidate_order_signals", [])
        if isinstance(item, dict) and str(item.get("entity") or "").strip()
    }
    monitoring_candidates = []
    for item in derived.get("competitors", []):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or entity_key(name) in aliases:
            continue
        monitoring_candidates.append({
            "name": name,
            "answer_ids": [str(value) for value in item.get("answer_ids", []) if str(value).strip()],
            "observed_positions": position_map.get(name, []),
        })

    observations = {
        int(item.get("raw_rank")): item
        for item in analysis.get("content_observations", [])
        if isinstance(item, dict) and isinstance(item.get("raw_rank"), int)
    }
    top20 = []
    for item in analysis.get("cited_content_pool", [])[:20]:
        if not isinstance(item, dict):
            continue
        rank = item.get("raw_rank")
        observation = observations.get(int(rank)) if isinstance(rank, int) else None
        unsafe = bool(observation and observation.get("status") == "unsafe_url")
        top20.append({
            "rank": rank,
            "title": item.get("content_title"),
            "url": None if unsafe else item.get("canonical_url"),
            "media_name": item.get("media_name"),
            "citation_count": item.get("citation_count"),
            "page_status": observation.get("status") if observation else None,
            "classified_pattern_id": observation.get("primary_pattern_id") if observation else None,
            "access_allowed": not unsafe,
        })

    question = str(task.get("question_text") or context.get("primary_question") or "").strip()
    dimensions = [
        str(value).strip() for value in derived.get("recurring_dimensions", []) if str(value).strip()
    ]
    if not dimensions and any(token in question for token in ("玻尿酸", "注射", "医美", "整形")):
        dimensions = [
            "机构与医生资质", "产品来源与验真", "面诊评估与适用需求",
            "风险告知与异常处置", "费用构成",
        ]
    already_supported = [
        {
            "name": str(item.get("display_name") or "").strip(),
            "fact_ids": [str(value) for value in item.get("fact_ids", []) if str(value).strip()],
            "source_ids": [str(value) for value in item.get("source_ids", []) if str(value).strip()],
        }
        for item in context.get("candidate_profiles", [])
        if isinstance(item, dict)
        and item.get("role") != "featured_brand"
        and item.get("evidence_status") == "publicly_supported"
        and item.get("fact_ids") and item.get("source_ids")
    ]
    return {
        "formal_question": question,
        "customer_brand": customer_brand,
        "monitoring_candidates": monitoring_candidates,
        "already_supported_candidates": already_supported,
        "top20_discovery_sources": top20,
        "common_dimensions": list(dict.fromkeys(dimensions))[:12],
        "research_goal": {
            "required_non_client_candidates": 2,
            "required_additional_candidates": max(0, 2 - len(already_supported)),
            "priority": "先核验监控中反复出现的真实候选；不足时再从 Top20 与可靠公开网页发现同题候选",
            "allowed_sources": ["候选官网", "政府登记或监管页面", "可靠专业媒体或公开数据库"],
            "forbidden_inferences": [
                "不得把监控提及、Top20 标题或编辑顺序写成候选事实、客观排名、疗效或安全结论",
                "不得用客户资料证明竞品优劣，不得编造医生、产品、价格、资质或口碑",
            ],
        },
        "output_contract": {
            "format": "JSON object",
            "sources": "公开 HTTP(S) 来源；每项含 source_id、title、url、source_kind",
            "facts": "每项含 statement、about_entities、source_ids，并以 candidate=true 或 candidate_facts 表明候选事实",
            "minimum": "尽可能为至少两个非客户候选各提供一条与共同维度有关、可由来源正文直接支持的事实",
        },
    }


def request_p02_candidate_research(job_root: Path, context: dict[str, Any]) -> tuple[Path | None, list[str]]:
    """Run optional public candidate research without creating a user pause."""

    expected = job_root / "E3/supplemental_research.json"
    action_path, action = controller_action(
        job_root,
        stage="E3",
        action="research_candidates",
        inputs=p02_candidate_research_inputs(job_root, context),
        expected_kind="supplemental_research_json",
        expected_path=expected,
    )
    try:
        response = invoke_provider(action_path, action)
        if response is None:
            return None, ["candidate_research_provider_unavailable"]
        if response.get("status") != "completed":
            reason = " ".join(str(response.get("reason") or response.get("status") or "unavailable").split())[:500]
            return None, [f"candidate_research_unavailable: {reason}"]
        output = provider_output_path(response, job_root)
        if output is None:
            return None, ["candidate_research_invalid: provider returned no safe JSON file"]
        try:
            payload = read_json(output)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            output.unlink(missing_ok=True)
            return None, [f"candidate_research_invalid: {type(exc).__name__}"]
        sources = payload.get("sources")
        facts = payload.get("facts") or payload.get("candidate_facts")
        if not isinstance(sources, list) or not isinstance(facts, list):
            output.unlink(missing_ok=True)
            return None, ["candidate_research_invalid: sources and facts are required arrays"]
        return output, []
    except Exception as exc:
        expected.unlink(missing_ok=True)
        clean = " ".join(str(exc).split())[:500]
        return None, [f"candidate_research_failed: {type(exc).__name__}: {clean}"]
    finally:
        action_path.unlink(missing_ok=True)


def run_e3(
    job_root: Path,
    brand: str | None = None,
    supplemental: Path | None = None,
    selected_pattern: str | None = None,
) -> Path:
    output = job_root / "E3/editorial_context.json"
    canonical_supplemental = job_root / "E3/supplemental_research.json"
    supplied = supplemental.resolve() if supplemental and supplemental.is_file() else None
    if supplied is None and canonical_supplemental.is_file():
        supplied = canonical_supplemental.resolve()

    def build(supplemental_path: Path | None) -> dict[str, Any]:
        values = [
            "--job-root", str(job_root), "--content-job", str(job_root / "00_input/content_job.json"),
            "--scope-analysis", str(job_root / "00_input/scope_analysis.json"), "--output", str(output),
        ]
        e2 = job_root / "E2/e2_pattern_analysis.json"
        monitoring = job_root / "E2/monitoring_context.json"
        if e2.is_file():
            values.extend(("--e2-analysis", str(e2)))
        if monitoring.is_file():
            values.extend(("--monitoring-context", str(monitoring)))
        if supplemental_path is not None:
            values.extend(("--supplemental-research", str(supplemental_path.resolve())))
        if brand:
            values.extend(("--brand", brand))
        return run_script("E3", E3_SCRIPT, values)

    result = build(supplied)
    context = read_json(output)
    warnings: list[str] = []
    if selected_pattern == "P02" and supplied is None and p02_public_candidate_count(context) < 2:
        researched, warnings = request_p02_candidate_research(job_root, context)
        if researched is not None:
            try:
                result = build(researched)
                context = read_json(output)
            except (RuntimeError, ValueError, OSError, json.JSONDecodeError) as exc:
                if researched == canonical_supplemental.resolve():
                    canonical_supplemental.unlink(missing_ok=True)
                warnings.append(f"candidate_research_invalid: {type(exc).__name__}")
        if p02_public_candidate_count(context) < 2:
            warnings.append("p02_candidate_evidence_still_insufficient")
    if warnings:
        current = read_json(job_root / "job_state.json")
        update_state(
            job_root / "job_state.json",
            "E3",
            "running",
            warnings=list(dict.fromkeys(warnings)),
            selected_pattern_id=current.get("selected_pattern_id"),
        )
    announce("E3", str(result.get("status") or "completed"))
    return output


def run_e4(job_root: Path, selected_pattern: str, blueprint_edits: Path | None = None) -> tuple[Path | None, dict[str, Any]]:
    output = job_root / "E4/article_blueprint.json"
    values = [
        "--content-job", str(job_root / "00_input/content_job.json"),
        "--working-context", str(job_root / "E3/editorial_context.json"),
        "--pattern-registry", str(PATTERN_REGISTRY),
        "--pattern-research-index", str(PATTERN_RESEARCH),
        "--selected-pattern", selected_pattern,
        "--blueprint-review", str(job_root / "E4/blueprint_review.md"),
        "--output", str(output),
    ]
    if blueprint_edits:
        values.extend(("--blueprint-edits", str(blueprint_edits.resolve())))
    result = run_script("E4", E4_SCRIPT, values)
    if result.get("status") == "awaiting_pattern_confirmation" or not output.is_file():
        return None, result
    announce("E4", str(result.get("status") or "completed"), f"selected {selected_pattern}")
    return output, result


def finish_blueprint_proposal(
    job_root: Path,
    selected_pattern: str,
    *,
    brand: str | None = None,
    supplemental: Path | None = None,
    blueprint_edits: Path | None = None,
) -> int:
    run_e3(job_root, brand, supplemental, selected_pattern)
    blueprint, result = run_e4(job_root, selected_pattern, blueprint_edits)
    state_path = job_root / "job_state.json"
    if blueprint is None:
        update_state(state_path, "E2", "awaiting_pattern_confirmation", selected_pattern_id=None)
        announce("E2", "awaiting_pattern_confirmation", str(result.get("message") or result.get("code") or "所选模式资料不足"))
        print(f"下一步：{next_action(job_root, read_json(state_path))}")
        return 0
    update_state(state_path, "E4", "awaiting_blueprint_confirmation", selected_pattern_id=selected_pattern)
    announce("E4", "awaiting_blueprint_confirmation", str(job_root / "E4/blueprint_review.md"))
    print(f"下一步：{next_action(job_root, read_json(state_path))}")
    return 0


def article(args: argparse.Namespace) -> int:
    job_root = args.job_dir.resolve()
    job_root.mkdir(parents=True, exist_ok=True)
    job_id = args.job_id or f"job_{uuid.uuid4().hex[:12]}"
    state_path = job_root / "job_state.json"
    write_json(state_path, make_state(job_id, "article", "E1"))
    run_script("E1", E1_SCRIPT, e1_arguments(args, job_root, job_id))
    announce("E1", "completed")
    job = read_json(job_root / "00_input/content_job.json")
    if job.get("entry_category") == "foundation_start":
        update_state(state_path, "E2", "skipped_optional", selected_pattern_id="P14")
        announce("E2", "skipped_optional", "foundation_start 固定 P14")
        return finish_blueprint_proposal(job_root, "P14", brand=args.brand, supplemental=args.supplemental_research)
    if not job.get("monitoring_answers_path") or not job.get("source_workbook_path"):
        update_state(state_path, "E1", "awaiting_research_inputs")
        announce("E1", "awaiting_research_inputs", "请提供同一正式问题的 AI 监控答案和引用信源工作簿")
        print(f"下一步：{next_action(job_root, read_json(state_path))}")
        return 0
    try:
        analysis = run_e2(job_root, offline=args.offline_research)
    except (RuntimeError, ValueError) as exc:
        update_state(state_path, "E1", "awaiting_research_inputs", warnings=[str(exc)[-1000:]])
        announce("E1", "awaiting_research_inputs", "研究文件未能精确对应正式问题，请修正或替换后继续")
        print(str(exc))
        return 0
    announce("E2", "completed")
    return pause_for_pattern(job_root, analysis)


def update_research_inputs(args: argparse.Namespace, job_root: Path) -> int:
    if not args.monitoring_answers or not args.source_workbook:
        return preserve_with_hint(job_root, read_json(job_root / "job_state.json"), "必须同时提供 AI 监控答案和引用信源工作簿。")
    content_job = job_root / "00_input/content_job.json"
    run_script("E1", E1_SCRIPT, [
        "--job-root", str(job_root), "--raw-job", str(content_job),
        "--monitoring-answers", str(args.monitoring_answers.resolve()),
        "--source-workbook", str(args.source_workbook.resolve()),
    ])
    announce("E1", "completed", "研究输入已关联正式问题")
    try:
        analysis = run_e2(job_root, offline=args.offline_research)
    except (RuntimeError, ValueError) as exc:
        update_state(job_root / "job_state.json", "E1", "awaiting_research_inputs", warnings=[str(exc)[-1000:]])
        announce("E1", "awaiting_research_inputs", "混合问题或字段匹配仍不可靠，请修正研究文件")
        print(str(exc))
        return 0
    announce("E2", "completed")
    return pause_for_pattern(job_root, analysis)


def confirm_pattern(args: argparse.Namespace, job_root: Path) -> int:
    analysis = read_json(job_root / "E2/e2_pattern_analysis.json")
    recommendation = analysis.get("recommendation") if isinstance(analysis.get("recommendation"), dict) else {}
    recommended = str(recommendation.get("recommended_pattern_id") or "")
    alternatives = [str(item) for item in recommendation.get("alternative_pattern_ids", [])]
    selected = recommended if args.accept_pattern else str(args.selected_pattern or "")
    legal_choices = list(dict.fromkeys([recommended, *alternatives]))
    if selected not in legal_choices or not PATTERN_RE.fullmatch(selected):
        return preserve_with_hint(job_root, read_json(job_root / "job_state.json"), f"请选择 E2 展示的合法类型：{', '.join(legal_choices)}")
    update_state(job_root / "job_state.json", "E2", "completed", selected_pattern_id=selected)
    return finish_blueprint_proposal(job_root, selected, supplemental=args.supplemental_research)


def run_content_stages(
    job_root: Path,
    authored_model: Path | None = None,
    edited_model: Path | None = None,
    generated_images: list[str] | None = None,
    *,
    start_stage: str = "E5",
) -> int:
    """Continue from the newest content-bearing stage, not an audit cursor."""
    state_path = job_root / "job_state.json"
    context = job_root / "E3/editorial_context.json"
    blueprint = job_root / "E4/article_blueprint.json"
    order = {stage: index for index, stage in enumerate(("E5", "E6", "E7", "E8", "E9", "E10"), 5)}
    if start_stage not in order:
        raise ValueError(f"unsupported resume stage: {start_stage}")

    draft_raw = job_root / "E5/generated_draft.json"
    draft = job_root / "E5/content_model.json"
    fact_checked = job_root / "E6/fact_checked.json"
    planned = job_root / "E7/content_visual_planned.json"
    prompt_plan = job_root / "E7/prompt_plan.json"
    visual_model = job_root / "E7/content_with_visuals.json"
    selection = job_root / "E7/visual_selection.json"
    editorial = job_root / "E8/editorial_master.json"
    harnessgeo_candidate = job_root / "E9/harnessgeo_candidate.json"
    legacy_autogeo_candidate = job_root / "E9/autogeo_candidate.json"
    candidate = (
        harnessgeo_candidate if harnessgeo_candidate.is_file() or not legacy_autogeo_candidate.is_file()
        else legacy_autogeo_candidate
    )
    final_model = job_root / "E10/final_content_model.json"

    direct_requirements = {
        "E5": ((context, "E3 editorial context"), (blueprint, "E4 article blueprint")),
        "E6": ((draft, "E5 content model"), (context, "E3 editorial context")),
        "E7": (
            (fact_checked, "E6 fact-checked article"),
            (context, "E3 editorial context"),
            (blueprint, "E4 article blueprint"),
        ),
        "E8": (
            (visual_model, "E7 article output"),
            (context, "E3 editorial context"),
            (blueprint, "E4 article blueprint"),
        ),
        "E9": ((editorial, "E8 editorial master"),),
        "E10": (
            (editorial, "E8 editorial master"),
            (candidate, "E9 HarnessGEO candidate"),
        ),
    }
    def require_stage_inputs(stage: str) -> None:
        for path, label in direct_requirements[stage]:
            if not path.is_file():
                raise ValueError(f"no_usable_content: {label} is absent")

    require_stage_inputs(start_stage)

    if order[start_stage] <= order["E5"]:
        update_state(state_path, "E5", "running")
        packet = job_root / "E5/writing_packet.json"
        provider_authored = job_root / "E5/provider_authored_model.json"
        if authored_model is None and provider_authored.is_file():
            authored_model = provider_authored
        if not draft.is_file():
            # A generated draft is a valid crash-recovery point: validation can
            # continue without asking the authoring provider to write it again.
            if not draft_raw.is_file() or authored_model is not None:
                if authored_model is None:
                    if not packet.is_file():
                        result = run_script("E5", E5_BUILD, [
                            "--working-context", str(context), "--blueprint", str(blueprint),
                            "--writing-packet", str(packet), "--packet-only", "--job-state", str(state_path),
                        ])
                    else:
                        result = {"status": "ready_for_internal_authoring"}
                    expected = job_root / "E5/provider_authored_model.json"
                    action_path, action = controller_action(
                        job_root,
                        stage="E5",
                        action="author_article",
                        inputs={
                            "writing_packet": str(packet),
                            "working_context": str(context),
                            "article_blueprint": str(blueprint),
                        },
                        expected_kind="content_model_json",
                        expected_path=expected,
                    )
                    response = invoke_provider(action_path, action)
                    if response and response.get("status") == "completed":
                        authored_model = provider_output_path(response, job_root)
                    if authored_model is None:
                        if response:
                            update_state(
                                state_path, "E5", "running",
                                warnings=["internal_authoring_provider_unavailable"],
                            )
                        announce("E5", "internal_authoring", str(packet))
                        print(json.dumps({
                            "status": "controller_handoff",
                            "contract": PROVIDER_CONTRACT,
                            "user_pause": False,
                            "action": action,
                            "message": "总控须在本次任务内整篇撰写无标题 Content Model，然后自动续跑；不向用户索取隐藏参数。",
                            "resume": {
                                "command": "continue",
                                "arguments": ["--job-dir", str(job_root), "--authored-model", "<controller-output.json>"],
                            },
                            "producer_status": result.get("status"),
                        }, ensure_ascii=False, indent=2))
                        return 0
                run_script("E5", E5_BUILD, [
                    "--working-context", str(context), "--blueprint", str(blueprint),
                    "--writing-packet", str(packet),
                    "--output", str(draft_raw), "--job-state", str(state_path),
                    "--authored-model", str(authored_model.resolve()),
                ])
                (job_root / "E5/controller_action.json").unlink(missing_ok=True)
            result = run_script("E5", E5_VALIDATE, [
                "--model", str(draft_raw), "--working-context", str(context), "--blueprint", str(blueprint),
                "--output", str(draft), "--summary", str(job_root / "E5/summary.json"), "--job-state", str(state_path),
            ])
        else:
            result = {"status": "completed"}
        status = str(result.get("status") or "completed")
        update_state(state_path, "E5", status)
        announce("E5", status)

    if order[start_stage] <= order["E6"]:
        require_stage_inputs("E6")
        update_state(state_path, "E6", "running")
        if not fact_checked.is_file():
            result = run_script("E6", E6_SCRIPT, [
                "--draft", str(draft), "--working-context", str(context), "--output", str(fact_checked),
                "--summary", str(job_root / "E6/summary.json"), "--job-state", str(state_path),
            ])
        else:
            result = {"status": "completed"}
        status = str(result.get("status") or "completed")
        update_state(state_path, "E6", status)
        announce("E6", status)

    if order[start_stage] <= order["E7"]:
        require_stage_inputs("E7")
        update_state(state_path, "E7", "running")
        if not planned.is_file() or not prompt_plan.is_file():
            result = run_script("E7", E7_PLAN, [
                "--model", str(fact_checked), "--working-context", str(context), "--blueprint", str(blueprint),
                "--output-model", str(planned), "--prompt-plan", str(prompt_plan),
            ])
        else:
            result = {"status": "completed"}
        announce("E7", str(result.get("status") or "completed"), "真实资产优先；缺失视觉已形成安全生产计划")
        prompt_items = [
            item for item in read_json(prompt_plan).get("images", [])
            if isinstance(item, dict) and item.get("visual_id")
        ]
        generated_assets = job_root / "E7/generated_assets.json"
        provided: dict[str, Path | None] = {}
        for value in generated_images or []:
            visual_id, separator, raw_path = value.partition("=")
            if not separator or not re.fullmatch(r"vis_[a-zA-Z0-9_-]+", visual_id):
                raise ValueError("internal visual result must use VISUAL_ID=/path/to/image or VISUAL_ID=NO_FILE")
            if raw_path.strip().casefold() in {"no_file", "none", "unavailable"}:
                provided[visual_id] = None
            else:
                path = Path(raw_path).resolve()
                if path.is_symlink() or not path.is_file():
                    raise ValueError(f"internal generated image is missing or a symlink: {path}")
                provided[visual_id] = path
        prompt_ids = {str(item["visual_id"]) for item in prompt_items}
        unknown = set(provided) - prompt_ids
        if unknown:
            raise ValueError("generated image does not match E7 prompt plan: " + ", ".join(sorted(unknown)))
        for visual_id, path in provided.items():
            values = [
                "--prompt-plan", str(prompt_plan), "--visual-id", visual_id,
                "--working-context", str(context),
                "--asset-root", str(job_root), "--output-dir", str(job_root / "E7/generated"),
                "--result", str(generated_assets),
            ]
            if path is not None:
                values.extend(("--generated-image", str(path)))
            run_script("E7", E7_AIGC, values)
        attempted = {
            str(item.get("visual_id"))
            for item in (read_json(generated_assets).get("attempts", []) if generated_assets.is_file() else [])
            if isinstance(item, dict)
        }
        remaining = [item for item in prompt_items if str(item["visual_id"]) not in attempted]
        if remaining:
            if provider_command() is not None:
                for item in remaining:
                    visual_id = str(item["visual_id"])
                    expected = job_root / "E7/provider" / f"{visual_id}.png"
                    action_path, action = controller_action(
                        job_root,
                        stage="E7",
                        action="generate_image",
                        inputs={"prompt_plan": str(prompt_plan), "visual": item},
                        expected_kind="image_file_or_no_file",
                        expected_path=expected,
                    )
                    response = invoke_provider(action_path, action) or {"status": "unavailable"}
                    image_path = provider_output_path(response, job_root) if response.get("status") == "completed" else None
                    values = [
                        "--prompt-plan", str(prompt_plan), "--visual-id", visual_id,
                        "--working-context", str(context), "--asset-root", str(job_root),
                        "--output-dir", str(job_root / "E7/generated"), "--result", str(generated_assets),
                    ]
                    if image_path is not None:
                        values.extend(("--generated-image", str(image_path)))
                    run_script("E7", E7_AIGC, values)
            else:
                action_path, action = controller_action(
                    job_root,
                    stage="E7",
                    action="generate_images",
                    inputs={"prompt_plan": str(prompt_plan), "visuals": remaining},
                    expected_kind="image_results",
                )
                update_state(state_path, "E7", "running", warnings=["internal_visual_generation_pending"])
                announce("E7", "internal_visual_generation", f"{len(remaining)} 个视觉槽位等待真实图工具返回")
                print(json.dumps({
                    "status": "controller_handoff",
                    "contract": PROVIDER_CONTRACT,
                    "user_pause": False,
                    "action": action,
                    "action_path": str(action_path),
                    "message": "总控须在本次任务内逐图调用真实图像工具；每个槽位无论返回文件或 NO_FILE 都立即续跑，不向用户询问。",
                    "resume": {
                        "command": "continue",
                        "arguments": [
                            "--job-dir", str(job_root),
                            "--generated-image", "<visual_id>=<tool-file-or-NO_FILE>",
                        ],
                    },
                }, ensure_ascii=False, indent=2))
                return 0
        select_values = [
            "--model", str(planned), "--working-context", str(context), "--asset-root", str(job_root),
            "--output-model", str(visual_model), "--selection", str(selection), "--job-state", str(state_path),
        ]
        if generated_assets.is_file():
            select_values.extend(("--generated-assets", str(generated_assets)))
        result = run_script("E7", E7_SELECT, select_values)
        (job_root / "E7/controller_action.json").unlink(missing_ok=True)
        status = str(result.get("status") or "completed")
        update_state(state_path, "E7", status)
        announce("E7", status)

    if order[start_stage] <= order["E8"]:
        require_stage_inputs("E8")
        update_state(state_path, "E8", "running")
        editing_brief = job_root / "E8/editing_brief.json"
        provider_edited = job_root / "E8/provider_edited_model.json"
        if edited_model is None and provider_edited.is_file():
            edited_model = provider_edited
        if not editorial.is_file():
            if edited_model is None:
                result = run_script("E8", E8_SCRIPT, [
                    "--model", str(visual_model), "--working-context", str(context), "--blueprint", str(blueprint),
                    "--editing-brief", str(editing_brief), "--brief-only", "--job-state", str(state_path),
                ])
                expected = job_root / "E8/provider_edited_model.json"
                action_path, action = controller_action(
                    job_root,
                    stage="E8",
                    action="edit_article",
                    inputs={
                        "editing_brief": str(editing_brief),
                        "working_context": str(context),
                        "article_blueprint": str(blueprint),
                    },
                    expected_kind="content_model_json",
                    expected_path=expected,
                )
                response = invoke_provider(action_path, action)
                if response and response.get("status") == "completed":
                    edited_model = provider_output_path(response, job_root)
                if edited_model is None:
                    if response:
                        update_state(
                            state_path, "E8", "running",
                            warnings=["internal_editing_provider_unavailable"],
                        )
                    announce("E8", "internal_editing", str(editing_brief))
                    print(json.dumps({
                        "status": "controller_handoff",
                        "contract": PROVIDER_CONTRACT,
                        "user_pause": False,
                        "action": action,
                        "message": "总控须在本次任务内完成内容、行文、事实三轮整篇编辑，然后自动续跑；不向用户索取隐藏参数。",
                        "resume": {
                            "command": "continue",
                            "arguments": ["--job-dir", str(job_root), "--edited-model", "<controller-output.json>"],
                        },
                        "producer_status": result.get("status"),
                    }, ensure_ascii=False, indent=2))
                    return 0
            try:
                result = run_script("E8", E8_SCRIPT, [
                    "--model", str(visual_model), "--working-context", str(context), "--blueprint", str(blueprint),
                    "--editing-brief", str(editing_brief), "--edited-model", str(edited_model.resolve()),
                    "--output", str(editorial), "--summary", str(job_root / "E8/summary.json"), "--job-state", str(state_path),
                ])
                (job_root / "E8/controller_action.json").unlink(missing_ok=True)
            except RuntimeError as exc:
                if "internal editorial rewrite" not in str(exc).casefold():
                    raise
                action_path, action = controller_action(
                    job_root,
                    stage="E8",
                    action="edit_article",
                    inputs={
                        "editing_brief": str(editing_brief),
                        "working_context": str(context),
                        "article_blueprint": str(blueprint),
                        "validation_feedback": str(exc)[-1500:],
                    },
                    expected_kind="content_model_json",
                    expected_path=job_root / "E8/provider_edited_model.json",
                )
                update_state(state_path, "E8", "running", warnings=["internal_editorial_rewrite_required"])
                print(json.dumps({
                    "status": "controller_handoff",
                    "contract": PROVIDER_CONTRACT,
                    "user_pause": False,
                    "action": action,
                    "action_path": str(action_path),
                    "message": "编辑校验仍有具体性或事实绑定问题；总控须吸收反馈整篇重编后自动续跑。",
                    "resume": {
                        "command": "continue",
                        "arguments": ["--job-dir", str(job_root), "--edited-model", "<revised-controller-output.json>"],
                    },
                }, ensure_ascii=False, indent=2))
                return 0
        else:
            result = {"status": "completed"}
        status = str(result.get("status") or "completed")
        update_state(state_path, "E8", status)
        announce("E8", status)

    if order[start_stage] <= order["E9"]:
        require_stage_inputs("E9")
        update_state(state_path, "E9", "running")
        if not candidate.is_file():
            result = run_script("E9", E9_SCRIPT, [
                "--editorial-master", str(editorial), "--output", str(candidate),
                "--summary", str(job_root / "E9/summary.json"), "--job-state", str(state_path),
            ])
        else:
            result = {"status": "completed"}
        status = str(result.get("status") or "completed")
        update_state(state_path, "E9", status)
        announce("E9", status, "整篇无标题正文已提交 HarnessGEO")

    require_stage_inputs("E10")
    update_state(state_path, "E10", "running")
    if not final_model.is_file():
        select_arguments = [
            "--editorial-master", str(editorial), "--harnessgeo-candidate", str(candidate),
            "--output", str(final_model), "--summary", str(job_root / "E10/body_selection.json"),
            "--job-state", str(state_path),
        ]
        if context.is_file():
            select_arguments.extend(("--working-context", str(context)))
        result = run_script("E10", E10_SELECT, select_arguments)
    else:
        result = {"selected_body": "recovered_final_body"}
    announce("E10", "body_selected", str(result.get("selected_body") or ""))
    run_script("E10", E10_COUNT, ["--job-state", str(state_path)])
    update_state(state_path, "E10", "awaiting_title_count", title_count=None)
    announce("E10", "awaiting_title_count", "请输入 1–20 个标题")
    print(f"下一步：{next_action(job_root, read_json(state_path))}")
    return 0


def confirm_blueprint(args: argparse.Namespace, job_root: Path) -> int:
    state_path = job_root / "job_state.json"
    selected = str(read_json(state_path).get("selected_pattern_id") or "")
    if not selected:
        raise ValueError("awaiting_pattern_confirmation: no P type has been confirmed")
    if args.blueprint_edits:
        blueprint, result = run_e4(job_root, selected, args.blueprint_edits)
        if blueprint is None:
            update_state(state_path, "E2", "awaiting_pattern_confirmation", selected_pattern_id=None)
            announce("E2", "awaiting_pattern_confirmation", str(result.get("message") or "蓝图编辑后模式条件不再满足"))
            return 0
    elif not args.accept_blueprint:
        return preserve_with_hint(job_root, read_json(state_path), "请确认蓝图或提供蓝图编辑文件。")
    update_state(state_path, "E4", "completed")
    return run_content_stages(job_root, authored_model=args.authored_model)


def deliver_titles(args: argparse.Namespace, job_root: Path) -> int:
    count = args.title_count
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 20:
        return preserve_with_hint(job_root, read_json(job_root / "job_state.json"), "标题数量必须是 1–20 的整数。")
    state_path = job_root / "job_state.json"
    final_model = job_root / "E10/final_content_model.json"
    if not final_model.is_file():
        raise ValueError("no_usable_content: E10 final body is absent")
    run_script("E10", E10_COUNT, ["--job-state", str(state_path), "--count", str(count)])
    title_map = job_root / "E10/title_map.json"
    run_script("E10", E10_TITLES, [
        "--content-model", str(final_model), "--job-state", str(state_path),
        "--pattern-registry", str(PATTERN_REGISTRY), "--output", str(title_map),
    ])
    render_values = [
        "--content-model", str(final_model), "--title-map", str(title_map),
        "--job-state", str(state_path), "--output-dir", str(job_root / "delivery"),
    ]
    visual = job_root / "E7/visual_selection.json"
    if visual.is_file():
        render_values.extend(("--visual-selection", str(visual), "--asset-root", str(job_root)))
    try:
        result = run_script("E10", E10_RENDER, render_values)
    except RuntimeError as exc:
        blocker = {"code": "render_failed", "message": str(exc)[-1500:]}
        update_state(state_path, "E10", "blocked", title_count=count, blocker=blocker)
        announce("E10", "blocked", blocker["message"])
        return 2
    status = str(result.get("status") or "completed")
    update_state(state_path, "E10", status, title_count=count)
    announce("E10", status, str(job_root / "delivery"))
    return 0


def recover_state(job_root: Path) -> dict[str, Any]:
    """Rebuild progress from the newest content-bearing artifact.

    A state update and an artifact write cannot be atomic across independent
    stage programs.  Therefore ``completed`` is terminal only for S9 or a
    delivered E10 job; every other non-pause state is reconciled against actual
    content.  This intentionally recovers E5-E10 crash windows without a hash
    ledger or receipt chain.
    """

    state_path = job_root / "job_state.json"
    existing: dict[str, Any] = {}
    if state_path.is_file():
        existing = read_json(state_path)
        if existing.get("workflow_mode") == "prepare":
            return existing
        if existing.get("status") == "blocked":
            return existing
        job_id = str(existing.get("job_id") or f"job_{uuid.uuid4().hex[:12]}")
    else:
        job = read_json(job_root / "00_input/content_job.json") if (job_root / "00_input/content_job.json").is_file() else {}
        job_id = str(job.get("job_id") or f"job_{uuid.uuid4().hex[:12]}")
    state = make_state(job_id, "article", "E1")
    state["selected_pattern_id"] = existing.get("selected_pattern_id")
    state["title_count"] = existing.get("title_count")
    state["warnings"] = existing.get("warnings", []) if isinstance(existing.get("warnings"), list) else []

    delivery_index = job_root / "delivery/delivery_index.json"
    if delivery_index.is_file():
        state.update({"current_stage": "E10", "status": "completed"})
    elif (job_root / "E10/final_content_model.json").is_file() or (job_root / "E9/final_content_model.json").is_file():
        old = job_root / "E9/final_content_model.json"
        target = job_root / "E10/final_content_model.json"
        if old.is_file() and not target.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old, target)
        state.update({"current_stage": "E10", "status": "awaiting_title_count", "title_count": None})
    elif (
        (job_root / "E9/harnessgeo_candidate.json").is_file()
        or (job_root / "E9/autogeo_candidate.json").is_file()
    ) and (job_root / "E8/editorial_master.json").is_file():
        state.update({"current_stage": "E10", "status": "running"})
    elif (job_root / "E8/editorial_master.json").is_file():
        state.update({"current_stage": "E9", "status": "running"})
    elif (job_root / "E7/content_with_visuals.json").is_file():
        state.update({"current_stage": "E8", "status": "running"})
    elif (job_root / "E8/editing_brief.json").is_file():
        state.update({"current_stage": "E8", "status": "running"})
    elif (job_root / "E6/fact_checked.json").is_file() or (job_root / "E7/prompt_plan.json").is_file():
        state.update({"current_stage": "E7", "status": "running"})
    elif (job_root / "E5/content_model.json").is_file():
        state.update({"current_stage": "E6", "status": "running"})
    elif (job_root / "E5/generated_draft.json").is_file() or (job_root / "E5/writing_packet.json").is_file():
        state.update({"current_stage": "E5", "status": "running"})
    elif (job_root / "E4/article_blueprint.json").is_file():
        blueprint = read_json(job_root / "E4/article_blueprint.json")
        selected = blueprint.get("selected_pattern_id")
        accepted_blueprint = (
            existing.get("current_stage") == "E4"
            and existing.get("status") in {"completed", "completed_with_limits"}
        ) or existing.get("current_stage") in {"E5", "E6", "E7", "E8", "E9", "E10"}
        if accepted_blueprint:
            state.update({"current_stage": "E5", "status": "running", "selected_pattern_id": selected})
        else:
            state.update({
                "current_stage": "E4", "status": "awaiting_blueprint_confirmation",
                "selected_pattern_id": selected,
            })
    elif (job_root / "E3/editorial_context.json").is_file() and existing.get("selected_pattern_id"):
        state.update({"current_stage": "E4", "status": "running"})
    elif (job_root / "E2/e2_pattern_analysis.json").is_file():
        if existing.get("current_stage") == "E2" and existing.get("status") in {"completed", "completed_with_limits"} and existing.get("selected_pattern_id"):
            state.update({"current_stage": "E3", "status": "running"})
        else:
            state.update({"current_stage": "E2", "status": "awaiting_pattern_confirmation"})
    elif (job_root / "00_input/content_job.json").is_file():
        job = read_json(job_root / "00_input/content_job.json")
        if job.get("entry_category") == "foundation_start" and existing.get("selected_pattern_id") == "P14":
            state.update({"current_stage": "E3", "status": "running", "selected_pattern_id": "P14"})
        else:
            state.update({"current_stage": "E1", "status": "awaiting_research_inputs"})
    write_json(state_path, state)
    return state


def continue_workflow(args: argparse.Namespace) -> int:
    job_root = args.job_dir.resolve()
    state = recover_state(job_root)
    if state.get("workflow_mode") == "prepare":
        return continue_prepare(args, state)
    status = state.get("status")
    if status == "running" and state.get("current_stage") in {"E3", "E4"}:
        selected = str(state.get("selected_pattern_id") or "")
        if not PATTERN_RE.fullmatch(selected):
            raise ValueError("awaiting_pattern_confirmation: no valid selected P type is available for recovery")
        return finish_blueprint_proposal(job_root, selected, supplemental=args.supplemental_research)
    if status == "running" and state.get("current_stage") in {"E5", "E6", "E7", "E8", "E9", "E10"}:
        return run_content_stages(
            job_root,
            authored_model=args.authored_model,
            edited_model=args.edited_model,
            generated_images=args.generated_image,
            start_stage=str(state["current_stage"]),
        )
    if status == "awaiting_research_inputs":
        if args.monitoring_answers or args.source_workbook:
            return update_research_inputs(args, job_root)
        return preserve_with_hint(job_root, state, "当前等待两份同题研究输入。")
    if status == "awaiting_pattern_confirmation":
        if args.accept_pattern or args.selected_pattern:
            return confirm_pattern(args, job_root)
        return preserve_with_hint(job_root, state, "当前等待确认 E2 推荐的文章类型。")
    if status == "awaiting_blueprint_confirmation":
        if args.accept_blueprint or args.blueprint_edits:
            return confirm_blueprint(args, job_root)
        return preserve_with_hint(job_root, state, "当前等待确认文章蓝图。")
    if status == "awaiting_title_count":
        if args.title_count is not None:
            return deliver_titles(args, job_root)
        return preserve_with_hint(job_root, state, "当前等待标题数量。")
    return preserve_with_hint(job_root, state, "当前状态不接受该操作。")


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="FrontMind GEO Content Workflow v2.3")
    commands = value.add_subparsers(dest="command", required=True)

    prepare_parser = commands.add_parser("prepare", help="run S1-S8 and pause for Pack summary confirmation")
    prepare_parser.add_argument("--brand", required=True)
    prepare_parser.add_argument("--input", action="append", type=Path, required=True)
    prepare_parser.add_argument("--work-dir", type=Path, required=True)
    prepare_parser.add_argument("--trend-signals", type=Path)
    prepare_parser.add_argument("--intake-route", choices=["auto", "direct", "legacy_enrichment"], default="auto")
    prepare_parser.add_argument("--job-id")
    prepare_parser.set_defaults(handler=prepare)

    article_parser = commands.add_parser("article", help="run E1-E2 and pause for the P-type decision")
    article_parser.add_argument("--input", action="append", type=Path, required=True)
    article_parser.add_argument("--job-dir", type=Path, required=True)
    article_parser.add_argument("--brand")
    article_parser.add_argument("--entry", required=True, choices=[
        "industry_ranking", "competitor_comparison", "reputation", "product_scenario", "foundation_start",
    ])
    article_parser.add_argument("--question")
    article_parser.add_argument("--foundation-subject")
    article_parser.add_argument("--product-scenario-subintent")
    article_parser.add_argument("--monitoring-answers", type=Path)
    article_parser.add_argument("--source-workbook", type=Path)
    article_parser.add_argument("--supplemental-research", type=Path, help=argparse.SUPPRESS)
    article_parser.add_argument("--constraint", action="append", default=[])
    article_parser.add_argument("--offline-research", action="store_true", help=argparse.SUPPRESS)
    article_parser.add_argument("--job-id")
    article_parser.set_defaults(handler=article)

    continue_parser = commands.add_parser("continue", help="resume the one content decision currently awaiting input")
    continue_parser.add_argument("--job-dir", type=Path, required=True)
    continue_parser.add_argument("--confirm-pack", action="store_true")
    continue_parser.add_argument("--monitoring-answers", type=Path)
    continue_parser.add_argument("--source-workbook", type=Path)
    continue_parser.add_argument("--accept-pattern", action="store_true")
    continue_parser.add_argument("--selected-pattern")
    continue_parser.add_argument("--supplemental-research", type=Path, help=argparse.SUPPRESS)
    continue_parser.add_argument("--accept-blueprint", action="store_true")
    continue_parser.add_argument("--blueprint-edits", type=Path)
    continue_parser.add_argument("--authored-model", type=Path, help=argparse.SUPPRESS)
    continue_parser.add_argument("--edited-model", type=Path, help=argparse.SUPPRESS)
    continue_parser.add_argument("--generated-image", action="append", default=[], help=argparse.SUPPRESS)
    continue_parser.add_argument("--title-count", type=int)
    continue_parser.add_argument("--output", type=Path, help="optional S9 Pack output when confirming a prepare job")
    continue_parser.add_argument("--version", type=int, default=1)
    continue_parser.add_argument("--offline-research", action="store_true", help=argparse.SUPPRESS)
    continue_parser.set_defaults(handler=continue_workflow)
    return value


def main() -> int:
    args = parser().parse_args()
    try:
        return int(args.handler(args))
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
