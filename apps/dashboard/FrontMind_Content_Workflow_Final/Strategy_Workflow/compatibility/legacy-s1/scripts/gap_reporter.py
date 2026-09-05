#!/usr/bin/env python3
"""
品牌知识库缺口报告生成器（v2.7）
用途：扫描品牌事实图谱 JSON 的 13 维度填充情况，生成缺口报告。
      v2.6 新增：视觉资产留存专项检查。
      v2.7 新增：公共情报采集专项检查（本地生活类行业强制）。

用法：
  python3 gap_reporter.py <json_file> <output_md> [--visual-assets-dir ./visual_assets/]

参数：
  json_file           品牌事实图谱 JSON 文件路径
  output_md           缺口报告输出路径（Markdown）
  --visual-assets-dir 视觉资产目录路径（默认: ./visual_assets/）
"""

import os
import sys
import json
import argparse
from datetime import datetime


# ============================================================
# 13 维度定义与必填字段
# ============================================================

DIMENSIONS = {
    "D01": {
        "name": "企业基础",
        "facts_key": "company_info",
        "required_fields": ["full_name", "short_name", "industry", "headquarters"],
        "optional_fields": ["english_name", "established_date", "registered_capital",
                            "legal_representative", "website_url", "social_media"],
        "impact": "全链路基础信息",
        "priority": "高"
    },
    "D02": {
        "name": "团队",
        "facts_key": "team",
        "required_fields": ["founder"],
        "optional_fields": ["total_employees", "rd_ratio", "core_team", "org_structure"],
        "impact": "S4 定位、S6 话语",
        "priority": "中"
    },
    "D03": {
        "name": "产品",
        "facts_key": "products",
        "required_fields": [],
        "optional_fields": ["name", "category", "description", "price_range"],
        "is_array": True,
        "min_items": 1,
        "impact": "S2 图谱、S4 定位、S8 问题路径",
        "priority": "高"
    },
    "D04": {
        "name": "技术",
        "facts_key": "technology",
        "required_fields": [],
        "optional_fields": ["core_technologies", "patents", "rd_investment", "tech_barriers"],
        "impact": "S4 定位、S9 IP 建议",
        "priority": "中"
    },
    "D05": {
        "name": "客户",
        "facts_key": "clients",
        "required_fields": ["target_segments"],
        "optional_fields": ["total_clients", "key_accounts", "retention_rate"],
        "impact": "S2 图谱、S4 定位、S8 问题路径",
        "priority": "高"
    },
    "D06": {
        "name": "资质",
        "facts_key": "certifications",
        "required_fields": [],
        "optional_fields": ["name", "number", "issuer", "valid_until"],
        "is_array": True,
        "min_items": 0,
        "impact": "S4 定位证据、S9 IP 建议",
        "priority": "中"
    },
    "D07": {
        "name": "财务",
        "facts_key": "financials",
        "required_fields": [],
        "optional_fields": ["annual_revenue", "revenue_growth", "profit_margin", "funding_rounds"],
        "impact": "S5 诊断、S9 赋能",
        "priority": "中"
    },
    "D08": {
        "name": "竞争",
        "facts_key": "competition",
        "required_fields": ["direct_competitors"],
        "optional_fields": ["indirect_competitors", "market_share", "competitive_advantages"],
        "impact": "S4 定位（核心依赖）",
        "priority": "高"
    },
    "D09": {
        "name": "市场",
        "facts_key": "market",
        "required_fields": [],
        "optional_fields": ["market_size", "growth_rate", "target_segment", "coverage_region"],
        "impact": "S3 趋势、S4 定位",
        "priority": "中"
    },
    "D10": {
        "name": "品牌视觉资产",
        "facts_key": "brand_assets",
        "required_fields": [],
        "optional_fields": ["logo_description", "brand_story", "brand_colors", "slogans",
                            "visual_asset_manifest", "retained_files", "extracted_palette",
                            "typography"],
        "impact": "S6 话语、S7 视觉符号体系、E3 视觉生成",
        "priority": "高"
    },
    "D11": {
        "name": "渠道",
        "facts_key": "channels",
        "required_fields": [],
        "optional_fields": ["online_channels", "offline_channels", "channel_distribution"],
        "impact": "S9 SEO/KOL 建议",
        "priority": "低"
    },
    "D12": {
        "name": "意图",
        "facts_key": "intent",
        "required_fields": ["strategic_goals"],
        "optional_fields": ["cooperation_expectations", "budget_range", "timeline"],
        "impact": "S0 编排、S9 赋能",
        "priority": "高"
    },
    "D13": {
        "name": "公共情报",
        "facts_key": "public_intelligence",
        "required_fields": [],
        "optional_fields": ["industry_trigger", "platforms_scanned", "rating_summary",
                            "positive_themes", "negative_themes", "storefront_images",
                            "poi_info", "competitive_context", "raw_reviews"],
        "conditional": True,
        "condition_desc": "本地生活类行业强制采集",
        "impact": "S4 定位、S8 问题路径、E1 选题、E5 分发",
        "priority": "高（本地生活类）/ 低（其他）"
    }
}


