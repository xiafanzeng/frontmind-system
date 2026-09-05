#!/usr/bin/env python3
"""
FrontMind E10 title-free MD→DOCX 组装器 (Markdown to DOCX Assembler)

正文契约不允许 Markdown/Word 表格。对比内容必须在 E2 写成维度一致的
分项段落；转换器遇到表格直接失败，不做图片化或纯文本降级。

功能：
  - 解析 Markdown 文件（标题/段落/列表/图片）
  - 转换为 Word 格式（所有 Markdown 语法必须转为 Word 格式）
  - 表格硬失败检查
  - 图片 PNG 规范化与物理嵌入
  - 文件大小上限检查
  - Markdown 残留检测与清理
  - 占位符扫描

用法：
  python3 md2docx.py \\
    --input "{brand}_{article_id}_final.md" \\
    --images-dir "./images/" \\
    --output "{brand}_{article_id}_final.docx" \\
    --max-size 10

依赖：
  pip3 install python-docx Pillow
"""

from __future__ import annotations

import argparse
import io
import os
import re
import shutil
import subprocess
import sys
from typing import Dict, List, Optional, Tuple

try:
    from docx import Document
    from docx.shared import Pt, Inches, Cm, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    HAS_DOCX = True
except ImportError:
    HAS_DOCX = False

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    import cairosvg
    HAS_CAIROSVG = True
except Exception:
    HAS_CAIROSVG = False

# ============================================================
# 排版常量（严格遵循 E4 SKILL.md 规范）
# ============================================================

# Keep module import and ``--help`` usable even when the optional document
# runtime is not installed.  Conversion itself is stopped explicitly in
# ``main`` before any of these values can be consumed.
STYLE_CONFIG = {
    'h1': {'size': Pt(22), 'bold': True, 'color': RGBColor(0x1A, 0x1A, 0x1A)},
    'h2': {'size': Pt(16), 'bold': True, 'color': RGBColor(0x2C, 0x3E, 0x50)},
    'h3': {'size': Pt(13), 'bold': True, 'color': RGBColor(0x34, 0x49, 0x5E)},
    'body': {'size': Pt(11), 'bold': False, 'color': RGBColor(0x33, 0x33, 0x33)},
    'caption': {'size': Pt(9), 'bold': False, 'color': RGBColor(0x66, 0x66, 0x66)},
} if HAS_DOCX else {}

LINE_SPACING = 1.5
PAGE_WIDTH_INCHES = 6.0  # A4 页面可用宽度（减去边距）


def select_cjk_font() -> str:
    """Pick an installed CJK-capable family without silently using tofu."""
    # Prefer macOS system CJK fonts for local render QA.  LibreOffice can
    # resolve ``Arial Unicode MS`` through fontconfig while still failing to
    # paint its CJK glyphs, so it is deliberately kept behind the native
    # Hiragino/Heiti families.  Windows authoring falls back to YaHei.
    # Arial Unicode MS is a plain TTF on macOS and survives LibreOffice/PDF
    # conversion reliably.  Some macOS TTC families resolve through
    # fontconfig but LibreOffice still substitutes Linux Libertine and emits
    # tofu, so they follow the portable TTF/Noto options.
    candidates = ("Arial Unicode MS", "Noto Sans CJK SC", "Microsoft YaHei", "Hiragino Sans GB", "Heiti SC")
    matcher = shutil.which("fc-match")
    if matcher:
        for candidate in candidates:
            try:
                result = subprocess.run(
                    [matcher, "-f", "%{family}", candidate], check=True,
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                ).stdout.lower()
            except (OSError, subprocess.SubprocessError):
                break
            if candidate.lower().lstrip(".") in result.replace(".", ""):
                return candidate
    # Microsoft YaHei is available on the primary Windows authoring target;
    # render QA on other systems should install one of the earlier families.
    return "Microsoft YaHei"


CJK_FONT_NAME = select_cjk_font()


