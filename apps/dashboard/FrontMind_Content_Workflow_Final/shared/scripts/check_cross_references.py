#!/usr/bin/env python3
"""Check local Markdown links and external JSON $ref targets without modifying files."""

from __future__ import annotations

import argparse
import glob
import json
import re
from pathlib import Path
from typing import Any


MARKDOWN_LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
BACKTICK = re.compile(r"`([^`\n]+)`")
PATH_PREFIXES = ("./", "../", "scripts/", "references/", "templates/", "shared/")


def is_ignored(path: Path) -> bool:
    return (
        any(part.startswith("legacy-") or ".legacy-" in part for part in path.parts)
        or path.name.startswith("legacy_")
        or path.name == ".DS_Store"
        or "__pycache__" in path.parts
    )


def normalize_link(raw: str) -> str:
    value = raw.strip().strip("<>").split("#", 1)[0]
    if re.search(r":\d+$", value):
        value = value.rsplit(":", 1)[0]
    return value


def markdown_issues(path: Path, root: Path) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    text = path.read_text(encoding="utf-8")
    for match in MARKDOWN_LINK.finditer(text):
        raw = match.group(1)
        if raw.startswith(("http://", "https://", "mailto:", "#")):
            continue
        value = normalize_link(raw)
        if not value or "{" in value or "}" in value:
            continue
        target = Path(value) if Path(value).is_absolute() else path.parent / value
        if not target.exists():
            issues.append({"file": str(path), "reference": raw, "resolved": str(target.resolve())})
    # Skills commonly cite executable assets in backticks rather than Markdown
    # links.  Validate only unambiguous relative project paths so runtime
    # output examples (for example ``delivery/final.html``) are not mistaken
    # for repository dependencies.
    for match in BACKTICK.finditer(text):
        raw = match.group(1).strip()
        if (
            not raw.startswith(PATH_PREFIXES)
            or any(character.isspace() for character in raw)
            or "{" in raw or "}" in raw or "..." in raw
            or raw.startswith(("http://", "https://"))
        ):
            continue
        value = normalize_link(raw)
        if value.startswith(("./", "../")):
            candidates = [path.parent / value]
        else:
            candidates = [path.parent / value]
            for ancestor in path.parents:
                try:
                    ancestor.relative_to(root)
                except ValueError:
                    continue
                candidates.append(ancestor / value)
        if any(character in value for character in "*?["):
            exists = any(glob.glob(str(candidate)) for candidate in candidates)
        else:
            exists = any(candidate.exists() for candidate in candidates)
        if not exists:
            issues.append({"file": str(path), "reference": raw, "resolved": str(candidates[0].resolve())})
    return issues


def walk_json_refs(value: Any) -> list[str]:
    refs: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "$ref" and isinstance(child, str):
                refs.append(child)
            else:
                refs.extend(walk_json_refs(child))
    elif isinstance(value, list):
        for child in value:
            refs.extend(walk_json_refs(child))
    return refs


def json_ref_issues(path: Path) -> list[dict[str, str]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    issues: list[dict[str, str]] = []
    for raw in walk_json_refs(data):
        if raw.startswith(("#", "http://", "https://")):
            continue
        value = raw.split("#", 1)[0]
        target = path.parent / value
        if not target.exists():
            issues.append({"file": str(path), "reference": raw, "resolved": str(target.resolve())})
    return issues


def check(root: Path) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    checked = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file() or is_ignored(path):
            continue
        if path.suffix.lower() in {".md", ".markdown"} or path.name == "SKILL.md":
            checked += 1
            issues.extend(markdown_issues(path, root))
        elif path.suffix.lower() == ".json":
            checked += 1
            issues.extend(json_ref_issues(path))
    return {"status": "pass" if not issues else "fail", "root": str(root), "checked_files": checked, "issues": issues}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=str(Path(__file__).resolve().parents[2]))
    args = parser.parse_args()
    report = check(Path(args.root).resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
