#!/usr/bin/env python3
"""Render one title-free v2.3 body to matching HTML and DOCX delivery."""

from __future__ import annotations

import argparse
import copy
import html
import importlib.util
import json
import mimetypes
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


WORKFLOW_ROOT = Path(__file__).resolve().parents[3]
EXECUTION_ROOT = Path(__file__).resolve().parents[2]
SHARED = EXECUTION_ROOT / "shared"
ROOT_SHARED = WORKFLOW_ROOT / "shared"
sys.path.insert(0, str(SHARED))
sys.path.insert(0, str(ROOT_SHARED / "scripts"))
from content_first_runtime import (  # noqa: E402
    load_object, title_field_paths, update_job_state, write_json,
)
from schema_validation import validate_root, validate_schema  # noqa: E402
from validate_title_map import validate as validate_title_content  # noqa: E402


def copy_actual_images(
    model: dict[str, Any], selection: dict[str, Any] | None, output_dir: Path, asset_root: Path,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    warnings: list[str] = []
    if not selection:
        return {}, (["visual_selection_not_provided; delivered text-only"] if model.get("visual_placements") else [])
    if selection.get("job_id") != model.get("job_id"):
        return {}, ["visual_selection_job_mismatch; delivered text-only"]
    selected = {
        str(item.get("image_id")): item
        for item in selection.get("used", []) if isinstance(item, dict) and item.get("image_id")
    }
    image_dir = output_dir / "images"
    copied: dict[str, dict[str, Any]] = {}
    for placement in model.get("visual_placements", []):
        if not isinstance(placement, dict):
            continue
        image_id = str(placement.get("asset_id", ""))
        asset = selected.get(image_id)
        visual_id = str(placement.get("visual_id", "vis_unknown"))
        if not asset:
            warnings.append(f"visual_omitted:{visual_id}:not in E7 used selection")
            continue
        if asset.get("rights_status") not in {"approved", "approved_with_credit"}:
            warnings.append(f"visual_omitted:{visual_id}:rights unavailable")
            continue
        if asset.get("rights_status") == "approved_with_credit" and not str(asset.get("credit") or "").strip():
            warnings.append(f"visual_omitted:{visual_id}:credit missing")
            continue
        source = Path(str(asset.get("file_path", "")))
        try:
            source.resolve().relative_to(asset_root.resolve())
        except ValueError:
            warnings.append(f"visual_omitted:{visual_id}:path escapes asset root")
            continue
        if source.is_symlink() or not source.is_file():
            warnings.append(f"visual_omitted:{visual_id}:file missing or symlink")
            continue
        image_dir.mkdir(parents=True, exist_ok=True)
        suffix = source.suffix.lower() or mimetypes.guess_extension(mimetypes.guess_type(source.name)[0] or "") or ".bin"
        target = image_dir / f"{image_id}{suffix}"
        shutil.copy2(source, target)
        copied[image_id] = {
            "delivery_path": f"images/{target.name}",
            "delivery_file": target,
            "alt": str(placement.get("alt_text") or ""),
            "credit": str(asset.get("credit") or ""),
        }
    return copied, warnings


def render_nodes(model: dict[str, Any], visuals: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    by_section: dict[str, list[dict[str, str]]] = {}
    for placement in model.get("visual_placements", []):
        if not isinstance(placement, dict):
            continue
        image = visuals.get(str(placement.get("asset_id", "")))
        if not image:
            continue
        key = str(placement.get("after_section_id") or "__cover__")
        by_section.setdefault(key, []).append({
            "kind": "image", "src": image["delivery_path"], "alt": image["alt"], "caption": image["credit"],
        })
    nodes: list[dict[str, str]] = []
    nodes.extend(by_section.get("__cover__", []))
    nodes.append({"kind": "p", "text": str((model.get("lead") or {}).get("text") or "")})
    for section in model.get("sections", []):
        if not isinstance(section, dict):
            continue
        nodes.append({"kind": "h2", "text": str(section.get("heading") or "")})
        for paragraph in section.get("paragraphs", []):
            if isinstance(paragraph, dict) and str(paragraph.get("text") or "").strip():
                nodes.append({"kind": "p", "text": str(paragraph["text"]).strip()})
        nodes.extend(by_section.get(str(section.get("section_id")), []))
    if model.get("faq"):
        nodes.append({"kind": "h2", "text": "常见问题"})
        for item in model.get("faq", []):
            if isinstance(item, dict):
                nodes.append({"kind": "h3", "text": str(item.get("question") or "")})
                nodes.append({"kind": "p", "text": str(item.get("answer") or "")})
    nodes.append({"kind": "h2", "text": "结论"})
    conclusion = model.get("conclusion") or {}
    for paragraph in conclusion.get("paragraphs", []):
        if isinstance(paragraph, dict) and str(paragraph.get("text") or "").strip():
            nodes.append({"kind": "p", "text": str(paragraph["text"]).strip()})
    if model.get("references"):
        nodes.append({"kind": "h2", "text": "资料来源"})
        for reference in model.get("references", []):
            if isinstance(reference, dict):
                nodes.append({
                    "kind": "reference", "text": str(reference.get("display_name") or ""),
                    "url": str(reference.get("url") or ""),
                })
    return nodes


def markdown_from_nodes(nodes: list[dict[str, str]]) -> str:
    lines: list[str] = []
    for node in nodes:
        kind = node["kind"]
        if kind == "h2":
            lines.extend((f"## {node['text']}", ""))
        elif kind == "h3":
            lines.extend((f"### {node['text']}", ""))
        elif kind == "image":
            lines.extend((f"![{node['alt']}]({node['src']})", node.get("caption", ""), ""))
        elif kind == "reference":
            value = f"[{node['text']}]({node['url']})" if node.get("url") else node["text"]
            lines.append(f"- {value}")
        else:
            lines.extend((node.get("text", ""), ""))
    return "\n".join(lines).strip() + "\n"


def html_from_nodes(nodes: list[dict[str, str]]) -> str:
    # Public HTML contains only publishing content; internal workflow/job
    # identifiers must not leak into data attributes.
    output = ['<article class="frontmind-article-body">']
    for node in nodes:
        kind = node["kind"]
        if kind in {"h2", "h3"}:
            output.append(f"<{kind}>{html.escape(node['text'])}</{kind}>")
        elif kind == "image":
            caption = f"<figcaption>{html.escape(node.get('caption', ''))}</figcaption>" if node.get("caption") else ""
            output.append(
                f'<figure><img src="{html.escape(node["src"], quote=True)}" '
                f'alt="{html.escape(node["alt"], quote=True)}">{caption}</figure>'
            )
        elif kind == "reference" and node.get("url"):
            output.append(
                f'<p class="reference"><a href="{html.escape(node["url"], quote=True)}" '
                f'rel="noopener noreferrer">{html.escape(node["text"])}</a></p>'
            )
        else:
            output.append(f"<p>{html.escape(node.get('text', ''))}</p>")
    output.append("</article>")
    return "\n".join(output) + "\n"


def render_docx(markdown: str, images_dir: Path, output: Path) -> None:
    module_path = EXECUTION_ROOT / "E8.编辑终审师.skill" / "scripts" / "md2docx.py"
    spec = importlib.util.spec_from_file_location("frontmind_e10_md2docx", module_path)
    if spec is not None and spec.loader is not None:
        try:
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with tempfile.TemporaryDirectory(prefix="frontmind-e10-") as directory:
                source = Path(directory) / "body.md"
                source.write_text(markdown, encoding="utf-8")
                result = module.assemble_with_size_control(str(source), str(images_dir), str(output), 20.0)
            if result.get("success"):
                return
            raise RuntimeError(result.get("error") or "DOCX renderer returned an unknown failure")
        except Exception as exc:
            raise RuntimeError(f"high-fidelity DOCX renderer failed: {exc}") from exc
    raise RuntimeError("high-fidelity DOCX renderer is unavailable")


def structured_data(model: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    templates: list[dict[str, Any]] = []
    warnings: list[str] = []
    requested = set(model.get("structured_data_types", []))
    if "Article" in requested:
        templates.append({
            "@context": "https://schema.org", "@type": "Article",
            "headline": "{{TITLE}}", "description": "{{META_DESCRIPTION}}",
            "dateModified": (model.get("metadata") or {}).get("as_of"),
            "inLanguage": (model.get("metadata") or {}).get("language", "zh-CN"),
        })
    if "FAQPage" in requested and model.get("faq"):
        templates.append({
            "@context": "https://schema.org", "@type": "FAQPage",
            "mainEntity": [
                {"@type": "Question", "name": item["question"], "acceptedAnswer": {"@type": "Answer", "text": item["answer"]}}
                for item in model.get("faq", []) if isinstance(item, dict)
            ],
        })
    if "ItemList" in requested and model.get("pattern_id") == "P02":
        candidates = (model.get("candidate_contract") or {}).get("ordered_candidates", [])
        if candidates:
            templates.append({
                "@context": "https://schema.org", "@type": "ItemList",
                "itemListOrder": "https://schema.org/ItemListUnordered",
                "itemListElement": [
                    {"@type": "ListItem", "name": str(item.get("display_name") or "")}
                    for item in candidates if isinstance(item, dict)
                ],
            })
    handled = {value.get("@type") for value in templates}
    for kind in sorted(requested - handled):
        warnings.append(f"structured_data_skipped:{kind}:insufficient visible data")
    return {
        "schema_version": "2.3.0", "job_id": model.get("job_id"),
        "title_placeholder": "{{TITLE}}", "meta_description_placeholder": "{{META_DESCRIPTION}}",
        "templates": templates,
    }, warnings


def metadata_map(model: dict[str, Any], title_map: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": "2.3.0", "job_id": model.get("job_id"),
        "entries": [
            {
                "title_id": item["title_id"], "title": item["title_text"],
                "h1": item["h1_suggestion"], "meta_description": item["meta_description"],
                "structured_data_replacements": {
                    "{{TITLE}}": item["title_text"], "{{META_DESCRIPTION}}": item["meta_description"],
                },
            }
            for item in title_map.get("options", [])
        ],
    }


def title_markdown(title_map: dict[str, Any]) -> str:
    lines = ["# 标题选项", ""]
    for index, item in enumerate(title_map.get("options", []), 1):
        lines.extend((
            f"## {index}. {item['title_text']}", "",
            f"- Title ID：`{item['title_id']}`",
            f"- H1 建议：{item['h1_suggestion']}",
            f"- Meta Description：{item['meta_description']}",
            f"- 公式：{item['title_formula']}",
            f"- 角度：{item['angle_tag']}", "",
        ))
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--content-model", type=Path, required=True)
    parser.add_argument("--title-map", type=Path, required=True)
    parser.add_argument("--job-state", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--visual-selection", type=Path)
    parser.add_argument("--asset-root", type=Path,
                        help="root containing all selected image inputs; defaults to visual-selection directory")
    args = parser.parse_args()

    model, title_map, state = (
        load_object(args.content_model), load_object(args.title_map), load_object(args.job_state)
    )
    validate_root(model, "content_model.schema.json", "E10 final Content Model")
    validate_root(title_map, "title_map.schema.json", "E10 title map")
    if title_field_paths(model):
        raise ValueError("final Content Model must remain title-free")
    if len({model.get("job_id"), title_map.get("job_id"), state.get("job_id")}) != 1:
        raise ValueError("E10 job_id mismatch")
    count = state.get("title_count")
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 20:
        raise ValueError("job_state.title_count must be set to 1..20 before delivery")
    if title_map.get("requested_count") != count or len(title_map.get("options", [])) != count:
        raise ValueError("title map count does not match job_state.title_count")
    title_errors = validate_title_content(title_map, model)
    if title_errors:
        raise ValueError("title safety validation failed: " + "; ".join(title_errors))

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    selection = load_object(args.visual_selection) if args.visual_selection else None
    asset_root = (args.asset_root or (args.visual_selection.parent if args.visual_selection else args.content_model.parent)).resolve()
    visuals, warnings = copy_actual_images(model, selection, output_dir, asset_root)
    rendered_model = copy.deepcopy(model)
    rendered_model["visual_placements"] = [
        item for item in rendered_model.get("visual_placements", [])
        if isinstance(item, dict) and str(item.get("asset_id")) in visuals
    ]
    nodes = render_nodes(rendered_model, visuals)
    markdown = markdown_from_nodes(nodes)
    html_fragment = html_from_nodes(nodes)
    if any(token in html_fragment.casefold() for token in ("<html", "<head", "<title", "<h1", "<script", "<table")):
        raise ValueError("HTML delivery must remain an embeddable title-free fragment")
    docx_path = output_dir / "article_body.docx"
    try:
        render_docx(markdown, output_dir / "images", docx_path)
    except Exception as exc:
        blocker = {"code": "render_failed", "message": str(exc)}
        update_job_state(
            args.job_state, stage="E10", status="blocked", warnings=warnings,
            selected_pattern_id=str(model.get("pattern_id")), title_count=count, blocker=blocker,
        )
        raise
    (output_dir / "article_body.html").write_text(html_fragment, encoding="utf-8")
    write_json(output_dir / "title_map.json", title_map)
    (output_dir / "title_options.md").write_text(title_markdown(title_map), encoding="utf-8")
    publishing = metadata_map(model, title_map)
    validate_schema(
        publishing, Path(__file__).resolve().parents[1] / "templates" / "publishing_metadata_map.schema.json",
        "E10 publishing metadata map",
    )
    write_json(output_dir / "publishing_metadata_map.json", publishing)
    structured, structured_warnings = structured_data(model)
    warnings.extend(structured_warnings)
    validate_schema(
        structured, Path(__file__).resolve().parents[1] / "templates" / "structured_data_template.schema.json",
        "E10 structured data template",
    )
    write_json(output_dir / "structured_data_template.json", structured)

    artifacts = [
        {"role": "article_body_docx", "path": "article_body.docx", "media_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
        {"role": "article_body_html", "path": "article_body.html", "media_type": "text/html"},
        {"role": "title_options", "path": "title_options.md", "media_type": "text/markdown"},
        {"role": "title_map", "path": "title_map.json", "media_type": "application/json"},
        {"role": "publishing_metadata_map", "path": "publishing_metadata_map.json", "media_type": "application/json"},
        {"role": "structured_data_template", "path": "structured_data_template.json", "media_type": "application/json"},
    ]
    for image in visuals.values():
        artifacts.append({
            "role": "image", "path": image["delivery_path"],
            "media_type": mimetypes.guess_type(image["delivery_path"])[0] or "application/octet-stream",
        })
    delivery_index = {
        "schema_version": "2.3.0", "job_id": model.get("job_id"),
        "created_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "artifacts": artifacts, "warnings": list(dict.fromkeys(warnings)),
    }
    validate_root(delivery_index, "delivery_index.schema.json", "E10 delivery index")
    write_json(output_dir / "delivery_index.json", delivery_index)
    status = "completed_with_limits" if warnings else "completed"
    update_job_state(
        args.job_state, stage="E10", status=status, warnings=warnings,
        selected_pattern_id=str(model.get("pattern_id")), title_count=count,
    )
    print(json.dumps({"status": status, "output_dir": str(output_dir), "warnings": warnings}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
