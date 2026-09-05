#!/usr/bin/env python3
"""
html_renderer.py - FrontMind HTML Renderer

Renders Markdown content to branded single-file HTML documents.
Used for showcase pages, news aggregation output, and preview files.

Features:
- Self-contained single-file HTML (embedded CSS)
- FrontMind brand styling
- Responsive design
- Print-friendly layout
- Dark mode support

Usage:
    python shared/html_renderer.py input.md output.html --brand "BrandName" --title "Document Title"
    python shared/html_renderer.py input.md output.html --brand "BrandName" --template showcase
"""

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

try:
    import markdown
except ImportError:
    print("Error: markdown not installed. Run: pip install markdown")
    sys.exit(1)


# ── HTML Template ────────────────────────────────────────────────────
HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title} | {brand}</title>
  <style>
    :root {{
      --primary: #6B21A8;
      --black: #1A1A1A;
      --white: #FFFFFF;
      --gray: #64748B;
      --light-bg: #F8FAFC;
      --border: #E2E8F0;
    }}
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-size: 16px;
      line-height: 1.7;
      color: var(--black);
      background: var(--white);
    }}
    .container {{
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }}
    header {{
      border-bottom: 3px solid var(--primary);
      padding-bottom: 1.5rem;
      margin-bottom: 2rem;
    }}
    header h1 {{
      font-size: 1.75rem;
      color: var(--primary);
      margin-bottom: 0.25rem;
    }}
    header .meta {{
      color: var(--gray);
      font-size: 0.875rem;
    }}
    h1 {{ font-size: 1.75rem; margin: 2rem 0 1rem; color: var(--primary); }}
    h2 {{ font-size: 1.375rem; margin: 1.75rem 0 0.75rem; color: var(--black); }}
    h3 {{ font-size: 1.125rem; margin: 1.5rem 0 0.5rem; color: var(--black); }}
    p {{ margin-bottom: 1rem; max-width: 72ch; }}
    a {{ color: var(--primary); text-decoration: underline; }}
    img {{ max-width: 100%; height: auto; border-radius: 0.5rem; margin: 1rem 0; }}
    blockquote {{
      border-left: 4px solid var(--primary);
      padding-left: 1rem;
      margin: 1rem 0;
      color: var(--gray);
      font-style: italic;
    }}
    code {{
      font-family: "SF Mono", Consolas, monospace;
      font-size: 0.9em;
      padding: 0.15em 0.35em;
      border-radius: 0.25rem;
      background: var(--light-bg);
    }}
    pre {{
      background: var(--black);
      color: #E2E8F0;
      padding: 1rem;
      border-radius: 0.5rem;
      overflow-x: auto;
      margin: 1rem 0;
    }}
    pre code {{ background: transparent; padding: 0; color: inherit; }}
    table {{
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
    }}
    th, td {{
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      text-align: left;
    }}
    th {{ background: var(--light-bg); font-weight: 600; }}
    footer {{
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
      color: var(--gray);
      font-size: 0.75rem;
      text-align: center;
    }}
    @media print {{
      body {{ font-size: 11pt; }}
      .container {{ max-width: 100%; padding: 0; }}
      a {{ color: var(--black); text-decoration: none; }}
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --black: #E2E8F0;
        --white: #0F172A;
        --light-bg: #1E293B;
        --border: #334155;
        --gray: #94A3B8;
      }}
    }}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>{title}</h1>
      <p class="meta">{brand} | Generated {date}</p>
    </header>
    <main>
      {content}
    </main>
    <footer>
      <p>{brand}</p>
    </footer>
  </div>
</body>
</html>"""


def render_markdown_to_html(md_content):
    """Convert Markdown to HTML using the markdown library."""
    extensions = ["tables", "fenced_code", "toc", "attr_list"]
    html = markdown.markdown(md_content, extensions=extensions)
    return html


def generate_html(input_path, output_path, brand_name, title=None):
    """Generate a branded HTML file from Markdown."""
    md_content = Path(input_path).read_text(encoding="utf-8")

    if not title:
        first_heading = re.search(r"^#\s+(.+)$", md_content, re.MULTILINE)
        title = first_heading.group(1) if first_heading else Path(input_path).stem

    html_content = render_markdown_to_html(md_content)
    date_str = datetime.now().strftime("%Y-%m-%d")

    full_html = HTML_TEMPLATE.format(
        title=title,
        brand=brand_name,
        date=date_str,
        content=html_content,
    )

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(full_html, encoding="utf-8")

    size = Path(output_path).stat().st_size
    print(f"Generated: {output_path} ({size / 1024:.1f} KB)")
    return output_path


def main():
    parser = argparse.ArgumentParser(description="FrontMind HTML Renderer")
    parser.add_argument("input", help="Input Markdown file")
    parser.add_argument("output", help="Output HTML file")
    parser.add_argument("--brand", required=True, help="Brand name")
    parser.add_argument("--title", help="Document title (auto-detected if omitted)")
    args = parser.parse_args()

    if not Path(args.input).exists():
        print(f"Error: Input file not found: {args.input}")
        sys.exit(1)

    generate_html(args.input, args.output, args.brand, args.title)


if __name__ == "__main__":
    main()
