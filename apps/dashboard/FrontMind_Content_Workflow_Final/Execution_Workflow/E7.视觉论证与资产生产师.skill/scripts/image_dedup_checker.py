#!/usr/bin/env python3
"""Non-blocking image similarity screen for the v2.3 visual pipeline."""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any

try:
    from PIL import Image
except ImportError:  # similarity is optional
    Image = None


def attribute(svg: str, key: str) -> str | None:
    match = re.search(rf"\b{re.escape(key)}\s*=\s*['\"]([^'\"]+)['\"]", svg, re.I)
    return match.group(1) if match else None


def number(value: str | None) -> float | None:
    if value is None:
        return None
    match = re.match(r"\s*(\d+(?:\.\d+)?)", value)
    return float(match.group(1)) if match else None


def image_facts(path: Path) -> tuple[str, int | None, int | None]:
    if path.suffix.lower() == ".svg":
        svg = path.read_text(encoding="utf-8", errors="replace")[:65536]
        width, height = number(attribute(svg, "width")), number(attribute(svg, "height"))
        if width and height:
            return "image/svg+xml", math.ceil(width), math.ceil(height)
        viewbox = attribute(svg, "viewBox")
        if viewbox:
            values = [value for value in re.split(r"[\s,]+", viewbox.strip()) if value]
            if len(values) == 4:
                try:
                    return "image/svg+xml", math.ceil(float(values[2])), math.ceil(float(values[3]))
                except ValueError:
                    pass
        return "image/svg+xml", None, None
    if Image is None:
        return "application/octet-stream", None, None
    with Image.open(path) as image:
        return Image.MIME.get(image.format, "application/octet-stream"), image.width, image.height


def perceptual_bits(path: Path, size: int = 16) -> str | None:
    if Image is None or path.suffix.lower() == ".svg":
        return None
    with Image.open(path) as image:
        pixels = list(image.convert("L").resize((size, size)).getdata())
    average = sum(pixels) / len(pixels)
    return "".join("1" if value >= average else "0" for value in pixels)


def similarity(left: str | None, right: str | None) -> float | None:
    if not left or not right or len(left) != len(right):
        return None
    return sum(a == b for a, b in zip(left, right)) / len(left)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--compare-dir", type=Path)
    parser.add_argument("--threshold", type=float, default=0.9)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.image.is_symlink() or not args.image.is_file():
        raise ValueError("image is missing or a symlink")
    current = perceptual_bits(args.image)
    matches: list[dict[str, Any]] = []
    if args.compare_dir and args.compare_dir.is_dir():
        for candidate in sorted(args.compare_dir.iterdir()):
            if not candidate.is_file() or candidate.resolve() == args.image.resolve():
                continue
            score = similarity(current, perceptual_bits(candidate))
            if score is not None and score >= args.threshold:
                matches.append({"file": candidate.name, "similarity": round(score, 4)})
    result = {
        "status": "duplicate_warning" if matches else "unique_or_unchecked",
        "usable": not matches, "matches": matches,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
