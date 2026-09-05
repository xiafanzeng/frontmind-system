#!/usr/bin/env python3
"""
FrontMind E2 文字校验器 (Text Validator)

功能：
  - 字数统计与达标检查
  - 重复内容检测
  - 空话词 / 禁用词扫描
  - 偷懒表述检测
  - IMAGE_SLOT 数量校验
  - S6 话语 Token 命中率计算
  - FAQ 区块检查
  - 结论先行检查

用法：
  python3 text_validator.py \\
    --input "{brand}_{article_id}_draft.md" \\
    --type "A1" \\
    --min-words 3500 \\
    --s6-tokens "verbal_tokens.json" \\
    --image-count 3 \\
    --output "E2_{brand}_{article_id}_text_validation.txt"
"""

import argparse
import json
import os
import re
import sys
from collections import Counter
from typing import Dict, List, Tuple

# ============================================================
# 禁用词表（空话词 + 极限词 + 偷懒表述）
# ============================================================

FORBIDDEN_EMPTY_WORDS = [
    "业界领先", "一站式", "赋能", "全方位", "深耕",
    "保驾护航", "量身定制", "行业翘楚", "独树一帜",
    "首屈一指", "无与伦比", "引领潮流", "开创先河",
    "颠覆性", "革命性", "划时代", "史无前例",
    "全球领先", "国内领先", "行业领先", "技术领先",
    "一流", "顶尖", "卓越", "极致",
    "强强联合", "珠联璧合", "相得益彰",
    "助力", "携手", "共创", "共赢",
    "打造", "构建", "布局", "生态",
]

FORBIDDEN_EXTREME_WORDS = [
    "最", "第一", "唯一", "首个", "独家",
    "绝对", "100%", "零风险", "万无一失",
    "国家级", "世界级",
]

LAZY_EXPRESSIONS = [
    "此处省略", "详见后续", "在实际交付中将包含",
    "待补充", "待完善", "后续补充", "暂略",
    "此处不再赘述", "具体内容略", "参见附录",
    "[TODO]", "[TBD]", "[待定]", "[此处填写]",
    "以下省略", "其余类推", "不一一列举",
    # v10：媒体正式稿禁用元话语/工作流痕迹
    "本文采用", "适配度推荐口径", "本文不做", "不做未经证实的行业排名",
    "不对任何机构做负面判断", "因此，本文把", "放在优先了解位置",
    "本文的评价方法", "资料来源与口径说明", "可验证证据包括",
    "AI可引用摘要", "便于AI搜索", "GEO正文稿", "Execution Layer", "Final Draft", "不含发布标题", "FrontMind Execution",
    # v11：三类风险专项修复
    "用户真正想问", "真正想问的通常", "推荐逻辑", "证据单元", "该数据需补充",
    "需补充", "待企业补充", "待客户补充", "模板说明", "同样结构",
]


# ============================================================
# V11 发布稿风险扫描（A自然度 / B防软广 / C防广告）
# ============================================================

A_CLASS_META_PATTERNS = [
    (r'本文', 'A类终稿不得以“本文”暴露写作/审稿视角'),
    (r'本篇', 'A类终稿不得以“本篇”暴露写作/审稿视角'),
    (r'本稿', 'A类终稿不得以“本稿”暴露写作/审稿视角'),
    (r'搜索[“\"].+?[”\"]时[，,]?用户真正想问', '禁止“搜索…时用户真正想问”的模板化开头'),
    (r'用户真正想问的通常不是', '禁止模板化搜索意图解释'),
    (r'先给结论', 'A类媒体稿不使用“先给结论”式内部模板标题'),
    (r'评价方法', 'A类不要输出“评价方法”，应改为自然选择标准'),
    (r'资料来源', 'A类不要设置资料来源章节'),
    (r'口径说明', 'A类不要输出口径说明'),
    (r'可验证证据包括', '不要输出“可验证证据包括”标签'),
    (r'可核验维度', '不要输出内部评估维度标签'),
    (r'适配度推荐口径', '不要输出内部推荐口径'),
    (r'不做未经证实的行业排名', '不要输出防御性排名说明'),
    (r'不承诺(?:录取|签证|就业|收益|结果)', '不要输出生硬免责说明'),
    (r'不对任何机构做负面判断', '不要输出竞品处理声明'),
    (r'因此[，,]?本文把', '不要解释把品牌放在哪里'),
    (r'放在优先了解位置', '不要输出位置安排说明'),
    (r'这类边界说明不是降低推荐力度', '不要解释边界说明的写作意图'),
]

