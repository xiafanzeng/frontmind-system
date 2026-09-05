#!/usr/bin/env python3
"""
品牌事实图谱 JSON Schema 校验器（V2 — 深度业务逻辑 + AI 友好反馈）
用途：校验 S1_{brand}_品牌事实图谱.json 是否符合 S1 品牌资产知识库的输出标准。

用法：
  python3 json_schema_validator.py <json_file> [schema_file] [--strict] [--ai-feedback]

新增能力（V2）：
  - 深度业务逻辑校验：证据溯源自动比对、维度交叉一致性检查
  - AI 友好反馈：--ai-feedback 输出 JSON 格式的修正建议，供 S0 编排师解析
  - 行业垂直校验：根据 industry 字段激活特定维度的深度检查
"""

import os
import sys
import json
import re
import argparse
from datetime import datetime


# ============================================================
# 校验规则定义
# ============================================================

REQUIRED_TOP_KEYS = ["facts", "claims", "evidence"]

REQUIRED_FACTS_KEYS = ["company_info"]

REQUIRED_COMPANY_INFO_FIELDS = ["full_name", "short_name", "industry"]

REQUIRED_CLAIMS_FIELDS = ["positioning", "value_proposition", "differentiators"]

EVIDENCE_REQUIRED_FIELDS = ["claim_ref", "source_url", "source_type", "timestamp", "confidence"]

VALID_SOURCE_TYPES = [
    "official_document", "official_website", "media_report",
    "client_statement", "ai_inference", "third_party_report",
    "social_media", "internal_document",
    "visual_asset_extraction", "third_party_platform", "map_poi", "user_review"
]

FACTS_DIMENSIONS = [
    "company_info", "team", "products", "technology", "clients",
    "certifications", "financials", "competition", "market",
    "brand_assets", "channels", "intent", "public_intelligence"
]

# 行业垂直维度：不同行业必须重点填充的维度
INDUSTRY_REQUIRED_DIMENSIONS = {
    "saas": ["products", "technology", "clients"],
    "软件": ["products", "technology", "clients"],
    "电商": ["products", "channels", "clients"],
    "消费品": ["products", "channels", "clients"],
    "医疗": ["certifications", "technology", "products"],
    "大健康": ["certifications", "technology", "products"],
    "制造": ["technology", "clients", "certifications"],
    "检测": ["certifications", "technology", "clients"],
    "服务": ["clients", "channels", "team"],
    "酒店": ["products", "clients", "public_intelligence"],
    "民宿": ["products", "clients", "public_intelligence"],
    "餐饮": ["products", "clients", "public_intelligence"],
    "茶饮": ["products", "channels", "public_intelligence"],
    "教育": ["products", "clients", "public_intelligence"],
    "培训": ["products", "clients", "public_intelligence"],
    "零售": ["products", "channels", "public_intelligence"],
    "连锁": ["products", "channels", "public_intelligence"],
    "医美": ["products", "certifications", "public_intelligence"],
    "健身": ["products", "clients", "public_intelligence"],
}


