"""Conservative semantic drift signals shared by E9 observation and E10 selection."""

from __future__ import annotations

import re
from typing import Any


MEDICAL_PRODUCT_TERMS = (
    "玻尿酸", "透明质酸", "胶原蛋白", "胶原", "肉毒素", "肉毒杆菌毒素", "童颜针", "再生材料",
    "hyaluronic acid", "ha filler", "dermal filler", "collagen", "botox", "poly-l-lactic acid",
)
REGULATORY_JURISDICTION_TERMS = (
    "国家药品监督管理局", "国家药监局", "药监局", "NMPA", "FDA", "HIPAA", "EMA", "MHRA",
    "CE认证", "CE marking", "中国监管", "美国监管", "欧盟监管", "泰国监管", "Thai FDA",
)
HIGH_RISK_OPERATION_TERMS = (
    "进针", "推注", "穿刺", "针头", "针尖", "注射层次", "注射深度", "注射角度", "剂量", "配比",
    "稀释", "局部麻醉", "无菌操作", "回抽", "抽吸", "血管定位", "操作步骤", "具体步骤",
    "inject", "injection depth", "needle", "dosage", "administer", "puncture", "sterilize",
)
ENGLISH_RUN_RE = re.compile(r"(?:\b[A-Za-z]{3,}\b[\s,;:()/-]*){4,}")
THAI_RE = re.compile(r"[\u0E00-\u0E7F]")


def _present_terms(text: str, terms: tuple[str, ...]) -> list[str]:
    folded = text.casefold()
    return sorted({term for term in terms if term.casefold() in folded}, key=str.casefold)


def language_profile(text: str) -> list[str]:
    flags: list[str] = []
    if THAI_RE.search(text):
        flags.append("thai_script")
    if ENGLISH_RUN_RE.search(text):
        flags.append("extended_english_run")
    cjk_count = len(re.findall(r"[\u3400-\u9fff]", text))
    latin_count = len(re.findall(r"[A-Za-z]", text))
    if latin_count >= 60 and latin_count > cjk_count:
        flags.append("latin_dominant")
    return flags


def semantic_risk_profile(text: Any) -> dict[str, list[str]]:
    value = str(text or "")
    return {
        "medical_product_terms": _present_terms(value, MEDICAL_PRODUCT_TERMS),
        "regulatory_jurisdiction_terms": _present_terms(value, REGULATORY_JURISDICTION_TERMS),
        "language_profile": language_profile(value),
        "high_risk_operation_terms": _present_terms(value, HIGH_RISK_OPERATION_TERMS),
    }


def semantic_risk_issues(before: Any, after: Any) -> list[str]:
    previous, current = semantic_risk_profile(before), semantic_risk_profile(after)
    issues: list[str] = []
    if previous["medical_product_terms"] != current["medical_product_terms"]:
        issues.append("medical_product_terminology_changed")
    if previous["regulatory_jurisdiction_terms"] != current["regulatory_jurisdiction_terms"]:
        issues.append("regulatory_jurisdiction_changed")
    if previous["language_profile"] != current["language_profile"]:
        issues.append("language_script_profile_changed")
    if previous["high_risk_operation_terms"] != current["high_risk_operation_terms"]:
        issues.append("high_risk_operational_instruction_changed")
    return issues
