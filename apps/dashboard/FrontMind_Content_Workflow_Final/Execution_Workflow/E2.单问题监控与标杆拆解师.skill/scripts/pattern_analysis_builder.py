#!/usr/bin/env python3
"""Build the mandatory E2 v2.3 research brief and advisory P recommendation."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from schema_validation import validate_root  # noqa: E402

PATTERNS = tuple(f"P{number:02d}" for number in range(1, 17))


def normal(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", str(value or ""))).strip()


def match_text(value: Any) -> str:
    return normal(value).casefold()


def question_key(value: Any) -> str:
    return re.sub(r"[^0-9a-z\u3400-\u9fff]+", "", unicodedata.normalize("NFKC", normal(value)).casefold())


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            if not content.endswith("\n"):
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


def write_json(path: Path, value: dict[str, Any]) -> None:
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2))


def pattern_map(registry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(item.get("id")): item
        for item in registry.get("patterns", [])
        if isinstance(item, dict) and str(item.get("id")) in PATTERNS
    }


def allowed_patterns(registry: dict[str, Any], entry: str, subintent: str | None) -> list[str]:
    route = (registry.get("routing") or {}).get(entry) or {}
    if entry == "product_scenario" and subintent:
        values = [
            *list((route.get("subintent_routing") or {}).get(subintent) or []),
            *list(route.get("secondary_patterns") or []),
        ]
    else:
        values = [*list(route.get("primary_patterns") or []), *list(route.get("secondary_patterns") or [])]
    return list(dict.fromkeys(item for item in values if item in PATTERNS))


def question_trigger_score(pattern: dict[str, Any], question: str) -> float:
    sample = match_text(question)
    return float(sum(1 for cue in pattern.get("trigger_signals", []) if match_text(cue) in sample))


def question_based_choice(registry: dict[str, Any], entry: str, subintent: str | None, question: str) -> str:
    if entry == "foundation_start":
        return "P14"
    allowed = allowed_patterns(registry, entry, subintent)
    if not allowed:
        raise ValueError(f"entry {entry!r} has no legal P-pattern route")
    if entry == "industry_ranking":
        if any(cue in question for cue in ("有哪些", "哪些", "哪几家", "排行榜", "推荐榜", "榜单", "多家")) and "P02" in allowed:
            return "P02"
        if any(cue in question for cue in ("推荐一家", "一家推荐", "为什么推荐")) and "P01" in allowed:
            return "P01"
    patterns = pattern_map(registry)
    scored = [(-question_trigger_score(patterns.get(pattern_id, {}), question), order, pattern_id)
              for order, pattern_id in enumerate(allowed)]
    return min(scored)[2]


def empty_observation(rank: int, reason: str) -> dict[str, Any]:
    return {
        "observation_id": f"obs_rank_{rank:02d}", "raw_rank": rank,
        "status": "unavailable", "content_form": None, "primary_pattern_id": None,
        "alternative_pattern_ids": [], "classification_confidence": 0.0,
        "matched_intent_signal_ids": [], "matched_structure_component_ids": [],
        "negative_signal_ids": [], "question_similarity": 0.0,
        "classification_rationale": reason, "structure_summary": None,
        "benchmark_review": None, "notes": [reason],
    }


def apply_corrections(observations: list[dict[str, Any]], document: dict[str, Any]) -> None:
    corrections = document.get("corrections") if isinstance(document.get("corrections"), list) else []
    by_rank = {int(item["raw_rank"]): item for item in observations if isinstance(item.get("raw_rank"), int)}
    allowed_fields = {
        "status", "content_form", "primary_pattern_id", "alternative_pattern_ids",
        "classification_confidence", "matched_intent_signal_ids", "matched_structure_component_ids",
        "negative_signal_ids", "question_similarity", "classification_rationale",
        "structure_summary", "notes",
    }
    for correction in corrections:
        if not isinstance(correction, dict) or not isinstance(correction.get("raw_rank"), int):
            continue
        target = by_rank.get(int(correction["raw_rank"]))
        if target is None:
            continue
        for field in allowed_fields:
            if field in correction:
                target[field] = correction[field]
        notes = [normal(item) for item in target.get("notes", []) if normal(item)]
        target["notes"] = list(dict.fromkeys([*notes, "已应用人工结构分类修正"]))


def distribution_item(pattern_id: str, support: float, share: float, ranks: list[int], trigger: float) -> dict[str, Any]:
    return {
        "pattern_id": pattern_id, "weighted_support": round(support, 8),
        "weighted_share": round(share, 8), "article_count": len(ranks),
        "average_rank": round(sum(ranks) / len(ranks), 4) if ranks else None,
        "question_trigger_score": trigger, "supporting_ranks": ranks,
    }


def build_recommendation(
    pool: list[dict[str, Any]], observations: list[dict[str, Any]], registry: dict[str, Any],
    entry: str, subintent: str | None, question: str,
) -> dict[str, Any]:
    by_rank = {int(item["raw_rank"]): item for item in pool if isinstance(item.get("raw_rank"), int)}
    weighted: dict[str, float] = defaultdict(float)
    ranks: dict[str, list[int]] = defaultdict(list)
    for item in observations:
        pattern_id = str(item.get("primary_pattern_id") or "")
        rank = item.get("raw_rank")
        if item.get("status") != "classified_article" or pattern_id not in PATTERNS or rank not in by_rank:
            continue
        confidence = max(0.0, min(1.0, float(item.get("classification_confidence") or 0)))
        weighted[pattern_id] += int(by_rank[int(rank)].get("citation_count") or 0) * confidence
        ranks[pattern_id].append(int(rank))
    patterns = pattern_map(registry)
    allowed = allowed_patterns(registry, entry, subintent)
    if entry == "industry_ranking":
        secondary_intent = any(cue in question for cue in ("价格", "费用", "预算", "风险", "限制", "白皮书", "研究", "案例", "观点", "评论"))
        if not secondary_intent and any(cue in question for cue in ("有哪些", "哪些", "哪几家", "排行榜", "推荐榜", "榜单", "多家")):
            allowed = ["P02"] if "P02" in allowed else []
        elif not secondary_intent and any(cue in question for cue in ("推荐一家", "一家推荐", "为什么推荐")):
            allowed = ["P01"] if "P01" in allowed else []
    classified = sum(len(value) for value in ranks.values())
    coverage = round(classified / len(pool), 8) if pool else 0.0
    total_weight = sum(weighted.values())
    all_ids = sorted(set(weighted) | set(allowed))
    weighted_distribution = [
        distribution_item(
            pattern_id, weighted.get(pattern_id, 0.0),
            weighted.get(pattern_id, 0.0) / total_weight if total_weight else 0.0,
            sorted(ranks.get(pattern_id, [])), question_trigger_score(patterns.get(pattern_id, {}), question),
        ) for pattern_id in all_ids
    ]
    weighted_distribution.sort(key=lambda item: (
        -float(item["weighted_support"]), -int(item["article_count"]),
        item["average_rank"] if item["average_rank"] is not None else 999,
        -float(item["question_trigger_score"]), str(item["pattern_id"]),
    ))
    unweighted_distribution = [
        distribution_item(
            pattern_id, float(len(ranks.get(pattern_id, []))),
            len(ranks.get(pattern_id, [])) / classified if classified else 0.0,
            sorted(ranks.get(pattern_id, [])), question_trigger_score(patterns.get(pattern_id, {}), question),
        ) for pattern_id in all_ids
    ]
    unweighted_distribution.sort(key=lambda item: (
        -int(item["article_count"]),
        item["average_rank"] if item["average_rank"] is not None else 999,
        -float(item["question_trigger_score"]), str(item["pattern_id"]),
    ))
    eligible = [item for item in weighted_distribution if item["pattern_id"] in allowed and item["weighted_support"] > 0]
    if eligible:
        selected = str(eligible[0]["pattern_id"])
        status = "evidence_supported" if coverage >= 0.5 else "partial_support"
        rationale = (
            f"原始 Top{len(pool)} 中有 {classified} 篇可分类文章；按引用次数 × 分类置信度，"
            f"{selected} 在当前入口的合法模式中获得最高支持。"
        )
    else:
        selected = question_based_choice(registry, entry, subintent, question)
        status = "partial_support"
        rationale = (
            f"已分析原始 Top{len(pool)}，但没有可分类页面对当前入口形成有效投票；"
            f"建议 {selected} 来自正式问题与预研模板，不冒充 Top20 支持结论。"
        )
    alternatives = [
        str(item["pattern_id"]) for item in weighted_distribution
        if item["pattern_id"] in allowed and item["pattern_id"] != selected
    ][:5]
    return {
        "status": status, "recommended_pattern_id": selected,
        "alternative_pattern_ids": alternatives,
        "weighted_distribution": weighted_distribution,
        "unweighted_distribution": unweighted_distribution,
        "supporting_content_ranks": sorted(ranks.get(selected, [])),
        "contradicting_content_ranks": sorted(
            int(item["raw_rank"]) for item in observations
            if item.get("status") == "classified_article" and item.get("primary_pattern_id") != selected
        ),
        "classification_coverage": coverage, "rationale": rationale, "advisory_only": True,
    }


def monitoring_summary(monitoring: dict[str, Any]) -> dict[str, Any]:
    derived = monitoring.get("derived") if isinstance(monitoring.get("derived"), dict) else {}
    entities = [normal(item.get("name")) for item in derived.get("competitors", [])
                if isinstance(item, dict) and normal(item.get("name"))]
    return {
        "answer_count": len(monitoring.get("answers", [])),
        "platforms": list(dict.fromkeys(
            normal(item.get("platform")) for item in monitoring.get("answers", [])
            if isinstance(item, dict) and normal(item.get("platform"))
        )),
        "mentioned_entities": list(dict.fromkeys(entities)),
        "candidate_order_signals": [item for item in derived.get("candidate_order_signals", []) if isinstance(item, dict)],
        "recurring_dimensions": list(dict.fromkeys(normal(item) for item in derived.get("recurring_dimensions", []) if normal(item))),
        "recurring_subquestions": list(dict.fromkeys(normal(item) for item in derived.get("recurring_subquestions", []) if normal(item))),
        "unanswered_subquestions": list(dict.fromkeys(normal(item) for item in derived.get("unanswered_subquestions", []) if normal(item))),
    }


def render_brief(payload: dict[str, Any], registry: dict[str, Any]) -> str:
    patterns = pattern_map(registry)
    monitoring = payload["monitoring_summary"]
    recommendation = payload["recommendation"]
    selected = recommendation["recommended_pattern_id"]
    selected_name = normal(patterns.get(selected, {}).get("name")) or selected
    lines = [
        "# E2 单问题研究简报", "",
        f"**正式问题：** {payload['question']}",
        f"**AI 监控样本：** {monitoring['answer_count']} 条，覆盖 {len(monitoring['platforms'])} 个平台",
        f"**引用语料池：** {len(payload['cited_content_pool'])} 条，可分类覆盖率 {recommendation['classification_coverage']:.1%}",
        f"**建议文章类型：** {selected} {selected_name}", "", recommendation["rationale"], "",
        "## AI 答案中的写作信号", "",
        f"- 高频候选：{'、'.join(monitoring['mentioned_entities'][:12]) or '未识别'}",
        f"- 反复判断维度：{'、'.join(monitoring['recurring_dimensions'][:12]) or '未识别'}",
        f"- 反复子问题：{'、'.join(monitoring['recurring_subquestions'][:10]) or '未识别'}",
        f"- 未回答子问题：{'、'.join(monitoring['unanswered_subquestions'][:10]) or '无明显项'}", "",
        "## P 类型加权分布", "",
        "| P 类型 | 加权支持 | 占比 | 篇数 | 支持排名 |", "|---|---:|---:|---:|---|",
    ]
    for item in recommendation["weighted_distribution"]:
        name = normal(patterns.get(item["pattern_id"], {}).get("name"))
        ranks = "、".join(str(rank) for rank in item["supporting_ranks"]) or "—"
        lines.append(f"| {item['pattern_id']} {name} | {item['weighted_support']:.2f} | {item['weighted_share']:.1%} | {item['article_count']} | {ranks} |")
    lines.extend(["", "## Top20 文章形态与分类", "", "| 排名 | 引用次数 | 内容 | 状态 | P 类型 | 结构摘要 |", "|---:|---:|---|---|---|---|"])
    observations = {item["raw_rank"]: item for item in payload["content_observations"]}
    for item in payload["cited_content_pool"]:
        observation = observations.get(item["raw_rank"], {})
        review = observation.get("benchmark_review")
        reviewed_structure = (
            "；".join(normal(value) for value in review.get("structure_observation", []) if normal(value))
            if isinstance(review, dict) else ""
        )
        summary = (reviewed_structure or normal(observation.get("structure_summary")))[:120].replace("|", "｜") or "—"
        title = normal(item["content_title"])[:60].replace("|", "｜")
        lines.append(f"| {item['raw_rank']} | {item['citation_count']} | [{title}]({item['canonical_url']}) | {observation.get('status') or '—'} | {observation.get('primary_pattern_id') or '—'} | {summary} |")
    lines.extend(["", "## 待确认", "", f"E2 建议选择 **{selected} {selected_name}**。可接受该建议，或从合法备选中选择：{'、'.join(recommendation['alternative_pattern_ids']) or '无'}。"])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build E2 v2.3 research analysis")
    parser.add_argument("--content-job", type=Path, required=True)
    parser.add_argument("--pattern-registry", type=Path, required=True)
    parser.add_argument("--monitoring-context", type=Path, required=True)
    parser.add_argument("--source-pool", type=Path, required=True)
    parser.add_argument("--page-analysis", type=Path, required=True)
    parser.add_argument("--corrections", type=Path)
    parser.add_argument("--research-brief", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    job, registry = load_object(args.content_job), load_object(args.pattern_registry)
    monitoring, source_pool = load_object(args.monitoring_context), load_object(args.source_pool)
    page_analysis = load_object(args.page_analysis)
    task = job.get("task") if isinstance(job.get("task"), dict) else {}
    entry, question = str(job.get("entry_category") or ""), normal(task.get("question_text"))
    if entry == "foundation_start":
        raise ValueError("foundation_start skips E2 and proceeds to the fixed P14 template")
    if not question:
        raise ValueError("ordinary E2 task has no formal question")
    if question_key(monitoring.get("question")) != question_key(question):
        raise ValueError("research_question_mismatch: monitoring context differs from the formal question")
    if question_key(source_pool.get("question")) != question_key(question):
        raise ValueError("research_question_mismatch: source workbook pool differs from the formal question")
    pool = [item for item in source_pool.get("cited_content_pool", []) if isinstance(item, dict)][:20]
    if not pool:
        raise ValueError("source_workbook_unusable: E2 requires a non-empty exact-question citation pool")
    raw_observations = [item for item in page_analysis.get("content_observations", []) if isinstance(item, dict)]
    by_rank = {int(item["raw_rank"]): dict(item) for item in raw_observations if isinstance(item.get("raw_rank"), int)}
    # Pre-release v2.3 page-analysis artifacts did not carry the structured
    # benchmark review.  They remain readable, but cannot claim a reviewed
    # benchmark and therefore normalize to the explicit null value.
    for item in by_rank.values():
        item.setdefault("benchmark_review", None)
    warnings = [normal(item) for item in source_pool.get("warnings", []) if normal(item)]
    for item in pool:
        rank = int(item["raw_rank"])
        if rank not in by_rank:
            by_rank[rank] = empty_observation(rank, "引用项没有页面结构结果")
            warnings.append(f"原始排名 {rank} 没有页面结构结果，已保留为 unavailable")
    observations = [by_rank[int(item["raw_rank"])] for item in pool]
    if args.corrections:
        apply_corrections(observations, load_object(args.corrections))
    # A review belongs only to a successfully classified article.  This also
    # makes status-changing human corrections deterministic instead of
    # leaking an obsolete review into a non-article/unavailable observation.
    for item in observations:
        item.setdefault("benchmark_review", None)
        if item.get("status") != "classified_article":
            item["benchmark_review"] = None
    result = build_recommendation(pool, observations, registry, entry, task.get("product_scenario_subintent"), question)
    payload = {
        "schema_version": "2.3.0", "job_id": job.get("job_id"), "question": question,
        "entry_category": entry, "product_scenario_subintent": task.get("product_scenario_subintent"),
        "completed_at": datetime.now(timezone.utc).isoformat(), "monitoring_summary": monitoring_summary(monitoring),
        "pool_status": "complete_pool" if len(pool) == 20 else "partial_pool",
        "cited_content_pool": [{
            "raw_rank": int(item["raw_rank"]), "content_title": normal(item.get("content_title") or item.get("canonical_url")),
            "canonical_url": str(item.get("canonical_url") or ""), "media_name": normal(item.get("media_name")) or None,
            "media_domain": normal(item.get("media_domain")) or None, "citation_date": normal(item.get("citation_date")) or None,
            "citation_count": int(item.get("citation_count") or 0), "citation_share": float(item.get("citation_share") or 0),
            "detailed_row_refs": sorted(set(int(value) for value in item.get("detailed_row_refs", []) if isinstance(value, int))),
        } for item in pool],
        "content_observations": observations, "recommendation": result,
        "warnings": list(dict.fromkeys([*warnings, *[
            normal(item) for item in (monitoring.get("derived") or {}).get("warnings", []) if normal(item)
        ]])),
    }
    validate_root(payload, "e2_pattern_analysis.schema.json", "E2 research and pattern analysis")
    write_json(args.output, payload)
    atomic_write(args.research_brief, render_brief(payload, registry))
    print(json.dumps({
        "stage": "E2", "status": "completed_with_limits" if payload["warnings"] or result["status"] == "partial_support" else "completed",
        "recommendation_status": result["status"], "recommended_pattern_id": result["recommended_pattern_id"],
        "classification_coverage": result["classification_coverage"], "research_brief": str(args.research_brief), "output": str(args.output),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
