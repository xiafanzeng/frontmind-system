#!/usr/bin/env python3
"""Create the v2.3 editorial master through three in-stage editing passes."""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
sys.path.insert(0, str(SHARED))
from content_first_runtime import (  # noqa: E402
    load_object, refresh_references, title_field_paths, update_job_state, visible_text, write_json,
)
from schema_validation import validate_root, validate_schema  # noqa: E402
from text_quality import article_specificity_errors, material_fact_binding_errors  # noqa: E402


BANNED_PUBLIC_PHRASES = (
    "资料较完整", "相关资料显示", "以审核为准", "服务边界", "信息边界", "保持克制",
    "用户提交资料", "用户上传资料", "客户资料", "需要说明", "不构成对", "待核验候选",
    "当前团队与产品待核验", "当前医师与产品待核验", "当前可公开资料不足",
    "资料粒度不同", "预研模板", "内部审稿", "审核回执", "工作流思考",
)
META_FAQ_MARKERS = (
    "客观排名", "为什么先介绍", "编辑顺序", "有哪些可核验信息", "待核验",
    "这份名单", "本文为什么", "资料是否", "证据是否",
)
RANK_PHRASES = (
    "综合排名第一", "综合第一", "排名第一", "市场最佳", "得分最高", "榜首", "第1名",
    "第一名", "Top 1", "Top1", "最好", "最安全", "最权威",
)
OBJECTIVE_RANK_RE = re.compile(
    r"(?:第\s*1\s*名|第一名|榜首|综合第一|综合排名第一|得分最高|市场最佳|行业第一|"
    r"(?:top|no\.?|number)\s*[-_#]?\s*1(?![A-Za-z0-9_])|最好|最安全|最权威)",
    flags=re.IGNORECASE,
)
CONNECTOR_RE = re.compile(r"^(?:首先|其次|此外|另外|综上所述|总的来说|需要注意的是)[，,:：\s]*")


def compact(value: Any) -> str:
    text = " ".join(str(value or "").split()).strip()
    if re.search(r"[\u3400-\u9fff]", text):
        text = text.replace(",", "，").replace(";", "；").replace(":", "：").replace("?", "？")
    return re.sub(r"\s+([，。；：！？])", r"\1", text)


def sentence_parts(value: str) -> list[str]:
    return [item for item in re.split(r"(?<=[。！？])\s*", compact(value)) if item.strip()]


def normalized(value: str) -> str:
    return re.sub(r"[^\u3400-\u9fffA-Za-z0-9]", "", value).casefold()


def near_duplicate(left: str, right: str, threshold: float = 0.86) -> bool:
    a, b = normalized(left), normalized(right)
    if not a or not b:
        return False
    if a in b or b in a:
        return min(len(a), len(b)) >= 25
    if min(len(a), len(b)) < 25:
        return False
    return SequenceMatcher(None, a, b, autojunk=False).ratio() >= threshold