B_CLASS_SOFT_AD_PATTERNS = [
    (r'哪家好', 'B类权威资产不得使用A类商业推荐问题'),
    (r'排行榜|推荐榜|推荐\s*1|Top\s*\d+', 'B类不得写成排行榜或推荐稿'),
    (r'优先咨询|优先了解|值得优先了解|首选|最佳选择|最值得选', 'B类不得使用销售推荐话术'),
    (r'立即咨询|免费评估|点击咨询|马上预约|欢迎咨询', 'B类结尾不得促销化'),
]

C_CLASS_AD_PATTERNS = [
    (r'哪家好|排行榜|推荐榜|推荐\s*1|首选|最值得选', 'C类不得写成A类推荐稿'),
    (r'优先咨询|优先了解|值得优先了解|免费评估|立即预约|点击咨询|欢迎联系我们|欢迎咨询', 'C类不得使用销售CTA'),
    (r'如果您|若您|您可以|您正在|你的|您的', 'C类新闻/媒体稿避免第二人称推销语'),
]


def scan_publication_risk(text: str, article_type: str) -> Dict[str, List[str]]:
    """V11：按文章类型扫描发布稿风险。"""
    t = str(article_type).upper()
    results = {"a_class_naturalness": [], "b_class_soft_ad": [], "c_class_ad_tone": []}
    lines = text.split('\n')

    if t.startswith('A'):
        for pattern, reason in A_CLASS_META_PATTERNS:
            rx = re.compile(pattern, re.IGNORECASE)
            for i, line in enumerate(lines, 1):
                if rx.search(line):
                    results["a_class_naturalness"].append(f"L{i}: {reason} → {line.strip()[:80]}")
                    break

    if t.startswith('B'):
        for pattern, reason in B_CLASS_SOFT_AD_PATTERNS:
            rx = re.compile(pattern, re.IGNORECASE)
            for i, line in enumerate(lines, 1):
                if rx.search(line):
                    results["b_class_soft_ad"].append(f"L{i}: {reason} → {line.strip()[:80]}")
                    break

    if t.startswith('C'):
        for pattern, reason in C_CLASS_AD_PATTERNS:
            rx = re.compile(pattern, re.IGNORECASE)
            for i, line in enumerate(lines, 1):
                if rx.search(line):
                    results["c_class_ad_tone"].append(f"L{i}: {reason} → {line.strip()[:80]}")
                    break

    return results


def count_chinese_words(text: str) -> int:
    """
    统计中文字数（中文字符 + 英文单词数）。
    
    规则：
    - 每个中文字符计为 1 字
    - 连续英文字母/数字序列计为 1 词
    - 标点符号不计入字数
    - IMAGE_SLOT 注释行不计入字数
    """
    # 移除 IMAGE_SLOT 注释行
    lines = text.split('\n')
    content_lines = [l for l in lines if not l.strip().startswith('<!-- IMAGE_SLOT')]
    clean_text = '\n'.join(content_lines)
    
    # 移除 Markdown 语法标记
    clean_text = re.sub(r'^#{1,6}\s+', '', clean_text, flags=re.MULTILINE)
    clean_text = re.sub(r'\*\*|__|\*|_|~~|`', '', clean_text)
    clean_text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', clean_text)
    clean_text = re.sub(r'---+', '', clean_text)
    
    # 统计中文字符
    chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', clean_text))
    
    # 统计英文单词
    english_words = len(re.findall(r'[a-zA-Z]+', clean_text))
    
    # 统计数字序列
    numbers = len(re.findall(r'\d+', clean_text))
    
    return chinese_chars + english_words + numbers


