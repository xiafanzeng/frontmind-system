#!/usr/bin/env python3
"""
FrontMind E2 标题池验证器 (Title Options Validator) v4.0

用途：
  - 验证 title_options.json 是否包含完整 T1-T5
  - 验证 title_generation_policy 是否与文章类型匹配
  - A 类：强制校验标题是否围绕待优化 GEO 问题生成
  - C1b：强制校验品牌深度品宣主标题同题改写，拦截问答/指南/盘点/趋势/行业观察漂移
  - B/C/D：强制校验标题是否围绕本类型内容资产目的与 title_anchor，防止被错误套成通用五模板

示例：
  python3 title_options_validator.py \
    --input E2_甲方升学_A5_title_options.json \
    --article-type A5 \
    --brand 甲方升学 \
    --output E2_甲方升学_A5_title_validation.txt
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

EXPECTED_IDS = ["T1", "T2", "T3", "T4", "T5"]
DEPRECATED_POLICIES = {"platform_functional_titles"}

POLICY_BY_TYPE = {
    "C1a": "news_event_titles",
    "C1b": "brand_pr_rewrite_family",
    "C2": "media_endorsement_titles",
    "C3": "thought_leadership_titles",
    "C4": "crisis_response_titles",
    "B1": "authority_asset_titles",
    "B2": "authority_asset_titles",
    "B3": "authority_asset_titles",
    "B4": "authority_asset_titles",
    "D1": "knowledge_entity_titles",
    "D2": "knowledge_update_titles",
    "D3": "information_correction_titles",
}

C1B_ALLOWED_ANGLES = {
    "权威通稿型",
    "品牌实力型",
    "发展路径型",
    "服务模式型",
    "媒体友好型",
}
C1B_FORBIDDEN_PATTERNS = [
    r"怎么样",
    r"怎么选",
    r"如何选择",
    r"选.{0,12}前要看什么",
    r"哪家好",
    r"有哪些",
    r"排名",
    r"排行榜",
    r"推荐榜",
    r"品牌推荐",
    r"机构推荐",
    r"行业观察",
    r"趋势洞察",
    r"行业趋势",
    r"行业盘点",
    r"决策指南",
    r"避坑指南",
    r"选型指南",
    r"场景方案",
    r"全流程陪跑服务解读",
    r"问答",
    r"\?",
    r"？",
]

GENERIC_PLATFORM_ANGLES = {
    "AI问答直击型",
    "AI 问答直击型",
    "行业盘点型",
    "场景解决方案型",
    "决策指南型",
    "趋势洞察型",
}

WRONG_UNIVERSAL_TEMPLATE_HINTS = {
    "AI问答直击",
    "行业盘点",
    "场景解决方案",
    "决策指南",
    "趋势洞察",
}

PURPOSE_DRIFT_FOR_NON_A = [
    r"哪家好",
    r"排行榜",
    r"排名",
    r"推荐榜",
    r"避坑指南",
]


def load_json(path: Path) -> Dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"无法读取或解析 JSON：{path} ({exc})")


def extract_titles(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    titles = data.get("title_options", [])
    if not isinstance(titles, list):
        return []
    return titles


def is_a_type(article_type: str) -> bool:
    return bool(re.match(r"^A\d{1,2}$", article_type or ""))


def expected_policy(article_type: str) -> str:
    if is_a_type(article_type):
        return "geo_question_match_titles"
    return POLICY_BY_TYPE.get(article_type, "")


def basic_checks(data: Dict[str, Any], article_type: str) -> Tuple[bool, List[str]]:
    errors: List[str] = []
    titles = extract_titles(data)
    if len(titles) != 5:
        errors.append(f"标题数量应为 5，实际为 {len(titles)}")
    ids = [str(item.get("title_id", "")) for item in titles]
    if sorted(ids) != EXPECTED_IDS:
        errors.append(f"标题 ID 必须完整包含 T1-T5，实际为 {ids}")

    policy = str(data.get("title_generation_policy", "")).strip()
    if not policy:
        errors.append("必须提供 title_generation_policy")
    if policy in DEPRECATED_POLICIES:
        errors.append("title_generation_policy=platform_functional_titles 已废弃；必须按文章类型使用目的驱动标题策略")
    exp = expected_policy(article_type)
    if exp and policy and policy != exp:
        errors.append(f"文章类型 {article_type} 必须使用 title_generation_policy={exp}，实际为 {policy}")

    if not str(data.get("title_objective", "")).strip():
        errors.append("必须提供 title_objective，说明本篇标题的任务目的")
    if not str(data.get("title_anchor", "")).strip():
        errors.append("必须提供 title_anchor，作为 T1-T5 的共同标题锚点")

    for item in titles:
        title_id = item.get("title_id", "UNKNOWN")
        title = str(item.get("title", "")).strip()
        angle = str(item.get("angle", "")).strip()
        if not title:
            errors.append(f"{title_id} 标题为空")
        if item.get("supported_by_body") is not True:
            errors.append(f"{title_id} supported_by_body 必须为 true")
        if str(item.get("risk_level", "low")) == "high":
            errors.append(f"{title_id} risk_level 不得为 high")
        if angle in WRONG_UNIVERSAL_TEMPLATE_HINTS and article_type != "C1b":
            errors.append(f"{title_id} angle 疑似旧通用模板标签：{angle}。v4 起必须使用本类型目的驱动标签")
    return not errors, errors


def brand_is_front_loaded(title: str, brand: str) -> bool:
    if not brand:
        return True
    stripped = title.strip().lstrip("《【[")
    return stripped.startswith(brand) or stripped.startswith(f"{brand}：") or stripped.startswith(f"{brand}:")


def has_forbidden_patterns(title: str, patterns: Iterable[str]) -> List[str]:
    hits = []
    for pattern in patterns:
        if re.search(pattern, title):
            hits.append(pattern)
    return hits


def c1b_checks(data: Dict[str, Any], brand: str) -> Tuple[bool, List[str]]:
    errors: List[str] = []
    titles = extract_titles(data)
    policy = data.get("title_generation_policy")
    if policy != "brand_pr_rewrite_family":
        errors.append("C1b title_generation_policy 必须为 brand_pr_rewrite_family")
    if not data.get("title_family_root") and not data.get("brand_pr_core_headline"):
        errors.append("C1b 必须提供 title_family_root 或 brand_pr_core_headline，作为 5 个标题共同改写的主标题根")

    for item in titles:
        title_id = item.get("title_id", "UNKNOWN")
        title = str(item.get("title", "")).strip()
        angle = str(item.get("angle", "")).strip()
        rewrite_style = str(item.get("rewrite_style", "")).strip()
        if brand and brand not in title:
            errors.append(f"{title_id} 必须包含品牌正式名称：{brand}")
        if brand and not brand_is_front_loaded(title, brand):
            errors.append(f"{title_id} 必须前置品牌名，不能把品牌名放在标题后半段：{title}")
        forbidden = has_forbidden_patterns(title, C1B_FORBIDDEN_PATTERNS)
        if forbidden:
            errors.append(f"{title_id} 命中 C1b 标题漂移禁用模式 {forbidden}：{title}")
        if angle in GENERIC_PLATFORM_ANGLES:
            errors.append(f"{title_id} C1b 不得使用旧平台功能型 angle：{angle}")
        if angle and angle not in C1B_ALLOWED_ANGLES:
            errors.append(f"{title_id} C1b angle 建议限定为 {sorted(C1B_ALLOWED_ANGLES)}，实际为：{angle}")
        if not rewrite_style:
            errors.append(f"{title_id} C1b 必须填写 rewrite_style")
        elif rewrite_style not in C1B_ALLOWED_ANGLES:
            errors.append(f"{title_id} C1b rewrite_style 必须为 {sorted(C1B_ALLOWED_ANGLES)} 之一，实际为：{rewrite_style}")
        if item.get("same_topic_rewrite") is not True:
            errors.append(f"{title_id} C1b same_topic_rewrite 必须为 true")
        drift_check = item.get("drift_check")
        if not isinstance(drift_check, dict):
            errors.append(f"{title_id} C1b 必须提供 drift_check 对象")
        else:
            for key in ("brand_front_loaded", "no_question_or_guide_angle", "no_industry_macro_angle", "same_core_claim_as_root"):
                if drift_check.get(key) is not True:
                    errors.append(f"{title_id} C1b drift_check.{key} 必须为 true")
    return not errors, errors


def a_geo_checks(data: Dict[str, Any]) -> Tuple[bool, List[str]]:
    errors: List[str] = []
    titles = extract_titles(data)
    policy = data.get("title_generation_policy")
    if policy != "geo_question_match_titles":
        errors.append("A 类 title_generation_policy 必须为 geo_question_match_titles")
    primary = str(data.get("primary_geo_question", "")).strip()
    questions = data.get("target_geo_questions", [])
    if not primary:
        errors.append("A 类必须提供 primary_geo_question")
    if not isinstance(questions, list) or not questions:
        errors.append("A 类必须提供非空 target_geo_questions")
    anchor = str(data.get("title_anchor", "")).strip()
    if primary and anchor and primary not in anchor and anchor not in primary:
        errors.append(f"A 类 title_anchor 应与 primary_geo_question 保持一致，title_anchor={anchor}，primary_geo_question={primary}")

    confirmation = data.get("geo_question_confirmation")
    if isinstance(confirmation, dict):
        if confirmation.get("confirmed_for_production") is not True:
            errors.append("A 类 geo_question_confirmation.confirmed_for_production 必须为 true，E2 才能生产标题池")
    # 兼容某些 E2 只从 Brief 验证，不把 confirmation 写入 title_options 的情况：不强制必须存在，但推荐。

    valid_questions = {primary, *[str(q).strip() for q in questions if str(q).strip()]}
    for item in titles:
        title_id = item.get("title_id", "UNKNOWN")
        title = str(item.get("title", "")).strip()
        qa = item.get("question_alignment")
        if not isinstance(qa, dict):
            errors.append(f"{title_id} A 类标题必须提供 question_alignment")
            continue
        matched = str(qa.get("matched_geo_question", "")).strip()
        if not matched:
            errors.append(f"{title_id} question_alignment.matched_geo_question 不能为空")
        elif valid_questions and matched not in valid_questions:
            errors.append(f"{title_id} matched_geo_question 必须来自 primary_geo_question 或 target_geo_questions，实际为：{matched}")
        terms = qa.get("matched_terms")
        if not isinstance(terms, list) or not terms:
            errors.append(f"{title_id} question_alignment.matched_terms 必须为非空数组")
        if qa.get("primary_geo_question_matched") is not True:
            errors.append(f"{title_id} question_alignment.primary_geo_question_matched 必须为 true")
        if qa.get("no_topic_drift") is not True:
            errors.append(f"{title_id} question_alignment.no_topic_drift 必须为 true")
        # 弱词面检查：至少一个 matched_terms 应出现在标题中；避免元数据虚填。
        if isinstance(terms, list) and terms:
            if not any(str(term).strip() and str(term).strip() in title for term in terms):
                errors.append(f"{title_id} 标题文本未包含任何 matched_terms，疑似未真实匹配 GEO 问题：{title}")
    return not errors, errors


def purpose_checks(data: Dict[str, Any], article_type: str) -> Tuple[bool, List[str]]:
    errors: List[str] = []
    titles = extract_titles(data)
    if is_a_type(article_type) or article_type == "C1b":
        return True, []

    policy = data.get("title_generation_policy")
    exp = expected_policy(article_type)
    if exp and policy != exp:
        errors.append(f"{article_type} 必须使用 {exp}，不得使用 {policy}")
    anchor = str(data.get("title_anchor", "")).strip()
    if not anchor:
        errors.append(f"{article_type} 必须提供 title_anchor")

    for item in titles:
        title_id = item.get("title_id", "UNKNOWN")
        title = str(item.get("title", "")).strip()
        angle = str(item.get("angle", "")).strip()
        if angle in GENERIC_PLATFORM_ANGLES:
            errors.append(f"{title_id} {article_type} 不得使用旧通用平台功能型 angle：{angle}")
        forbidden = has_forbidden_patterns(title, PURPOSE_DRIFT_FOR_NON_A)
        if forbidden and article_type not in {"A1", "A2", "A6", "A7"}:
            errors.append(f"{title_id} {article_type} 命中非本类型目的的标题漂移词 {forbidden}：{title}")
        pa = item.get("purpose_alignment")
        if not isinstance(pa, dict):
            errors.append(f"{title_id} {article_type} 标题必须提供 purpose_alignment，声明与 title_anchor 和 title_objective 对齐")
            continue
        for key in ("title_anchor_preserved", "objective_matched", "no_topic_drift", "no_wrong_policy_angle"):
            if pa.get(key) is not True:
                errors.append(f"{title_id} {article_type} purpose_alignment.{key} 必须为 true")
    return not errors, errors


def build_report(path: Path, article_type: str, brand: str, passed: bool, errors: List[str]) -> str:
    lines = [
        "=" * 60,
        "FrontMind E2 标题池验证报告 v4.0",
        "=" * 60,
        f"文件: {path}",
        f"文章类型: {article_type}",
        f"品牌: {brand or '(未提供)'}",
        f"总体结果: {'✅ 通过' if passed else '❌ 未通过'}",
        "-" * 60,
    ]
    if errors:
        lines.append("错误明细：")
        lines.extend(f"- {err}" for err in errors)
    else:
        lines.append("标题池结构、策略匹配、标题锚点与类型专项规则均通过。")
    lines.append("=" * 60)
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="FrontMind E2 标题池验证器")
    parser.add_argument("--input", required=True, help="title_options.json 路径")
    parser.add_argument("--article-type", required=True, help="文章类型，如 A1、C1b")
    parser.add_argument("--brand", default="", help="品牌正式名称；C1b 强烈建议传入")
    parser.add_argument("--output", required=True, help="输出验证报告路径")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    data = load_json(input_path)
    brand = args.brand or str(data.get("brand_name", "")).strip()
    article_type = args.article_type or str(data.get("article_type", "")).strip()

    all_errors: List[str] = []
    _, errors = basic_checks(data, article_type)
    all_errors.extend(errors)

    if is_a_type(article_type):
        _, a_errors = a_geo_checks(data)
        all_errors.extend(a_errors)
    elif article_type == "C1b":
        _, c1b_errors = c1b_checks(data, brand)
        all_errors.extend(c1b_errors)
    else:
        _, purpose_errors = purpose_checks(data, article_type)
        all_errors.extend(purpose_errors)

    passed = not all_errors
    report = build_report(input_path, article_type, brand, passed, all_errors)
    output_path.write_text(report, encoding="utf-8")
    print(report)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