def set_ooxml_font(target, family: str = CJK_FONT_NAME) -> None:
    """Set Latin and East Asian OOXML font slots on a run or style."""
    element = target._element
    properties = element.get_or_add_rPr()
    fonts = properties.rFonts
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        properties.insert(0, fonts)
    for key in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(qn(f"w:{key}"), family)
    fonts.set(qn("w:hint"), "eastAsia")

    language = properties.find(qn("w:lang"))
    if language is None:
        language = OxmlElement("w:lang")
        properties.append(language)
    language.set(qn("w:val"), "zh-CN")
    language.set(qn("w:eastAsia"), "zh-CN")
    target.font.name = family

# Markdown 残留检测模式
MARKDOWN_PATTERNS = [
    (r'\*\*([^*]+)\*\*', 'bold_markdown', r'\1'),
    (r'__([^_]+)__', 'bold_markdown_alt', r'\1'),
    (r'\*([^*]+)\*', 'italic_markdown', r'\1'),
    (r'_([^_]+)_', 'italic_markdown_alt', r'\1'),
    (r'~~([^~]+)~~', 'strikethrough_markdown', r'\1'),
    (r'`([^`]+)`', 'code_markdown', r'\1'),
    (r'\[([^\]]+)\]\(([^\)]+)\)', 'link_markdown', r'\1'),
]

# 占位符检测模式
PLACEHOLDER_PATTERNS = [
    r'IMAGE_SLOT[-:]?\s*\w+',
    r'\{\{[^}]+\}\}',
    r'\[TODO\]',
    r'\[TBD\]',
    r'\[待定\]',
    r'\[此处填写\]',
    r'\[待补充\]',
    r'caption:',
]


# ============================================================
# 图片处理
# ============================================================

def prepare_docx_image(image_path: str) -> bytes:
    """
    将图片规范化为 python-docx 可稳定嵌入的 PNG 字节。

    python-docx/底层 OOXML 不保证接受 WebP；输入转 WebP 会出现
    图片文件有效但 DOCX 只留下“嵌入失败”占位文本的假成功。

    Args:
        image_path: 原始图片路径
    Returns:
        PNG 格式的图片字节数据
    """
    with open(image_path, 'rb') as source:
        header = source.read(512).lstrip()
    is_svg = image_path.lower().endswith('.svg') or header.startswith(b'<svg') or b'<svg' in header
    if is_svg:
        if not HAS_CAIROSVG:
            raise RuntimeError(
                "SVG image requires CairoSVG; install requirements-optional.txt or provide an approved PNG derivative"
            )
        try:
            return cairosvg.svg2png(url=image_path)
        except Exception as exc:
            raise RuntimeError(f"SVG-to-PNG conversion failed for {image_path}: {exc}") from exc

    if not HAS_PIL:
        raise RuntimeError("raster image normalization requires Pillow")

    img = Image.open(image_path)

    # 确保 RGB 模式
    if img.mode in ('RGBA', 'P'):
        img = img.convert('RGB')

    # 限制最大尺寸（避免 DOCX 过大）
    max_width = 1600
    if img.width > max_width:
        ratio = max_width / img.width
        new_height = int(img.height * ratio)
        img = img.resize((max_width, new_height), Image.LANCZOS)

    buffer = io.BytesIO()
    img.save(buffer, format='PNG', optimize=True)
    return buffer.getvalue()


# ============================================================
# Markdown 解析
# ============================================================