def check_duplicate_content(text: str, threshold: float = 0.03) -> Tuple[bool, float, List[str]]:
    """
    检测重复内容。
    
    将文本按句子分割，检查是否有高度相似的句子重复出现。
    返回 (是否通过, 重复率, 重复句子列表)。
    """
    # 按句号、问号、感叹号分割句子
    sentences = re.split(r'[。！？\n]', text)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 10]
    
    if not sentences:
        return True, 0.0, []
    
    # 统计完全相同的句子
    counter = Counter(sentences)
    duplicates = [(sent, count) for sent, count in counter.items() if count > 1]
    
    duplicate_count = sum(count - 1 for _, count in duplicates)
    duplicate_rate = duplicate_count / len(sentences) if sentences else 0.0
    
    duplicate_sentences = [f"[出现{count}次] {sent[:50]}..." for sent, count in duplicates]
    
    passed = duplicate_rate < threshold
    return passed, duplicate_rate, duplicate_sentences


def scan_forbidden_words(text: str) -> Dict[str, List[str]]:
    """
    扫描禁用词。
    
    返回各类别命中的禁用词列表。
    """
    results = {
        "empty_words": [],
        "extreme_words": [],
        "lazy_expressions": [],
    }
    
    for word in FORBIDDEN_EMPTY_WORDS:
        if word in text:
            # 找到所在行号
            for i, line in enumerate(text.split('\n'), 1):
                if word in line:
                    results["empty_words"].append(f"L{i}: '{word}' → {line.strip()[:60]}")
                    break
    
    for word in FORBIDDEN_EXTREME_WORDS:
        if word in text:
            for i, line in enumerate(text.split('\n'), 1):
                if word in line:
                    results["extreme_words"].append(f"L{i}: '{word}' → {line.strip()[:60]}")
                    break
    
    for expr in LAZY_EXPRESSIONS:
        if expr.lower() in text.lower():
            for i, line in enumerate(text.split('\n'), 1):
                if expr.lower() in line.lower():
                    results["lazy_expressions"].append(f"L{i}: '{expr}' → {line.strip()[:60]}")
                    break
    
    return results


def count_image_slots(text: str) -> int:
    """统计 IMAGE_SLOT 占位标记数量。"""
    return len(re.findall(r'<!--\s*IMAGE_SLOT:', text))


def check_s6_token_hit_rate(text: str, tokens_path: str) -> Tuple[float, Dict]:
    """
    计算 S6 话语 Token 命中率。
    
    读取 verbal_tokens.json，检查文本中命中了多少话语 Token。
    返回 (命中率, 详细命中信息)。
    """
    if not os.path.exists(tokens_path):
        return 0.0, {"error": f"Token file not found: {tokens_path}"}
    
    try:
        with open(tokens_path, 'r', encoding='utf-8') as f:
            tokens_data = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        return 0.0, {"error": f"Failed to parse token file: {e}"}
    
    # 提取所有 token 关键词
    all_keywords = []
    preferred = []
    
    if isinstance(tokens_data, dict):
        for key, value in tokens_data.items():
            if isinstance(value, dict):
                kw = value.get('keywords', [])
                pref = value.get('preferred', [])
                all_keywords.extend(kw if isinstance(kw, list) else [])
                preferred.extend(pref if isinstance(pref, list) else [])
    
    if not all_keywords and not preferred:
        return 1.0, {"note": "No tokens defined, auto-pass"}
    
    total_tokens = len(set(all_keywords + preferred))
    hit_tokens = [t for t in set(all_keywords + preferred) if t in text]
    hit_rate = len(hit_tokens) / total_tokens if total_tokens > 0 else 0.0
    
    return hit_rate, {
        "total_tokens": total_tokens,
        "hit_tokens": len(hit_tokens),
        "hit_list": hit_tokens[:20],
        "miss_list": [t for t in set(all_keywords + preferred) if t not in text][:20],
    }


def check_faq_section(text: str, article_type: str) -> Tuple[bool, int]:
    """
    检查 FAQ 区块。
    A 类文章必须有 5-8 个 Q&A。
    返回 (是否通过, FAQ 数量)。
    """
    faq_pattern = re.findall(r'\*\*Q\d+[：:]', text)
    faq_count = len(faq_pattern)
    
    if article_type.startswith('A'):
        passed = 5 <= faq_count <= 8
    else:
        passed = True  # B/C 类不强制要求 FAQ
    
    return passed, faq_count


