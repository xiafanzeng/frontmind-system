#!/usr/bin/env python3
"""
FrontMind 全量打包器 (ZIP Packer)

功能：
  将所有 Agent 产出文件按标准目录结构整理并打包为 ZIP。
  自动排除系统文件（.DS_Store, __MACOSX, Thumbs.db）。

用法：
  python3 zip_packer.py --brand "品牌名" --source-dir "./" --output "output.zip"

目录结构：
  {brand}_FrontMind全链路产出/
  ├── 00_策略包/
  ├── 01_内容策略/
  ├── 02_核心素材/
  ├── 03_分发编排/
  ├── 04_图片注册表/
  └── E0_{brand}_FrontMind全链路展示.html
"""

import argparse
import os
import shutil
import sys
import zipfile
from datetime import datetime

# ─── 排除的系统文件模式 ─────────────────────────────────────────────
EXCLUDE_PATTERNS = [
    ".DS_Store",
    "__MACOSX",
    "Thumbs.db",
    ".git",
    "__pycache__",
    "*.pyc",
    ".env",
]


def should_exclude(filepath: str) -> bool:
    """判断文件是否应被排除。"""
    basename = os.path.basename(filepath)
    for pattern in EXCLUDE_PATTERNS:
        if pattern.startswith("*"):
            if basename.endswith(pattern[1:]):
                return True
        elif pattern in filepath or basename == pattern:
            return True
    return False


def collect_files(source_dir: str, brand: str) -> dict:
    """
    扫描源目录，按标准结构收集文件。
    返回 {zip内路径: 本地文件路径} 的映射。
    """
    files = {}
    root_prefix = f"{brand}_FrontMind全链路产出"

    # 定义目录映射规则
    dir_rules = [
        ("strategy_pack", "00_策略包"),
        ("选题矩阵", "01_内容策略"),
        ("核心素材清单", "01_内容策略"),
        ("quality_review", "02_核心素材"),
        ("HarnessGEO", "03_分发编排"),
        ("harnessgeo", "03_分发编排"),
        ("distribution", "03_分发编排"),
        ("分发", "03_分发编排"),
        ("渠道推荐", "03_分发编排"),
        ("信源", "03_分发编排"),
        ("平台适配", "03_分发编排"),
        ("image_registry", "04_图片注册表"),
    ]

    for dirpath, dirnames, filenames in os.walk(source_dir):
        # 跳过排除的目录
        dirnames[:] = [d for d in dirnames if not should_exclude(d)]

        for fname in filenames:
            fpath = os.path.join(dirpath, fname)

            if should_exclude(fpath):
                continue

            # 确定目标子目录
            target_subdir = "02_核心素材"  # 默认放入核心素材
            for keyword, subdir in dir_rules:
                if keyword in fname:
                    target_subdir = subdir
                    break

            # 特殊处理：图片文件
            if fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                target_subdir = "02_核心素材/images"

            # 特殊处理：DOCX 和 MD 文章文件
            if fname.endswith((".docx", ".md")) and brand in fname:
                if "核心素材" in fname:
                    target_subdir = "02_核心素材"

            # 特殊处理：展示 HTML
            if "全链路展示" in fname:
                zip_path = f"{root_prefix}/{fname}"
                files[zip_path] = fpath
                continue

            zip_path = f"{root_prefix}/{target_subdir}/{fname}"
            files[zip_path] = fpath

    return files


def create_zip(files: dict, output_path: str) -> None:
    """创建 ZIP 文件。"""
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for zip_path, local_path in sorted(files.items()):
            if os.path.isfile(local_path):
                zf.write(local_path, zip_path)
                size_kb = os.path.getsize(local_path) / 1024
                print(f"  + {zip_path} ({size_kb:.1f}KB)")

    zip_size = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\n[OK] ZIP 已创建: {output_path} ({zip_size:.1f}MB)")


def print_summary(files: dict, brand: str) -> None:
    """打印打包摘要。"""
    ext_counts = {}
    total_size = 0
    for zip_path, local_path in files.items():
        if os.path.isfile(local_path):
            ext = os.path.splitext(local_path)[1].lower()
            ext_counts[ext] = ext_counts.get(ext, 0) + 1
            total_size += os.path.getsize(local_path)

    print(f"\n╔══════════════════════════════════════╗")
    print(f"║  FrontMind 全量打包摘要              ║")
    print(f"╠══════════════════════════════════════╣")
    print(f"║  品牌: {brand:<29s} ║")
    print(f"║  文件总数: {len(files):<26d} ║")
    print(f"║  总大小: {total_size/1024/1024:<28.1f}MB ║")
    print(f"╠══════════════════════════════════════╣")
    for ext, count in sorted(ext_counts.items()):
        print(f"║  {ext or '(无扩展名)':<10s}: {count:<24d} ║")
    print(f"╚══════════════════════════════════════╝")


def main():
    """CLI 入口。"""
    parser = argparse.ArgumentParser(description="FrontMind 全量打包器")
    parser.add_argument("--brand", required=True, help="品牌名称")
    parser.add_argument("--source-dir", required=True, help="源文件目录")
    parser.add_argument("--output", required=True, help="输出 ZIP 文件路径")
    args = parser.parse_args()

    print(f"[INFO] 开始打包: {args.brand}")
    print(f"[INFO] 源目录: {args.source_dir}")
    print(f"[INFO] 输出: {args.output}")

    if not os.path.isdir(args.source_dir):
        print(f"[ERROR] 源目录不存在: {args.source_dir}")
        sys.exit(1)

    # 收集文件
    files = collect_files(args.source_dir, args.brand)

    if not files:
        print("[ERROR] 未找到任何可打包的文件")
        sys.exit(1)

    # 打印摘要
    print_summary(files, args.brand)

    # 创建 ZIP
    create_zip(files, args.output)

    print(f"\n🎉 打包完成！共 {len(files)} 个文件。")


if __name__ == "__main__":
    main()