def analyze_dimension(facts: dict, dim_config: dict) -> dict:
    """分析单个维度的填充情况"""
    key = dim_config["facts_key"]
    data = facts.get(key)
    result = {
        "status": "missing",
        "missing_required": [],
        "missing_optional": [],
        "filled_count": 0,
        "total_count": len(dim_config.get("required_fields", [])) + len(dim_config.get("optional_fields", []))
    }

    if data is None:
        result["status"] = "missing"
        result["missing_required"] = dim_config.get("required_fields", [])
        return result

    is_array = dim_config.get("is_array", False)

    if is_array:
        if isinstance(data, list) and len(data) >= dim_config.get("min_items", 1):
            result["status"] = "complete"
            result["filled_count"] = len(data)
        elif isinstance(data, list) and len(data) == 0:
            result["status"] = "missing"
        else:
            result["status"] = "partial"
        return result

    if isinstance(data, dict):
        for field in dim_config.get("required_fields", []):
            val = data.get(field)
            if val is None or (isinstance(val, str) and val.strip() == ""):
                result["missing_required"].append(field)
            else:
                result["filled_count"] += 1

        for field in dim_config.get("optional_fields", []):
            val = data.get(field)
            if val is None or (isinstance(val, str) and val.strip() == ""):
                result["missing_optional"].append(field)
            else:
                result["filled_count"] += 1

        if len(result["missing_required"]) == 0 and len(result["missing_optional"]) == 0:
            result["status"] = "complete"
        elif len(result["missing_required"]) == 0:
            result["status"] = "partial"
        else:
            result["status"] = "incomplete"

    return result