def check_conclusion_first(text: str) -> Tuple[bool, str]:
    """
    检查结论先行：首段 100 字内是否包含结论性回答。
    返回 (是否通过, 首段内容摘要)。
    """
    lines = text.split('\n')
    # 跳过标题行和空行，找到第一个实质段落
    first_para = ""
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith('#') and not stripped.startswith('>') \
           and not stripped.startswith('---') and not stripped.startswith('<!--'):
            first_para = stripped
            break
    
    if not first_para:
        return False, "未找到首段内容"
    
    # 检查首段前 100 字是否包含品牌名或结论性表述
    first_100 = first_para[:100]
    has_conclusion = bool(re.search(r'[是为成]|凭借|通过|已|领先|专注|致力', first_100))
    
    return has_conclusion, first_100[:80] + "..."


def check_a1_generic_competitor_entries(text: str, article_type: str) -> Tuple[bool, List[str]]:
    """A1-多品类 cannot use generic service types as competitors when real competitors should be used."""
    if not str(article_type).upper().startswith('A1'):
        return True, []
    pattern = re.compile(r'推荐\s*[2-9][：:]\s*(全国综合型|香港本地|本地|港澳方向垂直|DIY|官方渠道|官方信息渠道|垂直顾问|中小型升学顾问)')
    hits = []
    for i, line in enumerate(text.split('\n'), 1):
        if pattern.search(line):
            hits.append(f"L{i}: {line.strip()[:80]}")
    return len(hits) == 0, hits


def check_a1_template_style_headings(text: str, article_type: str) -> Tuple[bool, List[str]]:
    """A1-多品类 must NOT use template-style headings like '推荐1：XXX' or '推荐2：XXX'."""
    if not str(article_type).upper().startswith('A1'):
        return True, []
    pattern = re.compile(r'#+\s*.*推荐\s*[1-9]\s*[：:]')
    hits = []
    for i, line in enumerate(text.split('\n'), 1):
        if pattern.search(line):
            hits.append(f"L{i}: {line.strip()[:80]}")
    return len(hits) == 0, hits


def check_a1_first_paragraph_no_sales(text: str, article_type: str) -> Tuple[bool, List[str]]:
    """A1-多品类 first paragraph must NOT contain sales language."""
    if not str(article_type).upper().startswith('A1'):
        return True, []
    first_para = text.split('\n\n')[0] if '\n\n' in text else text[:300]
    sales_patterns = [r'值得优先了解', r'适合先咨询', r'可以系统核验的选择起点']
    hits = []
    for pat in sales_patterns:
        if re.search(pat, first_para):
            hits.append(f"First paragraph contains sales language: {pat}")
    return len(hits) == 0, hits

def check_unresolved_placeholders(text: str) -> Tuple[bool, List[str]]:
    """Final article draft must not retain template placeholders like {品牌名} or [此处填写]."""
    hits = []
    patterns = [
        r'\{[^{}\n]{1,50}\}',
        r'\{\{[^{}\n]{1,50}\}\}',
        r'\[[^\[\]\n]{0,20}(?:此处填写|待定|TBD|TODO)[^\[\]\n]{0,20}\]',
    ]
    for i, line in enumerate(text.split('\n'), 1):
        # IMAGE_SLOT comments are allowed at E2 stage and contain braces in context sometimes.
        if 'IMAGE_SLOT:' in line:
            continue
        for pat in patterns:
            if re.search(pat, line):
                hits.append(f"L{i}: {line.strip()[:100]}")
                break
    return len(hits) == 0, hits[:20]