def known_facts(context: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not context:
        return {}
    raw = context.get("fact_cards") if isinstance(context.get("fact_cards"), list) else context.get("facts", [])
    return {str(item.get("fact_id")): item for item in raw if isinstance(item, dict) and item.get("fact_id")}


def public_text_fields(model: dict[str, Any]) -> list[tuple[str, str]]:
    """Return public prose without changing a single authored character."""
    values: list[tuple[str, str]] = []
    lead = model.get("lead")
    if isinstance(lead, dict):
        values.append(("lead", str(lead.get("text") or "")))
    for section in model.get("sections", []):
        if not isinstance(section, dict):
            continue
        section_id = str(section.get("section_id") or "section")
        values.append((f"{section_id}:heading", str(section.get("heading") or "")))
        values.extend(
            (f"{section_id}:paragraph:{index}", str(item.get("text") or ""))
            for index, item in enumerate(section.get("paragraphs", [])) if isinstance(item, dict)
        )
    for index, item in enumerate(model.get("faq", [])):
        if isinstance(item, dict):
            values.append((f"faq:{index}:question", str(item.get("question") or "")))
            values.append((f"faq:{index}:answer", str(item.get("answer") or "")))
    conclusion = model.get("conclusion")
    if isinstance(conclusion, dict):
        values.extend(
            (f"conclusion:{index}", str(item.get("text") or ""))
            for index, item in enumerate(conclusion.get("paragraphs", [])) if isinstance(item, dict)
        )
    return values


def editing_issues(
    model: dict[str, Any], context: dict[str, Any] | None,
    blueprint: dict[str, Any] | None = None,
) -> list[str]:
    """Audit the provider's prose; findings trigger another whole-article edit.

    E8 deliberately does not rewrite, replace, or delete prose.  Deterministic
    code is a critic and verifier only; the editing provider owns every
    semantic change.
    """
    issues: list[str] = []
    voice = context.get("voice_profile") if isinstance(context, dict) else None
    dynamic_banned = tuple(
        str(value) for value in (voice.get("forbidden_public_phrases", []) if isinstance(voice, dict) else [])
        if str(value).strip()
    )
    text_fields = public_text_fields(model)
    for location, text in text_fields:
        for phrase in (*BANNED_PUBLIC_PHRASES, *dynamic_banned):
            if phrase and phrase in text:
                issues.append(f"public_language:{location}:{phrase}")
        if re.search(r"(?:仍|均|皆)?(?:待|需)(?:进一步)?(?:核验|确认|补充)", text):
            issues.append(f"public_language:{location}:pending_review_phrase")
        if model.get("pattern_id") in {"P01", "P02"} and OBJECTIVE_RANK_RE.search(text):
            issues.append(f"objective_rank:{location}")

    if model.get("pattern_id") == "P02":
        contract = model.get("candidate_contract") if isinstance(model.get("candidate_contract"), dict) else {}
        names = [
            compact(item.get("display_name")) for item in contract.get("ordered_candidates", [])
            if isinstance(item, dict) and compact(item.get("display_name"))
        ]
        lead_text = str((model.get("lead") or {}).get("text") or "")
        if len(names) < 3:
            issues.append("P02_requires_three_real_candidates")
        elif not all(name in lead_text for name in names[:3]):
            issues.append("P02_lead_must_name_first_three_candidates")

    questions: list[str] = []
    answers: list[str] = []
    for index, item in enumerate(model.get("faq", [])):
        if not isinstance(item, dict):
            continue
        question = compact(item.get("question"))
        answer = compact(item.get("answer"))
        if not question or any(marker in question for marker in META_FAQ_MARKERS):
            issues.append(f"faq:{index}:workflow_facing_question")
        if any(near_duplicate(question, previous, 0.83) for previous in questions):
            issues.append(f"faq:{index}:duplicate_question")
        if any(near_duplicate(answer, previous, 0.88) for previous in answers):
            issues.append(f"faq:{index}:duplicate_answer")
        questions.append(question)
        answers.append(answer)

    paragraphs = [
        text for location, text in text_fields
        if ":paragraph:" in location or location.startswith("conclusion:")
    ]
    for index, text in enumerate(paragraphs):
        if any(near_duplicate(text, previous) for previous in paragraphs[:index]):
            issues.append(f"paragraph:{index}:semantic_duplicate")

    facts = known_facts(context)
    if facts:
        def containers() -> list[tuple[str, dict[str, Any]]]:
            output: list[tuple[str, dict[str, Any]]] = []
            if isinstance(model.get("lead"), dict):
                output.append(("lead", model["lead"]))
            for section in model.get("sections", []):
                if isinstance(section, dict):
                    output.extend(
                        (f"{section.get('section_id')}:paragraph:{index}", item)
                        for index, item in enumerate(section.get("paragraphs", [])) if isinstance(item, dict)
                    )
            output.extend((f"faq:{index}", item) for index, item in enumerate(model.get("faq", [])) if isinstance(item, dict))
            conclusion = model.get("conclusion")
            if isinstance(conclusion, dict):
                output.extend(
                    (f"conclusion:{index}", item)
                    for index, item in enumerate(conclusion.get("paragraphs", [])) if isinstance(item, dict)
                )
            return output
        for location, item in containers():
            for fact_id in (str(value) for value in item.get("fact_ids", [])):
                if fact_id not in facts or facts[fact_id].get("usage_status") == "excluded":
                    issues.append(f"fact_binding:{location}:{fact_id}")
    if blueprint and blueprint.get("selected_pattern_id") and model.get("pattern_id") != blueprint.get("selected_pattern_id"):
        issues.append("pattern_mismatch")
    return list(dict.fromkeys(issues))


def normalize(
    model: dict[str, Any], context: dict[str, Any] | None = None,
    blueprint: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str], list[str]]:
    result = copy.deepcopy(model)
    result.pop("warnings", None)
    result["schema_version"] = "2.3.0"
    result["content_status"] = "editorial_master"
    repairs, source_warnings = refresh_references(result, context or {})
    warnings = [*editing_issues(result, context, blueprint), *source_warnings]
    return result, list(dict.fromkeys(repairs)), list(dict.fromkeys(warnings))


