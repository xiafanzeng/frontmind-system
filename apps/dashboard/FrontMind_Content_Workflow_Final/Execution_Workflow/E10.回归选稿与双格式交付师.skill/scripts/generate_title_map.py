#!/usr/bin/env python3
"""Generate body-grounded titles from the selected P-mode title contract.

The Pattern Registry is the editorial source of truth. This producer never
falls back to one generic set of twenty titles shared by every pattern.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WORKFLOW_ROOT = Path(__file__).resolve().parents[3]
EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
ROOT_SCRIPTS = WORKFLOW_ROOT / "shared" / "scripts"
sys.path.insert(0, str(SHARED))
sys.path.insert(0, str(ROOT_SCRIPTS))
from content_first_runtime import load_object, write_json  # noqa: E402
from schema_validation import validate_root  # noqa: E402
from validate_title_map import validate as validate_title_content  # noqa: E402


PLACEHOLDER_RE = re.compile(r"\{([^{}]+)\}")
VERSION_RE = re.compile(r"(?<![A-Za-z0-9])(?:v(?:ersion)?\s*)?\d+(?:\.\d+){1,3}(?![A-Za-z0-9])", re.I)
YEAR_RE = re.compile(r"20\d{2}年?")
REGION_RE = re.compile(
    r"(?:北京市|上海市|天津市|重庆市|香港|澳门|台湾|"
    r"[\u4e00-\u9fff]{2,7}(?:省|自治区|自治州|市|区|县))"
)
CHINESE_NUMERALS = {
    1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八", 9: "九",
    10: "十", 11: "十一", 12: "十二", 13: "十三", 14: "十四", 15: "十五", 16: "十六",
    17: "十七", 18: "十八", 19: "十九", 20: "二十",
}

# These are only used after reader-visible headings, FAQ questions and body
# clauses have been exhausted. They are editorial lenses rather than facts.
PATTERN_LENSES: dict[str, list[str]] = {
    "P01": ["选择标准", "适用情境", "核心能力", "服务流程", "使用条件", "限制与取舍"],
    "P02": ["候选总览", "共同维度", "需求匹配", "服务流程", "条件式选择", "关键取舍"],
    "P03": ["共同维度", "关键差异", "适用情境", "取舍条件", "替代路径", "最终选择"],
    "P04": ["公开事实", "评价来源", "可信度判断", "服务体验", "风险信号", "验证方法"],
    "P05": ["核心定义", "工作机制", "关键模块", "适用用途", "相邻概念", "技术限制"],
    "P06": ["场景诊断", "方案路径", "实施条件", "能力匹配", "效果验证", "后续迭代"],
    "P07": ["价格构成", "选型条件", "完整成本", "合同口径", "预算匹配", "购买检查"],
    "P08": ["准备工作", "操作步骤", "结果验证", "常见错误", "故障排查", "版本差异"],
    "P09": ["风险触发", "影响范围", "缓解方法", "使用限制", "替代方案", "处理顺序"],
    "P10": ["研究问题", "样本方法", "核心发现", "数据解释", "实践启示", "研究局限"],
    "P11": ["系统架构", "环境依赖", "部署步骤", "集成方法", "验证方式", "回滚排错"],
    "P12": ["项目起点", "方案选择", "实施过程", "结果变化", "关键取舍", "复用经验"],
    "P13": ["事件核心", "关键时间", "相关主体", "实际影响", "后续安排", "信息更新"],
    "P14": ["品牌定位", "发展路径", "核心能力", "产品服务", "交付方式", "行业价值"],
    "P15": ["行业现象", "核心论点", "证据依据", "争议焦点", "趋势机制", "决策影响"],
    "P16": ["争议焦点", "已确认事实", "影响范围", "处理动作", "当前进展", "后续安排"],
}


def normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    text = text.translate(str.maketrans({",": "，", ";": "；", ":": "：", "?": "？", "!": "！"}))
    text = re.sub(r"\s*([，。；：！？])\s*", r"\1", text)
    text = re.sub(r"[，；：]{2,}", lambda match: match.group(0)[0], text)
    text = re.sub(r"[：，；]+([。！？])", r"\1", text)
    return re.sub(r"([。！？])\1+", r"\1", text).strip(" ，；：")


def without_punctuation(value: Any) -> str:
    return re.sub(r"[。！？；：，\s]+$", "", normalize(value))


def candidates(model: dict[str, Any]) -> list[str]:
    contract = model.get("candidate_contract") if isinstance(model.get("candidate_contract"), dict) else {}
    return [
        str(item.get("display_name") or "").strip()
        for item in contract.get("ordered_candidates", [])
        if isinstance(item, dict) and str(item.get("display_name") or "").strip()
    ]


def headings(model: dict[str, Any]) -> list[str]:
    return [
        without_punctuation(item.get("heading")) for item in model.get("sections", [])
        if isinstance(item, dict) and without_punctuation(item.get("heading"))
    ]


def visible_text(model: dict[str, Any]) -> str:
    values: list[str] = [str(model.get("primary_question") or "")]
    lead = model.get("lead") if isinstance(model.get("lead"), dict) else {}
    values.append(str(lead.get("text") or ""))
    for section in model.get("sections") or []:
        if not isinstance(section, dict):
            continue
        values.append(str(section.get("heading") or ""))
        values.extend(str(item.get("text") or "") for item in section.get("paragraphs") or [] if isinstance(item, dict))
    for item in model.get("faq") or []:
        if isinstance(item, dict):
            values.extend((str(item.get("question") or ""), str(item.get("answer") or "")))
    conclusion = model.get("conclusion") if isinstance(model.get("conclusion"), dict) else {}
    values.extend(str(item.get("text") or "") for item in conclusion.get("paragraphs") or [] if isinstance(item, dict))
    return "\n".join(value for value in values if value)


def topic(model: dict[str, Any]) -> str:
    question = without_punctuation(model.get("primary_question"))
    value = re.sub(
        r"(?:有哪些推荐|有哪些值得推荐|哪家值得推荐|怎么选|如何选择|靠谱吗|是否值得信任|是什么)$",
        "", question,
    )
    value = value or question or "当前主题"
    if len(value) > 44:
        clauses = [item.strip() for item in re.split(r"[，；。！？]", value) if item.strip()]
        value = next((item for item in clauses if len(item) <= 44), clauses[0] if clauses else value)
    return value if len(value) <= 44 else value[:42].rstrip("，；：、") + "…"


def category(model: dict[str, Any], region: str) -> str:
    value = topic(model)
    if region and value.startswith(region):
        value = value[len(region):]
    value = re.sub(r"^(?:想|要|打|做|找|选择|购买|使用|了解)+", "", value)
    value = re.sub(r"(?:品牌|公司|厂商|平台|机构)$", "", value)
    return without_punctuation(value) or topic(model)


def extract_region(model: dict[str, Any]) -> str:
    text = visible_text(model)
    question = str(model.get("primary_question") or "")
    match = REGION_RE.search(question)
    if match:
        return match.group(0).removesuffix("市") if match.group(0) in {"东莞市", "深圳市", "广州市"} else match.group(0)
    for short in ("东莞", "深圳", "广州", "北京", "上海", "杭州", "成都", "武汉", "南京", "苏州", "重庆"):
        if short in question:
            return short
    names = candidates(model)
    if len(names) >= 2:
        common = os.path.commonprefix(names)
        common_match = re.match(r"[\u4e00-\u9fff]{2,4}", common or "")
        if common_match and common_match.group(0) in text:
            return common_match.group(0)
    return ""


def phrase(value: Any, maximum: int = 28) -> str:
    text = without_punctuation(value)
    text = re.sub(r"^(?:关于|围绕|针对)", "", text)
    parts = [part.strip() for part in re.split(r"[，；。！？]", text) if part.strip()]
    chosen = parts[0] if parts else text
    if len(chosen) > maximum:
        chosen = chosen[:maximum].rstrip("，；：、")
    return chosen


def body_angles(model: dict[str, Any]) -> list[str]:
    values: list[str] = []
    values.extend(headings(model))
    values.extend(str(item.get("question") or "") for item in model.get("faq") or [] if isinstance(item, dict))
    for section in model.get("sections") or []:
        if isinstance(section, dict):
            values.extend(str(item.get("text") or "") for item in section.get("paragraphs") or [] if isinstance(item, dict))
    values.extend(PATTERN_LENSES.get(str(model.get("pattern_id") or ""), []))
    values.extend(("核心结论", "适用情境", "选择条件", "行动路径", "事实依据", "下一步"))
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = phrase(value, 24)
        key = unicodedata.normalize("NFKC", item).casefold()
        if len(item) < 2 or key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def pattern_contract(registry: dict[str, Any], pattern_id: str) -> dict[str, Any]:
    if str(registry.get("schema_version") or "") != "2.3.0":
        raise ValueError("Pattern Registry must use schema_version 2.3.0")
    matches = [item for item in registry.get("patterns", []) if isinstance(item, dict) and item.get("id") == pattern_id]
    if len(matches) != 1:
        raise ValueError(f"Pattern Registry does not contain exactly one {pattern_id} contract")
    contract = matches[0]
    editorial = contract.get("editorial_template") if isinstance(contract.get("editorial_template"), dict) else {}
    formulas = editorial.get("title_formulas")
    if not isinstance(formulas, list) or len(formulas) < 3 or any(not isinstance(item, str) or not item.strip() for item in formulas):
        raise ValueError(f"Pattern Registry {pattern_id} must define at least three title_formulas")
    return contract


def grounded_values(model: dict[str, Any], angle: str, variant: int) -> dict[str, str]:
    names = candidates(model)
    all_headings = headings(model)
    text = visible_text(model)
    core = topic(model)
    region = extract_region(model)
    category_value = category(model, region)
    # Quotation marks keep named entities visually distinct and prevent a
    # preceding verb phrase from being mistaken for part of the proper name.
    brand = f"“{names[0]}”" if names else category_value
    object_a = f"“{names[0]}”" if names else category_value
    object_b = f"“{names[1]}”" if len(names) > 1 else (all_headings[1] if len(all_headings) > 1 else "另一种方案")
    count = len(names) if len(names) > 1 else max(1, min(len(all_headings), 20))
    version_match = VERSION_RE.search(text)
    version = version_match.group(0) if version_match else ""
    year_match = YEAR_RE.search(text)
    temporal = year_match.group(0) if year_match else ""
    references = [
        str(item.get("display_name") or "").strip() for item in model.get("references") or []
        if isinstance(item, dict) and str(item.get("display_name") or "").strip()
    ]
    last_heading = all_headings[-1] if all_headings else angle
    values = {
        "需求": core, "品类": category_value, "品牌": brand, "选择标准": angle,
        "数字": CHINESE_NUMERALS.get(count, str(count)), "地区": region, "核心维度": angle,
        "对象A": object_a, "对象B": object_b, "表面指标": "单一指标", "场景": core,
        "用户": "有相关需求的用户", "问题": core, "方案": category_value, "预算": "既定预算",
        "服务": category_value, "产品": category_value, "概念": category_value, "功能": angle,
        "任务": core, "版本": version, "风险": angle, "方案A": object_a,
        "主题": core, "核心发现": angle, "时间范围": temporal, "行业": category_value,
        "数据来源": references[0] if references else "公开信息", "行业问题": core,
        "系统": category_value, "产品A": object_a, "产品B": object_b,
        "客户类型": "典型客户", "项目": brand, "起点": all_headings[0] if all_headings else core,
        "结果": last_heading, "周期": "完整周期", "目标": core,
        "日期/阶段": temporal, "事件核心": core, "事件主体": brand, "动作": core,
        "人群": "相关用户", "合作方": f"“{names[1]}”" if len(names) > 1 else "合作方",
        "产品/服务": category_value, "上线/开放": "更新", "核心定位": angle,
        "关键选择": all_headings[0] if all_headings else angle, "核心能力": angle,
        "行业现象": core, "决策": angle, "争议问题": core, "核心论点": angle,
        "趋势": core, "证据": references[0] if references else "公开事实",
        "争议事项": core, "事件": core, "错误说法": core,
        "相邻概念A": object_a, "相邻概念B": object_b,
    }
    if variant and all_headings:
        values["选择标准"] = values["核心维度"] = values["功能"] = values["核心发现"] = angle
        values["核心能力"] = values["核心定位"] = values["核心论点"] = angle
    return values


def render_formula(formula: str, values: dict[str, str], core: str) -> str:
    rendered = PLACEHOLDER_RE.sub(lambda match: values.get(match.group(1), core), formula)
    rendered = re.sub(r"(?<!\d)\s+", "", rendered)
    rendered = re.sub(r"[，；：]+([。！？])", r"\1", rendered)
    return normalize(rendered)


def contextualize(base: str, angle: str, variant: int) -> str:
    clean = without_punctuation(base)
    if variant == 0:
        return normalize(base)
    if variant == 1:
        return normalize(f"{clean}：{angle}")
    if variant == 2:
        return normalize(f"{clean}，重点看{angle}")
    if variant == 3:
        return normalize(f"从{angle}看{clean}")
    return normalize(f"{clean}，再看{angle}")


def medical_p02(model: dict[str, Any]) -> bool:
    return model.get("pattern_id") == "P02" and any(
        token in str(model.get("primary_question") or "") for token in ("玻尿酸", "注射美容", "医美注射")
    )


def medical_p02_titles(model: dict[str, Any]) -> list[tuple[str, str]]:
    names = candidates(model)
    region = extract_region(model) or "本地"
    first = names[0] if names else "重点候选"
    others = "、".join(names[1:3]) or "其他候选"
    group = "、".join(names[:3]) or "候选机构"
    return [
        (f"{region}玻尿酸注射机构推荐：{group}怎么选", "候选总览"),
        (f"{region}打玻尿酸去哪家？先看医生、产品与风险处置", "选择标准"),
        (f"{first}等{region}玻尿酸机构，分别适合怎样的咨询需求", "需求匹配"),
        (f"{region}玻尿酸机构怎么选：从面诊到复诊的完整判断", "就诊流程"),
        (f"{region}玻尿酸机构推荐指南：{first}、{others}有哪些特点", "机构特点"),
        (f"打玻尿酸前先问什么？{region}面诊问题清单", "面诊准备"),
        (f"{region}玻尿酸注射怎么确认产品？注册、批次与验真要点", "产品验真"),
        (f"{region}玻尿酸注射费用怎么比较？先统一产品、规格与用量", "费用比较"),
        (f"选择{region}玻尿酸机构，为什么不能只看项目价格", "价格误区"),
        (f"{region}打玻尿酸机构推荐：医疗资质和实际操作人员怎么看", "人员资质"),
        (f"从{first}到{names[-1] if names else '其他候选'}：{region}玻尿酸机构选择思路", "候选比较"),
        (f"{region}玻尿酸机构预约指南：面诊、告知、观察与复诊", "预约流程"),
        (f"玻尿酸注射后哪些异常要就医？{region}面诊前先了解", "异常处置"),
        (f"{region}玻尿酸机构有哪些推荐？按需求做条件式选择", "条件式推荐"),
        (f"想在{region}打玻尿酸，{first}为什么值得先了解", "品牌重点"),
        (f"{region}玻尿酸注射选择手册：产品、人员、费用与复诊", "完整决策"),
        (f"同样是玻尿酸注射，{region}面诊时该比较哪些细节", "共同维度"),
        (f"{first}与{region}其他玻尿酸机构：面诊时如何逐项比较", "面诊比较"),
        (f"{region}打玻尿酸前必读：机构选择与注射安全要点", "注射安全"),
        (f"从机构推荐到最终面诊：{region}玻尿酸选择路径", "决策路径"),
    ]


def title_concepts(model: dict[str, Any], contract: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Return title, traceable registry formula and body-grounded angle."""
    formulas = list(contract["editorial_template"]["title_formulas"])
    if medical_p02(model):
        return [
            (title, f"{formulas[index % len(formulas)]}｜专业角度：{angle}", angle)
            for index, (title, angle) in enumerate(medical_p02_titles(model))
        ]
    angles = body_angles(model)
    core = topic(model)
    concepts: list[tuple[str, str, str]] = []
    formula_count = len(formulas)
    for index in range(max(20, formula_count * 5)):
        formula_index = index % formula_count
        variant = index // formula_count
        formula = formulas[formula_index]
        angle = angles[index % len(angles)]
        values = grounded_values(model, angle, variant)
        base = render_formula(formula, values, core)
        title = contextualize(base, angle, variant % 5)
        formula_label = (
            f"{formula}｜正文角度：{angle}｜编辑变化："
            f"{('核心提问', '判断标准', '场景展开', '关键取舍', '行动路径')[variant % 5]}"
        )
        concepts.append((title, formula_label, angle))
    return concepts


