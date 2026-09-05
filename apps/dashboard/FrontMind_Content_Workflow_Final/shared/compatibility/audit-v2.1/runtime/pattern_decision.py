#!/usr/bin/env python3
"""Semantic contracts shared by E2 classification and E4 blueprint routing.

JSON Schema fixes the wire shape.  These validators close relationships that
cannot be expressed safely in the supported schema subset: Top20 identity,
weighted recommendation arithmetic, Registry signal membership, explicit E4
override semantics, benchmark provenance, and exact template-component
coverage.  They are deliberately side-effect free so every active stage can
reuse the same authority.
"""

from __future__ import annotations

from collections import defaultdict
from math import isclose
import re
from typing import Any
import unicodedata


PATTERN_IDS = tuple(f"P{index:02d}" for index in range(1, 17))
FOUNDATION_PATTERN = "P14"
ARTICLE_FORMS = {
    "editorial_article",
    "brand_feature",
    "news_article",
    "comparison_review",
    "tutorial_documentation",
    "case_study",
    "research_pdf",
    "official_longform",
}
NON_ARTICLE_FORMS = {
    "homepage",
    "company_registry",
    "database_listing",
    "encyclopedia",
    "search_result",
    "patent_record",
    "short_video",
    "social_post",
    "download_shell",
    "unknown",
}
OVERRIDE_REASONS = {
    "question_intent_mismatch",
    "entry_route_conflict",
    "evidence_requirement_unmet",
    "non_article_sample_bias",
    "insufficient_classification_coverage",
    "explicit_engineer_constraint",
}
EVIDENCE_SUPPORTED_MIN_COVERAGE = 0.5
CITATION_SHARE_DISPLAY_TOLERANCE = 0.000051


