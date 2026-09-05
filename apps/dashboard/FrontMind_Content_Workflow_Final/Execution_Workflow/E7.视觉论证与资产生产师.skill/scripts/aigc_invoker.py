#!/usr/bin/env python3
"""Accept one image-generator result and safely apply an original Logo overlay."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
sys.path.insert(0, str(SHARED))
from content_first_runtime import load_object, resolve_input_file, write_json  # noqa: E402
from schema_validation import validate_schema  # noqa: E402


def aggregate_result(
    output: Path, *, job_id: str, attempt: dict[str, Any], image: dict[str, Any] | None,
) -> dict[str, Any]:
    """Append/replace one provider attempt in the job-level generated-assets file."""
    if output.is_file():
        result = load_object(output)
        if result.get("job_id") != job_id:
            raise ValueError("generated-assets job_id mismatch")
    else:
        result = {"schema_version": "2.3.0", "job_id": job_id, "attempts": [], "images": []}
    visual_id = str(attempt["visual_id"])
    result["attempts"] = [
        value for value in result.get("attempts", [])
        if isinstance(value, dict) and value.get("visual_id") != visual_id
    ] + [attempt]
    result["images"] = [
        value for value in result.get("images", [])
        if isinstance(value, dict) and value.get("visual_id") != visual_id
    ]
    if image is not None:
        result["images"].append(image)
    result["status"] = (
        "completed_with_limits"
        if any(value.get("status") == "completed_with_limits" for value in result["attempts"])
        else "completed"
    )
    return result


def overlay_original_logo(
    generated: Path, output: Path, item: dict[str, Any], context: dict[str, Any] | None, asset_root: Path | None,
) -> tuple[int, int]:
    try:
        from PIL import Image
    except Exception as exc:  # pragma: no cover - dependency error is explicit
        raise RuntimeError("Pillow is required for safe image production") from exc
    with Image.open(generated) as source:
        canvas = source.convert("RGBA")
    logo_id = item.get("logo_overlay_asset_id")
    if logo_id:
        if not context or not asset_root:
            raise ValueError("an original Logo overlay requires --working-context and --asset-root")
        asset = next(
            (value for value in context.get("images", []) if isinstance(value, dict) and value.get("image_id") == logo_id),
            None,
        )
        if not asset or str(asset.get("asset_kind", "")).casefold() != "logo":
            raise ValueError("logo_overlay_asset_id must reference an original Logo asset")
        if asset.get("rights_status") not in {"approved", "approved_with_credit"}:
            raise ValueError("Logo overlay rights are not approved")
        logo_path = resolve_input_file(asset_root, str(asset.get("file_path") or ""))
        with Image.open(logo_path) as logo_source:
            logo = logo_source.convert("RGBA")
        maximum_width = max(48, int(canvas.width * 0.18))
        if logo.width > maximum_width:
            height = max(1, int(logo.height * maximum_width / logo.width))
            logo = logo.resize((maximum_width, height), Image.Resampling.LANCZOS)
        margin = max(18, int(min(canvas.size) * 0.035))
        canvas.alpha_composite(logo, (canvas.width - logo.width - margin, canvas.height - logo.height - margin))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(output, quality=94)
    return canvas.width, canvas.height


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-plan", type=Path, required=True)
    parser.add_argument("--visual-id", required=True)
    parser.add_argument("--generated-image", type=Path)
    parser.add_argument("--working-context", type=Path)
    parser.add_argument("--asset-root", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()
    plan = load_object(args.prompt_plan)
    validate_schema(
        plan, Path(__file__).resolve().parents[1] / "templates" / "prompt_plan_schema.json",
        "E7 prompt plan",
    )
    item = next(
        (value for value in plan.get("images", []) if isinstance(value, dict) and value.get("visual_id") == args.visual_id),
        None,
    )
    if item is None:
        raise ValueError(f"unknown visual_id: {args.visual_id}")
    if args.generated_image is None:
        result = aggregate_result(
            args.result, job_id=str(plan.get("job_id")),
            attempt={"visual_id": args.visual_id, "status": "completed_with_limits",
                     "reason": "image_generator_returned_no_file"}, image=None,
        )
        validate_schema(
            result, Path(__file__).resolve().parents[1] / "templates" / "generated_assets.schema.json",
            "E7 generated assets",
        )
        write_json(args.result, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.generated_image.is_symlink() or not args.generated_image.is_file():
        raise ValueError("generated image is missing or a symlink")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    image_id = "img_generated_" + args.visual_id.removeprefix("vis_")
    target = args.output_dir / f"{image_id}.jpg"
    context = load_object(args.working_context) if args.working_context else None
    width, height = overlay_original_logo(args.generated_image, target, item, context, args.asset_root)
    image = {
            "image_id": image_id, "file_path": str(target),
            "asset_kind": "brand_image" if item.get("role") == "brand_editorial" else "diagram",
            "origin": "generated", "usage_status": "usable", "rights_status": "approved",
            "width": width, "height": height,
            "visual_id": item.get("visual_id"), "role": item.get("role"),
            "after_section_id": item.get("after_section_id"), "alt_text": item.get("alt_text"),
            "supports_fact_ids": item.get("supports_fact_ids", []),
    }
    result = aggregate_result(
        args.result, job_id=str(plan.get("job_id")),
        attempt={"visual_id": args.visual_id, "status": "completed"}, image=image,
    )
    validate_schema(
        result, Path(__file__).resolve().parents[1] / "templates" / "generated_assets.schema.json",
        "E7 generated assets",
    )
    write_json(args.result, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