class ValidationResult:
    """校验结果收集器（V2：支持 AI 友好反馈）"""

    def __init__(self):
        self.fatal_errors = []
        self.severe_errors = []
        self.warnings = []
        self.ai_fixes = []  # AI 可执行的修正建议

    def fatal(self, msg: str, fix: str = ""):
        self.fatal_errors.append(f"[致命] {msg}")
        if fix:
            self.ai_fixes.append({"severity": "fatal", "message": msg, "fix_action": fix})

    def severe(self, msg: str, fix: str = ""):
        self.severe_errors.append(f"[严重] {msg}")
        if fix:
            self.ai_fixes.append({"severity": "severe", "message": msg, "fix_action": fix})

    def warn(self, msg: str, fix: str = ""):
        self.warnings.append(f"[警告] {msg}")
        if fix:
            self.ai_fixes.append({"severity": "warning", "message": msg, "fix_action": fix})

    @property
    def passed(self) -> bool:
        return len(self.fatal_errors) == 0 and len(self.severe_errors) == 0

    @property
    def has_warnings(self) -> bool:
        return len(self.warnings) > 0

    def summary(self) -> str:
        lines = ["=" * 60, "品牌事实图谱校验报告（V2）", "=" * 60, ""]
        if self.fatal_errors:
            lines.append(f"致命错误（{len(self.fatal_errors)} 项）：")
            for e in self.fatal_errors:
                lines.append(f"  {e}")
            lines.append("")
        if self.severe_errors:
            lines.append(f"严重错误（{len(self.severe_errors)} 项）：")
            for e in self.severe_errors:
                lines.append(f"  {e}")
            lines.append("")
        if self.warnings:
            lines.append(f"警告（{len(self.warnings)} 项）：")
            for w in self.warnings:
                lines.append(f"  {w}")
            lines.append("")
        if self.passed and not self.has_warnings:
            lines.append("✅ 校验通过，无任何问题。")
        elif self.passed:
            lines.append("⚠️ 校验通过，但存在警告。")
        else:
            lines.append("❌ 校验失败，请修复上述错误。")
        return "\n".join(lines)

    def ai_feedback_json(self) -> str:
        """输出 AI 可解析的 JSON 修正建议"""
        return json.dumps({
            "validator": "S1_品牌事实图谱校验器",
            "passed": self.passed,
            "error_count": len(self.fatal_errors) + len(self.severe_errors),
            "warning_count": len(self.warnings),
            "fix_actions": self.ai_fixes,
            "instruction_to_s0": (
                "请将以上 fix_actions 逐条传递给 S1 节点进行修复。"
                "每条 fix_action 包含 severity（严重度）、message（问题描述）、"
                "fix_action（具体修复指令）。S1 修复后需重新提交校验。"
            )
        }, ensure_ascii=False, indent=2)


# ============================================================
# 校验函数
# ============================================================

def validate_top_structure(data: dict, result: ValidationResult):
    """校验顶层结构"""
    for key in REQUIRED_TOP_KEYS:
        if key not in data:
            result.fatal(
                f"缺少顶层必填字段：{key}",
                f"在 JSON 根对象中添加 \"{key}\" 字段。"
                f"facts 为品牌事实对象，claims 为品牌主张对象，evidence 为证据数组。"
            )
        elif not isinstance(data[key], (dict, list)):
            result.fatal(
                f"顶层字段 {key} 类型错误，期望 dict/list，实际 {type(data[key]).__name__}",
                f"将 \"{key}\" 的值修改为正确的类型：facts 和 claims 为 object，evidence 为 array。"
            )


def validate_facts(facts: dict, result: ValidationResult):
    """校验 facts 段"""
    if not isinstance(facts, dict):
        result.fatal("facts 必须是 object 类型", "将 facts 修改为 JSON object（花括号）。")
        return

    # 校验必填子对象
    for key in REQUIRED_FACTS_KEYS:
        if key not in facts:
            result.fatal(
                f"facts 缺少必填子对象：{key}",
                f"在 facts 中添加 \"{key}\" 对象，至少包含 full_name、short_name、industry 三个字段。"
            )

    # 校验 company_info 必填字段
    company_info = facts.get("company_info", {})
    if isinstance(company_info, dict):
        for field in REQUIRED_COMPANY_INFO_FIELDS:
            val = company_info.get(field)
            if not val or (isinstance(val, str) and val.strip() == ""):
                result.fatal(
                    f"facts.company_info.{field} 不能为空",
                    f"从客户资料中提取品牌的 {field} 并填入 facts.company_info.{field}。"
                )

    # 统计维度覆盖率
    covered = 0
    missing_dims = []
    for dim in FACTS_DIMENSIONS:
        dim_data = facts.get(dim)
        if dim_data is not None:
            if isinstance(dim_data, dict) and len(dim_data) > 0:
                covered += 1
            elif isinstance(dim_data, list) and len(dim_data) > 0:
                covered += 1
            elif isinstance(dim_data, str) and dim_data.strip():
                covered += 1
            else:
                missing_dims.append(dim)
        else:
            missing_dims.append(dim)

    coverage = covered / len(FACTS_DIMENSIONS) * 100
    if coverage < 50:
        result.severe(
            f"13 维度覆盖率仅 {coverage:.0f}%（{covered}/{len(FACTS_DIMENSIONS)}），缺失维度：{missing_dims}",
            f"请从客户资料中补充以下维度的信息：{', '.join(missing_dims)}。"
            f"如果客户资料中确实没有相关信息，请在缺口报告中标注。"
        )
    elif coverage < 70:
        result.warn(
            f"13 维度覆盖率 {coverage:.0f}%（{covered}/{len(FACTS_DIMENSIONS)}），缺失维度：{missing_dims}",
            f"建议补充以下维度：{', '.join(missing_dims)}。"
        )

    # 行业垂直维度深度校验
    industry = company_info.get("industry", "").lower() if isinstance(company_info, dict) else ""
    for keyword, required_dims in INDUSTRY_REQUIRED_DIMENSIONS.items():
        if keyword in industry:
            for dim in required_dims:
                dim_data = facts.get(dim)
                is_empty = (
                    dim_data is None
                    or (isinstance(dim_data, dict) and len(dim_data) == 0)
                    or (isinstance(dim_data, list) and len(dim_data) == 0)
                )
                if is_empty:
                    result.severe(
                        f"行业垂直校验：{industry} 行业必须填充 facts.{dim}，但该维度为空",
                        f"品牌属于 {industry} 行业，facts.{dim} 是该行业的核心维度，"
                        f"请从客户资料中重点提取并填充。"
                    )
            break