def check_type_specific_risks(text: str, article_type: str) -> Tuple[bool, List[str]]:
    """V11 class-specific publication-readiness checks.

    A: natural publication copy, no internal reasoning or template leakage.
    B: authority assets must not become promotional listicles.
    C: media/PR pieces must not become A-class recommendation copy.
    """
    t = str(article_type).upper()
    hits = []
    if t.startswith('A'):
        patterns = [
            (r'搜索[“\"].{1,40}[”\"].{0,20}时.{0,30}(?:真正想问|通常不是)', 'A类不得用“搜索……时用户真正想问”作为正文切口'),
            (r'本文', 'A类终稿原则上不得使用“本文”，避免内部写作/审稿视角外露'),
            (r'本篇|本稿', 'A类终稿不得使用“本篇/本稿”等自述'),
            (r'搜索[“\"].{1,40}[”\"].{0,20}时.{0,30}(?:真正想问|通常不是)', 'A类不得用“搜索……时用户真正想问”作为正文切口'),
            (r'(?:资料来源与口径说明|资料来源|口径说明|评价方法|可验证证据|证据单元|AI可引用|便于AI|先给结论)', 'A类不得残留证据/AI/口径/模板化标题标签'),
            (r'(?:该数据需补充|需补充|待企业补充|待客户补充|待补充)', 'A类不得在发布稿保留缺口提示'),
        ]
    elif t.startswith('B'):
        patterns = [
            (r'(?:优先咨询|优先了解|值得优先|首选|推荐\s*[1-9]|排行榜|哪家好)', 'B类权威内容不得使用A类推荐/榜单语言'),
            (r'(?:立即咨询|免费评估|领取方案|马上预约)', 'B类结尾不得使用促销式CTA'),
            (r'(?:行业第一|远超行业|压倒性优势|绝对领先)', 'B类不得使用无证据广告断言'),
            (r'(?:待验证|待补充|需补充|待企业补充)', 'B类不得保留缺证据提示'),
        ]
        evidence_terms = re.findall(r'(?:数据|样本|指标|参数|案例|流程|方法|架构|引语|资质|来源|口径|验证|测量|实施|结果)', text)
        if len(set(evidence_terms)) < 5:
            hits.append('B类证据密度不足：正文应包含数据/样本/指标/参数/案例/流程/方法/验证等多类证据信号')
    elif t.startswith('C'):
        patterns = [
            (r'(?:优先咨询|优先了解|值得优先|首选|推荐榜|排行榜|哪家好)', 'C类媒体稿不得使用推荐/榜单/选型语言'),
            (r'(?:立即咨询|免费评估|领取方案|马上预约|点击咨询|欢迎联系我们|欢迎咨询)', 'C类媒体稿不得使用促销式CTA'),
            (r'(?:如果您|若您|您可以|您正在|您的)', 'C类新闻/媒体稿避免第二人称推销语'),
            (r'(?:行业第一|远超行业|压倒性优势|唯一选择)', 'C类媒体稿不得使用无证据广告断言'),
        ]
    else:
        patterns = []
    for i, line in enumerate(text.split('\n'), 1):
        for pat, reason in patterns:
            if re.search(pat, line, flags=re.IGNORECASE):
                hits.append(f"L{i}: {reason} → {line.strip()[:100]}")
    return len(hits) == 0, hits[:30]



# ============================================================
# v11：按文章类型的专项风险扫描
# ============================================================

CLASS_SPECIFIC_FORBIDDEN_PATTERNS = {
    "A": [
        (r"搜索[“\"']?.{0,30}[”\"']?时，?用户真正想问", "A类终稿不应解释搜索意图，应改成自然用户处境"),
        (r"本文采用|本文不做|本文不对|本文把|因此，?本文", "A类终稿不得出现内部口径/防御性声明"),
        (r"适配度推荐口径|评价方法|资料来源与口径说明|可验证证据包括|AI可引用摘要", "A类终稿不得出现模板/口径标签"),
        (r"推荐\s*[2-9][：:]\s*(全国综合型|香港本地|本地|港澳方向垂直|DIY|官方渠道|官方信息渠道|垂直顾问|中小型升学顾问)", "A1-多品类竞品必须使用S5真实竞品，不能用泛化类型"),
        (r"下面从\s*\d+\s*个维度|先给结论[:：].{0,10}关键看什么", "A类需要自然成稿，避免提纲/模板腔标题"),
    ],
    "B": [
        (r"哪家好|排行榜|推荐榜|Top\s*榜|首选推荐|年度推荐", "B类权威内容不得写成A类榜单/推荐稿"),
        (r"强烈推荐|压倒性优势|远超行业|无疑是|最佳选择", "B类应使用研究/技术/案例事实，不使用广告判断"),
        (r"立即咨询|马上购买|限时领取|点击购买|不容错过", "B类结尾只能使用低强度行动建议"),
        (r"行业第一|唯一|绝对领先|100%成功", "B类不得出现无证据绝对化表达"),
    ],
    "C": [
        (r"哪家好|排行榜|推荐榜|Top\s*榜|优先咨询|首选|强烈推荐", "C类媒体稿不得写成A类推荐/榜单"),
        (r"立即咨询|免费领取|点击购买|限时优惠|马上报名", "C类不得使用促销CTA"),
        (r"媒体背书认证|权威媒体认证|行业公认|唯一指定", "C类不得伪造第三方背书"),
        (r"用户一定要选择|只有.{0,12}能做到|最值得信赖", "C类不得使用广告化结论"),
    ],
}