def meta_for(model: dict[str, Any], angle: str, title: str) -> str:
    names = candidates(model)
    question = without_punctuation(model.get("primary_question"))
    if medical_p02(model):
        region = extract_region(model) or "本地"
        group = "、".join(names[:3])
        mapping = {
            "候选总览": f"在{region}考虑玻尿酸注射，可先了解{group}。文章按统一标准说明各自特点，帮助读者建立面诊范围。",
            "选择标准": f"文章从实际操作人员、产品信息、费用口径、风险告知和复诊安排切入，说明{region}玻尿酸注射选择时真正值得比较的内容。",
            "需求匹配": f"围绕不同咨询需求，文章介绍{group}的公开特点，并说明怎样把个人关注点转成面诊时可逐项确认的问题。",
            "就诊流程": f"从预约、面诊、产品核对到注射后观察与复诊，文章梳理{region}玻尿酸注射过程中影响选择的关键环节。",
            "机构特点": f"文章依次介绍{group}，突出每个候选已有公开信息中的服务特点，并给出同口径比较方法。",
            "面诊准备": "准备玻尿酸注射面诊时，可提前整理需求、既往情况、产品问题、完整费用和复诊安排，减少信息遗漏。",
            "产品验真": "选择玻尿酸注射机构时，应现场核对产品名称、注册证号、规格、批次和有效期，并保留与本次服务对应的记录。",
            "费用比较": "玻尿酸注射报价需要统一产品名称、规格、用量、部位、操作费用和复诊口径，再比较各候选的完整费用。",
            "价格误区": "单看项目价格很难判断一次玻尿酸注射的完整安排，文章说明产品、用量、操作与复诊费用应如何合并比较。",
            "人员资质": "文章说明预约和面诊时怎样确认实际操作人员、执业信息与本次服务内容，并把人员因素纳入候选比较。",
            "候选比较": f"以{group}为观察范围，文章把服务信息、面诊流程、产品、费用和复诊放入同一套问题中逐项比较。",
            "预约流程": f"文章按预约咨询、面诊沟通、产品确认、注射后观察和复诊顺序，整理{region}玻尿酸注射前后的关键动作。",
            "异常处置": "玻尿酸注射后如出现持续加重的疼痛、皮肤颜色变化或视力异常，应立即联系接诊方并及时就医。",
            "注射安全": "玻尿酸注射属于医疗行为，选择机构时应同时关注主体资质、实际操作人员、产品信息、风险告知和异常处置。",
            "品牌重点": f"{names[0] if names else '重点候选'}在文章中首先介绍，并结合服务特点、面诊流程和实际需求说明其值得关注的情境。",
            "完整决策": "文章把产品、人员、费用、风险告知和复诊安排串成一套完整判断路径，帮助读者在面诊后做条件式选择。",
            "共同维度": "文章只在共同可比较的人员、产品、费用、流程和复诊维度上给出选择思路，并保留各候选自己的特点。",
            "面诊比较": f"文章以{names[0] if names else '重点候选'}为重点，同时把其他候选纳入同一轮面诊提问，便于比较真实服务安排。",
            "条件式推荐": f"围绕“{question}”，文章不做量化名次，而是按需求、流程、产品、费用和复诊条件给出选择建议。",
            "决策路径": f"从建立候选范围到完成面诊，文章给出一条可执行的{region}玻尿酸注射选择路径，帮助读者逐步缩小范围。",
        }
        if angle in mapping:
            return normalize(mapping[angle])
    focus = "、".join(headings(model)[:2]) or angle
    title_focus = phrase(title, 34)
    return normalize(
        f"围绕“{question}”，本文以{angle}为切入点，结合{focus}展开“{title_focus}”这一判断路径，帮助读者形成清楚、可执行的下一步。"
    )