def parse_markdown_line(line: str) -> Dict:
    """
    解析单行 Markdown，返回解析结果。

    Args:
        line: 单行 Markdown 文本

    Returns:
        解析结果字典，包含 type 和 content
    """
    stripped = line.strip()

    # 空行
    if not stripped:
        return {'type': 'empty', 'content': ''}

    # 分隔线
    if re.match(r'^---+$', stripped):
        return {'type': 'separator', 'content': ''}

    # 标题
    heading_match = re.match(r'^(#{1,6})\s+(.+)$', stripped)
    if heading_match:
        level = len(heading_match.group(1))
        return {'type': f'h{level}', 'content': heading_match.group(2)}

    # 图片引用
    img_match = re.match(r'!\[([^\]]*)\]\(([^\)]+)\)', stripped)
    if img_match:
        return {'type': 'image', 'alt': img_match.group(1), 'src': img_match.group(2)}

    # IMAGE_SLOT 注释
    if stripped.startswith('<!-- IMAGE_SLOT'):
        return {'type': 'image_slot', 'content': stripped}

    # 有序列表
    ol_match = re.match(r'^(\d+)[.、]\s+(.+)$', stripped)
    if ol_match:
        return {'type': 'ordered_list', 'number': int(ol_match.group(1)), 'content': ol_match.group(2)}

    # 无序列表
    ul_match = re.match(r'^[-*+]\s+(.+)$', stripped)
    if ul_match:
        return {'type': 'unordered_list', 'content': ul_match.group(1)}

    # 引用块
    bq_match = re.match(r'^>\s*(.*)$', stripped)
    if bq_match:
        return {'type': 'blockquote', 'content': bq_match.group(1)}

    # 表格行
    if '|' in stripped and stripped.startswith('|'):
        cells = [c.strip() for c in stripped.split('|')[1:-1]]
        if all(re.match(r'^[-:]+$', c) for c in cells):
            return {'type': 'table_separator', 'content': ''}
        return {'type': 'table_row', 'cells': cells}

    # 普通段落
    return {'type': 'paragraph', 'content': stripped}


def clean_markdown_syntax(text: str) -> str:
    """
    清理文本中的 Markdown 语法标记，返回纯文本。

    Args:
        text: 可能含有 Markdown 语法的文本

    Returns:
        清理后的纯文本
    """
    cleaned = text
    for pattern, name, replacement in MARKDOWN_PATTERNS:
        cleaned = re.sub(pattern, replacement, cleaned)
    return cleaned


def detect_markdown_residue(text: str) -> List[Dict]:
    """
    检测文本中的 Markdown 语法残留。

    Args:
        text: 待检测文本

    Returns:
        残留列表
    """
    residues = []
    for pattern, name, _ in MARKDOWN_PATTERNS:
        matches = re.findall(pattern, text)
        if matches:
            residues.append({
                'type': name,
                'count': len(matches),
                'samples': [str(m)[:50] for m in matches[:3]],
            })
    return residues


def detect_placeholders(text: str) -> List[Dict]:
    """
    检测文本中的占位符残留。

    Args:
        text: 待检测文本

    Returns:
        占位符列表
    """
    placeholders = []
    for pattern in PLACEHOLDER_PATTERNS:
        matches = re.findall(pattern, text, re.IGNORECASE)
        if matches:
            placeholders.append({
                'pattern': pattern,
                'count': len(matches),
                'samples': matches[:3],
            })
    return placeholders


def apply_paragraph_style(paragraph, style_key: str):
    """
    应用段落样式。

    Args:
        paragraph: python-docx Paragraph 对象
        style_key: 样式键名（h1/h2/h3/body/caption）
    """
    if not HAS_DOCX:
        return

    style = STYLE_CONFIG.get(style_key, STYLE_CONFIG['body'])

    for run in paragraph.runs:
        set_ooxml_font(run)
        run.font.size = style['size']
        run.font.bold = style['bold']
        run.font.color.rgb = style['color']

    paragraph.paragraph_format.line_spacing = LINE_SPACING
    paragraph.paragraph_format.space_after = Pt(6)


