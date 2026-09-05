#!/usr/bin/env python3
"""
FrontMind E4 合规扫描器 (Compliance Scanner)

功能：
  - 极限词扫描（广告法第九条）
  - 空话词扫描（品牌内容禁用）
  - 敏感词扫描（政治/宗教/民族）
  - 竞品贬损检测
  - 偷懒表述检测
  - 标题党词汇检测
  - 生成合规扫描报告

用法：
  python3 compliance_scanner.py \\
    --input "{brand}_{article_id}_draft.md" \\
    --output "{brand}_{article_id}_compliance_report.json"

依赖：无额外依赖
"""

import argparse
import json
import os
import re
import sys
from typing import Dict, List, Tuple

# ============================================================
# 合规关键词库
# ============================================================

EXTREME_WORDS = [
    "最", "最佳", "最好", "最优", "最先进", "最大", "最小", "最高", "最低",
    "第一", "首个", "首家", "首创", "独家", "唯一", "独一无二",
    "绝对", "100%", "万无一失", "零风险", "零缺陷", "零投诉",
    "国家级", "世界级", "全球领先", "全国领先",
    "史无前例", "前所未有", "空前绝后", "永久", "终身",
]

EMPTY_WORDS = [
    "赋能", "助力", "加持", "保驾护航", "强强联合",
    "一站式", "全方位", "多维度", "全链路", "生态化",
    "业界领先", "行业翘楚", "独树一帜", "首屈一指",
    "颠覆性", "革命性", "划时代", "引领潮流", "开创先河",
    "打造", "构建", "布局", "深耕", "量身定制",
    "携手共创", "珠联璧合", "相得益彰", "互利共赢",
    "无与伦比", "卓越", "极致",
]

SENSITIVE_PATTERNS = [
    # 竞品贬损模式
    (r'(?:质量差|不如|已经过时|价格虚高|服务态度差)', 'competitor_derogation'),
    # 标题党
    (r'(?:震惊|惊呆|吓人|恐怖|可怕|必看|必读|不看后悔|错过就没了)', 'clickbait'),
    (r'(?:秒杀|碾压|吊打|完爆|怒了|哭了|笑了|疯了|炸了)', 'clickbait'),
]

LAZY_EXPRESSIONS = [
    r'\[TODO\]', r'\[TBD\]', r'\[待定\]', r'\[此处填写\]',
    r'待补充', r'待完善', r'后续补充', r'暂略',
    r'此处省略', r'详见后续', r'在实际交付中将包含',
    r'此处不再赘述', r'具体内容略',
    r'以下省略', r'其余类推', r'不一一列举',
    # v10：媒体正式稿禁用元话语/工作流痕迹
    r'本文采用', r'适配度推荐口径', r'本文不做', r'不做未经证实的行业排名',
    r'不对任何机构做负面判断', r'因此，?本文把', r'放在优先了解位置',
    r'本文的评价方法', r'资料来源与口径说明', r'可验证证据包括',
    r'AI可引用摘要', r'便于\s*AI\s*搜索', r'GEO正文稿', r'Execution Layer', r'Final Draft', r'不含发布标题', r'FrontMind Execution',
    # v11：自然发布稿/防软广/防广告化专项拦截
    r'本文(?:采用|不做|不对|不承诺|把|的评价方法|企业信息基于|推荐逻辑)', r'本篇', r'本稿', r'搜索[“\"].{1,40}[”\"].{0,20}时.{0,30}(?:真正想问|通常不是)', r'用户真正想问',
    r'先给结论', r'评价方法', r'资料来源', r'口径说明', r'可核验维度', r'证据单元', r'该数据需补充',
    r'推荐\s*[2-9][：:]\s*(全国综合型|香港本地|本地|港澳方向垂直|DIY|官方渠道|官方信息渠道|垂直顾问|中小型升学顾问)',
    # v11：三类潜在风险修复
    r'用户真正想问', r'搜索[“\"].{0,60}[”\"].{0,20}真正',
    r'本文将', r'本文通过', r'本文基于', r'本文围绕', r'本篇', r'这篇内容',
    r'评价方法', r'评价口径', r'适配度判断', r'可核验维度',
    r'资料来源(?![\u4e00-\u9fff]*(?:附录|参考))', r'口径说明', r'可验证证据',
    r'AI可引用|便于\s*AI\s*搜索|GEO正文稿|Workflow|Template|Execution Layer|Final Draft',
    r'必须包含|至少包含|不得出现|直接回答',
    r'(?:B1|B2|B3|B4|白皮书|技术文档|Case Study|用例分析).{0,80}(?:排行榜|推荐\s*1|哪家好|首选|优先咨询|立即咨询|领取方案)',
    r'(?:C1a|C1b|C2|C3|C4|新闻稿|媒体稿|报道|评论).{0,80}(?:哪家好|推荐榜|排行榜|优先了解|优先咨询|首选|立即咨询|免费评估|领取方案|媒体背书|权威媒体认证)',
    # v11：三类风险专项修复
    r'用户真正想问', r'真正想问的通常', r'推荐逻辑', r'证据单元', r'该数据需补充',
    r'需补充', r'待企业补充', r'待客户补充', r'同样结构',
]