def analyze_visual_assets(facts: dict, visual_assets_dir: str) -> dict:
    """
    v2.6 新增：视觉资产留存专项分析。
    检查 brand_assets 中的视觉资产留存情况和物理文件完整性。
    兼容字段名：brand_assets 或 visual_identity_assets。
    """
    brand_assets = facts.get("brand_assets", {})
    # 兼容可能的字段名变体
    visual_identity_assets = brand_assets.get("visual_identity_assets", {})
    result = {
        "has_logo_file": False,
        "has_favicon_file": False,
        "has_screenshot": False,
        "has_palette": False,
        "has_typography": False,
        "has_manifest": False,
        "retained_file_count": 0,
        "missing_physical_files": [],
        "palette_color_count": 0,
        "logo_source": None,
        "issues": [],
        "score": 0  # 0-5 分
    }

    # 检查视觉资产清单文件
    manifest_path = brand_assets.get("visual_asset_manifest", "")
    if manifest_path:
        result["has_manifest"] = True
        result["score"] += 1

    # 检查 scrape_status（可能在视觉资产清单 JSON 中）
    scrape_status = brand_assets.get("scrape_status", None)
    if manifest_path and os.path.exists(manifest_path):
        try:
            with open(manifest_path, 'r', encoding='utf-8') as mf:
                manifest_data = json.load(mf)
                scrape_status = manifest_data.get("scrape_status", scrape_status)
        except Exception:
            pass
    result["scrape_status"] = scrape_status

    # 检查 logo_files（兼容 retained_files 和 visual_identity_assets.logo_files 两种结构）
    logo_files = visual_identity_assets.get("logo_files", [])
    if logo_files:
        result["has_logo_file"] = True
        result["logo_source"] = logo_files[0].get("provided_by", "unknown")

    # 检查 retained_files
    retained = brand_assets.get("retained_files", [])
    result["retained_file_count"] = len(retained)

    for rf in retained:
        asset_type = rf.get("asset_type", "")
        local_path = rf.get("local_path", "")
        provided_by = rf.get("provided_by", "")

        if asset_type == "logo":
            result["has_logo_file"] = True
            result["logo_source"] = provided_by
        elif asset_type == "favicon":
            result["has_favicon_file"] = True
        elif asset_type == "screenshot":
            result["has_screenshot"] = True

        # 检查物理文件是否存在
        if local_path and visual_assets_dir:
            full_path = os.path.join(os.path.dirname(visual_assets_dir), local_path)
            if not os.path.exists(full_path):
                # 也尝试直接路径
                if not os.path.exists(local_path):
                    result["missing_physical_files"].append(local_path)

    if result["has_logo_file"]:
        result["score"] += 2  # Logo 权重最高

    if result["has_favicon_file"]:
        result["score"] += 0.5

    if result["has_screenshot"]:
        result["score"] += 0.5

    # 检查 extracted_palette
    palette = brand_assets.get("extracted_palette", {})
    dominant = palette.get("dominant_colors", [])
    if dominant and len(dominant) > 0:
        result["has_palette"] = True
        result["palette_color_count"] = len(dominant)
        result["score"] += 0.5

    # 检查 typography
    typo = brand_assets.get("typography", {})
    if typo and (typo.get("from_css") or typo.get("from_vi_manual") or typo.get("client_specified")):
        result["has_typography"] = True
        result["score"] += 0.5

    # 汇总问题
    if not result["has_logo_file"]:
        result["issues"].append("未留存任何 Logo 文件（客户未提供且官网抓取失败），S7 将无法基于真实 Logo 工作")
    if not result["has_palette"]:
        result["issues"].append("未提取到品牌配色，S7 生成的视觉方案可能与品牌实际色彩不符")
    if not result["has_screenshot"]:
        result["issues"].append("未留存官网截图，缺少整体视觉风格参考")
    if result["missing_physical_files"]:
        result["issues"].append(f"有 {len(result['missing_physical_files'])} 个视觉资产文件路径指向不存在的文件")

    # 也检查 visual_assets 目录本身
    if visual_assets_dir and os.path.isdir(visual_assets_dir):
        files = [f for f in os.listdir(visual_assets_dir)
                 if f.lower().endswith(('.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'))]
        if files and not result["has_logo_file"]:
            # 目录有文件但 retained_files 没记录
            result["issues"].append(f"visual_assets/ 目录有 {len(files)} 个图片文件但 retained_files 未记录")

    return result


