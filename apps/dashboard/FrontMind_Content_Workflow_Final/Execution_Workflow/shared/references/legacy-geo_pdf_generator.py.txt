#!/usr/bin/env python3
"""
FrontMind 策略工作流 PDF 生成器 — 深紫/黑/白风格
基于 WeasyPrint + Markdown → HTML → PDF 管线
用法: python3 geo_pdf_generator.py input.md output.pdf [--title "报告标题"]
"""

import re
import sys
import os
import datetime
import markdown

# ============================================================
# CSS 样式表 — 深紫/黑/白风格（FrontMind 品牌）
# ============================================================
CSS_STYLE = """
@page {
    size: A4;
    margin: 22mm 20mm 25mm 20mm;
    @top-left {
        content: "";
        font-family: 'Noto Sans CJK SC', sans-serif;
        font-size: 7pt;
        color: #9CA3AF;
    }
    @top-right {
        content: "";
        font-family: 'Noto Sans CJK SC', sans-serif;
        font-size: 7pt;
        color: #9CA3AF;
    }
    @bottom-center {
        content: "— " counter(page) " —";
        font-family: 'Noto Sans CJK SC', sans-serif;
        font-size: 8pt;
        color: #9CA3AF;
    }
    @top-left-corner { border-bottom: 2px solid #6B21A8; }
    @top-center { border-bottom: 2px solid #6B21A8; }
    @top-left { border-bottom: 2px solid #6B21A8; }
    @top-right { border-bottom: 2px solid #6B21A8; }
    @top-right-corner { border-bottom: 2px solid #6B21A8; }
    @bottom-left-corner { border-top: 0.5px solid #8B5CF6; }
    @bottom-center { border-top: 0.5px solid #8B5CF6; }
    @bottom-left { border-top: 0.5px solid #8B5CF6; }
    @bottom-right { border-top: 0.5px solid #8B5CF6; }
    @bottom-right-corner { border-top: 0.5px solid #8B5CF6; }
}

@page :first {
    @top-left { content: none; border: none; }
    @top-right { content: none; border: none; }
    @top-left-corner { border: none; }
    @top-center { border: none; }
    @top-right-corner { border: none; }
    @bottom-center { content: none; }
    @bottom-left-corner { border: none; }
    @bottom-center { border: none; }
    @bottom-left { border: none; }
    @bottom-right { border: none; }
    @bottom-right-corner { border: none; }
}

/* ---- 基础 ---- */
body {
    font-family: 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', sans-serif;
    font-size: 10pt;
    line-height: 1.7;
    color: #1A1A1A;
    text-align: justify;
}

/* ---- 封面 ---- */
.cover {
    page-break-after: always;
    padding-top: 120px;
}
.cover .deco-line {
    width: 40%;
    height: 3px;
    background: #6B21A8;
    margin-bottom: 24px;
}
.cover h1 {
    font-size: 28pt;
    font-weight: 700;
    color: #6B21A8;
    line-height: 1.3;
    margin-bottom: 12px;
    border: none;
    padding: 0;
}
.cover .subtitle {
    font-size: 13pt;
    color: #6B7280;
    margin-bottom: 60px;
}
.cover .deco-line-thin {
    width: 60%;
    height: 1px;
    background: #8B5CF6;
    margin-bottom: 30px;
}
.cover .meta {
    font-size: 10pt;
    color: #6B7280;
    line-height: 2;
}

/* ---- 标题 ---- */
h1 {
    font-size: 16pt;
    font-weight: 700;
    color: #6B21A8;
    border-left: 4px solid #6B21A8;
    padding-left: 12px;
    margin-top: 28px;
    margin-bottom: 12px;
    line-height: 1.4;
    page-break-after: avoid;
}
h2 {
    font-size: 13pt;
    font-weight: 700;
    color: #1A1A2E;
    margin-top: 20px;
    margin-bottom: 8px;
    line-height: 1.4;
    page-break-after: avoid;
}
h3 {
    font-size: 11pt;
    font-weight: 600;
    color: #1A1A1A;
    margin-top: 14px;
    margin-bottom: 6px;
    page-break-after: avoid;
}
h4, h5, h6 {
    font-size: 10pt;
    font-weight: 600;
    color: #374151;
    margin-top: 10px;
    margin-bottom: 4px;
    page-break-after: avoid;
}

/* ---- 编号标签 ---- */
.section-badge {
    display: inline-block;
    background: #6B21A8;
    color: white;
    font-size: 9pt;
    font-weight: 700;
    padding: 2px 10px;
    border-radius: 4px;
    margin-bottom: 6px;
    margin-right: 6px;
}

/* ---- 段落 ---- */
p {
    margin-bottom: 8px;
    orphans: 3;
    widows: 3;
}

/* ---- 粗体 ---- */
strong, b {
    font-weight: 700;
    color: #111827;
}

/* ---- 行内代码 ---- */
code {
    font-family: 'Noto Sans Mono CJK SC', 'Courier New', monospace;
    font-size: 8.5pt;
    color: #7C3AED;
    background: #F3F4F6;
    padding: 1px 4px;
    border-radius: 3px;
}

/* ---- 代码块 ---- */
pre {
    background: #F3F4F6;
    border: 0.5px solid #E5E7EB;
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 8pt;
    line-height: 1.5;
    overflow-x: auto;
    margin: 8px 0 12px 0;
    page-break-inside: avoid;
}
pre code {
    background: none;
    padding: 0;
    color: #1A1A1A;
}

/* ---- 引用块 ---- */
blockquote {
    border-left: 3px solid #8B5CF6;
    background: #F3E8FF;
    padding: 8px 12px;
    margin: 8px 0 12px 0;
    color: #6B21A8;
    font-size: 9.5pt;
    page-break-inside: avoid;
}
blockquote p {
    margin-bottom: 4px;
}

/* ---- 列表 ---- */
ul, ol {
    margin: 4px 0 8px 0;
    padding-left: 20px;
}
li {
    margin-bottom: 3px;
}

/* ---- 表格 ---- */
table {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0 14px 0;
    font-size: 9pt;
    page-break-inside: avoid;
}
thead tr {
    background: #2D1B69;
    color: white;
}
thead th {
    padding: 6px 8px;
    font-weight: 700;
    text-align: center;
    border: 0.5px solid #4C3A8A;
    font-size: 9pt;
}
tbody td {
    padding: 5px 8px;
    border: 0.5px solid #E5E7EB;
    text-align: left;
    vertical-align: top;
}
tbody tr:nth-child(even) {
    background: #F9FAFB;
}
tbody tr:hover {
    background: #F3E8FF;
}

/* ---- 水平线 ---- */
hr {
    border: none;
    border-top: 1px solid #E5E7EB;
    margin: 16px 0;
}

/* ---- 链接 ---- */
a {
    color: #7C3AED;
    text-decoration: underline;
}

/* ---- 图片 ---- */
img {
    max-width: 100%;
    margin: 8px 0;
}
"""


