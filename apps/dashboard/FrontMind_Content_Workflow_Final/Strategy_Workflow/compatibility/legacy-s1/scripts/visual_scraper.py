#!/usr/bin/env python3
"""
品牌视觉资产抓取与留存工具 (Visual Asset Scraper)
用途：主动抓取企业官网及公开渠道的视觉元素（Logo、Favicon、OG 图片、
      核心配色、字体线索、Banner 等），截图留存并输出结构化清单。

用法：
  python3 visual_scraper.py --url "https://www.example.com" \
    --brand "品牌名" --output-dir "./visual_assets/" \
    --manifest "S1_{brand}_视觉资产清单.json"

依赖：
  pip3 install requests beautifulsoup4 Pillow colorthief
  浏览器截图需要 playwright 或由上层 Agent 的 browser 工具完成。

输出：
  1. visual_assets/ 目录下的图片文件（logo_*.png, favicon_*.png, og_*.png, banner_*.png）
  2. S1_{brand}_视觉资产清单.json — 结构化的视觉资产元数据
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Dict, List, Optional
from urllib.parse import urljoin, urlparse

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("[ERROR] 需要安装依赖: pip3 install requests beautifulsoup4", file=sys.stderr)
    sys.exit(1)

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    from colorthief import ColorThief
    HAS_COLORTHIEF = True
except ImportError:
    HAS_COLORTHIEF = False


# ============================================================
# 常量
# ============================================================
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}
SUPPORTED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico", ".gif"}
MAX_DOWNLOAD_SIZE = 10 * 1024 * 1024  # 10MB


# ============================================================
# 工具函数
# ============================================================

def compute_sha256(filepath: str) -> str:
    """计算文件 SHA256"""
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def download_image(url: str, save_path: str, timeout: int = 15) -> bool:
    """下载图片到本地，返回是否成功"""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=timeout, stream=True)
        resp.raise_for_status()
        content_length = int(resp.headers.get("content-length", 0))
        if content_length > MAX_DOWNLOAD_SIZE:
            print(f"  [SKIP] 文件过大: {url} ({content_length / 1024 / 1024:.1f}MB)")
            return False
        with open(save_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        return True
    except Exception as e:
        print(f"  [WARN] 下载失败: {url} — {e}")
        return False


def extract_dominant_colors(image_path: str, count: int = 5) -> List[str]:
    """从图片中提取主色调，返回 hex 列表"""
    if not HAS_COLORTHIEF or not HAS_PIL:
        return []
    try:
        ct = ColorThief(image_path)
        palette = ct.get_palette(color_count=count, quality=5)
        return [f"#{r:02X}{g:02X}{b:02X}" for r, g, b in palette]
    except Exception:
        return []


def get_image_dimensions(image_path: str) -> Optional[Dict]:
    """获取图片尺寸"""
    if not HAS_PIL:
        return None
    try:
        with Image.open(image_path) as img:
            w, h = img.size
            return {"width": w, "height": h, "format": img.format}
    except Exception:
        return None


# ============================================================
# 核心抓取逻辑
# ============================================================

def scrape_visual_assets(url: str, brand: str, output_dir: str) -> Dict:
    """
    抓取目标网站的视觉资产。

    抓取范围：
    1. Logo（<link rel="icon">, <link rel="apple-touch-icon">, <img> 含 logo 关键词）
    2. Favicon（<link rel="shortcut icon">, /favicon.ico）
    3. OG 图片（<meta property="og:image">）
    4. Banner / Hero 图（首屏大图）
    5. CSS 中的品牌色（内联 style 和外链 CSS 中的高频色值）
    6. 字体线索（font-family 声明）

    Returns:
        结构化的视觉资产清单字典
    """
    os.makedirs(output_dir, exist_ok=True)

    manifest = {
        "meta": {
            "brand": brand,
            "source_url": url,
            "scraped_at": datetime.now(timezone.utc).isoformat(),
            "scraper_version": "1.0.0"
        },
        "scrape_status": "pending",  # success / partial / failed
        "assets": {
            "logos": [],
            "favicons": [],
            "og_images": [],
            "banners": [],
            "screenshots": []
        },
        "extracted_palette": {
            "from_logo": [],
            "from_website": [],
            "dominant_colors": []
        },
        "typography_hints": [],
        "summary": {
            "total_assets_downloaded": 0,
            "has_logo": False,
            "has_favicon": False,
            "has_og_image": False,
            "primary_color_guess": None
        }
    }

    # 获取页面 HTML
    try:
        resp = requests.get(url, headers=HEADERS, timeout=20)
        resp.raise_for_status()
        html = resp.text
    except Exception as e:
        print(f"[ERROR] 无法访问 {url}: {e}")
        manifest["meta"]["error"] = str(e)
        return manifest

    soup = BeautifulSoup(html, "html.parser")
    base_url = url
    asset_count = 0

    # ── 1. Favicon ──────────────────────────────────────────
    favicon_selectors = [
        {"rel": "icon"},
        {"rel": "shortcut icon"},
        {"rel": "apple-touch-icon"},
        {"rel": "apple-touch-icon-precomposed"},
    ]
    for selector in favicon_selectors:
        for link in soup.find_all("link", attrs=selector):
            href = link.get("href", "")
            if not href:
                continue
            full_url = urljoin(base_url, href)
            ext = os.path.splitext(urlparse(full_url).path)[1].lower() or ".png"
            if ext not in SUPPORTED_IMAGE_EXTS:
                ext = ".png"
            filename = f"favicon_{asset_count:03d}{ext}"
            save_path = os.path.join(output_dir, filename)
            if download_image(full_url, save_path):
                dims = get_image_dimensions(save_path)
                colors = extract_dominant_colors(save_path)
                entry = {
                    "asset_id": f"favicon_{asset_count:03d}",
                    "source_url": full_url,
                    "local_path": save_path,
                    "file_hash": compute_sha256(save_path),
                    "dimensions": dims,
                    "rel_type": link.get("rel", ["icon"])[0] if isinstance(link.get("rel"), list) else str(link.get("rel", "icon")),
                    "extracted_colors": colors
                }
                manifest["assets"]["favicons"].append(entry)
                if colors:
                    manifest["extracted_palette"]["from_logo"].extend(colors[:3])
                asset_count += 1
                manifest["summary"]["has_favicon"] = True
                print(f"  [OK] Favicon: {filename}")

    # 尝试默认 /favicon.ico
    default_favicon_url = urljoin(base_url, "/favicon.ico")
    fav_path = os.path.join(output_dir, "favicon_default.ico")
    if download_image(default_favicon_url, fav_path):
        if os.path.getsize(fav_path) > 100:
            entry = {
                "asset_id": "favicon_default",
                "source_url": default_favicon_url,
                "local_path": fav_path,
                "file_hash": compute_sha256(fav_path),
                "dimensions": get_image_dimensions(fav_path),
                "rel_type": "default_favicon",
                "extracted_colors": []
            }
            manifest["assets"]["favicons"].append(entry)
            asset_count += 1
            manifest["summary"]["has_favicon"] = True
            print(f"  [OK] Default favicon.ico")
        else:
            os.remove(fav_path)

    # ── 2. Logo（<img> 含 logo 关键词）──────────────────────
    logo_patterns = re.compile(r"logo|brand|emblem|mark", re.IGNORECASE)
    for img in soup.find_all("img"):
        src = img.get("src", "")
        alt = img.get("alt", "")
        cls = " ".join(img.get("class", []))
        img_id = img.get("id", "")
        if logo_patterns.search(src) or logo_patterns.search(alt) or \
           logo_patterns.search(cls) or logo_patterns.search(img_id):
            full_url = urljoin(base_url, src)
            ext = os.path.splitext(urlparse(full_url).path)[1].lower() or ".png"
            if ext not in SUPPORTED_IMAGE_EXTS:
                ext = ".png"
            filename = f"logo_{asset_count:03d}{ext}"
            save_path = os.path.join(output_dir, filename)
            if download_image(full_url, save_path):
                dims = get_image_dimensions(save_path)
                colors = extract_dominant_colors(save_path)
                entry = {
                    "asset_id": f"logo_{asset_count:03d}",
                    "source_url": full_url,
                    "local_path": save_path,
                    "file_hash": compute_sha256(save_path),
                    "dimensions": dims,
                    "alt_text": alt,
                    "extracted_colors": colors
                }
                manifest["assets"]["logos"].append(entry)
                if colors:
                    manifest["extracted_palette"]["from_logo"].extend(colors[:3])
                asset_count += 1
                manifest["summary"]["has_logo"] = True
                print(f"  [OK] Logo: {filename} (alt='{alt}')")

    # ── 3. OG 图片 ─────────────────────────────────────────
    og_tags = soup.find_all("meta", attrs={"property": "og:image"})
    for tag in og_tags:
        content = tag.get("content", "")
        if not content:
            continue
        full_url = urljoin(base_url, content)
        ext = os.path.splitext(urlparse(full_url).path)[1].lower() or ".png"
        if ext not in SUPPORTED_IMAGE_EXTS:
            ext = ".png"
        filename = f"og_image_{asset_count:03d}{ext}"
        save_path = os.path.join(output_dir, filename)
        if download_image(full_url, save_path):
            dims = get_image_dimensions(save_path)
            colors = extract_dominant_colors(save_path)
            entry = {
                "asset_id": f"og_image_{asset_count:03d}",
                "source_url": full_url,
                "local_path": save_path,
                "file_hash": compute_sha256(save_path),
                "dimensions": dims,
                "extracted_colors": colors
            }
            manifest["assets"]["og_images"].append(entry)
            asset_count += 1
            manifest["summary"]["has_og_image"] = True
            print(f"  [OK] OG Image: {filename}")

    # ── 4. CSS 色值提取 ─────────────────────────────────────
    hex_pattern = re.compile(r"#([0-9A-Fa-f]{6})\b")
    all_colors = []

    # 内联 style
    for tag in soup.find_all(style=True):
        matches = hex_pattern.findall(tag["style"])
        all_colors.extend([f"#{m.upper()}" for m in matches])

    # <style> 标签
    for style_tag in soup.find_all("style"):
        if style_tag.string:
            matches = hex_pattern.findall(style_tag.string)
            all_colors.extend([f"#{m.upper()}" for m in matches])

    # 统计高频色值（排除纯黑纯白和灰色系）
    from collections import Counter
    color_counter = Counter(all_colors)
    filtered_colors = []
    for color, count in color_counter.most_common(20):
        r, g, b = int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)
        # 排除纯黑、纯白、接近灰色
        if (r == g == b) or color in ("#000000", "#FFFFFF", "#FAFAFA", "#F5F5F5",
                                       "#E0E0E0", "#CCCCCC", "#999999", "#333333"):
            continue
        filtered_colors.append({"hex": color, "frequency": count})
        if len(filtered_colors) >= 8:
            break

    manifest["extracted_palette"]["from_website"] = filtered_colors
    if filtered_colors:
        manifest["extracted_palette"]["dominant_colors"] = [c["hex"] for c in filtered_colors[:5]]
        manifest["summary"]["primary_color_guess"] = filtered_colors[0]["hex"]

    # ── 5. 字体线索 ─────────────────────────────────────────
    font_pattern = re.compile(r"font-family\s*:\s*([^;}{]+)", re.IGNORECASE)
    font_families = set()
    for style_tag in soup.find_all("style"):
        if style_tag.string:
            matches = font_pattern.findall(style_tag.string)
            for m in matches:
                font_families.add(m.strip().strip("'\""))
    for tag in soup.find_all(style=True):
        matches = font_pattern.findall(tag["style"])
        for m in matches:
            font_families.add(m.strip().strip("'\""))

    manifest["typography_hints"] = list(font_families)[:10]

    # ── 汇总 ───────────────────────────────────────────────
    manifest["summary"]["total_assets_downloaded"] = asset_count

    # 确定 scrape_status
    if asset_count >= 3 and manifest["summary"]["has_logo"]:
        manifest["scrape_status"] = "success"
    elif asset_count >= 1:
        manifest["scrape_status"] = "partial"
    else:
        manifest["scrape_status"] = "failed"

    return manifest


# ============================================================
# 清单输出
# ============================================================

def save_manifest(manifest: Dict, output_path: str):
    """保存视觉资产清单 JSON"""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\n[OK] 视觉资产清单已保存: {output_path}")
    print(f"     共下载 {manifest['summary']['total_assets_downloaded']} 个资产")
    print(f"     Logo: {'✅' if manifest['summary']['has_logo'] else '❌'}")
    print(f"     Favicon: {'✅' if manifest['summary']['has_favicon'] else '❌'}")
    print(f"     OG Image: {'✅' if manifest['summary']['has_og_image'] else '❌'}")
    if manifest["summary"]["primary_color_guess"]:
        print(f"     推测主色: {manifest['summary']['primary_color_guess']}")


# ============================================================
# CLI 入口
# ============================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="品牌视觉资产抓取与留存工具")
    parser.add_argument("--url", required=True, help="企业官网 URL")
    parser.add_argument("--brand", required=True, help="品牌简称")
    parser.add_argument("--output-dir", default="./visual_assets/",
                        help="视觉资产保存目录")
    parser.add_argument("--manifest", default=None,
                        help="清单 JSON 输出路径（默认: S1_{brand}_视觉资产清单.json）")
    args = parser.parse_args()

    if not args.manifest:
        args.manifest = f"S1_{args.brand}_视觉资产清单.json"

    print(f"[START] 抓取 {args.url} 的视觉资产...")
    manifest = scrape_visual_assets(args.url, args.brand, args.output_dir)
    save_manifest(manifest, args.manifest)