def generate_report(json_path: str, output_path: str, visual_assets_dir: str = "./visual_assets/"):
    """生成缺口报告（v2.6 含视觉资产专项）"""
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    facts = data.get("facts", {})
    brand = facts.get("company_info", {}).get("short_name", "未知品牌")

    results = {}
    for dim_id, dim_config in DIMENSIONS.items():
        results[dim_id] = analyze_dimension(facts, dim_config)

    # 视觉资产专项分析
    visual_result = analyze_visual_assets(facts, visual_assets_dir)

    # 统计
    complete_count = sum(1 for r in results.values() if r["status"] == "complete")
    # D13 是条件性维度，非本地生活类不计入覆盖率分母
    effective_dims = len(DIMENSIONS)
    industry_info = facts.get("company_info", {}).get("sub_industry", "") or facts.get("company_info", {}).get("industry", "")
    local_kws = ["酒店", "民宿", "餐饮", "茶饮", "教育", "培训", "零售", "连锁", "医美", "健身", "丽人", "旅游"]
    if not any(kw in industry_info for kw in local_kws):
        effective_dims -= 1  # D13 不计入
    coverage = complete_count / effective_dims * 100 if effective_dims > 0 else 0
    required_missing = sum(len(r["missing_required"]) for r in results.values())

    # 确定等级
    if coverage >= 90:
        grade = "A"
    elif coverage >= 70:
        grade = "B"
    elif coverage >= 50:
        grade = "C"
    else:
        grade = "D"

    # 生成 Markdown
    lines = [
        f"# {brand} 知识库缺口报告",
        "",
        f"> 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"> 数据来源：`{os.path.basename(json_path)}`",
        f"> 报告版本：v2.7（含视觉资产 + 公共情报专项检查）",
        "",
        "## 总体评估",
        "",
        f"- {effective_dims} 维度覆盖率：{complete_count}/{effective_dims}（{coverage:.0f}%）",
        f"- 知识库等级：**{grade} 级**",
        f"- 必填字段缺失数：{required_missing}",
        "",
        "## 视觉资产留存评估（v2.6 新增）",
        "",
    ]

    # 视觉资产评估表
    va = visual_result
    logo_status = f"✅ 已留存（来源: {va['logo_source']}）" if va["has_logo_file"] else "❌ 未留存"
    palette_status = f"✅ 已提取（{va['palette_color_count']} 个色值）" if va["has_palette"] else "❌ 未提取"
    screenshot_status = "✅ 已留存" if va["has_screenshot"] else "❌ 未留存"
    manifest_status = "✅ 已生成" if va["has_manifest"] else "❌ 未生成"
    typo_status = "✅ 已提取" if va["has_typography"] else "❌ 未提取"

    lines.extend([
        "| 检查项 | 状态 | 说明 |",
        "| :--- | :--- | :--- |",
        f"| Logo 文件留存 | {logo_status} | S7 视觉符号体系的核心视觉约束 |",
        f"| 品牌配色提取 | {palette_status} | 确保生成图片色彩与品牌一致 |",
        f"| 官网截图留存 | {screenshot_status} | 整体视觉风格参考 |",
        f"| 字体线索提取 | {typo_status} | 辅助视觉方案设计 |",
        f"| 视觉资产清单 | {manifest_status} | S7/E3 的结构化输入 |",
        f"| 留存文件总数 | {va['retained_file_count']} 个 | — |",
        f"| 视觉资产评分 | **{va['score']:.1f}/5.0** | — |",
        "",
    ])

    if va["issues"]:
        lines.append("**视觉资产问题清单**：")
        lines.append("")
        for issue in va["issues"]:
            lines.append(f"- ⚠️ {issue}")
        lines.append("")

    if va["score"] < 2:
        lines.extend([
            '> **\u26a0\ufe0f 视觉资产严重不足**：当前视觉资产评分低于 2.0，S7 视觉符号体系将被迫进行"纯文本盲绘"，',
            '> 生成的视觉方案可能与品牌实际形象严重不符。**强烈建议**用户提供 Logo 源文件或高清 PNG。',
            "",
        ])

    # 公共情报专项分析（v2.7 新增）
    public_intel = facts.get("public_intelligence")
    industry = facts.get("company_info", {}).get("sub_industry", "") or facts.get("company_info", {}).get("industry", "")
    LOCAL_LIFE_KEYWORDS = ["酒店", "民宿", "餐饮", "茶饮", "教育", "培训", "零售", "连锁", "医美", "健身", "丽人",
                           "美容", "美发", "足浴", "影院", "KTV", "娱乐", "休闲", "旅游"]
    is_local_life = any(kw in industry for kw in LOCAL_LIFE_KEYWORDS)

    lines.extend([
        "## 公共情报采集评伌（v2.7 新增）",
        "",
    ])

    if is_local_life:
        if public_intel and isinstance(public_intel, dict):
            platforms = public_intel.get("platforms_scanned", [])
            pos_themes = public_intel.get("positive_themes", [])
            neg_themes = public_intel.get("negative_themes", [])
            storefront = public_intel.get("storefront_images", [])
            poi = public_intel.get("poi_info", {})

            poi_status = "✅ 已获取" if poi.get("address") else "❌ 未获取"
            lines.extend([
                f"- 行业属性：**{industry}**（本地生活类，强制采集）",
                f"- 已扫描平台数：{len(platforms)}",
                f"- 好评主题数：{len(pos_themes)}",
                f"- 差评主题数：{len(neg_themes)}",
                f"- 门头照/环境照：{len(storefront)} 张",
                f"- POI 信息：{poi_status}",
                "",
            ])
            if len(platforms) == 0:
                lines.append("> \u26a0\ufe0f **公共情报严重不足**：本地生活类业务必须至少扫描 1 个第三方平台。\u8bf7重新执行 Stage A-3。")
                lines.append("")
        else:
            lines.extend([
                f"- 行业属性：**{industry}**（本地生活类，强制采集）",
                "- 公共情报状态：\u274c **未采集**",
                "",
                "> \u26a0\ufe0f **严重缺失**：本地生活类业务必须执行 Stage A-3 全网公共情报研究。",
                "> 缺少第三方平台评分/评论/门头照将导致 S4 定位缺乏口碑支撑、E1 选题无法围绕真实用户痛点展开。",
                "",
            ])
    else:
        intel_status = "✅ 已采集" if public_intel else "— 未采集（可选）"
        lines.extend([
            f"- 行业属性：**{industry}**（非本地生活类，可选采集）",
            f"- 公共情报状态：{intel_status}",
            "",
        ])

    # 缺口详情表
    lines.extend([
        "## 缺口详情",
        "",
        "| 维度 | 状态 | 缺失必填字段 | 缺失选填字段 | 优先级 | 影响范围 |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |",
    ])

    STATUS_ICONS = {"complete": "✅ 完整", "partial": "⚠️ 部分", "incomplete": "❌ 不完整", "missing": "❌ 缺失"}

    for dim_id, dim_config in DIMENSIONS.items():
        r = results[dim_id]
        status = STATUS_ICONS.get(r["status"], "❓")
        missing_req = ", ".join(r["missing_required"]) if r["missing_required"] else "—"
        missing_opt = ", ".join(r["missing_optional"][:3]) if r["missing_optional"] else "—"
        if len(r.get("missing_optional", [])) > 3:
            missing_opt += f" 等{len(r['missing_optional'])}项"
        lines.append(
            f"| {dim_id} {dim_config['name']} | {status} | {missing_req} | {missing_opt} | {dim_config['priority']} | {dim_config['impact']} |"
        )

    lines.extend([
        "",
        "## 补充建议",
        "",
        f"当前知识库等级为 **{grade} 级**。",
        ""
    ])

    if grade in ("C", "D"):
        lines.append("建议用户优先补充以下高优先级维度的信息，以确保下游策略节点的产出质量：")
        lines.append("")
        for dim_id, dim_config in DIMENSIONS.items():
            r = results[dim_id]
            if r["status"] in ("missing", "incomplete") and dim_config["priority"] == "高":
                lines.append(f"- **{dim_id} {dim_config['name']}**：影响 {dim_config['impact']}")
    else:
        lines.append("知识库基本完整，可继续执行后续策略节点。")

    # 视觉资产补充建议
    if not va["has_logo_file"]:
        lines.extend([
            "",
            "### 视觉资产补充建议（高优先级）",
            "",
            "- **请用户提供 Logo 源文件**（AI/EPS/SVG/高清 PNG 均可），这是 S7 视觉符号体系的核心约束输入",
            "- 如有 VI 手册（视觉识别系统），请一并提供",
            "- 如有品牌标准色色号（Hex/RGB/Pantone），请明确告知",
        ])

    lines.append("")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"[OK] 缺口报告已生成：{output_path}")
    print(f"     等级：{grade} | 覆盖率：{coverage:.0f}% | 必填缺失：{required_missing}")
    print(f"     视觉资产评分：{va['score']:.1f}/5.0 | Logo: {'✅' if va['has_logo_file'] else '❌'} | 配色: {'✅' if va['has_palette'] else '❌'}")


# ============================================================
# CLI 入口
# ============================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="品牌知识库缺口报告生成器 v2.7（含公共情报专项检查）")
    parser.add_argument("json_file", help="品牌事实图谱 JSON 文件路径")
    parser.add_argument("output_md", help="缺口报告输出路径（Markdown）")
    parser.add_argument("--visual-assets-dir", default="./visual_assets/",
                        help="视觉资产目录路径（默认: ./visual_assets/）")
    args = parser.parse_args()
    generate_report(args.json_file, args.output_md, args.visual_assets_dir)
