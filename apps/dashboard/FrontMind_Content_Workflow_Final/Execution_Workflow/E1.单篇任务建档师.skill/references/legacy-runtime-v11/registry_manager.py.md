#!/usr/bin/env python3
"""
FrontMind 图片注册表管理器 (Image Registry Manager)

功能：
  - append: 将新文章的图片信息追加到注册表
  - check-dup: 检查新图片是否与注册表中已有图片重复
  - validate: 验证注册表完整性（无重复、字段齐全）
  - init: 初始化空注册表

用法：
  python3 registry_manager.py init --brand "品牌名" --output registry.json
  python3 registry_manager.py append --registry registry.json --article-id A1-001 --images-dir images/
  python3 registry_manager.py check-dup --registry registry.json --new-image img.png --image-type aigc_scene --prompt-hash sha256:abc
  python3 registry_manager.py validate --registry registry.json
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone


# ─── 常量 ───────────────────────────────────────────────────────────
SIMILARITY_THRESHOLD = 0.85  # 去重相似度阈值
MIN_IMAGE_SIZE_KB = 10       # 最小图片文件大小（KB）
REQUIRED_FIELDS = [
    "article_id", "image_id", "image_type", "generation_method",
    "caption_summary", "file_hash", "file_path", "file_size_kb", "created_at"
]
VALID_IMAGE_TYPES = ["aigc_brand_poster", "enterprise_photo", "mermaid_or_d2_flowchart", "web_search", "brand_photo", "certificate_photo", "team_photo", "case_photo", "service_scene", "environment_photo"]


def compute_file_hash(file_path: str) -> str:
    """计算文件的 SHA256 哈希值。"""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return f"sha256:{sha256.hexdigest()}"


def compute_text_hash(text: str) -> str:
    """计算文本的 SHA256 哈希值（用于 Prompt 去重）。"""
    return f"sha256:{hashlib.sha256(text.encode('utf-8')).hexdigest()}"


def load_registry(path: str) -> dict:
    """加载注册表 JSON 文件。"""
    if not os.path.exists(path):
        print(f"[ERROR] 注册表文件不存在: {path}")
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_registry(registry: dict, path: str) -> None:
    """保存注册表到 JSON 文件。"""
    registry["updated_at"] = datetime.now(timezone.utc).isoformat()
    registry["total_images"] = len(registry["entries"])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(registry, f, ensure_ascii=False, indent=2)
    print(f"[OK] 注册表已保存: {path} (共 {registry['total_images']} 张图片)")


def init_registry(brand: str, output_path: str) -> None:
    """初始化空的图片注册表。"""
    registry = {
        "brand": brand,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "total_images": 0,
        "entries": []
    }
    save_registry(registry, output_path)
    print(f"[OK] 已初始化空注册表: {output_path}")


def check_duplicate(registry: dict, new_entry: dict) -> list:
    """
    检查新图片是否与注册表中已有图片重复。
    返回冲突列表，空列表表示无重复。
    """
    conflicts = []
    for existing in registry["entries"]:
        # 规则 1: 文件哈希完全相同
        if existing.get("file_hash") == new_entry.get("file_hash"):
            conflicts.append({
                "type": "file_hash_duplicate",
                "existing_image_id": existing["image_id"],
                "message": f"文件哈希相同: {new_entry['file_hash']}"
            })

        # 规则 2: AIGC 图片 Prompt 哈希相同
        if (new_entry.get("image_type") == "aigc_brand_poster"
                and existing.get("image_type") == "aigc_brand_poster"
                and existing.get("prompt_hash") == new_entry.get("prompt_hash")
                and new_entry.get("prompt_hash")):
            conflicts.append({
                "type": "prompt_hash_duplicate",
                "existing_image_id": existing["image_id"],
                "message": f"AIGC Prompt 哈希相同: {new_entry['prompt_hash']}"
            })

        # 规则 3: 网络搜索图片 URL 相同
        if (new_entry.get("image_type") == "web_search"
                and existing.get("image_type") == "web_search"
                and existing.get("source_url") == new_entry.get("source_url")
                and new_entry.get("source_url")):
            conflicts.append({
                "type": "source_url_duplicate",
                "existing_image_id": existing["image_id"],
                "message": f"图片 URL 相同: {new_entry['source_url']}"
            })



    return conflicts


def append_images(registry_path: str, article_id: str, images_dir: str) -> None:
    """将指定目录中的图片追加到注册表。"""
    registry = load_registry(registry_path)

    if not os.path.isdir(images_dir):
        print(f"[ERROR] 图片目录不存在: {images_dir}")
        sys.exit(1)

    added = 0
    prefix = article_id
    for fname in sorted(os.listdir(images_dir)):
        if not fname.startswith(prefix):
            continue
        if not fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            continue

        fpath = os.path.join(images_dir, fname)
        fsize_kb = os.path.getsize(fpath) / 1024

        if fsize_kb < MIN_IMAGE_SIZE_KB:
            print(f"[WARN] 图片过小，跳过: {fname} ({fsize_kb:.1f}KB < {MIN_IMAGE_SIZE_KB}KB)")
            continue

        file_hash = compute_file_hash(fpath)
        image_id = os.path.splitext(fname)[0]

        new_entry = {
            "article_id": article_id,
            "image_id": image_id,
            "image_type": "enterprise_photo",  # 默认类型，实际应由 E3 传入
            "generation_method": "client_submitted_image_library",
            "caption_summary": f"图片: {fname}",
            "file_hash": file_hash,
            "file_path": f"images/{fname}",
            "file_size_kb": round(fsize_kb, 1),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "client_submitted": False,
            "rights_status": "unknown",
            "allowed_usage": []
        }

        # 去重检查
        conflicts = check_duplicate(registry, new_entry)
        if conflicts:
            print(f"[CONFLICT] {fname} 与已有图片冲突:")
            for c in conflicts:
                print(f"  - {c['type']}: {c['message']} (冲突图片: {c['existing_image_id']})")
            continue

        registry["entries"].append(new_entry)
        added += 1
        print(f"[OK] 已追加: {image_id}")

    save_registry(registry, registry_path)
    print(f"[DONE] 共追加 {added} 张图片到注册表")


def validate_registry(registry_path: str) -> bool:
    """验证注册表完整性：字段齐全、无重复。"""
    registry = load_registry(registry_path)
    errors = []

    # 检查必需字段
    for i, entry in enumerate(registry["entries"]):
        for field in REQUIRED_FIELDS:
            if field not in entry or not entry[field]:
                errors.append(f"条目 {i}: 缺少必需字段 '{field}'")

        if entry.get("image_type") not in VALID_IMAGE_TYPES:
            errors.append(f"条目 {i}: 无效的 image_type '{entry.get('image_type')}'")

        if entry.get("file_size_kb", 0) < MIN_IMAGE_SIZE_KB:
            errors.append(f"条目 {i}: 图片过小 {entry.get('file_size_kb')}KB")

        if entry.get("client_submitted") is True and not entry.get("source_asset_id"):
            errors.append(f"条目 {i}: client_submitted=true 但缺少 source_asset_id")
        if entry.get("image_type") in ("enterprise_photo", "brand_photo", "certificate_photo", "team_photo", "case_photo", "service_scene", "environment_photo"):
            if entry.get("generation_method") == "web_search":
                errors.append(f"条目 {i}: 企业真实图片不得使用 web_search 作为 generation_method")

    # 检查重复
    file_hashes = {}
    prompt_hashes = {}
    source_urls = {}
    chart_dims = {}

    for entry in registry["entries"]:
        fh = entry.get("file_hash")
        if fh in file_hashes:
            errors.append(f"文件哈希重复: {entry['image_id']} 与 {file_hashes[fh]}")
        file_hashes[fh] = entry["image_id"]

        if entry.get("image_type") == "aigc_brand_poster" and entry.get("prompt_hash"):
            ph = entry["prompt_hash"]
            if ph in prompt_hashes:
                errors.append(f"Prompt 哈希重复: {entry['image_id']} 与 {prompt_hashes[ph]}")
            prompt_hashes[ph] = entry["image_id"]

        if entry.get("image_type") == "web_search" and entry.get("source_url"):
            su = entry["source_url"]
            if su in source_urls:
                errors.append(f"URL 重复: {entry['image_id']} 与 {source_urls[su]}")
            source_urls[su] = entry["image_id"]



    if errors:
        print(f"❌ 注册表验证失败，发现 {len(errors)} 个问题:")
        for e in errors:
            print(f"  - {e}")
        return False
    else:
        total = len(registry["entries"])
        print(f"✅ 注册表验证通过: {total} 张图片，无重复，字段完整")
        return True


def main():
    """CLI 入口。"""
    parser = argparse.ArgumentParser(description="FrontMind 图片注册表管理器")
    subparsers = parser.add_subparsers(dest="command", help="可用命令")

    # init
    p_init = subparsers.add_parser("init", help="初始化空注册表")
    p_init.add_argument("--brand", required=True, help="品牌名称")
    p_init.add_argument("--output", required=True, help="输出文件路径")

    # append
    p_append = subparsers.add_parser("append", help="追加图片到注册表")
    p_append.add_argument("--registry", required=True, help="注册表文件路径")
    p_append.add_argument("--article-id", required=True, help="文章编号")
    p_append.add_argument("--images-dir", required=True, help="图片目录路径")

    # check-dup
    p_check = subparsers.add_parser("check-dup", help="检查图片是否重复")
    p_check.add_argument("--registry", required=True, help="注册表文件路径")
    p_check.add_argument("--new-image", required=True, help="新图片文件路径")
    p_check.add_argument("--image-type", required=True, choices=VALID_IMAGE_TYPES)
    p_check.add_argument("--prompt-hash", default="", help="AIGC Prompt 哈希")

    # validate
    p_val = subparsers.add_parser("validate", help="验证注册表完整性")
    p_val.add_argument("--registry", required=True, help="注册表文件路径")

    args = parser.parse_args()

    if args.command == "init":
        init_registry(args.brand, args.output)
    elif args.command == "append":
        append_images(args.registry, args.article_id, args.images_dir)
    elif args.command == "check-dup":
        registry = load_registry(args.registry)
        new_entry = {
            "image_type": args.image_type,
            "file_hash": compute_file_hash(args.new_image),
            "prompt_hash": args.prompt_hash
        }
        conflicts = check_duplicate(registry, new_entry)
        if conflicts:
            print(f"❌ 发现 {len(conflicts)} 个冲突:")
            for c in conflicts:
                print(f"  - {c['message']}")
            sys.exit(1)
        else:
            print("✅ 无重复")
    elif args.command == "validate":
        ok = validate_registry(args.registry)
        sys.exit(0 if ok else 1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