def add_external_hyperlink(paragraph, text: str, url: str, *, size_half_points: int = 18) -> None:
    """Append a directly formatted external hyperlink to a paragraph."""
    relationship_id = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), relationship_id)
    run = OxmlElement("w:r")
    properties = OxmlElement("w:rPr")
    fonts = OxmlElement("w:rFonts")
    for key in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(qn(f"w:{key}"), CJK_FONT_NAME)
    fonts.set(qn("w:hint"), "eastAsia")
    properties.append(fonts)
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "0563C1")
    properties.append(color)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    properties.append(underline)
    size = OxmlElement("w:sz")
    size.set(qn("w:val"), str(size_half_points))
    properties.append(size)
    language = OxmlElement("w:lang")
    language.set(qn("w:val"), "zh-CN")
    language.set(qn("w:eastAsia"), "zh-CN")
    properties.append(language)
    run.append(properties)
    value = OxmlElement("w:t")
    value.text = text
    run.append(value)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


# ============================================================
# DOCX 构建核心
# ============================================================

def _embed_image(doc: Document, parsed: Dict, images_dir: str):
    """
    嵌入图片到 DOCX。

    Args:
        doc: Document 对象
        parsed: 解析后的图片信息
        images_dir: 图片目录
    """
    src = parsed.get('src', '')
    alt = parsed.get('alt', '')

    # 查找图片文件
    image_path = os.path.join(images_dir, os.path.basename(src))
    if not os.path.exists(image_path):
        image_path = src

    if not os.path.exists(image_path):
        raise FileNotFoundError(f"DOCX image is missing: {src}")

    image_stream = io.BytesIO(prepare_docx_image(image_path))
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run()
    try:
        run.add_picture(image_stream, width=Inches(min(PAGE_WIDTH_INCHES, 5.5)))
    except Exception as exc:
        raise RuntimeError(f"DOCX image embedding failed for {src}: {exc}") from exc


def clear_article_headers_footers(doc) -> None:
    """Ensure media-ready article DOCX has no internal headers/footers."""
    for section in doc.sections:
        for part in (section.header, section.footer):
            for paragraph in part.paragraphs:
                paragraph.text = ""
            for table in part.tables:
                for row in table.rows:
                    for cell in row.cells:
                        cell.text = ""