# ============================================================
# Markdown → HTML 转换（增加编号标签）
# ============================================================
def md_to_html_with_badges(md_text, title=None):
    """将 Markdown 转换为带编号标签的 HTML"""

    # 自动提取标题
    if not title:
        first_h1 = re.search(r'^#\s+(.+)', md_text, re.MULTILINE)
        if first_h1:
            title = first_h1.group(1).strip()
        else:
            title = '报告'

    # 使用 markdown 库转换
    html_body = markdown.markdown(
        md_text,
        extensions=['tables', 'fenced_code', 'codehilite', 'toc', 'nl2br'],
        extension_configs={
            'codehilite': {'css_class': 'highlight', 'guess_lang': False},
        }
    )

    # 为 H1 添加编号标签
    section_counter = [0]
    def add_badge(match):
        section_counter[0] += 1
        badge_num = f"{section_counter[0]:02d}"
        inner = match.group(1)
        return f'<span class="section-badge">{badge_num}</span><h1>{inner}</h1>'

    html_body = re.sub(r'<h1>(.+?)</h1>', add_badge, html_body)

    # 封面
    cover_html = f"""
    <div class="cover">
        <div class="deco-line"></div>
        <h1>{title}</h1>
        <div class="subtitle">品牌内容报告</div>
        <div class="deco-line-thin"></div>
        <div class="meta">
            生成日期：{datetime.date.today().strftime('%Y-%m-%d')}
        </div>
    </div>
    """

    full_html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <style>{CSS_STYLE}</style>
</head>
<body>
{cover_html}
{html_body}
</body>
</html>"""

    return full_html


# ============================================================
# 主函数
# ============================================================
def generate_pdf(input_md, output_pdf, title=None):
    """将 Markdown 文件转换为深紫/黑/白风格的 PDF"""
    import weasyprint

    with open(input_md, 'r', encoding='utf-8') as f:
        md_text = f.read()

    html_content = md_to_html_with_badges(md_text, title)

    # 保存中间 HTML（调试用，可删除）
    html_path = output_pdf.replace('.pdf', '.html')
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html_content)

    # 生成 PDF
    doc = weasyprint.HTML(string=html_content)
    doc.write_pdf(output_pdf)
    print(f'[OK] PDF 已生成: {output_pdf}')

    # 清理中间文件
    if os.path.exists(html_path):
        os.remove(html_path)


# ============================================================
# CLI 入口
# ============================================================
if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('用法: python3 geo_pdf_generator.py input.md output.pdf [--title "标题"]')
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]
    title = None

    if '--title' in sys.argv:
        idx = sys.argv.index('--title')
        if idx + 1 < len(sys.argv):
            title = sys.argv[idx + 1]

    generate_pdf(input_file, output_file, title)