def _objects(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _pattern_map(registry: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(registry, dict):
        return {}
    return {
        str(item.get("id")): item
        for item in _objects(registry.get("patterns"))
        if item.get("id") in PATTERN_IDS
    }


def _route_patterns(registry: Any, entry: Any, subintent: Any = None) -> set[str]:
    if not isinstance(registry, dict) or not isinstance(entry, str):
        return set()
    route = (registry.get("routing") or {}).get(entry)
    if not isinstance(route, dict):
        return set()
    if entry == "product_scenario" and isinstance(subintent, str):
        values = (route.get("subintent_routing") or {}).get(subintent)
        return {
            item
            for item in (values or []) + (route.get("secondary_patterns") or [])
            if item in PATTERN_IDS
        }
    return {
        item
        for item in (route.get("primary_patterns") or []) + (route.get("secondary_patterns") or [])
        if item in PATTERN_IDS
    }


def _float_equal(left: Any, right: float, tolerance: float = 1e-8) -> bool:
    return isinstance(left, (int, float)) and not isinstance(left, bool) and isclose(
        float(left), float(right), rel_tol=tolerance, abs_tol=tolerance
    )


def _normal_text(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip().casefold()


def _question_trigger_score(registry: dict[str, Any], pattern_id: str, question: str) -> int:
    pattern = _pattern_map(registry).get(pattern_id, {})
    normalized = _normal_text(question)
    return sum(
        1
        for signal in pattern.get("trigger_signals", [])
        if _normal_text(signal) and _normal_text(signal) in normalized
    )


def _template_pattern(registry: dict[str, Any], entry: str, subintent: str | None, question: str) -> str:
    route = (registry.get("routing") or {}).get(entry) or {}
    primary = list(route.get("primary_patterns") or [])
    if entry == "product_scenario" and subintent:
        primary = list((route.get("subintent_routing") or {}).get(subintent) or [])
    if not primary:
        raise ValueError(f"Registry has no signed primary fallback route for {entry}/{subintent}")
    scored = [
        (-_question_trigger_score(registry, pattern_id, question), order, pattern_id)
        for order, pattern_id in enumerate(primary)
    ]
    return min(scored)[2]


def compute_e2_recommendation(
    pool: list[dict[str, Any]],
    observations: list[dict[str, Any]],
    registry: dict[str, Any],
    entry: str,
    subintent: str | None,
    question: str,
) -> dict[str, Any]:
    """Return the one canonical E2 recommendation from classified Top20 rows."""

    pool_by_rank = {int(item["raw_rank"]): item for item in pool}
    weights: dict[str, float] = defaultdict(float)
    ranks: dict[str, list[int]] = defaultdict(list)
    counts: dict[str, int] = defaultdict(int)
    rank_sums: dict[str, int] = defaultdict(int)
    classified_count = 0
    for observation in observations:
        if observation.get("status") != "classified_article":
            continue
        rank = int(observation["raw_rank"])
        classification = observation.get("classification") or {}
        pattern_id = str(classification.get("primary_pattern_id") or "")
        confidence = float(classification.get("classification_confidence") or 0)
        support = int(pool_by_rank[rank]["citation_count"]) * confidence
        weights[pattern_id] += support
        ranks[pattern_id].append(rank)
        counts[pattern_id] += 1
        rank_sums[pattern_id] += rank
        classified_count += 1

    total_weight = sum(weights.values())
    weighted_order = sorted(weights, key=lambda pattern_id: (-weights[pattern_id], pattern_id))
    weighted_distribution = [
        {
            "pattern_id": pattern_id,
            "support_weight": round(weights[pattern_id], 12),
            "support_share": round(weights[pattern_id] / total_weight, 12) if total_weight > 0 else 0,
            "article_count": counts[pattern_id],
            "average_raw_rank": round(rank_sums[pattern_id] / counts[pattern_id], 12),
        }
        for pattern_id in weighted_order
    ]
    distribution_by_pattern = {item["pattern_id"]: item for item in weighted_distribution}
    unweighted_distribution = [
        {
            "pattern_id": pattern_id,
            "article_count": counts[pattern_id],
            "article_share": round(counts[pattern_id] / classified_count, 12),
        }
        for pattern_id in sorted(counts, key=lambda pattern_id: (-counts[pattern_id], pattern_id))
    ]
    coverage = round(classified_count / len(pool), 12) if pool else 0
    allowed = _route_patterns(registry, entry, subintent)
    eligible = [
        (
            weight,
            counts[pattern_id],
            rank_sums[pattern_id] / counts[pattern_id],
            _question_trigger_score(registry, pattern_id, question),
            pattern_id,
        )
        for pattern_id, weight in weights.items()
        if pattern_id in allowed and weight > 0
    ]
    eligible.sort(key=lambda item: (-item[0], -item[1], item[2], -item[3], item[4]))
    if not eligible:
        fallback = _template_pattern(registry, entry, subintent, question)
        return {
            "recommendation_status": "template_fallback",
            "recommended_pattern_id": fallback,
            "alternative_recommendations": [],
            "weighted_distribution": weighted_distribution,
            "unweighted_distribution": unweighted_distribution,
            "supporting_content_ranks": [],
            "contradicting_content_ranks": sorted(rank for values in ranks.values() for rank in values),
            "classification_coverage": coverage,
            "recommendation_rationale": (
                "原始 Top20 中没有形成可用于当前入口合法路由的正权重文章分类，"
                f"因此仅回退到签名模板 {fallback}；真实分类分布与覆盖率仍完整保留，"
                "该建议只供 E4 决策，不代表已获得标杆证据支持。"
            ),
            "ambiguous": False,
            "advisory_only": True,
        }

    top_weight, top_count, top_average_rank, top_trigger_score, recommended = eligible[0]
    ambiguous = len(eligible) > 1 and (
        isclose(top_weight, eligible[1][0], rel_tol=0, abs_tol=1e-12)
        and top_count == eligible[1][1]
        and isclose(top_average_rank, eligible[1][2], rel_tol=0, abs_tol=1e-12)
        and top_trigger_score == eligible[1][3]
    )
    status = (
        "evidence_supported"
        if coverage >= EVIDENCE_SUPPORTED_MIN_COVERAGE and not ambiguous
        else "partial_support"
    )
    return {
        "recommendation_status": status,
        "recommended_pattern_id": recommended,
        "alternative_recommendations": [
            distribution_by_pattern[pattern_id]
            for _weight, _count, _average_rank, _trigger_score, pattern_id in eligible[1:6]
        ],
        "weighted_distribution": weighted_distribution,
        "unweighted_distribution": unweighted_distribution,
        "supporting_content_ranks": sorted(ranks[recommended]),
        "contradicting_content_ranks": sorted(
            rank
            for pattern_id, pattern_ranks in ranks.items()
            if pattern_id != recommended
            for rank in pattern_ranks
        ),
        "classification_coverage": coverage,
        "recommendation_rationale": (
            f"按用户锁定的 citation_count × classification_confidence 公式汇总后，{recommended} "
            f"在当前入口合法模式中获得最高支持权重 {round(top_weight, 6)}；"
            f"原始 Top20 分类覆盖率为 {round(coverage, 4)}；并按权重、篇数、平均原始名次、问题触发信号、P编号依次决胜，"
            f"{'前四项仍完全并列，保留歧义标记' if ambiguous else '已得到确定性首选'}。"
        ),
        "ambiguous": ambiguous,
        "advisory_only": True,
    }


def _recommendation_equal(actual: Any, expected: Any, path: str = "recommendation") -> list[str]:
    """Deep exact comparison with only 1e-10 tolerance for JSON numbers."""

    errors: list[str] = []
    if isinstance(expected, dict):
        if not isinstance(actual, dict) or set(actual) != set(expected):
            return [f"{path} keys differ from canonical recomputation"]
        for key, value in expected.items():
            errors.extend(_recommendation_equal(actual[key], value, f"{path}.{key}"))
    elif isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return [f"{path} length differs from canonical recomputation"]
        for index, value in enumerate(expected):
            errors.extend(_recommendation_equal(actual[index], value, f"{path}[{index}]"))
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        if not _float_equal(actual, float(expected), tolerance=1e-10):
            errors.append(f"{path} differs from canonical recomputation")
    elif actual != expected:
        errors.append(f"{path} differs from canonical recomputation")
    return errors


def validate_e2_pattern_analysis(
    document: Any,
    registry: Any,
    human_review_receipt: Any | None = None,
    *,
    human_review_receipt_sha256: str | None = None,
) -> list[str]:
    """Validate the E2 Top20 corpus, classifications, and recommendation math."""

    errors: list[str] = []
    if not isinstance(document, dict):
        return ["E2 pattern analysis must be an object"]
    patterns = _pattern_map(registry)
    if set(patterns) != set(PATTERN_IDS):
        errors.append("Registry must expose exactly P01-P16 before E2 validation")

    receipt = document.get("source_workbook_receipt")
    receipt = receipt if isinstance(receipt, dict) else {}
    if receipt.get("normalized_question") != document.get("question"):
        errors.append("source workbook normalized_question must equal E2 question")
    if receipt.get("content_status_ignored") is not True:
        errors.append("内容状态 must be explicitly ignored")
    if receipt.get("citation_rank_definition") != "citation_count_descending":
        errors.append("字段说明 must confirm 引用排行 is sorted by citation_count descending")

    pool = _objects(document.get("cited_content_pool"))
    observations = _objects(document.get("content_observations"))
    expected_ranks = list(range(1, len(pool) + 1))
    pool_ranks = [item.get("raw_rank") for item in pool]
    observation_ranks = [item.get("raw_rank") for item in observations]
    if pool_ranks != expected_ranks:
        errors.append(f"cited_content_pool ranks must be unique, ordered, and contiguous: {expected_ranks}")
    if observation_ranks != expected_ranks:
        errors.append("content_observations must cover every original Top20 rank exactly once and in order")
    citation_counts = [item.get("citation_count") for item in pool]
    if all(isinstance(value, int) for value in citation_counts) and citation_counts != sorted(citation_counts, reverse=True):
        errors.append("cited_content_pool must preserve citation_count-descending Dashboard rank order")
    expected_pool_status = "complete_pool" if len(pool) == 20 else "partial_pool"
    if document.get("pool_status") != expected_pool_status:
        errors.append(f"pool_status must be {expected_pool_status} for {len(pool)} rows")

    total_citations = receipt.get("dashboard_total_citation_count")
    top20_citations = sum(item.get("citation_count", 0) for item in pool if isinstance(item.get("citation_count"), int))
    if receipt.get("top20_citation_count") != top20_citations:
        errors.append("source workbook top20_citation_count does not equal the fixed pool total")
    if isinstance(total_citations, int) and total_citations < top20_citations:
        errors.append("dashboard_total_citation_count cannot be lower than the Top20 citation total")
    for item in pool:
        count, share = item.get("citation_count"), item.get("citation_share")
        if isinstance(total_citations, int) and isinstance(count, int):
            expected_share = count / total_citations if total_citations else 0.0
            if not _float_equal(share, expected_share, tolerance=CITATION_SHARE_DISPLAY_TOLERANCE):
                errors.append(f"rank {item.get('raw_rank')} citation_share does not match citation_count / dashboard total")
        date_range = item.get("citation_date_range")
        if isinstance(date_range, dict):
            start, end = date_range.get("from"), date_range.get("to")
            if isinstance(start, str) and isinstance(end, str) and start > end:
                errors.append(f"rank {item.get('raw_rank')} citation date range is reversed")

    pool_by_rank = {item.get("raw_rank"): item for item in pool}
    seen_observation_ids: set[str] = set()
    first_url_rank: dict[str, int] = {}
    classified: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    human_reviewed = False
    registry_sha = (document.get("pattern_registry_ref") or {}).get("sha256")
    classifier_version = document.get("classifier_version")
    for observation in observations:
        rank = observation.get("raw_rank")
        pool_item = pool_by_rank.get(rank, {})
        if observation.get("canonical_url") != pool_item.get("canonical_url"):
            errors.append(f"rank {rank} observation canonical_url differs from cited_content_pool")
        observation_id = observation.get("observation_id")
        if observation_id in seen_observation_ids:
            errors.append(f"duplicate observation_id: {observation_id}")
        elif isinstance(observation_id, str):
            seen_observation_ids.add(observation_id)

        canonical_url = observation.get("canonical_url")
        status = observation.get("status")
        observation_review_status = observation.get("review_status")
        if observation_review_status in {"human_confirmed", "human_corrected"}:
            human_reviewed = True
        if isinstance(canonical_url, str):
            prior = first_url_rank.get(canonical_url)
            if prior is None:
                first_url_rank[canonical_url] = rank
                if status == "duplicate_alias":
                    errors.append(f"rank {rank} cannot be duplicate_alias before a canonical URL first appears")
            elif status != "duplicate_alias":
                errors.append(f"rank {rank} repeats rank {prior} canonical URL and must be duplicate_alias")

        retrieval = observation.get("retrieval_receipt")
        retrieval = retrieval if isinstance(retrieval, dict) else {}
        classification = observation.get("classification")
        form = observation.get("content_form")
        if status == "classified_article":
            if form not in ARTICLE_FORMS:
                errors.append(f"rank {rank} classified_article has non-article content_form")
            if retrieval.get("extraction_status") not in {"extracted", "partial"}:
                errors.append(f"rank {rank} cannot be classified without analyzable extracted content")
            if not isinstance(classification, dict):
                errors.append(f"rank {rank} classified_article lacks classification")
                continue
            pattern_id = classification.get("primary_pattern_id")
            contract = (patterns.get(pattern_id) or {}).get("classification_contract")
            contract = contract if isinstance(contract, dict) else {}
            if form not in set(contract.get("eligible_content_forms") or []):
                errors.append(f"rank {rank} content_form is not eligible for {pattern_id}")
            if classification.get("content_form") != form:
                errors.append(f"rank {rank} classification content_form differs from observation")
            if classification.get("snapshot_sha256") != retrieval.get("snapshot_sha256"):
                errors.append(f"rank {rank} classification is not bound to its retrieval snapshot")
            if classification.get("registry_sha256") != registry_sha:
                errors.append(f"rank {rank} classification is not bound to pattern_registry_ref")
            if classification.get("classifier_version") != classifier_version:
                errors.append(f"rank {rank} classification classifier_version differs from E2 root")
            if classification.get("review_status") != observation_review_status:
                errors.append(f"rank {rank} observation and classification review_status differ")

            components = {
                component.get("component_id")
                for component in _objects((patterns.get(pattern_id) or {}).get("structure_components"))
            }
            matched_components = set(classification.get("matched_structure_component_ids") or [])
            if not matched_components <= components:
                errors.append(f"rank {rank} matched structure components do not belong to {pattern_id}")
            intent_ids = {
                signal.get("signal_id") for signal in _objects(contract.get("positive_intent_signals"))
            }
            if not set(classification.get("matched_intent_signal_ids") or []) <= intent_ids:
                errors.append(f"rank {rank} matched intent signals do not belong to {pattern_id}")
            negative_ids = {
                signal.get("signal_id") for signal in _objects(contract.get("exclusion_signals"))
            }
            if not set(classification.get("negative_signal_ids") or []) <= negative_ids:
                errors.append(f"rank {rank} negative signals do not belong to {pattern_id}")
            confusable = {
                item.get("pattern_id") for item in _objects(contract.get("confusable_patterns"))
            }
            alternatives = set(classification.get("alternative_pattern_ids") or [])
            if pattern_id in alternatives:
                errors.append(f"rank {rank} primary pattern cannot repeat as an alternative")
            if not alternatives <= confusable:
                errors.append(f"rank {rank} alternatives must be declared confusable patterns for {pattern_id}")
            classified.append((observation, classification, pool_item))
        else:
            if classification is not None:
                errors.append(f"rank {rank} non-classified status must not carry a P classification")
            if status == "non_article" and form not in NON_ARTICLE_FORMS:
                errors.append(f"rank {rank} non_article has invalid content_form")

    human_receipt = document.get("human_review_receipt_ref")
    if human_reviewed and not isinstance(human_receipt, dict):
        errors.append("human-confirmed/corrected classifications require human_review_receipt_ref")
    if human_reviewed and human_review_receipt_sha256 is not None and (
        not isinstance(human_receipt, dict) or human_receipt.get("sha256") != human_review_receipt_sha256
    ):
        errors.append("human_review_receipt_ref SHA-256 differs from the supplied receipt bytes")
    if not human_reviewed and human_receipt is not None:
        errors.append("all-machine classifications require human_review_receipt_ref=null")
    human_observations = {
        observation.get("observation_id"): observation
        for observation in observations
        if observation.get("review_status") in {"human_confirmed", "human_corrected"}
    }
    if human_reviewed and isinstance(human_review_receipt, dict):
        if human_review_receipt.get("job_id") != document.get("job_id"):
            errors.append("human review receipt job_id differs from E2")
        decisions = _objects(human_review_receipt.get("decisions"))
        by_observation = {item.get("observation_id"): item for item in decisions}
        if len(by_observation) != len(decisions) or set(by_observation) != set(human_observations):
            errors.append("human review decisions must exactly cover every human-reviewed observation once")
        for observation_id, observation in human_observations.items():
            review = by_observation.get(observation_id, {})
            if review.get("final_review_status") != observation.get("review_status"):
                errors.append(f"human review final status differs for {observation_id}")
            classification = observation.get("classification")
            final_pattern = classification.get("primary_pattern_id") if isinstance(classification, dict) else None
            if review.get("final_pattern_id") != final_pattern:
                errors.append(f"human review final pattern differs for {observation_id}")

    recommendation = document.get("recommendation")
    try:
        expected_recommendation = compute_e2_recommendation(
            pool,
            observations,
            registry,
            str(document.get("entry_category") or ""),
            document.get("product_scenario_subintent"),
            str(document.get("question") or ""),
        )
    except (KeyError, TypeError, ValueError) as exc:
        errors.append(f"canonical E2 recommendation could not be recomputed: {exc}")
    else:
        errors.extend(_recommendation_equal(recommendation, expected_recommendation))
    return errors


def validate_e4_pattern_decision(
    decision: Any,
    registry: Any,
    e2_analysis: Any | None = None,
    *,
    e2_analysis_sha256: str | None = None,
) -> list[str]:
    """Validate E4's sole final P decision and selected benchmark identities."""

    errors: list[str] = []
    if not isinstance(decision, dict):
        return ["E4 pattern decision must be an object"]
    entry = decision.get("entry_category")
    selected = decision.get("selected_pattern_id")
    recommended = decision.get("recommended_pattern_id")
    mode = decision.get("decision")
    allowed = _route_patterns(registry, entry, decision.get("product_scenario_subintent"))
    if selected not in allowed:
        errors.append(f"selected_pattern_id {selected!r} is outside the entry/subintent route")
    if any((decision.get(key) or {}).get("status") != "passed" for key in (
        "entry_route_check", "question_fit_check", "evidence_readiness_check"
    )):
        errors.append("all three E4 decision checks must pass before blueprint production")

    if entry == "foundation_start":
        if selected != FOUNDATION_PATTERN or recommended is not None or decision.get("e2_pattern_analysis_ref") is not None:
            errors.append("foundation_start must select P14 without E2 or a recommended P")
        if mode != "template_fallback":
            errors.append("foundation_start must use template_fallback")
        if decision.get("selected_benchmark_ranks") or decision.get("selected_benchmark_observation_ids"):
            errors.append("foundation_start cannot declare runtime benchmarks")
        return errors

    if not isinstance(e2_analysis, dict):
        errors.append("non-foundation E4 requires its exact E2 pattern analysis")
        return errors
    e2_ref = decision.get("e2_pattern_analysis_ref")
    if not isinstance(e2_ref, dict):
        errors.append("non-foundation E4 requires a structured e2_pattern_analysis_ref")
        e2_ref = {}
    if e2_analysis_sha256 is not None and e2_ref.get("sha256") != e2_analysis_sha256:
        errors.append("E4 e2_pattern_analysis_ref SHA-256 differs from the supplied E2 bytes")
    if decision.get("job_id") != e2_analysis.get("job_id") or entry != e2_analysis.get("entry_category"):
        errors.append("E4 job/entry identity differs from E2")
    if decision.get("product_scenario_subintent") != e2_analysis.get("product_scenario_subintent"):
        errors.append("E4 product subintent differs from E2")
    e2_recommended = (e2_analysis.get("recommendation") or {}).get("recommended_pattern_id")
    if recommended != e2_recommended:
        errors.append("E4 recommended_pattern_id must preserve the E2 recommendation")
    if decision.get("pattern_registry_ref") != e2_analysis.get("pattern_registry_ref"):
        errors.append("E4 pattern_registry_ref must equal the E2 frozen reference")
    if decision.get("pattern_research_index_ref") != e2_analysis.get("pattern_research_index_ref"):
        errors.append("E4 pattern_research_index_ref must equal the E2 frozen reference")

    if mode == "accepted":
        if selected != recommended:
            errors.append("accepted E4 decision must select the recommended P")
        if (e2_analysis.get("recommendation") or {}).get("recommendation_status") == "template_fallback":
            errors.append("an E2 template fallback must remain template_fallback or use an explicit override")
        if decision.get("override_reason_code") is not None or decision.get("override_rationale") is not None:
            errors.append("accepted E4 decision cannot carry override metadata")
    elif mode == "overridden":
        if selected == recommended:
            errors.append("overridden E4 decision must select a different P")
        if decision.get("override_reason_code") not in OVERRIDE_REASONS:
            errors.append("overridden E4 decision lacks an allowed reason code")
        if not isinstance(decision.get("override_rationale"), str) or len(decision["override_rationale"].strip()) < 20:
            errors.append("overridden E4 decision requires a concrete rationale")
    elif mode == "template_fallback":
        if (e2_analysis.get("recommendation") or {}).get("recommendation_status") != "template_fallback":
            errors.append("non-foundation template_fallback must be justified by the E2 fallback status")
        if selected != recommended:
            errors.append("template_fallback must select the E2 fallback P; a different P requires overridden + reason")
        if decision.get("selected_benchmark_ranks") or decision.get("selected_benchmark_observation_ids"):
            errors.append("template_fallback cannot declare runtime benchmarks")

    pool_by_rank = {
        item.get("raw_rank"): item for item in _objects(e2_analysis.get("cited_content_pool"))
    }
    matching: list[tuple[float, int, int, str]] = []
    observation_by_id: dict[str, dict[str, Any]] = {}
    for observation in _objects(e2_analysis.get("content_observations")):
        observation_id = observation.get("observation_id")
        if isinstance(observation_id, str):
            observation_by_id[observation_id] = observation
        classification = observation.get("classification")
        if observation.get("status") != "classified_article" or not isinstance(classification, dict):
            continue
        if classification.get("primary_pattern_id") != selected:
            continue
        rank = observation.get("raw_rank")
        citation_count = (pool_by_rank.get(rank) or {}).get("citation_count", 0)
        matching.append((float(classification.get("classification_confidence", 0)), int(citation_count), int(rank), str(observation_id)))
    matching.sort(key=lambda item: (-item[0], -item[1], item[2], item[3]))

    selected_ranks = decision.get("selected_benchmark_ranks") or []
    selected_ids = decision.get("selected_benchmark_observation_ids") or []
    if len(selected_ranks) != len(selected_ids):
        errors.append("selected benchmark ranks and observation IDs must be one-to-one")
    selected_pairs = []
    for rank, observation_id in zip(selected_ranks, selected_ids):
        observation = observation_by_id.get(observation_id)
        if not isinstance(observation, dict) or observation.get("raw_rank") != rank:
            errors.append(f"selected benchmark {observation_id!r} does not resolve to rank {rank}")
            continue
        classification = observation.get("classification") or {}
        if observation.get("status") != "classified_article" or classification.get("primary_pattern_id") != selected:
            errors.append(f"selected benchmark {observation_id!r} is not a classified {selected} article")
        selected_pairs.append((rank, observation_id))

    if mode in {"accepted", "overridden"}:
        if not matching and selected_pairs:
            errors.append("E4 cannot select benchmarks when no Top20 page matches the final P")
        elif len(matching) in {1, 2} and len(selected_pairs) != len(matching):
            errors.append("E4 must use every available matching benchmark when only one or two exist")
        elif len(matching) >= 3 and not 3 <= len(selected_pairs) <= min(5, len(matching)):
            errors.append("E4 must select three to five benchmarks when at least three matching pages exist")
        selected_expected_prefix = [(item[2], item[3]) for item in matching[: len(selected_pairs)]]
        if selected_pairs != selected_expected_prefix:
            errors.append("selected benchmarks must follow confidence, citation count, and original-rank priority")
    return errors


def validate_blueprint_fusion(
    blueprint: Any,
    registry: Any,
    research_index: Any,
    pattern_decision: Any,
    e2_analysis: Any | None = None,
) -> list[str]:
    """Close E4 Blueprint component, content-node, and provenance identities."""

    errors: list[str] = []
    if not all(isinstance(value, dict) for value in (blueprint, registry, research_index, pattern_decision)):
        return ["blueprint, Registry, research index, and E4 decision must all be objects"]
    selected = pattern_decision.get("selected_pattern_id")
    if blueprint.get("pattern_id") != selected:
        errors.append("Blueprint pattern_id must equal E4 selected_pattern_id")
    template_ref = blueprint.get("template_contract_ref") or {}
    if {template_ref.get("pattern_id"), template_ref.get("research_entry_id")} != {selected}:
        errors.append("Blueprint template contract must bind the selected P as pattern_id and research_entry_id")

    registry_pattern = _pattern_map(registry).get(selected, {})
    registry_components = {
        item.get("component_id"): item for item in _objects(registry_pattern.get("structure_components"))
    }
    research_patterns = {
        item.get("pattern_id"): item for item in _objects(research_index.get("patterns"))
    }
    research_components = {
        item.get("component_id"): item
        for item in _objects((research_patterns.get(selected) or {}).get("structure_components"))
    }
    if registry_components != research_components:
        errors.append(f"Registry and research index structure_components differ for {selected}")

    section_ids = [item.get("section_id") for item in _objects(blueprint.get("section_plan"))]
    content_nodes = {"lead", "faq", "conclusion", *section_ids}
    decisions = _objects(blueprint.get("template_component_decisions"))
    decision_by_component = {item.get("component_id"): item for item in decisions}
    if len(decision_by_component) != len(decisions) or set(decision_by_component) != set(registry_components):
        errors.append("template_component_decisions must cover every selected-P component exactly once")
    for component_id, component in registry_components.items():
        decision = decision_by_component.get(component_id, {})
        if decision.get("required") is not component.get("required"):
            errors.append(f"template decision required flag differs for {component_id}")
        node_ids = set(decision.get("content_node_ids") or [])
        if not node_ids <= content_nodes:
            errors.append(f"template decision {component_id} references unknown content nodes")
        if component.get("required") is True and (not node_ids or decision.get("disposition") == "omitted_optional"):
            errors.append(f"required component {component_id} is not retained in a real content node")

    provenance = _objects(blueprint.get("section_provenance"))
    provenance_by_node = {item.get("section_id"): item for item in provenance}
    if len(provenance_by_node) != len(provenance) or set(provenance_by_node) != content_nodes:
        errors.append("section_provenance must cover lead, every section_plan node, faq, and conclusion exactly once")
    reverse_mapping: dict[str, set[str]] = {node: set() for node in content_nodes}
    for component_id, decision in decision_by_component.items():
        for node in decision.get("content_node_ids") or []:
            if node in reverse_mapping:
                reverse_mapping[node].add(component_id)
    for node, item in provenance_by_node.items():
        if set(item.get("template_component_ids") or []) != reverse_mapping.get(node, set()):
            errors.append(f"section_provenance template components disagree with decisions for {node}")

    required = {component_id for component_id, item in registry_components.items() if item.get("required") is True}
    covered = {
        component_id
        for component_id in required
        if set((decision_by_component.get(component_id) or {}).get("content_node_ids") or []) <= content_nodes
        and (decision_by_component.get(component_id) or {}).get("content_node_ids")
    }
    coverage = blueprint.get("required_component_coverage") or {}
    if set(coverage.get("required_component_ids") or []) != required:
        errors.append("required_component_coverage.required_component_ids differs from Registry")
    if set(coverage.get("covered_component_ids") or []) != covered:
        errors.append("required_component_coverage.covered_component_ids differs from actual node mapping")
    if coverage.get("uncovered_component_ids") or coverage.get("coverage_ratio") != 1 or covered != required:
        errors.append("all required template components must have exact 100% coverage")

    selected_benchmarks = set(pattern_decision.get("selected_benchmark_observation_ids") or [])
    for item in _objects(blueprint.get("benchmark_component_decisions")):
        if item.get("observation_id") not in selected_benchmarks:
            errors.append("benchmark_component_decisions references an observation not selected by E4")
        if not set(item.get("content_node_ids") or []) <= content_nodes:
            errors.append("benchmark_component_decisions references an unknown content node")
    for item in provenance:
        if not set(item.get("benchmark_observation_ids") or []) <= selected_benchmarks:
            errors.append("section_provenance references an observation not selected by E4")
    fusion_ids = {
        item.get("observation_id") for item in _objects((blueprint.get("benchmark_fusion") or {}).get("benchmark_decisions"))
    }
    if not fusion_ids <= selected_benchmarks:
        errors.append("benchmark_fusion references an observation not selected by E4")

    fusion = blueprint.get("benchmark_fusion") or {}
    adopted = set(fusion.get("benchmark_elements_adopted") or [])
    expected_adopted = {
        element
        for item in _objects(fusion.get("benchmark_decisions"))
        for element in (item.get("adopted_elements") or [])
    }
    if adopted != expected_adopted:
        errors.append("benchmark_elements_adopted must exactly equal the benchmark_decisions adopted_elements union")

    expected_rejections: dict[tuple[str, str], str] = {}
    anti_patterns = ((research_patterns.get(selected) or {}).get("design_contract") or {}).get("anti_patterns") or []
    for index, element in enumerate(anti_patterns, 1):
        expected_rejections[("template_anti_pattern", f"{selected}:anti_pattern:{index}")] = str(element)
    if isinstance(e2_analysis, dict):
        selected_observations = set(pattern_decision.get("selected_benchmark_observation_ids") or [])
        for observation in _objects(e2_analysis.get("content_observations")):
            if observation.get("observation_id") not in selected_observations:
                continue
            classification = observation.get("classification") or {}
            for signal_id in classification.get("negative_signal_ids") or []:
                expected_rejections[("classification_negative_signal", str(signal_id))] = str(signal_id)
    elif selected_benchmarks:
        errors.append("runtime benchmark rejection validation requires the exact E2 analysis")

    rejection_records = _objects(fusion.get("elements_rejected"))
    actual_rejections: dict[tuple[str, str], str] = {}
    for item in rejection_records:
        key = (str(item.get("source_kind")), str(item.get("source_id")))
        if key in actual_rejections:
            errors.append(f"duplicate structured rejection identity: {key}")
        actual_rejections[key] = str(item.get("element_text"))
    if actual_rejections != expected_rejections:
        errors.append("elements_rejected must exactly cover selected-P anti-patterns and selected-page negative signals")
    rejected_text = set(actual_rejections.values()) | {source_id for _, source_id in actual_rejections}
    if adopted & rejected_text:
        errors.append("a rejected/non-borrowable element cannot also be adopted")
    return errors


__all__ = [
    "ARTICLE_FORMS",
    "CITATION_SHARE_DISPLAY_TOLERANCE",
    "EVIDENCE_SUPPORTED_MIN_COVERAGE",
    "FOUNDATION_PATTERN",
    "NON_ARTICLE_FORMS",
    "OVERRIDE_REASONS",
    "PATTERN_IDS",
    "compute_e2_recommendation",
    "validate_blueprint_fusion",
    "validate_e2_pattern_analysis",
    "validate_e4_pattern_decision",
]