def build_docx(md_lines: List[str], images_dir: str) -> Optional[Document]:
    """
    将解析后的 Markdown 行构建为 DOCX 文档。

    Markdown 表格是上游内容契约错误，遇到时直接失败。

    Args:
        md_lines: Markdown 文件的行列表
        images_dir: 图片目录路径

    Returns:
        python-docx Document 对象
    """
    if not HAS_DOCX:
        print("错误: python-docx 未安装", file=sys.stderr)
        return None

    doc = Document()
    clear_article_headers_footers(doc)

    # Set semantic Word styles as well as direct rendering tokens.  Without
    # real Title/Heading styles the document looks plausible but loses Word's
    # navigation outline, accessibility hierarchy and TOC compatibility.
    for style_name, size in (("Normal", 11), ("Title", 22), ("Heading 1", 18), ("Heading 2", 16), ("Heading 3", 13)):
        style = doc.styles[style_name]
        style.font.size = Pt(size)
        set_ooxml_font(style)

    list_counter = 0   # 有序列表计数器
    in_references = False

    for line in md_lines:
        parsed = parse_markdown_line(line)

        if parsed['type'] in ('table_row', 'table_separator'):
            raise ValueError("DOCX source contains a forbidden Markdown table; rewrite it as parallel prose")

        if parsed['type'] == 'empty':
            continue

        elif parsed['type'] == 'separator':
            doc.add_paragraph('').paragraph_format.space_after = Pt(12)

        elif parsed['type'].startswith('h'):
            level = int(parsed['type'][1])
            text = clean_markdown_syntax(parsed['content'])
            in_references = level == 2 and text == "资料来源"
            style_key = f'h{min(level, 3)}'
            # Preserve the source hierarchy exactly.  E10 sends a title-free
            # body beginning at Markdown H2, so the DOCX must likewise begin
            # at Word Heading 2 and contain no synthetic Heading 1.
            paragraph_style = "Title" if level == 1 else f"Heading {min(level, 3)}"
            p = doc.add_paragraph(style=paragraph_style)
            run = p.add_run(text)
            apply_paragraph_style(p, style_key)
            list_counter = 0

        elif parsed['type'] == 'image':
            _embed_image(doc, parsed, images_dir)

        elif parsed['type'] == 'image_slot':
            p = doc.add_paragraph()
            run = p.add_run(f"[警告: 未替换的 IMAGE_SLOT: {parsed['content'][:60]}]")
            run.font.color.rgb = RGBColor(0xFF, 0x00, 0x00)

        elif parsed['type'] == 'ordered_list':
            list_counter += 1
            text = clean_markdown_syntax(parsed['content'])
            p = doc.add_paragraph()
            run = p.add_run(f"{list_counter}. {text}")
            apply_paragraph_style(p, 'body')
            p.paragraph_format.left_indent = Cm(1)

        elif parsed['type'] == 'unordered_list':
            p = doc.add_paragraph()
            if in_references:
                link = re.fullmatch(r'\[([^\]]+)\]\((https?://[^)]+)\)', parsed['content'])
                prefix = p.add_run("• ")
                apply_paragraph_style(p, 'body')
                if link:
                    add_external_hyperlink(p, clean_markdown_syntax(link.group(1)), link.group(2))
                else:
                    p.add_run(clean_markdown_syntax(parsed['content']))
                # References are supporting navigation, not another body
                # section.  A compact source list avoids a mostly blank last
                # page while keeping every source name readable.
                for item_run in p.runs:
                    item_run.font.size = Pt(9)
                p.paragraph_format.line_spacing = 1.0
                p.paragraph_format.space_after = Pt(2)
                p.paragraph_format.left_indent = Cm(0.6)
            else:
                text = clean_markdown_syntax(parsed['content'])
                p.add_run(f"• {text}")
                apply_paragraph_style(p, 'body')
                p.paragraph_format.left_indent = Cm(1)

        elif parsed['type'] == 'blockquote':
            text = clean_markdown_syntax(parsed['content'])
            p = doc.add_paragraph()
            run = p.add_run(text)
            apply_paragraph_style(p, 'body')
            p.paragraph_format.left_indent = Cm(1.5)
            for run in p.runs:
                run.font.italic = True
                run.font.color.rgb = RGBColor(0x55, 0x55, 0x55)

        elif parsed['type'] == 'paragraph':
            text = clean_markdown_syntax(parsed['content'])
            if text:
                p = doc.add_paragraph()
                run = p.add_run(text)
                apply_paragraph_style(p, 'body')
                list_counter = 0

    # Apply the OOXML East Asian font/language slots to every textual run,
    # including defensive error messages created by image handling.  Merely
    # setting ``font.name`` leaves ``w:eastAsia`` unset and produces tofu in
    # some Word/LibreOffice renderers.
    for paragraph in doc.paragraphs:
        for run in paragraph.runs:
            set_ooxml_font(run)

    return doc


def strip_article_title_heading(md_lines: List[str]) -> Tuple[List[str], bool]:
    """
    移除正文文件开头的文章标题 H1 和紧随其后的发布副标题。

    v3.7 规则：E4 final.md/final.docx 是不带文章标题的正文文件，
    发布标题只存在于 title_options_reviewed.json，并由交付消息打印。
    """
    lines = list(md_lines)
    idx = 0
    while idx < len(lines) and not lines[idx].strip():
        idx += 1

    stripped = False
    if idx < len(lines) and re.match(r"^#\s+", lines[idx].strip()):
        del lines[idx]
        stripped = True

        # 删除标题后的空行
        while idx < len(lines) and not lines[idx].strip():
            del lines[idx]

        # 删除紧随文章标题的发布副标题/blockquote（章节正文内的引用不受影响）
        if idx < len(lines) and re.match(r"^>\s+", lines[idx].strip()):
            del lines[idx]
            while idx < len(lines) and not lines[idx].strip():
                del lines[idx]

    return lines, stripped