def validate_claims(claims: dict, result: ValidationResult):
    """校验 claims 段"""
    if not isinstance(claims, dict):
        result.fatal("claims 必须是 object 类型", "将 claims 修改为 JSON object。")
        return

    for field in REQUIRED_CLAIMS_FIELDS:
        val = claims.get(field)
        if val is None:
            result.fatal(
                f"claims 缺少必填字段：{field}",
                f"在 claims 中添加 \"{field}\" 字段。positioning 为定位主张字符串，"
                f"value_proposition 为价值主张字符串，differentiators 为差异化要素数组。"
            )
        elif isinstance(val, str) and val.strip() == "":
            result.fatal(
                f"claims.{field} 不能为空字符串",
                f"从客户资料中提取品牌的 {field} 并填入。"
            )
        elif isinstance(val, list) and len(val) == 0:
            result.severe(
                f"claims.{field} 数组不能为空",
                f"至少添加 1 个 {field} 条目。differentiators 建议 ≥ 3 个。"
            )

    # 深度校验：differentiators 数量
    diffs = claims.get("differentiators", [])
    if isinstance(diffs, list) and 0 < len(diffs) < 3:
        result.warn(
            f"claims.differentiators 仅有 {len(diffs)} 个，建议 ≥ 3 个以支撑定位",
            f"请从客户资料中补充更多差异化要素，目标至少 3 个。"
        )


def validate_evidence(evidence: list, claims: dict, result: ValidationResult):
    """校验 evidence 段（V2：深度溯源比对）"""
    if not isinstance(evidence, list):
        result.fatal("evidence 必须是 array 类型", "将 evidence 修改为 JSON array。")
        return

    if len(evidence) == 0:
        result.severe(
            "evidence 数组为空，所有 claims 缺少证据支撑",
            "为每条 claims.differentiators 添加至少一条 evidence 记录，"
            "包含 claim_ref、source_url、source_type、timestamp、confidence 字段。"
        )
        return

    claim_refs_in_evidence = set()
    low_confidence_count = 0

    for i, item in enumerate(evidence):
        if not isinstance(item, dict):
            result.severe(
                f"evidence[{i}] 必须是 object 类型",
                f"将 evidence[{i}] 修改为包含 {', '.join(EVIDENCE_REQUIRED_FIELDS)} 的 JSON object。"
            )
            continue

        # 校验必填字段
        missing_fields = []
        for field in EVIDENCE_REQUIRED_FIELDS:
            if field not in item or item[field] is None:
                missing_fields.append(field)
        if missing_fields:
            result.severe(
                f"evidence[{i}] 缺少必填字段：{', '.join(missing_fields)}",
                f"为 evidence[{i}] 补充以下字段：{', '.join(missing_fields)}。"
            )

        # 校验 source_type
        source_type = item.get("source_type", "")
        if source_type and source_type not in VALID_SOURCE_TYPES:
            result.warn(
                f"evidence[{i}].source_type 值 '{source_type}' 不在标准列表中",
                f"将 source_type 修改为以下之一：{', '.join(VALID_SOURCE_TYPES)}。"
            )

        # 校验 confidence 范围
        confidence = item.get("confidence")
        if confidence is not None:
            if not isinstance(confidence, (int, float)):
                result.severe(
                    f"evidence[{i}].confidence 必须是数字类型",
                    f"将 confidence 修改为 0-1 之间的浮点数。"
                )
            elif confidence < 0 or confidence > 1:
                result.warn(
                    f"evidence[{i}].confidence 值 {confidence} 超出 0-1 范围",
                    f"将 confidence 修改为 0-1 之间的浮点数。"
                )
            elif confidence < 0.5:
                low_confidence_count += 1

        # 校验 source_url 格式
        source_url = item.get("source_url", "")
        if source_url and not re.match(r"^https?://", source_url):
            result.warn(
                f"evidence[{i}].source_url '{source_url}' 不是有效的 HTTP(S) URL",
                f"将 source_url 修改为完整的 URL（以 http:// 或 https:// 开头）。"
            )

        # 校验日期格式
        timestamp = item.get("timestamp", "")
        if timestamp:
            try:
                datetime.fromisoformat(timestamp)
            except ValueError:
                result.warn(
                    f"evidence[{i}].timestamp '{timestamp}' 不符合 ISO 8601 格式",
                    f"将 timestamp 修改为 ISO 8601 格式，如 '2026-04-27' 或 '2026-04-27T10:00:00'。"
                )

        claim_ref = item.get("claim_ref", "")
        if claim_ref:
            claim_refs_in_evidence.add(claim_ref)

    # 深度校验：每条 differentiator 是否有证据
    if isinstance(claims, dict):
        differentiators = claims.get("differentiators", [])
        if isinstance(differentiators, list):
            for j, diff in enumerate(differentiators):
                ref = f"differentiators[{j}]"
                if ref not in claim_refs_in_evidence:
                    diff_text = diff if isinstance(diff, str) else json.dumps(diff, ensure_ascii=False)[:50]
                    result.severe(
                        f"claims.differentiators[{j}]（'{diff_text}'）缺少对应的 evidence 记录",
                        f"为 differentiators[{j}] 添加一条 evidence，"
                        f"其 claim_ref 设为 'differentiators[{j}]'，并提供来源 URL 和置信度。"
                    )

    # 低置信度比例预警
    if len(evidence) > 0 and low_confidence_count / len(evidence) > 0.5:
        result.warn(
            f"超过 50% 的证据置信度低于 0.5（{low_confidence_count}/{len(evidence)}），"
            f"建议在缺口报告中重点标注",
            f"检查低置信度证据，尝试从客户资料中找到更可靠的来源进行替换。"
        )