def scan_keywords(text: str, keywords: List[str], category: str) -> List[Dict]:
    """
    扫描文本中的关键词。
    
    Args:
        text: 待扫描文本
        keywords: 关键词列表
        category: 类别名称
    
    Returns:
        命中结果列表
    """
    hits = []
    lines = text.split('\n')
    
    for keyword in keywords:
        for line_num, line in enumerate(lines, 1):
            if keyword in line:
                # 提取上下文（关键词前后各 20 字符）
                idx = line.index(keyword)
                context_start = max(0, idx - 20)
                context_end = min(len(line), idx + len(keyword) + 20)
                context = line[context_start:context_end]
                
                hits.append({
                    'category': category,
                    'keyword': keyword,
                    'line': line_num,
                    'context': context.strip(),
                    'severity': _get_severity(category),
                })
                break  # 每个关键词只报告第一次出现
    
    return hits


def scan_patterns(text: str) -> List[Dict]:
    """
    使用正则模式扫描文本。
    
    Args:
        text: 待扫描文本
    
    Returns:
        命中结果列表
    """
    hits = []
    lines = text.split('\n')
    
    for pattern, category in SENSITIVE_PATTERNS:
        for line_num, line in enumerate(lines, 1):
            matches = re.findall(pattern, line)
            for match in matches:
                hits.append({
                    'category': category,
                    'keyword': match,
                    'line': line_num,
                    'context': line.strip()[:80],
                    'severity': _get_severity(category),
                })
    
    return hits


def scan_lazy_expressions(text: str) -> List[Dict]:
    """
    扫描偷懒表述。
    
    Args:
        text: 待扫描文本
    
    Returns:
        命中结果列表
    """
    hits = []
    lines = text.split('\n')
    
    for pattern in LAZY_EXPRESSIONS:
        for line_num, line in enumerate(lines, 1):
            if re.search(pattern, line, re.IGNORECASE):
                hits.append({
                    'category': 'lazy_expression',
                    'keyword': pattern,
                    'line': line_num,
                    'context': line.strip()[:80],
                    'severity': 'critical',
                })
    
    return hits


def scan_type_specific_risks(text: str, article_type: str = None) -> List[Dict]:
    """V11 class-specific scans for publication readiness."""
    if not article_type:
        return []
    t = str(article_type).upper()
    patterns = []
    if t.startswith('A'):
        patterns = [
            (r'搜索[“\"].{1,40}[”\"].{0,20}时.{0,30}(?:真正想问|通常不是)', 'A_natural_copy'),
            (r'本文.{0,12}(?:采用|不做|不承诺|不对|把|评价方法|推荐逻辑)', 'A_internal_meta'),
            (r'(?:资料来源与口径说明|口径说明|可验证证据|证据单元|AI可引用|便于AI)', 'A_internal_meta'),
            (r'(?:该数据需补充|需补充|待企业补充|待客户补充|待补充)', 'A_unfinished_copy'),
        ]
    elif t.startswith('B'):
        patterns = [
            (r'(?:优先咨询|优先了解|值得优先|首选|推荐\s*[1-9]|排行榜|哪家好)', 'B_soft_ad'),
            (r'(?:立即咨询|免费评估|领取方案|马上预约)', 'B_soft_ad'),
            (r'(?:行业第一|远超行业|压倒性优势|绝对领先)', 'B_unverified_claim'),
            (r'(?:待验证|待补充|需补充|待企业补充)', 'B_unfinished_copy'),
        ]
    elif t.startswith('C'):
        patterns = [
            (r'(?:优先咨询|优先了解|值得优先|首选|推荐榜|排行榜|哪家好)', 'C_ad_tone'),
            (r'(?:立即咨询|免费评估|领取方案|马上预约)', 'C_ad_tone'),
            (r'(?:行业第一|远超行业|压倒性优势|唯一选择)', 'C_unverified_claim'),
        ]
    hits = []
    for pattern, category in patterns:
        for line_num, line in enumerate(text.split('\n'), 1):
            if re.search(pattern, line, flags=re.IGNORECASE):
                hits.append({
                    'category': category,
                    'keyword': pattern,
                    'line': line_num,
                    'context': line.strip()[:100],
                    'severity': 'critical',
                })
    return hits