def assemble_with_size_control(md_path: str, images_dir: str,
                                output_path: str, max_mb: float = 10.0) -> Dict:
    """
    组装 DOCX 并控制文件大小。

    输出超过 max_mb 时直接失败；不以有损降级换取假通过。

    Args:
        md_path: Markdown 文件路径
        images_dir: 图片目录路径
        output_path: 输出 DOCX 路径
        max_mb: 最大文件大小（MB）

    Returns:
        组装结果字典
    """
    with open(md_path, 'r', encoding='utf-8') as f:
        md_lines = f.readlines()

    if any(parse_markdown_line(line)['type'] in {'table_row', 'table_separator'} for line in md_lines):
        return {"success": False, "error": "正文含 Markdown 表格；请改写为维度一致的分项段落"}

    md_lines, article_heading_stripped = strip_article_title_heading(md_lines)

    doc = build_docx(md_lines, images_dir)
    if doc is None:
        return {"success": False, "error": "python-docx 未安装"}
    doc.save(output_path)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    if size_mb > max_mb:
        return {"success": False, "error": f"文件大小 {size_mb:.2f} MB 超过 {max_mb} MB 限制"}
    full_text = '\n'.join(p.text for p in doc.paragraphs)
    return {
        "success": True,
        "image_format": "PNG",
        "file_size_mb": round(size_mb, 2),
        "markdown_residues": detect_markdown_residue(full_text),
        "placeholders": detect_placeholders(full_text),
        "native_tables": len(doc.tables),
        "article_heading_stripped": article_heading_stripped,
        "output_path": output_path,
    }


def main():
    parser = argparse.ArgumentParser(description="FrontMind E10 无标题正文 MD→DOCX 组装器")
    parser.add_argument("--input", required=True, help="输入 Markdown 文件路径")
    parser.add_argument("--images-dir", default="./images/", help="图片目录路径")
    parser.add_argument("--output", required=True, help="输出 DOCX 文件路径")
    parser.add_argument("--max-size", type=float, default=10.0, help="最大文件大小（MB）")

    args = parser.parse_args()

    missing_dependencies = []
    if not HAS_DOCX:
        missing_dependencies.append("python-docx")
    if not HAS_PIL:
        missing_dependencies.append("Pillow")
    if missing_dependencies:
        print(
            "错误: DOCX 转换依赖缺失: " + ", ".join(missing_dependencies)
            + "。请先按根 requirements.txt 安装后重试。",
            file=sys.stderr,
        )
        sys.exit(2)

    if not os.path.exists(args.input):
        print(f"错误: 输入文件不存在: {args.input}", file=sys.stderr)
        sys.exit(1)

    result = assemble_with_size_control(args.input, args.images_dir, args.output, args.max_size)

    if result["success"]:
        print(f"✅ DOCX 组装成功")
        print(f"  文件: {result['output_path']}")
        print(f"  大小: {result['file_size_mb']} MB")
        print(f"  图片格式: {result['image_format']}")
        print(f"  原生表格数: {result['native_tables']}（应为 0）")
        print(f"  文章标题H1已移除: {result.get('article_heading_stripped', False)}")

        if result["native_tables"] > 0:
            print(f"  ❌ 检测到 {result['native_tables']} 个原生表格")

        if result["markdown_residues"]:
            print(f"  ⚠️ Markdown 残留: {len(result['markdown_residues'])} 处")
            for r in result["markdown_residues"]:
                print(f"    - {r['type']}: {r['count']} 处")

        if result["placeholders"]:
            print(f"  ⚠️ 占位符残留: {len(result['placeholders'])} 处")
            for p in result["placeholders"]:
                print(f"    - {p['pattern']}: {p['count']} 处")
    else:
        print(f"❌ DOCX 组装失败: {result.get('error', '未知错误')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
