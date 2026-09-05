#!/usr/bin/env python3
"""Optional color-consistency helper for S6 visual review.

This diagnostic deliberately does not invent brand colors or treat a score as
an image-rights decision. Final use follows automatic rights and factual-image safety rules.
"""

from __future__ import annotations

import argparse
import colorsys
import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def hex_to_rgb(value: str) -> tuple[float, float, float] | None:
    raw = value.strip().lstrip("#")
    if len(raw) != 6:
        return None
    try:
        return tuple(int(raw[index:index + 2], 16) / 255 for index in (0, 2, 4))  # type: ignore[return-value]
    except ValueError:
        return None


def color_distance(first: str, second: str) -> float:
    rgb_first = hex_to_rgb(first)
    rgb_second = hex_to_rgb(second)
    if rgb_first is None or rgb_second is None:
        return 1.0
    return min(math.sqrt(sum((a - b) ** 2 for a, b in zip(rgb_first, rgb_second))) / math.sqrt(3), 1.0)


def extract_colors(path: Path, count: int = 5) -> list[dict[str, Any]]:
    try:
        from PIL import Image
    except ImportError:
        return []
    try:
        with Image.open(path) as image:
            image = image.convert("RGB")
            image.thumbnail((180, 180))
            quantized = [tuple((channel // 32) * 32 for channel in pixel) for pixel in image.getdata()]
    except Exception:
        return []
    total = len(quantized)
    return [
        {"hex": f"#{red:02X}{green:02X}{blue:02X}", "percentage": round(amount / total * 100, 2)}
        for (red, green, blue), amount in Counter(quantized).most_common(count)
    ] if total else []


def configured_colors(reference: Any) -> list[str]:
    values = (reference.get("brand_constraints") or {}).get("colors") or [] if isinstance(reference, dict) else []
    result: list[str] = []
    for value in values:
        candidate = value if isinstance(value, str) else value.get("hex") or value.get("value") if isinstance(value, dict) else None
        if isinstance(candidate, str) and hex_to_rgb(candidate):
            result.append("#" + candidate.strip().lstrip("#").upper())
    return list(dict.fromkeys(result))


def main() -> int:
    parser = argparse.ArgumentParser(description="Optional S6 color and visual consistency helper")
    parser.add_argument("images_dir")
    parser.add_argument("visual_reference_json")
    parser.add_argument("output_json")
    args = parser.parse_args()
    image_dir = Path(args.images_dir).expanduser().resolve()
    reference_path = Path(args.visual_reference_json).expanduser().resolve()
    if not image_dir.is_dir():
        parser.error(f"image directory does not exist: {image_dir}")
    if not reference_path.is_file():
        parser.error(f"visual reference does not exist: {reference_path}")
    reference = load_json(reference_path)
    brand_colors = configured_colors(reference)
    images = sorted(path for path in image_dir.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS)
    diagnostics = []
    primary_colors = []
    for path in images:
        colors = extract_colors(path)
        if colors:
            primary_colors.append(colors[0]["hex"])
        distances = [min(color_distance(color["hex"], brand) for brand in brand_colors) for color in colors] if colors and brand_colors else []
        diagnostics.append({
            "path": str(path),
            "dominant_colors": colors,
            "nearest_brand_color_distance": round(sum(distances) / len(distances), 4) if distances else None,
            "status": "measured" if colors and brand_colors else "insufficient_color_data",
        })
    pairwise = [color_distance(primary_colors[i], primary_colors[j]) for i in range(len(primary_colors)) for j in range(i + 1, len(primary_colors))]
    payload = {
        "schema_version": "2.0.0",
        "diagnostic_only": True,
        "brand": reference.get("brand") if isinstance(reference, dict) else None,
        "brand_colors": brand_colors,
        "image_count": len(images),
        "images_with_color_data": len(primary_colors),
        "average_primary_color_distance_between_images": round(sum(pairwise) / len(pairwise), 4) if pairwise else None,
        "images": diagnostics,
        "human_checks_required": ["brand consistency", "information correctness", "asset rights", "logo integrity", "accessibility"],
    }
    output = Path(args.output_json).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps({"status": "ok", "output": str(output), "image_count": len(images)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
