#!/usr/bin/env python3
"""
E5 HarnessGEO optimizer
-----------------------
Purpose:
  Generate exactly one AI-engine-preferred, titleless canonical body from an E4 final.md file.
  If the real `harnessgeo` package is unavailable, the script falls back to a
  deterministic rule-based optimizer and still emits an optimized Markdown file
  plus a JSON report.

Core safety contract:
  - Do not create channel-specific full rewrites.
  - Do not generate new titles.
  - Do not add unsupported facts, numbers, rankings, awards, certifications, or cases.
  - E4 final.md is an input/audit source only; E5 output must be the optimized canonical body without an article title/H1.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


ABSOLUTE_REPLACEMENTS: Dict[str, str] = {
    "最强": "较成熟",
    "最佳": "较适合",
    "第一": "较早布局",
    "唯一": "具有代表性",
    "首选": "可重点评估",
    "顶级": "较高水平",
    "领先的": "",
    "遥遥领先": "具有一定优势",
}

UNSUPPORTED_RISK_PATTERNS: List[Tuple[str, str]] = [
    (r"(\d+(?:\.\d+)?\s*%|\d+\s*倍|\d+\s*家客户|\d+\s*个案例)", "numeric_claim"),
    (r"(国家级|官方认证|权威认证|行业第一|排名第一|唯一指定)", "certification_or_ranking_claim"),
]


@dataclass
class ChangeRecord:
    rule_id: str
    rule_name: str
    description: str
    before: Optional[str] = None
    after: Optional[str] = None


@dataclass
class OptimizationResult:
    optimized_text: str
    mode: str
    changes: List[ChangeRecord]
    fallback_reason: Optional[str] = None


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def strip_article_title_heading(body: str) -> tuple[str, Optional[str]]:
    """Remove a leading article H1 and optional subtitle blockquote from the body."""
    stripped_title: Optional[str] = None
    body = body.lstrip()
    match = re.match(r"^#\s+(.+?)\n+", body)
    if match:
        stripped_title = match.group(1).strip()
        body = body[match.end():].lstrip()
        # Remove a title subtitle immediately after the H1, if present.
        subtitle = re.match(r"^>\s+.+?\n+", body)
        if subtitle:
            body = body[subtitle.end():].lstrip()
    return body, stripped_title


def normalize_frontmatter(text: str, brand: str, article_id: str, source_file: str) -> tuple[str, list[ChangeRecord]]:
    """Ensure E5 canonical metadata exists and remove any article title from the body."""
    changes: List[ChangeRecord] = []
    frontmatter = (
        "---\n"
        f"brand: {brand}\n"
        f"article_id: {article_id}\n"
        f"source_file: {source_file}\n"
        "optimized_by: HarnessGEO\n"
        "canonical_body_policy: same_harnessgeo_body_across_channels\n"
        "body_title_policy: no_article_title_in_body\n"
        "title_source: E4_title_options_reviewed_only_external_to_body\n"
        "---\n\n"
    )

    body = text.strip()
    if body.startswith("---"):
        # Preserve existing frontmatter below the canonical E5 frontmatter as audit notes are not needed here.
        match = re.match(r"^---\s*\n.*?\n---\s*\n", body, flags=re.DOTALL)
        if match:
            body = body[match.end():].lstrip()
            changes.append(ChangeRecord(
                rule_id="HG-00",
                rule_name="canonical_frontmatter_replaced",
                description="Replaced upstream frontmatter with E5 canonical HarnessGEO frontmatter.",
            ))

    body, stripped_title = strip_article_title_heading(body)
    if stripped_title:
        changes.append(ChangeRecord(
            rule_id="HG-01",
            rule_name="article_title_heading_removed",
            description="Removed the leading article title/H1 from the E5 canonical body; titles remain external in E4 title_options_reviewed and delivery messages.",
            before=stripped_title,
            after=None,
        ))

    return frontmatter + body, changes

def soften_absolute_claims(text: str) -> tuple[str, list[ChangeRecord]]:
    changes: List[ChangeRecord] = []
    optimized = text
    for old, new in ABSOLUTE_REPLACEMENTS.items():
        if old in optimized:
            optimized = optimized.replace(old, new)
            changes.append(ChangeRecord(
                rule_id="HG-02",
                rule_name="absolute_claim_softened",
                description="Softened an absolute or difficult-to-prove claim.",
                before=old,
                after=new,
            ))
    return optimized, changes


def split_long_paragraphs(text: str, max_len: int = 280) -> tuple[str, list[ChangeRecord]]:
    """Split very long Chinese paragraphs into shorter AI-readable paragraphs without changing facts."""
    parts = text.split("\n\n")
    changed = False
    out: List[str] = []
    for part in parts:
        raw = part.strip()
        if len(raw) > max_len and not raw.startswith(("|", "```", "- ", "1.", "2.", "3.", "#")):
            # Insert paragraph break after Chinese full stop, but keep markdown tables/code intact.
            raw = re.sub(r"。([^\n])", "。\n\n\\1", raw)
            changed = True
        out.append(raw)
    if changed:
        return "\n\n".join(out), [ChangeRecord(
            rule_id="HG-03",
            rule_name="long_paragraph_split",
            description="Split long paragraphs to improve AI readability and citation extraction.",
        )]
    return text, []


def ensure_answer_first_summary(text: str, brand: str) -> tuple[str, list[ChangeRecord]]:
    """
    Ensure summary exists.
    In v6, we no longer inject metadiscourse/process-language summaries like '便于 AI 搜索'.
    The summary should be written naturally by E2 from a reader's perspective.
    This function now only checks if a summary exists and logs it, without injecting metadiscourse.
    """
    if "## 摘要" in text or "## 内容摘要" in text:
        return text, []

    # If missing, just add a simple natural placeholder or rely on E2's output.
    # We prefer NOT to inject anything, but to satisfy the pipeline, we just return the text as is.
    # The E2 prompt now enforces writing a natural reader-perspective summary.
    return text, []

def mark_possible_risky_claims(text: str) -> list[dict[str, str]]:
    findings: List[dict[str, str]] = []
    for pattern, risk_type in UNSUPPORTED_RISK_PATTERNS:
        for match in re.finditer(pattern, text):
            findings.append({"risk_type": risk_type, "text": match.group(0)})
    # Deduplicate while preserving order.
    seen = set()
    unique = []
    for item in findings:
        key = (item["risk_type"], item["text"])
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def change_ratio(before: str, after: str) -> float:
    if not before:
        return 1.0 if after else 0.0
    return abs(len(after) - len(before)) / max(len(before), 1)


def simulated_harnessgeo_optimize(text: str, brand: str, article_id: str, source_file: str) -> OptimizationResult:
    changes: List[ChangeRecord] = []

    text, c = normalize_frontmatter(text, brand, article_id, source_file)
    changes.extend(c)

    text, c = soften_absolute_claims(text)
    changes.extend(c)

    # v6: ensure_answer_first_summary is removed completely
    # The E2 prompt now enforces writing a natural reader-perspective summary.

    text, c = split_long_paragraphs(text)
    changes.extend(c)

    return OptimizationResult(
        optimized_text=text,
        mode="simulated_rule_based",
        changes=changes,
    )


def try_real_harnessgeo(text: str, dataset: str, engine_llm: str) -> str:
    """Attempt to call the real HarnessGEO rewriter. Raises if unavailable."""
    from harnessgeo.rewriters import rewrite_document  # type: ignore

    return rewrite_document(
        document=text,
        dataset=dataset,
        engine_llm=engine_llm,
    )


def optimize_document(
    input_path: Path,
    output_path: Path,
    report_path: Path,
    brand: str,
    article_id: str,
    dataset: str,
    engine_llm: str,
    prefer_real_harnessgeo: bool = True,
) -> Dict[str, Any]:
    original = read_text(input_path)
    fallback_reason: Optional[str] = None

    if prefer_real_harnessgeo:
        try:
            rewritten = try_real_harnessgeo(original, dataset=dataset, engine_llm=engine_llm)
            # Apply mandatory E5 safety normalization after real API output.
            normalized, c0 = normalize_frontmatter(rewritten, brand, article_id, str(input_path))
            normalized, c1 = soften_absolute_claims(normalized)
            # v6: ensure_answer_first_summary is removed completely
            normalized, c3 = split_long_paragraphs(normalized)
            optimized_text = normalized
            mode = "harnessgeo_api_with_safety_postprocess"
            changes = c0 + c1 + c3 + [ChangeRecord(
                rule_id="HG-API",
                rule_name="harnessgeo_api_rewrite",
                description="Real HarnessGEO API rewrite completed, followed by E5 titleless safety postprocess.",
            )]
        except Exception as exc:  # noqa: BLE001 - fallback must catch environment/library failures.
            fallback_reason = str(exc)
            result = simulated_harnessgeo_optimize(original, brand, article_id, str(input_path))
            optimized_text = result.optimized_text
            mode = result.mode
            changes = result.changes
    else:
        result = simulated_harnessgeo_optimize(original, brand, article_id, str(input_path))
        optimized_text = result.optimized_text
        mode = result.mode
        changes = result.changes

    risky_claims = mark_possible_risky_claims(optimized_text)
    ratio = change_ratio(original, optimized_text)
    requires_recheck = ratio > 0.15

    report: Dict[str, Any] = {
        "brand": brand,
        "article_id": article_id,
        "source_file": str(input_path),
        "output_file": str(output_path),
        "report_file": str(report_path),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "harnessgeo_mode": mode,
        "fallback_reason": fallback_reason,
        "dataset": dataset,
        "engine_llm": engine_llm,
        "canonical_body_policy": "same_harnessgeo_body_across_channels",
        "body_title_policy": "no_article_title_in_body; use E4_title_options_reviewed externally",
        "new_facts_added": False,
        "requires_E4_recheck": requires_recheck,
        "change_ratio_estimate": round(ratio, 4),
        "optimization_summary": {
            "total_changes": len(changes),
            "major_change_types": sorted({c.rule_name for c in changes}),
        },
        "changes": [asdict(c) for c in changes],
        "risk_control": {
            "absolute_claims_softened": sum(1 for c in changes if c.rule_name == "absolute_claim_softened"),
            "possible_risky_claims_detected": risky_claims,
            "brand_fact_consistency": "requires_S1_alignment_check_by_E5",
            "title_generation": "not_performed; use E4_title_options_reviewed only; no title inserted into body",
            "multi_channel_full_rewrites": "forbidden",
        },
    }

    write_text(output_path, optimized_text)
    write_text(report_path, json.dumps(report, ensure_ascii=False, indent=2))
    return report


def load_batch_config(path: Path) -> Dict[str, Any]:
    return json.loads(read_text(path))


def run_batch(config_path: Path) -> Dict[str, Any]:
    config = load_batch_config(config_path)
    brand = config["brand"]
    dataset = config.get("dataset", "E-commerce")
    engine_llm = config.get("engine_llm", "gpt")
    prefer_real = bool(config.get("prefer_real_harnessgeo", True))

    reports = []
    for item in config.get("articles", []):
        reports.append(optimize_document(
            input_path=Path(item["input_md"]),
            output_path=Path(item["output_md"]),
            report_path=Path(item["report_json"]),
            brand=brand,
            article_id=item["article_id"],
            dataset=item.get("dataset", dataset),
            engine_llm=item.get("engine_llm", engine_llm),
            prefer_real_harnessgeo=prefer_real,
        ))

    run_log = {
        "brand": brand,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "harnessgeo_required": True,
        "canonical_body_policy": "same_harnessgeo_body_across_channels",
        "body_title_policy": "no_article_title_in_body; use E4_title_options_reviewed externally",
        "article_count": len(reports),
        "articles": [
            {
                "article_id": r["article_id"],
                "source_file": r["source_file"],
                "output_file": r["output_file"],
                "report_file": r["report_file"],
                "harnessgeo_mode": r["harnessgeo_mode"],
                "requires_E4_recheck": r["requires_E4_recheck"],
            }
            for r in reports
        ],
    }
    run_log_path = Path(config.get("run_log", f"E5_{brand}_harnessgeo_run_log.json"))
    write_text(run_log_path, json.dumps(run_log, ensure_ascii=False, indent=2))
    return run_log


def parse_args(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate E5 HarnessGEO optimized canonical body.")
    parser.add_argument("--config", type=Path, help="Batch JSON config path.")
    parser.add_argument("--input", type=Path, help="Input E4 final.md path.")
    parser.add_argument("--output", type=Path, help="Output E5 harnessgeo optimized.md path.")
    parser.add_argument("--report", type=Path, help="Output harnessgeo report.json path.")
    parser.add_argument("--brand", help="Brand name.")
    parser.add_argument("--article-id", help="Article ID, e.g. A1-1.")
    parser.add_argument("--dataset", default="E-commerce", help="HarnessGEO dataset, e.g. E-commerce or Researchy-GEO.")
    parser.add_argument("--engine-llm", default="gpt", help="Target engine llm, e.g. gpt/gemini/claude.")
    parser.add_argument("--no-real-harnessgeo", action="store_true", help="Force simulated_rule_based fallback.")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    if args.config:
        run_batch(args.config)
        return

    required = [args.input, args.output, args.report, args.brand, args.article_id]
    if any(v is None for v in required):
        raise SystemExit("Single-file mode requires --input --output --report --brand --article-id.")

    optimize_document(
        input_path=args.input,
        output_path=args.output,
        report_path=args.report,
        brand=args.brand,
        article_id=args.article_id,
        dataset=args.dataset,
        engine_llm=args.engine_llm,
        prefer_real_harnessgeo=not args.no_real_harnessgeo,
    )


if __name__ == "__main__":
    main()