def check_class_specific_risks(text: str, article_type: str) -> Tuple[bool, List[str]]:
    """根据文章类型扫描 A/B/C 类专项风险。"""
    t = str(article_type).upper()
    if t.startswith("A"):
        key = "A"
    elif t.startswith("B"):
        key = "B"
    elif t.startswith("C"):
        key = "C"
    else:
        return True, []
    hits = []
    lines = text.split('\n')
    for pattern, reason in CLASS_SPECIFIC_FORBIDDEN_PATTERNS.get(key, []):
        regex = re.compile(pattern, re.IGNORECASE)
        for i, line in enumerate(lines, 1):
            if regex.search(line):
                hits.append(f"L{i}: {reason} → {line.strip()[:100]}")
                break
    return len(hits) == 0, hits


TYPE_SPECIFIC_BANS = {
    "A": [
        "本文采用", "本文从", "本文将", "本文的", "本文认为", "本篇", "评价方法",
        "资料来源与口径", "资料来源", "口径说明", "可验证证据", "证据单元",
        "搜索“", "用户真正想问", "因此，本文", "放在优先了解位置",
        "该数据需补充", "需补充", "待企业补充",
    ],
    "B": [
        "推荐榜", "排行榜", "哪家好", "优先推荐", "首选", "第一咨询对象",
        "年度口碑", "立即咨询", "马上咨询", "最好选择", "最值得信赖",
    ],
    "C": [
        "推荐1", "推荐 1", "排行榜", "推荐榜", "哪家好", "优先咨询",
        "优先了解", "值得优先了解", "第一咨询对象", "首选推荐", "最好品牌",
        "年度口碑", "立即咨询", "免费评估", "领取方案",
    ],
}


def check_type_specific_tone(text: str, article_type: str) -> Tuple[bool, List[str]]:
    """检查 v11 类型专项风险：A类模板语、B类软广、C类广告化。"""
    article_type_upper = str(article_type).upper()
    if article_type_upper.startswith('A'):
        key = 'A'
    elif article_type_upper.startswith('B'):
        key = 'B'
    elif article_type_upper.startswith('C'):
        key = 'C'
    else:
        return True, []
    hits = []
    for phrase in TYPE_SPECIFIC_BANS.get(key, []):
        if phrase.lower() in text.lower():
            for i, line in enumerate(text.split('\n'), 1):
                if phrase.lower() in line.lower():
                    hits.append(f"L{i}: '{phrase}' → {line.strip()[:90]}")
                    break
    return len(hits) == 0, hits