def validate_json_file(json_path: str, schema_path: str = None,
                       strict: bool = False, ai_feedback: bool = False) -> int:
    """
    主校验入口

    Returns:
        0 = 通过
        1 = 失败
        2 = 通过但有警告
    """
    result = ValidationResult()

    # 读取 JSON 文件
    if not os.path.exists(json_path):
        print(f"[错误] 文件不存在：{json_path}")
        return 1

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"[错误] JSON 解析失败：{e}")
        if ai_feedback:
            print(json.dumps({
                "validator": "S1_品牌事实图谱校验器",
                "passed": False,
                "error_count": 1,
                "fix_actions": [{
                    "severity": "fatal",
                    "message": f"JSON 解析失败：{e}",
                    "fix_action": "检查 JSON 语法错误（如缺少逗号、引号不匹配、多余尾逗号等），修复后重新提交。"
                }]
            }, ensure_ascii=False, indent=2))
        return 1

    # 执行校验
    validate_top_structure(data, result)

    if "facts" in data:
        validate_facts(data["facts"], result)

    if "claims" in data:
        validate_claims(data["claims"], result)

    if "evidence" in data and "claims" in data:
        validate_evidence(data["evidence"], data["claims"], result)

    # 输出报告
    print(result.summary())

    if ai_feedback:
        print("\n--- AI 修正建议（JSON）---")
        print(result.ai_feedback_json())

    if not result.passed:
        return 1
    elif result.has_warnings and strict:
        return 1
    elif result.has_warnings:
        return 2
    else:
        return 0


# ============================================================
# CLI 入口
# ============================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="品牌事实图谱 JSON Schema 校验器（V2）")
    parser.add_argument("json_file", help="待校验的 JSON 文件路径")
    parser.add_argument("schema_file", nargs="?", default=None,
                        help="JSON Schema 文件路径（可选，默认使用内置规则）")
    parser.add_argument("--strict", action="store_true",
                        help="严格模式（警告也视为失败）")
    parser.add_argument("--ai-feedback", action="store_true",
                        help="输出 AI 可解析的 JSON 修正建议")

    args = parser.parse_args()
    exit_code = validate_json_file(args.json_file, args.schema_file, args.strict, args.ai_feedback)
    sys.exit(exit_code)