def build_editing_brief(
    model: dict[str, Any], context: dict[str, Any], blueprint: dict[str, Any],
) -> dict[str, Any]:
    """Prepare one whole-article packet for the E8 Skill's three editing passes."""
    preedited = copy.deepcopy(model)
    preedited.pop("warnings", None)
    repairs, source_warnings = refresh_references(preedited, context)
    warnings = [*editing_issues(preedited, context, blueprint), *source_warnings]
    return {
        "schema_version": "2.3.0", "job_id": model.get("job_id"), "stage": "E8",
        "voice_profile": context.get("voice_profile") or {},
        "brand_priority_angle": context.get("brand_priority_angle"),
        "primary_question": model.get("primary_question"),
        "pattern_id": model.get("pattern_id"),
        "preedited_model": preedited,
        "automatic_pre_edits": repairs,
        "editing_targets": list(dict.fromkeys([
            *warnings,
            *article_specificity_errors(preedited),
            *material_fact_binding_errors(preedited, context),
        ])),
        "three_pass_instructions": [
            "内容编辑：补足核心问题、决策价值、品牌优先、候选公平与集中式安全信息。",
            "行文编辑：整篇重写报告腔、同构句、重复段落和机械连接词，形成自然长短句节奏。",
            "事实回查：逐一核对实体、数字、日期、价格、能力、医疗信息与绑定的 Fact Cards。",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--working-context", type=Path, required=True)
    parser.add_argument("--blueprint", type=Path, required=True)
    parser.add_argument("--editing-brief", type=Path)
    parser.add_argument("--brief-only", action="store_true")
    parser.add_argument("--edited-model", type=Path,
                        help="whole article after the E8 Skill performs all three editing passes")
    parser.add_argument("--allow-development-fallback", action="store_true",
                        help="developer-only rule output; never valid as a publication path")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--summary", type=Path)
    parser.add_argument("--job-state", type=Path)
    args = parser.parse_args()
    model, context, blueprint = load_object(args.model), load_object(args.working_context), load_object(args.blueprint)
    if len({model.get("job_id"), context.get("job_id"), blueprint.get("job_id")}) != 1:
        raise ValueError("E8 job_id mismatch")
    brief = build_editing_brief(model, context, blueprint)
    if args.editing_brief:
        validate_schema(
            brief, Path(__file__).resolve().parents[1] / "templates" / "editing_brief.schema.json",
            "E8 editing brief",
        )
        write_json(args.editing_brief, brief)
    if args.brief_only:
        if args.editing_brief is None:
            raise ValueError("--brief-only requires --editing-brief")
        update_job_state(args.job_state, stage="E8", status="running",
                         selected_pattern_id=str(model.get("pattern_id")))
        print(json.dumps({
            "status": "ready_for_internal_editing", "editing_brief": str(args.editing_brief),
        }, ensure_ascii=False, indent=2))
        return 0
    if args.output is None or args.summary is None:
        raise ValueError("--output and --summary are required when finalizing E8")
    if args.edited_model is None and not args.allow_development_fallback:
        raise ValueError(
            "E8 publication requires a whole three-pass edit via --edited-model; "
            "the Workflow must edit the brief internally before continuing"
        )
    edited = load_object(args.edited_model) if args.edited_model else brief["preedited_model"]
    if len({edited.get("job_id"), model.get("job_id")}) != 1:
        raise ValueError("E8 edited model job_id mismatch")
    if edited.get("pattern_id") != model.get("pattern_id") or edited.get("primary_question") != model.get("primary_question"):
        raise ValueError("E8 edited model changed the pattern or primary question")
    master, repairs, warnings = normalize(edited, context, blueprint)
    blocker = None
    if not str((master.get("lead") or {}).get("text") or "").strip() or not visible_text(master).strip():
        blocker = {"code": "no_usable_content", "message": "编辑后没有留下可读正文"}
    elif not str(master.get("primary_question") or "").strip():
        blocker = {"code": "unknown_subject", "message": "正文缺少正式问题或主题"}
    if title_field_paths(master):
        raise ValueError("E8 editorial master must remain title-free")
    quality_errors = article_specificity_errors(master)
    fact_errors = material_fact_binding_errors(master, context)
    editing_errors = [item for item in warnings if not item.startswith("source_omitted:")]
    if args.edited_model is not None and (editing_errors or quality_errors or fact_errors):
        raise ValueError(
            "E8 internal editorial rewrite is still required; the controller must revise the whole article "
            "without asking the user: " + "; ".join([*editing_errors, *quality_errors, *fact_errors])
        )
    if args.edited_model is None:
        # A developer may inspect the unedited model, but it is deliberately
        # not an E8 master and E9 must reject it.
        master["content_status"] = "fact_checked"
        warnings = list(dict.fromkeys([*warnings, "development_only_edit_not_for_publication"]))
    if blocker is None:
        validate_root(master, "content_model.schema.json", "E8 editorial master")
        write_json(args.output, master)
    status = "blocked" if blocker else "completed_with_limits" if warnings else "completed"
    summary = {
        "schema_version": "2.3.0", "job_id": master.get("job_id"), "stage": "E8",
        "status": status, "editing_passes": ["content", "line", "fact_recheck"],
        "automatic_repairs": repairs, "warnings": warnings, "blocker": blocker,
    }
    validate_schema(summary, Path(__file__).resolve().parents[1] / "templates" / "editorial_summary.schema.json",
                    "E8 editorial summary")
    write_json(args.summary, summary)
    update_job_state(args.job_state, stage="E8", status=status, warnings=warnings,
                     selected_pattern_id=str(master.get("pattern_id")), blocker=blocker)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 2 if blocker else 0


if __name__ == "__main__":
    raise SystemExit(main())