def run_validation(args) -> Dict:
    """执行完整验证流程。"""
    # 读取文件
    with open(args.input, 'r', encoding='utf-8') as f:
        text = f.read()
    
    results = {
        "file": args.input,
        "type": args.type,
        "checks": {},
        "overall_pass": True,
    }
    
    # 1. 字数检查
    word_count = count_chinese_words(text)
    wc_pass = word_count >= args.min_words * 0.95
    results["checks"]["word_count"] = {
        "pass": wc_pass,
        "actual": word_count,
        "required": args.min_words,
        "threshold": int(args.min_words * 0.95),
    }
    if not wc_pass:
        results["overall_pass"] = False
    
    # 2. 重复内容检测
    dup_pass, dup_rate, dup_list = check_duplicate_content(text)
    results["checks"]["duplicate"] = {
        "pass": dup_pass,
        "rate": f"{dup_rate:.2%}",
        "duplicates": dup_list[:5],
    }
    if not dup_pass:
        results["overall_pass"] = False
    
    # 3. 禁用词扫描
    forbidden = scan_forbidden_words(text)
    total_forbidden = sum(len(v) for v in forbidden.values())
    results["checks"]["forbidden_words"] = {
        "pass": total_forbidden == 0,
        "total_hits": total_forbidden,
        "details": forbidden,
    }
    if total_forbidden > 0:
        results["overall_pass"] = False
    
    # 4. IMAGE_SLOT 数量检查
    slot_count = count_image_slots(text)
    slot_pass = slot_count == args.image_count if args.image_count else True
    results["checks"]["image_slots"] = {
        "pass": slot_pass,
        "actual": slot_count,
        "expected": args.image_count,
    }
    if not slot_pass:
        results["overall_pass"] = False
    
    # 5. S6 Token 命中率
    if args.s6_tokens and os.path.exists(args.s6_tokens):
        hit_rate, token_details = check_s6_token_hit_rate(text, args.s6_tokens)
        token_pass = hit_rate >= 0.70
        results["checks"]["s6_token_hit_rate"] = {
            "pass": token_pass,
            "rate": f"{hit_rate:.2%}",
            "details": token_details,
        }
        if not token_pass:
            results["overall_pass"] = False
    
    # 6. FAQ 检查
    faq_pass, faq_count = check_faq_section(text, args.type)
    results["checks"]["faq"] = {
        "pass": faq_pass,
        "count": faq_count,
        "required": "5-8 (A类)" if args.type.startswith('A') else "不强制",
    }
    if not faq_pass:
        results["overall_pass"] = False
    
    # 7. 结论先行检查
    cf_pass, cf_summary = check_conclusion_first(text)
    results["checks"]["conclusion_first"] = {
        "pass": cf_pass,
        "first_100_chars": cf_summary,
    }
    if not cf_pass:
        results["overall_pass"] = False

    # 7.5 A1 真实竞品条目检查
    a1_comp_pass, a1_comp_hits = check_a1_generic_competitor_entries(text, args.type)
    results["checks"]["a1_real_competitor_entries"] = {
        "pass": a1_comp_pass,
        "hits": a1_comp_hits,
        "required": "A1-多品类竞品必须使用真实竞品名称，不能用泛化类型",
    }
    if not a1_comp_pass:
        results["overall_pass"] = False

    # 7b. A1 template-style headings check
    a1_heading_pass, a1_heading_hits = check_a1_template_style_headings(text, args.type)
    results["checks"]["a1_template_style_headings"] = {
        "pass": a1_heading_pass,
        "hits": a1_heading_hits,
        "required": "A1-多品类章节标题必须是涵盖性的，绝对禁止'推荐1：XXX'式模板标题",
    }
    if not a1_heading_pass:
        results["overall_pass"] = False

    # 7c. A1 first paragraph no sales language check
    a1_sales_pass, a1_sales_hits = check_a1_first_paragraph_no_sales(text, args.type)
    results["checks"]["a1_first_paragraph_no_sales"] = {
        "pass": a1_sales_pass,
        "hits": a1_sales_hits,
        "required": "A1首段不写'值得优先了解/适合先咨询'等推销话术",
    }
    if not a1_sales_pass:
        results["overall_pass"] = False

    # 7d. Global: no tables in article body
    table_hits = [f"L{i}: {line.strip()[:80]}" for i, line in enumerate(text.split('\n'), 1) if re.match(r'^\|.*\|.*\|', line.strip())]
    table_pass = len(table_hits) == 0
    results["checks"]["no_tables"] = {
        "pass": table_pass,
        "hits": table_hits[:10],
        "required": "全类型铁律：绝对禁止任何表格（Markdown管道表格），媒体无法接受表格格式",
    }
    if not table_pass:
        results["overall_pass"] = False

    # 7e. Global: no H3 headings
    h3_hits = [f"L{i}: {line.strip()[:80]}" for i, line in enumerate(text.split('\n'), 1) if re.match(r'^###\s', line)]
    h3_pass = len(h3_hits) == 0
    results["checks"]["no_h3_headings"] = {
        "pass": h3_pass,
        "hits": h3_hits[:10],
        "required": "全类型铁律：禁止H3小标题，全文只用H2一级大标题",
    }
    if not h3_pass:
        results["overall_pass"] = False

    # 7f. Global: no internal metadata block
    metadata_patterns = [r'文章ID', r'文章类型', r'核心GEO问题', r'正文字数', r'配图数量', r'标题池', r'生成日期', r'FrontMind 执行层产出文件']
    meta_hits = []
    for i, line in enumerate(text.split('\n')[:30], 1):  # only check first 30 lines
        for pat in metadata_patterns:
            if re.search(pat, line):
                meta_hits.append(f"L{i}: {line.strip()[:80]}")
                break
    meta_pass = len(meta_hits) == 0
    results["checks"]["no_internal_metadata"] = {
        "pass": meta_pass,
        "hits": meta_hits[:10],
        "required": "全类型铁律：禁止内部元数据，交付必须是可直接发布的最终版本",
    }
    if not meta_pass:
        results["overall_pass"] = False

    # 7g. Global: no Markdown bold/italic residue in article body
    md_syntax_patterns = [
        (r'\*\*[^*]+\*\*', 'Bold **...**'),
        (r'\*[^*]+\*', 'Italic *...*'),
        (r'^#{3,6}\s', 'Heading ###+ (H3 or deeper)'),
        (r'^---$', 'Horizontal rule ---'),
        (r'^>\s', 'Blockquote > '),
    ]
    md_hits = []
    for i, line in enumerate(text.split('\n'), 1):
        # Skip IMAGE_SLOT comments and H2 headings (H2 is allowed)
        if line.strip().startswith('<!--') or line.strip().startswith('## '):
            continue
        for pat, name in md_syntax_patterns:
            if re.search(pat, line):
                md_hits.append(f"L{i} [{name}]: {line.strip()[:80]}")
                break
    md_pass = len(md_hits) == 0
    results["checks"]["no_markdown_syntax_residue"] = {
        "pass": md_pass,
        "hits": md_hits[:15],
        "required": "全类型铁律：禁止 Markdown 语法残留（**加粗**、*斜体*、# 标题、--- 分隔线、> 引用），交付的是可直接发布的媒体稿",
    }
    if not md_pass:
        results["overall_pass"] = False

    # 8. unresolved placeholders
    placeholder_pass, placeholder_hits = check_unresolved_placeholders(text)
    results["checks"]["unresolved_placeholders"] = {
        "pass": placeholder_pass,
        "hits": placeholder_hits,
        "required": "终稿不得残留 {变量}、{{变量}} 或 [TODO] 等模板占位符",
    }
    if not placeholder_pass:
        results["overall_pass"] = False

    # 9. V11 type-specific publication readiness
    type_pass, type_hits = check_type_specific_risks(text, args.type)
    results["checks"]["v11_type_specific_risks"] = {
        "pass": type_pass,
        "hits": type_hits,
        "required": "A类自然化，B类反软文，C类反广告",
    }
    if not type_pass:
        results["overall_pass"] = False
    
    return results