def _get_severity(category: str) -> str:
    """根据类别返回严重级别。"""
    severity_map = {
        'extreme_word': 'critical',
        'empty_word': 'minor',
        'competitor_derogation': 'major',
        'clickbait': 'minor',
        'lazy_expression': 'critical',
        'A_natural_copy': 'critical',
        'A_internal_meta': 'critical',
        'A_unfinished_copy': 'critical',
        'B_soft_ad': 'critical',
        'B_unverified_claim': 'critical',
        'B_unfinished_copy': 'critical',
        'C_ad_tone': 'critical',
        'C_unverified_claim': 'critical',
    }
    return severity_map.get(category, 'minor')


def calculate_deductions(hits: List[Dict]) -> Dict:
    """
    计算扣分。
    
    Args:
        hits: 所有命中结果
    
    Returns:
        扣分详情
    """
    deduction_rules = {
        'extreme_word': 20,
        'empty_word': 3,
        'competitor_derogation': 15,
        'clickbait': 5,
        'lazy_expression': 20,
        'A_natural_copy': 20,
        'A_internal_meta': 20,
        'A_unfinished_copy': 20,
        'B_soft_ad': 20,
        'B_unverified_claim': 20,
        'B_unfinished_copy': 20,
        'C_ad_tone': 20,
        'C_unverified_claim': 20,
    }
    
    total_deduction = 0
    category_deductions = {}
    
    for hit in hits:
        cat = hit['category']
        deduction = deduction_rules.get(cat, 5)
        total_deduction += deduction
        
        if cat not in category_deductions:
            category_deductions[cat] = {'count': 0, 'deduction': 0}
        category_deductions[cat]['count'] += 1
        category_deductions[cat]['deduction'] += deduction
    
    score = max(0, 100 - total_deduction)
    
    return {
        'score': score,
        'total_deduction': total_deduction,
        'passed': score == 100,
        'categories': category_deductions,
    }


def run_full_scan(text: str, article_type: str = None) -> Dict:
    """
    执行完整合规扫描。
    
    Args:
        text: 待扫描文本
    
    Returns:
        完整扫描结果
    """
    all_hits = []
    
    # 1. 极限词扫描
    all_hits.extend(scan_keywords(text, EXTREME_WORDS, 'extreme_word'))
    
    # 2. 空话词扫描
    all_hits.extend(scan_keywords(text, EMPTY_WORDS, 'empty_word'))
    
    # 3. 模式扫描（竞品贬损 + 标题党）
    all_hits.extend(scan_patterns(text))
    
    # 4. 偷懒表述扫描
    all_hits.extend(scan_lazy_expressions(text))

    # 5. v11 类型专项扫描
    all_hits.extend(scan_type_specific_risks(text, article_type))
    
    # 计算扣分
    deductions = calculate_deductions(all_hits)
    
    return {
        'total_hits': len(all_hits),
        'hits': all_hits,
        'deductions': deductions,
        'passed': deductions['passed'],
        'score': deductions['score'],
    }


def format_report(scan_result: Dict, input_file: str) -> str:
    """格式化扫描报告为可读文本。"""
    lines = []
    lines.append("=" * 60)
    lines.append("FrontMind E4 合规扫描报告")
    lines.append("=" * 60)
    lines.append(f"文件: {input_file}")
    lines.append(f"总命中数: {scan_result['total_hits']}")
    lines.append(f"合规得分: {scan_result['score']} / 100")
    lines.append(f"结果: {'✅ 通过' if scan_result['passed'] else '❌ 未通过'}")
    lines.append("-" * 60)
    
    if scan_result['hits']:
        for hit in scan_result['hits']:
            severity_icon = {'critical': '🔴', 'major': '🟠', 'minor': '🟡'}.get(
                hit['severity'], '⚪')
            lines.append(f"\n{severity_icon} [{hit['category']}] L{hit['line']}: {hit['keyword']}")
            lines.append(f"  上下文: {hit['context']}")
    else:
        lines.append("\n无合规问题。")
    
    lines.append("\n" + "=" * 60)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="FrontMind E4 合规扫描器")
    parser.add_argument("--input", required=True, help="输入 Markdown 文件路径")
    parser.add_argument("--type", default=None, help="文章类型（如 A1, B3, C2）；用于 V11 类型专项扫描")
    parser.add_argument("--output", default=None, help="输出报告路径（JSON）")
    parser.add_argument("--text-report", default=None, help="输出文本报告路径")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.input):
        print(f"错误: 输入文件不存在: {args.input}", file=sys.stderr)
        sys.exit(1)
    
    with open(args.input, 'r', encoding='utf-8') as f:
        text = f.read()
    
    result = run_full_scan(text, args.type)
    
    # 输出 JSON 报告
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    
    # 输出文本报告
    report = format_report(result, args.input)
    if args.text_report:
        with open(args.text_report, 'w', encoding='utf-8') as f:
            f.write(report)
    
    print(report)
    
    if not result['passed']:
        sys.exit(1)


if __name__ == "__main__":
    main()