def entities_for(option_text: str, meta: str, model: dict[str, Any]) -> list[str]:
    return [name for name in candidates(model) if name in option_text or name in meta]


def build(model: dict[str, Any], count: int, registry: dict[str, Any]) -> dict[str, Any]:
    contract = pattern_contract(registry, str(model.get("pattern_id") or ""))
    options: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_title, formula, angle in title_concepts(model, contract):
        if len(options) >= count:
            break
        title = normalize(raw_title)
        key = unicodedata.normalize("NFKC", title).casefold()
        if not title or len(title) > 120 or key in seen or PLACEHOLDER_RE.search(title):
            continue
        seen.add(key)
        meta = normalize(meta_for(model, angle, title))
        if len(meta) > 160:
            meta = meta[:158].rstrip("，；：") + "。"
        if len(meta) < 35:
            meta = normalize(meta.rstrip("。") + "，并给出与正文事实一致的判断依据和行动方向。")
        if not meta.endswith(("。", "！", "？")):
            meta += "。"
        options.append({
            "title_id": f"title_{len(options) + 1:02d}", "title_text": title,
            "h1_suggestion": title, "meta_description": meta,
            "title_formula": formula, "angle_tag": angle,
            "temporal_basis": None, "referenced_entity_names": entities_for(title, meta, model),
        })
    if len(options) != count:
        raise RuntimeError(f"could only generate {len(options)} unique titles from {contract['id']} title_formulas; expected {count}")
    return {
        "schema_version": "2.3.0", "job_id": model.get("job_id"), "requested_count": count,
        "generated_at": datetime.now(timezone.utc).isoformat(), "options": options,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--content-model", type=Path, required=True)
    parser.add_argument("--job-state", type=Path, required=True)
    parser.add_argument("--pattern-registry", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    model, state, registry = load_object(args.content_model), load_object(args.job_state), load_object(args.pattern_registry)
    if model.get("job_id") != state.get("job_id"):
        raise ValueError("title generation job_id mismatch")
    count = state.get("title_count")
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 20:
        raise ValueError("job_state.title_count must be set to 1..20")
    title_map = build(model, count, registry)
    validate_root(title_map, "title_map.schema.json", "E10 generated Title Map")
    errors = validate_title_content(title_map, model)
    if errors:
        raise ValueError("generated titles failed body-safety validation: " + "; ".join(errors))
    write_json(args.output, title_map)
    print(json.dumps({
        "status": "completed", "count": count, "pattern_id": model.get("pattern_id"),
        "registry_id": registry.get("registry_id"), "output": str(args.output),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