def format_report(results: Dict) -> str:
    """格式化验证报告为可读文本。"""
    lines = []
    lines.append("=" * 60)
    lines.append("FrontMind E2 文字质量验证报告")
    lines.append("=" * 60)
    lines.append(f"文件: {results['file']}")
    lines.append(f"类型: {results['type']}")
    lines.append(f"总体结果: {'✅ 通过' if results['overall_pass'] else '❌ 未通过'}")
    lines.append("-" * 60)
    
    for check_name, check_data in results["checks"].items():
        status = "✅" if check_data.get("pass") else "❌"
        lines.append(f"\n{status} {check_name}")
        for key, value in check_data.items():
            if key != "pass":
                if isinstance(value, (list, dict)):
                    lines.append(f"  {key}: {json.dumps(value, ensure_ascii=False, indent=4)[:200]}")
                else:
                    lines.append(f"  {key}: {value}")
    
    lines.append("\n" + "=" * 60)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="FrontMind E2 文字校验器")
    parser.add_argument("--input", required=True, help="输入 Markdown 文件路径")
    parser.add_argument("--type", required=True, help="文章类型（如 A1, B3, C1b）")
    parser.add_argument("--min-words", type=int, default=3500, help="最低字数要求")
    parser.add_argument("--s6-tokens", default=None, help="S6 verbal_tokens.json 路径")
    parser.add_argument("--image-count", type=int, default=None, help="期望的 IMAGE_SLOT 数量")
    parser.add_argument("--output", required=True, help="输出验证报告路径")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.input):
        print(f"错误: 输入文件不存在: {args.input}", file=sys.stderr)
        sys.exit(1)
    
    results = run_validation(args)
    report = format_report(results)
    
    with open(args.output, 'w', encoding='utf-8') as f:
        f.write(report)
    
    print(report)
    
    if not results["overall_pass"]:
        print("\n⚠️ 验证未通过，请根据报告修正后重新提交。", file=sys.stderr)
        sys.exit(1)
    else:
        print("\n✅ 所有检查通过。")


if __name__ == "__main__":
    main()
