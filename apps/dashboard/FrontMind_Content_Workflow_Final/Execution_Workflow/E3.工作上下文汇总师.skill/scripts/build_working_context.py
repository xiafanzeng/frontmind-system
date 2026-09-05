#!/usr/bin/env python3
"""FrontMind E3 v2.3: build the complete editorial working context."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import tempfile
import sys
import unicodedata
import warnings
import zipfile
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from schema_validation import validate_root  # noqa: E402


TEXT_SUFFIXES = {".md", ".txt", ".csv", ".html", ".htm"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
EXCLUDED_MARKERS = {
    "内部", "保密", "机密", "confidential", "internal only", "不得公开", "隐私",
    "患者姓名", "身份证", "手机号", "病历号",
}
QUALIFIED_MARKERS = {
    "手术操作", "处方", "剂量", "治疗方案", "诊断结论", "疗效", "治愈", "保证效果",
}


def normal(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", str(value or ""))).strip()


def question_key(value: Any) -> str:
    """Match an approved question after spelling and punctuation normalization only."""
    return re.sub(r"[^0-9a-z\u3400-\u9fff]+", "", unicodedata.normalize("NFKC", normal(value)).casefold())


def identifier(prefix: str, value: Any, fallback: str) -> str:
    raw = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().casefold()
    slug = re.sub(r"[^a-z0-9]+", "_", raw).strip("_")[:80] or fallback
    if len(slug) < 3:
        slug = re.sub(r"[^a-z0-9]+", "_", fallback.casefold()).strip("_")[:80] or f"item_{slug}"
    if not slug[0].isalnum():
        slug = f"x_{slug}"
    return f"{prefix}_{slug}"


def load_object(path: Path | None) -> dict[str, Any]:
    if path is None or not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


class TextHTML(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() in {"script", "style", "noscript", "svg", "canvas"}:
            self.hidden += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() in {"script", "style", "noscript", "svg", "canvas"} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data: str) -> None:
        if not self.hidden and normal(data):
            self.parts.append(normal(data))


def read_text(path: Path) -> str:
    suffix = path.suffix.casefold()
    if suffix in {".md", ".txt", ".csv"}:
        return path.read_text(encoding="utf-8", errors="replace")[:2_000_000]
    if suffix in {".html", ".htm"}:
        parser = TextHTML()
        parser.feed(path.read_text(encoding="utf-8", errors="replace")[:4_000_000])
        return "\n".join(parser.parts)[:2_000_000]
    if suffix == ".docx":
        with zipfile.ZipFile(path) as archive:
            raw = archive.read("word/document.xml").decode("utf-8", errors="replace")
        return normal(re.sub(r"<[^>]+>", " ", raw))[:2_000_000]
    if suffix == ".pptx":
        chunks: list[str] = []
        with zipfile.ZipFile(path) as archive:
            for name in sorted(item for item in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", item)):
                chunks.append(normal(re.sub(r"<[^>]+>", " ", archive.read(name).decode("utf-8", errors="replace"))))
        return "\n".join(chunks)[:2_000_000]
    if suffix == ".xlsx":
        try:
            from openpyxl import load_workbook
        except ImportError:
            return ""
        workbook = load_workbook(path, read_only=True, data_only=True)
        chunks: list[str] = []
        try:
            for sheet in workbook.worksheets[:30]:
                chunks.append(sheet.title)
                for row in sheet.iter_rows(values_only=True):
                    text = " | ".join(normal(value) for value in row if normal(value))
                    if text:
                        chunks.append(text[:2000])
                    if sum(len(item) for item in chunks) > 2_000_000:
                        break
        finally:
            workbook.close()
        return "\n".join(chunks)[:2_000_000]
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            return ""
        reader = PdfReader(path)
        return "\n".join((page.extract_text() or "") for page in reader.pages[:200])[:2_000_000]
    return ""


def iter_json(path: Path) -> Iterable[tuple[Path, dict[str, Any]]]:
    if path.is_file() and path.suffix.casefold() == ".json":
        value = load_object(path)
        if value:
            yield path, value
    elif path.is_dir():
        for item in path.rglob("*.json"):
            if item.is_file() and not item.is_symlink():
                value = load_object(item)
                if value:
                    yield item, value


def safe_extract_zip(path: Path, destination: Path) -> list[str]:
    """Extract regular ZIP members without letting one unsafe member poison the Pack.

    The first normalized member wins.  Traversal paths, symbolic links and
    duplicate aliases are skipped, while an otherwise readable Pack remains
    available to the content-first workflow.
    """
    skipped: list[str] = []
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) > 20_000:
            raise ValueError("unsafe_input: ZIP contains too many entries")
        total = 0
        seen: set[str] = set()
        for item in archive.infolist():
            member = PurePosixPath(item.filename.replace("\\", "/"))
            member_key = member.as_posix().casefold()
            if not member.parts or member.is_absolute() or ".." in member.parts:
                skipped.append("skipped unsafe ZIP path")
                continue
            mode = (item.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                skipped.append("skipped ZIP symbolic link")
                continue
            if member_key in seen:
                skipped.append("skipped duplicate ZIP member")
                continue
            seen.add(member_key)
            total += item.file_size
        if total > 4 * 1024 * 1024 * 1024:
            raise ValueError("unsafe_input: ZIP expands beyond 4 GiB")
        seen.clear()
        destination_root = destination.resolve()
        for item in archive.infolist():
            member = PurePosixPath(item.filename.replace("\\", "/"))
            member_key = member.as_posix().casefold()
            mode = (item.external_attr >> 16) & 0o170000
            if (
                not member.parts or member.is_absolute() or ".." in member.parts
                or mode == 0o120000 or member_key in seen
            ):
                continue
            seen.add(member_key)
            target = destination.joinpath(*member.parts)
            resolved_target = target.resolve()
            if resolved_target != destination_root and destination_root not in resolved_target.parents:
                skipped.append("skipped ZIP member outside extraction root")
                continue
            if item.is_dir():
                try:
                    target.mkdir(parents=True, exist_ok=True)
                except OSError:
                    skipped.append("skipped conflicting ZIP directory member")
                continue
            temporary: str | None = None
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                descriptor, temporary = tempfile.mkstemp(prefix=".frontmind-zip-", dir=target.parent)
                with os.fdopen(descriptor, "wb") as output, archive.open(item) as source:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                os.replace(temporary, target)
                temporary = None
            except (OSError, RuntimeError, zipfile.BadZipFile):
                skipped.append("skipped unreadable or conflicting ZIP member")
            finally:
                if temporary is not None:
                    try:
                        os.unlink(temporary)
                    except FileNotFoundError:
                        pass
    return list(dict.fromkeys(skipped))


def status_for(text: str, explicit: Any = None) -> tuple[str, str | None]:
    sample = normal(text).casefold()
    explicit_value = normal(explicit).casefold()
    if explicit_value in {"excluded", "prohibited", "internal_only", "not_authorized", "denied"}:
        return "excluded", "资料明确标为内部、禁止或未授权公开"
    if any(marker.casefold() in sample for marker in EXCLUDED_MARKERS):
        return "excluded", "资料包含明确内部、保密或个人隐私标记"
    if any(marker.casefold() in sample for marker in QUALIFIED_MARKERS):
        return "qualified", "仅陈述资料中明确的服务或专业范围；个人适用性、具体方案与效果需由合格专业人员结合实际情况判断"
    if explicit_value in {"qualified", "public_with_qualification", "verified_with_limits", "limited_evidence"}:
        return "qualified", "使用时必须保留资料原有范围、时间与条件限定"
    return "usable", None


def discover_brand(documents: list[dict[str, Any]], fallback: str | None) -> tuple[str | None, list[str]]:
    aliases: list[str] = []
    for document in documents:
        company = document.get("company")
        if isinstance(company, dict):
            name = normal(company.get("name") or company.get("canonical_name"))
            if name:
                aliases.extend(normal(item) for item in company.get("aliases", []) if normal(item))
                return name, list(dict.fromkeys(aliases))
        brand = document.get("brand")
        if isinstance(brand, dict):
            name = normal(brand.get("canonical_name") or brand.get("name"))
            if name:
                aliases.extend(normal(item) for item in brand.get("aliases", []) if normal(item))
                return name, list(dict.fromkeys(aliases))
        identity = document.get("brand_identity")
        if isinstance(identity, dict):
            name = normal(identity.get("canonical_name") or identity.get("name"))
            if name:
                aliases.extend(normal(item) for item in identity.get("aliases", []) if normal(item))
                return name, list(dict.fromkeys(aliases))
        name = normal(document.get("brand_name") or document.get("canonical_brand"))
        if name:
            return name, []
    return normal(fallback) or None, []


def registry_records(documents: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for document in documents:
        value = document.get(key)
        if isinstance(value, list):
            result.extend(item for item in value if isinstance(item, dict))
    return result


def merged_image_records(
    documents: list[dict[str, Any]], document_asset_roots: dict[int, Path],
) -> list[dict[str, Any]]:
    """Merge the S2 image Registry with S6's curated asset pool.

    A Pack can contain both views of the same asset.  The Registry normally
    carries the rights attribution while S6 carries the final allowed roles;
    neither view should overwrite a non-empty field from the other.
    """
    merged: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for document in documents:
        for field_name in ("images", "asset_pool"):
            values = document.get(field_name)
            if not isinstance(values, list):
                continue
            for index, record in enumerate(values, 1):
                if not isinstance(record, dict) or not normal(record.get("file_path")):
                    continue
                raw_id = normal(record.get("asset_id") or record.get("image_id"))
                key_name = raw_id or f"file:{normal(record.get('file_path'))}"
                if key_name not in merged:
                    merged[key_name] = dict(record)
                    merged[key_name]["_asset_roots"] = [document_asset_roots[id(document)]]
                    order.append(key_name)
                    continue
                target = merged[key_name]
                source_root = document_asset_roots[id(document)]
                roots = target.get("_asset_roots") if isinstance(target.get("_asset_roots"), list) else []
                if source_root not in roots:
                    roots.append(source_root)
                target["_asset_roots"] = roots
                for key_name_field, value in record.items():
                    if key_name_field in {"allowed_roles", "usable_for"}:
                        existing = target.get(key_name_field) if isinstance(target.get(key_name_field), list) else []
                        incoming = value if isinstance(value, list) else []
                        target[key_name_field] = list(dict.fromkeys([*existing, *incoming]))
                    elif target.get(key_name_field) in (None, "", []):
                        target[key_name_field] = value
    return [merged[item] for item in order]


def document_asset_root(origin: Path, input_root: Path, pack_roots: list[Path]) -> Path:
    """Return the nearest Reference Pack root that owns one JSON document."""
    owners: list[Path] = []
    resolved_origin = origin.resolve()
    for candidate in pack_roots:
        resolved = candidate.resolve()
        if resolved_origin == resolved or resolved in resolved_origin.parents:
            owners.append(resolved)
    if owners:
        return max(owners, key=lambda item: len(item.parts))
    return input_root.resolve() if input_root.is_dir() else input_root.resolve().parent


def safe_visual_source(base: Path, raw_path: Any) -> tuple[Path | None, str | None]:
    value = normal(raw_path)
    if not value or "\\" in value:
        return None, "visual path is empty or uses an unsafe separator"
    relative = PurePosixPath(value)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        return None, "visual path is not a safe Pack-relative path"
    base_resolved = base.resolve()
    candidate = base.joinpath(*relative.parts)
    current = base
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return None, "visual path contains a symbolic link"
    try:
        resolved = candidate.resolve(strict=True)
    except (OSError, RuntimeError):
        return None, "visual file is missing or unreadable"
    if base_resolved not in resolved.parents or not resolved.is_file():
        return None, "visual path escapes the Pack or is not a regular file"
    return resolved, None


def verify_visual_file(path: Path) -> tuple[bool, str | None]:
    """Verify that E7/Pillow can really decode the visual after E3 exits."""
    if path.suffix.casefold() not in IMAGE_SUFFIXES - {".svg"}:
        return False, "visual format is not supported by the active renderer"
    try:
        from PIL import Image
        from PIL.Image import DecompressionBombWarning
    except Exception:
        return False, "Pillow is unavailable, so Pack visuals cannot be verified"
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", DecompressionBombWarning)
            with Image.open(path) as image:
                image.verify()
            with Image.open(path) as image:
                width, height = image.size
                if width < 1 or height < 1 or width * height > 100_000_000:
                    return False, "visual dimensions are invalid or excessive"
                image.load()
    except Exception:
        return False, "visual file cannot be decoded safely"
    return True, None


def materialize_visuals(
    records: list[dict[str, Any]], job_root: Path,
) -> tuple[list[dict[str, Any]], dict[str, list[str]], list[str]]:
    """Copy only publishable, decodable Pack visuals into the stable job tree."""
    warnings_out: list[str] = []
    materialized: list[dict[str, Any]] = []
    role_overrides: dict[str, list[str]] = {}
    controlled_parent = job_root / "00_input"
    controlled_root = controlled_parent / "reference_assets"
    if controlled_parent.is_symlink() or controlled_root.is_symlink():
        return [], {}, ["reference asset directory is a symbolic link; Pack visuals were skipped"]
    try:
        controlled_root.mkdir(parents=True, exist_ok=True)
        if job_root not in controlled_root.resolve().parents:
            return [], {}, ["reference asset directory escapes the job root; Pack visuals were skipped"]
    except OSError:
        return [], {}, ["reference asset directory could not be created; Pack visuals were skipped"]

    used_targets: set[str] = set()
    used_ids: set[str] = set()
    for index, record in enumerate(records, 1):
        raw_id = normal(record.get("asset_id") or record.get("image_id"))
        identity_seed = raw_id or normal(record.get("file_path"))
        image_id = raw_id if raw_id.startswith("img_") else identifier("img", identity_seed, f"registry_{index:03d}")
        if image_id in used_ids:
            warnings_out.append("duplicate visual identity was skipped")
            continue
        rights = normal(record.get("rights_status")).casefold()
        rights = rights if rights in {"approved", "approved_with_credit", "unknown", "prohibited"} else "unknown"
        credit = normal(record.get("attribution_text") or record.get("credit") or record.get("credit_line")) or None
        explicit_usage = normal(record.get("usage_status")).casefold()
        if (
            rights not in {"approved", "approved_with_credit"}
            or explicit_usage in {"excluded", "prohibited", "internal_only", "not_authorized", "denied"}
            or (rights == "approved_with_credit" and not credit)
        ):
            warnings_out.append("an unavailable or unlicensed Pack visual was skipped")
            continue

        source: Path | None = None
        source_reason: str | None = None
        roots = record.get("_asset_roots") if isinstance(record.get("_asset_roots"), list) else []
        for root in roots:
            if not isinstance(root, Path):
                continue
            source, source_reason = safe_visual_source(root, record.get("file_path"))
            if source is not None:
                break
        if source is None:
            warnings_out.append(source_reason or "Pack visual could not be resolved")
            continue
        verified, reason = verify_visual_file(source)
        if not verified:
            warnings_out.append(reason or "Pack visual could not be verified")
            continue

        safe_stem = re.sub(r"[^0-9A-Za-z_-]+", "_", image_id).strip("_") or f"img_{index:03d}"
        suffix = source.suffix.casefold()
        target_name = f"{safe_stem}{suffix}"
        collision = 2
        while target_name.casefold() in used_targets:
            target_name = f"{safe_stem}_{collision}{suffix}"
            collision += 1
        used_targets.add(target_name.casefold())
        target = controlled_root / target_name
        descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=controlled_root)
        os.close(descriptor)
        try:
            shutil.copyfile(source, temporary)
            os.replace(temporary, target)
        except OSError:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            warnings_out.append("Pack visual could not be copied into the job")
            continue

        used_ids.add(image_id)
        roles = record.get("allowed_roles") or record.get("usable_for") or []
        role_overrides[image_id] = list(dict.fromkeys(
            normal(role) for role in roles
            if normal(role) in {"brand_editorial", "navigate", "explain", "prove"}
        ))
        materialized.append({
            "image_id": image_id,
            "file_path": target.relative_to(job_root).as_posix(),
            "asset_kind": normal(record.get("asset_kind")) or "reference_image",
            "usage_status": "usable",
            "rights_status": rights,
            "credit": credit,
            "notes": normal(record.get("caption") or record.get("notes")) or None,
        })
    return materialized, role_overrides, list(dict.fromkeys(warnings_out))


def fact_candidates(text: str) -> list[str]:
    lines = []
    for item in re.split(r"[\n\r]+|(?<=[。！？.!?])\s+", text):
        clean = normal(re.sub(r"^[#*\-\d.、\s]+", "", item))
        if 15 <= len(clean) <= 600 and not clean.endswith(("目录", "contents")):
            lines.append(clean)
    return list(dict.fromkeys(lines))


def source_kind(record: dict[str, Any], default: str = "user_upload") -> str:
    raw = normal(record.get("source_kind") or record.get("source_type") or record.get("source_origin_class")).casefold()
    if raw in {"third_party_public", "editorial_media", "primary_data_research", "regulation_standard"}:
        return "third_party_public"
    if raw in {"monitoring"}:
        return "monitoring"
    if raw in {"runtime_approved", "runtime_research"}:
        return "runtime_research"
    if raw in {"first_party_official", "first_party_public"}:
        return "first_party_public"
    return default


def public_url(value: Any) -> str | None:
    raw = normal(value)
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return None
    return raw if parsed.scheme.casefold() in {"http", "https"} and parsed.netloc else None


def ingest_supplemental_research(
    path: Path | None,
    sources: list[dict[str, Any]],
    source_ids: set[str],
    facts: list[dict[str, Any]],
    fact_ids: set[str],
) -> set[str]:
    """Add explicitly sourced public competitor facts without an audit ledger.

    Accepted input is a compact JSON object with optional ``sources`` and
    ``facts`` (``candidate_facts`` is an alias).  A fact is admitted only when
    it names at least one entity and points to a public HTTP(S) source, either
    through ``source_ids`` or inline ``source_url``.  Monitoring mentions alone
    therefore remain discovery signals and can never satisfy P02 readiness.
    """
    if path is None:
        return set()
    if path.is_symlink() or not path.is_file() or path.suffix.casefold() != ".json":
        raise ValueError("supplemental_research_invalid: expected a regular JSON file")
    document = load_object(path)
    source_aliases: dict[str, str] = {}
    url_to_id = {
        normal(item.get("url")): str(item.get("source_id"))
        for item in sources if public_url(item.get("url")) and item.get("usage_status") != "excluded"
    }
    for index, record in enumerate(document.get("sources", []), 1):
        if not isinstance(record, dict):
            continue
        url = public_url(record.get("url"))
        if not url:
            continue
        supplied = normal(record.get("source_id"))
        source_id = supplied if re.fullmatch(r"src_[a-z0-9][a-z0-9_-]{1,100}", supplied) else identifier(
            "src", f"supplemental_{index}_{url}", f"supplemental_{index:03d}"
        )
        source_aliases[supplied or str(index)] = source_id
        if url in url_to_id:
            source_aliases[supplied or str(index)] = url_to_id[url]
            continue
        while source_id in source_ids:
            source_id = f"{source_id}_{index}"
        source_ids.add(source_id)
        url_to_id[url] = source_id
        source_aliases[supplied or str(index)] = source_id
        sources.append({
            "source_id": source_id,
            "title": normal(record.get("title") or record.get("publisher")) or urlsplit(url).hostname or "公开资料",
            "source_kind": "third_party_public" if normal(record.get("source_kind")) == "third_party_public" else "runtime_research",
            "url": url,
            "file_path": None,
            "usage_status": "qualified" if normal(record.get("usage_status")) == "qualified" else "usable",
            "qualification": normal(record.get("qualification")) or None,
        })

    general_facts = [item for item in document.get("facts", []) if isinstance(item, dict)]
    candidate_facts = [item for item in document.get("candidate_facts", []) if isinstance(item, dict)]
    candidate_entities: set[str] = set()
    tagged_facts = [(item, bool(item.get("candidate"))) for item in general_facts]
    tagged_facts.extend((item, True) for item in candidate_facts)
    for index, (record, candidate_record) in enumerate(tagged_facts, 1):
        statement = normal(record.get("statement") or record.get("fact") or record.get("text"))
        entities = [normal(item) for item in record.get("about_entities", []) if normal(item)]
        if not entities and normal(record.get("about_entity")):
            entities = [normal(record.get("about_entity"))]
        if not statement or not entities:
            continue
        if candidate_record:
            candidate_entities.update(entities)
        bound_sources = [
            source_aliases.get(normal(item), normal(item)) for item in record.get("source_ids", [])
            if source_aliases.get(normal(item), normal(item)) in source_ids
        ]
        inline_url = public_url(record.get("source_url"))
        if inline_url:
            source_id = url_to_id.get(inline_url)
            if source_id is None:
                source_id = identifier("src", f"supplemental_fact_{index}_{inline_url}", f"supplemental_fact_{index:03d}")
                while source_id in source_ids:
                    source_id = f"{source_id}_{index}"
                source_ids.add(source_id)
                url_to_id[inline_url] = source_id
                sources.append({
                    "source_id": source_id,
                    "title": normal(record.get("source_title") or record.get("publisher")) or urlsplit(inline_url).hostname or "公开资料",
                    "source_kind": "third_party_public" if normal(record.get("source_kind")) == "third_party_public" else "runtime_research",
                    "url": inline_url,
                    "file_path": None,
                    "usage_status": "qualified" if normal(record.get("usage_status")) == "qualified" else "usable",
                    "qualification": normal(record.get("qualification")) or None,
                })
            bound_sources.append(source_id)
        bound_sources = list(dict.fromkeys(bound_sources))
        if not bound_sources:
            continue
        supplied_id = normal(record.get("fact_id"))
        fact_id = supplied_id if re.fullmatch(r"(?:fact|clm)_[a-z0-9][a-z0-9_-]{2,100}", supplied_id) else identifier(
            "fact", f"supplemental_{index}_{'_'.join(entities)}", f"supplemental_{index:03d}"
        )
        while fact_id in fact_ids:
            fact_id = f"{fact_id}_{index}"
        fact_ids.add(fact_id)
        facts.append({
            "fact_id": fact_id,
            "statement": statement,
            "about_entities": list(dict.fromkeys(entities)),
            "source_ids": bound_sources,
            "usage_status": "qualified" if normal(record.get("usage_status")) == "qualified" else "usable",
            "qualification": normal(record.get("qualification")) or None,
        })
    return candidate_entities


def scope_context(scope: dict[str, Any], question: str) -> dict[str, Any]:
    geography = scope.get("geographic_scope") if isinstance(scope.get("geographic_scope"), dict) else {}
    decision = scope.get("decision_context") if isinstance(scope.get("decision_context"), dict) else {}
    time_basis = scope.get("time_basis") if isinstance(scope.get("time_basis"), dict) else {}
    inference = scope.get("inference_basis") if isinstance(scope.get("inference_basis"), dict) else {}
    role_text = "、".join(str(item) for item in decision.get("roles", []) if str(item).strip())
    problem = normal(decision.get("problem")) or question
    criteria = "、".join(str(item) for item in decision.get("decision_criteria", []) if str(item).strip())
    decision_text = "；".join(item for item in (role_text, problem, criteria) if item) or question
    time_text = f"截至 {time_basis.get('as_of') or '当前可用资料'}，新鲜度：{time_basis.get('freshness_class') or 'moderate'}"
    return {
        "geographic_scope": geography.get("status") if geography.get("status") in {"specific", "global", "not_applicable"} else "not_applicable",
        "geographic_detail": geography.get("value"),
        "decision_context": decision_text,
        "time_basis": time_text,
        "inference_basis": [str(item) for item in inference.get("notes", []) if str(item).strip()] or ["由任务与可用资料自动推断"],
    }


def research_context(e2: dict[str, Any], foundation: bool) -> dict[str, Any]:
    if foundation:
        return {
            "status": "not_applicable", "recommended_pattern_id": "P14",
            "weighted_pattern_distribution": [], "notes": ["基础启动按固定 P14 预研模板继续"],
        }
    recommendation = e2.get("recommendation") if isinstance(e2.get("recommendation"), dict) else {}
    return {
        "status": "available" if recommendation.get("status") == "evidence_supported" else "partial",
        "recommended_pattern_id": recommendation.get("recommended_pattern_id"),
        "weighted_pattern_distribution": [
            item for item in recommendation.get("weighted_distribution", []) if isinstance(item, dict)
        ],
        "notes": [normal(item) for item in e2.get("warnings", []) if normal(item)]
        or [normal(recommendation.get("rationale")) or "E2 已完成"],
    }


PUBLIC_PHRASES = [
    "资料较完整", "相关资料显示", "以审核为准", "服务边界", "信息边界",
    "保持克制", "用户提交资料", "需要说明", "不构成对", "待核验候选",
    "当前团队与产品待核验", "当前可公开资料不足", "资料粒度不同",
]


def find_document(documents: list[dict[str, Any]], marker: str) -> dict[str, Any]:
    candidates = [item for item in documents if marker in item and item.get(marker) not in (None, "", [])]
    if not candidates:
        return {}
    expected_stage = "S5_article_voice_contract" if marker == "voice_mode" else "S4_information_evidence_architecture"
    return max(candidates, key=lambda item: (
        item.get("stage") == expected_stage,
        normal(item.get("schema_version")) == "2.3.0",
    ))


def voice_profile(documents: list[dict[str, Any]], entry: str) -> dict[str, Any]:
    """Project the active S5 contract into the compact E3 writing profile.

    The v2.3 producer writes ``voice_mode`` at the document root.  The older
    ``default_voice`` shape remains readable so existing v2.1/v2.2 Packs do
    not need to be rebuilt.
    """
    contract = find_document(documents, "voice_mode") or find_document(documents, "default_voice")
    default = contract.get("default_voice") if isinstance(contract.get("default_voice"), dict) else {}
    style = contract.get("style") if isinstance(contract.get("style"), dict) else {}
    publication = contract.get("publication_language") if isinstance(contract.get("publication_language"), dict) else {}
    preferred = [
        "首段直接回答问题",
        "以第三方编辑视角组织事实与选择建议",
        "用事实—能力意义—适合情境呈现客户品牌",
        "把时间、地区、版本和适用条件自然写入原句",
    ]
    for item in default.get("observable_rules", []):
        rule = normal(item.get("rule")) if isinstance(item, dict) else normal(item)
        if rule and not any(token in rule.casefold() for token in ("claim", "proof", "审批", "哈希", "绑定")):
            preferred.append(rule)
    preferred.extend(normal(item) for item in contract.get("reader_experience", []) if normal(item))
    preferred.extend(normal(item) for item in style.values() if normal(item))
    preferred.extend(normal(item) for item in publication.values() if normal(item))
    preferred.extend(
        normal(item.get("tone_adjustment")) for item in contract.get("entry_overrides", [])
        if isinstance(item, dict) and item.get("entry_category") == entry and normal(item.get("tone_adjustment"))
    )
    avoided = [
        normal(item.get("term")) for item in (contract.get("terminology") or {}).get("avoid_terms", [])
        if isinstance(item, dict) and normal(item.get("term"))
    ]
    avoided.extend(normal(item) for item in contract.get("forbidden_public_phrases", []) if normal(item))
    default_summary = "第三方客观报道＋企业品牌宣传稿，既有编辑信息密度，也清楚展示品牌定位、能力和适用需求。"
    return {
        "style_summary": "；".join(item for item in (
            normal(style.get("tone")), normal(style.get("sentence_rhythm")), normal(style.get("brand_expression"))
        ) if item) or default_summary,
        "editorial_stance": normal(contract.get("editorial_position"))
        or "直接呈现已知事实、判断标准和条件式建议，不向读者展示资料审阅过程。",
        # S5 may contain several long brand-message examples.  They belong in
        # Fact Cards and the question-selected priority angle, not in the
        # stylistic instruction itself; concatenating them here caused the
        # writer to echo an internal evidence digest.  Keep this field as a
        # compact editorial direction while the actual claims travel through
        # their dedicated, source-bound channels.
        "brand_promotion_mode": (
            "客户品牌自然首位并获得更完整的事实型特写；用定位、服务、团队和流程事实解释适合情境，不制造名次或空泛优势。"
            if entry == "industry_ranking"
            else "用可支持的定位、能力和服务事实自然解释品牌价值，不使用空泛形容词。"
        ),
        "preferred_moves": list(dict.fromkeys(preferred)),
        "forbidden_public_phrases": list(dict.fromkeys([*PUBLIC_PHRASES, *avoided])),
    }


def choose_priority_angle(
    documents: list[dict[str, Any]], entry: str, suggested_pattern: str | None,
    fact_ids: set[str], brand_name: str, facts: list[dict[str, Any]], question: str,
) -> dict[str, Any] | None:
    architecture = find_document(documents, "brand_priority_angles")
    proof_by_id = {
        str(item.get("proof_id")): item for item in architecture.get("proof_bundles", []) if isinstance(item, dict)
    }
    fact_by_id = {str(item.get("fact_id")): item for item in facts if isinstance(item, dict)}
    question_text = normal(question).casefold()
    query_terms: dict[str, int] = {}
    for length in (2, 3, 4):
        for index in range(max(0, len(question_text) - length + 1)):
            token = question_text[index:index + length]
            if re.fullmatch(r"[\u3400-\u9fff]+", token):
                query_terms[token] = max(query_terms.get(token, 0), 1)
    semantic_expansions = {
        "玻尿酸": {"玻尿酸": 8, "注射": 6, "填充": 6, "轻医美": 4, "面部年轻化": 3},
        "推荐": {"选择": 3, "适合": 3, "服务": 2, "能力": 2},
        "机构": {"机构": 3, "医院": 2, "中心": 2},
        "价格": {"价格": 6, "费用": 5, "收费": 4, "选型": 2},
        "怎么": {"流程": 4, "步骤": 4, "操作": 3},
        "风险": {"风险": 6, "限制": 4, "禁忌": 4, "安全": 3},
        "团队": {"团队": 6, "医师": 5, "医生": 5, "专家": 4},
    }
    for trigger, additions in semantic_expansions.items():
        if trigger in question_text:
            for token, weight in additions.items():
                query_terms[token] = max(query_terms.get(token, 0), weight)

    candidates: list[tuple[int, int, dict[str, Any]]] = []
    for item in architecture.get("brand_priority_angles", []):
        if not isinstance(item, dict):
            continue
        entries = item.get("eligible_entry_categories") or []
        patterns = item.get("eligible_pattern_ids") or []
        if entries and entry not in entries:
            continue
        if suggested_pattern and patterns and suggested_pattern not in patterns:
            continue
        raw_ids = list(item.get("claim_ids") or [])
        for proof_ref in item.get("proof_refs", []):
            raw_ids.extend((proof_by_id.get(str(proof_ref)) or {}).get("claim_ids") or [])
        supported = list(dict.fromkeys(str(value) for value in raw_ids if str(value) in fact_ids))
        message = normal(item.get("priority_message") or item.get("angle") or item.get("allowed_wording"))
        if not message:
            continue
        publication = architecture.get("publication_boundary") if isinstance(architecture.get("publication_boundary"), dict) else {}
        must_not_claim = [normal(value) for value in item.get("must_not_claim", []) if normal(value)]
        must_not_claim.extend(
            normal(value) for value in publication.get("first_party_cannot_alone_support", []) if normal(value)
        )
        result = {
            "angle_id": normal(item.get("angle_id")) or "angle_brand_priority",
            "angle": message,
            "allowed_wording": normal(item.get("allowed_wording")) or message,
            "fact_ids": supported,
            "eligible_pattern_ids": [str(value) for value in patterns if re.fullmatch(r"P(?:0[1-9]|1[0-6])", str(value))],
            "must_not_claim": list(dict.fromkeys(must_not_claim)),
        }
        evidence_text = " ".join(
            normal(fact_by_id.get(value, {}).get("statement")) for value in supported
        )
        haystack = f"{message} {evidence_text}".casefold()
        relevance = sum(weight for token, weight in query_terms.items() if token in haystack)
        candidates.append((relevance, len(supported), result))
    if candidates:
        return max(candidates, key=lambda value: (value[0], value[1]))[2]
    usable = [str(item["fact_id"]) for item in facts if item.get("usage_status") == "usable"][:4]
    if not usable:
        return None
    return {
        "angle_id": "angle_brand_factual_strength",
        "angle": f"{brand_name}的定位、核心能力与适用需求",
        "allowed_wording": f"从{brand_name}的定位、核心能力和匹配情境展开重点介绍。",
        "fact_ids": usable,
        "eligible_pattern_ids": [suggested_pattern] if suggested_pattern else [],
        "must_not_claim": ["不得由编辑顺序推出市场第一、最佳或优于竞品"],
    }


def benchmark_moves(e2: dict[str, Any]) -> list[dict[str, Any]]:
    pool = {int(item["raw_rank"]): item for item in e2.get("cited_content_pool", []) if isinstance(item, dict) and isinstance(item.get("raw_rank"), int)}
    values: list[dict[str, Any]] = []
    for observation in e2.get("content_observations", []):
        if not isinstance(observation, dict) or observation.get("status") != "classified_article":
            continue
        rank = int(observation["raw_rank"])
        source = pool.get(rank, {})
        structure = normal(observation.get("structure_summary")) or normal(observation.get("classification_rationale"))
        if not structure or not source.get("canonical_url"):
            continue
        # Signed Pattern Research observations append a reviewed semantic layer
        # after the page's raw heading trace.  The raw trace often contains
        # navigation chrome ("Secondary Menu", "Jump to", and similar labels),
        # which is useful for extraction diagnostics but must never become an
        # editorial move.  Prefer the reviewed layer and keep only the quoted,
        # transferable actions from it.
        benchmark_review = observation.get("benchmark_review")
        benchmark_id: str | None = None
        structure_observations: list[str] = []
        evidence_positions: list[str] = []
        selection_rationale: str | None = None
        if isinstance(benchmark_review, dict):
            benchmark_id = normal(benchmark_review.get("benchmark_id")) or None
            structure_observations = [
                normal(item) for item in benchmark_review.get("structure_observation", []) if normal(item)
            ]
            editorial_structure = "；".join(structure_observations) or structure
            subquestions = [
                normal(item) for item in benchmark_review.get("subquestions_observed", []) if normal(item)
            ][:10]
            selection_rationale = normal(benchmark_review.get("selection_rationale")) or None
            evidence_positions = [
                normal(item) for item in benchmark_review.get("evidence_positions_observed", []) if normal(item)
            ]
            # Selection rationale and reader questions have their own typed
            # fields.  Only actual structural/evidence moves are candidates
            # for section adoption.
            adoptable = [
                *[f"结构借鉴：{item}" for item in structure_observations],
                *[f"证据安排：{item}" for item in evidence_positions],
            ]
            adoptable = list(dict.fromkeys(adoptable))[:8]
        else:
            reviewed = ""
            for marker in ("｜预研结构观察：", "|预研结构观察："):
                if marker in structure:
                    reviewed = normal(structure.split(marker, 1)[1])
                    break
            editorial_structure = reviewed or structure
            components = [normal(item) for item in observation.get("matched_structure_component_ids", []) if normal(item)]
            reviewed_actions = [
                normal(item) for item in re.findall(r"“([^”]{4,120})”", reviewed)
                if normal(item) and not any(token in normal(item) for token in ("所有内容压进", "页面自身", "不进入客户文章"))
            ]
            if reviewed:
                subquestions = []
                adoptable = [f"借鉴结构动作：{item}" for item in reviewed_actions[:4]]
            else:
                blocked_navigation = {
                    "secondary menu", "main menu", "main menu mega", "jump to", "navigation menu",
                    "search", "search or browse", "helpful links", "related story", "permalink",
                }
                subquestions = [
                    normal(item) for item in re.split(r"\s*(?:→|>|\|)\s*", structure)
                    if 3 <= len(normal(item)) <= 100 and normal(item).casefold().rstrip(":") not in blocked_navigation
                ][:10]
                adoptable = [f"参考该标杆的“{item}”结构位置" for item in components[:6]]
                if subquestions:
                    adoptable.insert(0, f"吸收其章节推进：{' → '.join(subquestions[:6])}")
        if not adoptable:
            adoptable = ["参考该标杆的章节顺序与判断维度"]
        values.append({
            "rank": rank, "title": normal(source.get("content_title")) or f"引用文章 {rank}",
            "url": source["canonical_url"], "pattern_id": observation["primary_pattern_id"],
            "classification_confidence": float(observation.get("classification_confidence") or 0),
            "citation_count": int(source.get("citation_count") or 0),
            "benchmark_id": benchmark_id,
            "structure_summary": editorial_structure,
            "structure_observations": list(dict.fromkeys(structure_observations)),
            "subquestions": list(dict.fromkeys(subquestions)),
            "evidence_positions": list(dict.fromkeys(evidence_positions)),
            "selection_rationale": selection_rationale,
            "adoptable_moves": list(dict.fromkeys(adoptable)),
        })
    return values[:20]


def medical_safety(question: str) -> list[str]:
    if not any(token in question for token in ("医美", "玻尿酸", "注射", "整形", "医院", "医生", "病例", "治疗")):
        return []
    return [
        "医疗项目应由具备相应资质的医师在合规医疗机构实施。",
        "注射产品需要核对 NMPA 注册信息、实物包装、批次和有效期。",
        "具体产品、部位和用量需结合面诊评估，不把网页信息写成个人方案。",
        "安全部分集中说明血管栓塞、组织坏死、视力变化等严重风险与紧急就医信号，不在多节重复。",
        "医疗广告审查、医院背景或设备配置不能写成疗效或绝对安全证明。",
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Build one content-first working context")
    parser.add_argument("--job-root", type=Path, required=True)
    parser.add_argument("--content-job", type=Path, required=True)
    parser.add_argument("--scope-analysis", type=Path)
    parser.add_argument("--e2-analysis", type=Path)
    parser.add_argument("--monitoring-context", type=Path)
    parser.add_argument("--supplemental-research", type=Path)
    parser.add_argument("--brand")
    parser.add_argument("--material", action="append", type=Path, default=[])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    job_root = args.job_root.resolve()
    job = load_object(args.content_job)
    task = job.get("task") if isinstance(job.get("task"), dict) else {}
    question = normal(task.get("question_text") or task.get("foundation_subject"))
    if not question:
        raise ValueError("unknown_subject: content job contains no question or foundation subject")
    input_paths: list[Path] = []
    if job.get("reference_pack_path"):
        input_paths.append(job_root / str(job["reference_pack_path"]))
    for item in job.get("material_paths", []):
        if isinstance(item, str) and item:
            input_paths.append(job_root / item)
    input_paths.extend(args.material)
    input_paths = [path.resolve() for path in input_paths if path.exists() and not path.is_symlink()]
    if not input_paths:
        raise ValueError("no_usable_content: no readable Pack or material")

    archive_warnings: list[str] = []
    visual_warnings: list[str] = []
    with tempfile.TemporaryDirectory(prefix="frontmind-e3-") as temporary:
        expanded: list[Path] = []
        for index, input_path in enumerate(input_paths, 1):
            if input_path.is_file() and input_path.suffix.casefold() == ".zip":
                destination = Path(temporary) / f"archive-{index}"
                destination.mkdir()
                archive_warnings.extend(safe_extract_zip(input_path, destination))
                expanded.append(destination)
            else:
                expanded.append(input_path)

        json_documents: list[dict[str, Any]] = []
        json_origins: list[tuple[Path, dict[str, Any]]] = []
        document_asset_roots: dict[int, Path] = {}
        for root in expanded:
            pack_roots = sorted({
                item.parent.resolve() for item in (
                    [root] if root.is_file() and root.name == "reference_pack.json"
                    else root.rglob("reference_pack.json") if root.is_dir()
                    else []
                ) if item.is_file() and not item.is_symlink()
            }, key=lambda item: len(item.parts), reverse=True)
            for origin, document in iter_json(root):
                json_origins.append((origin, document))
                json_documents.append(document)
                document_asset_roots[id(document)] = document_asset_root(origin, root, pack_roots)
        brand_name, brand_aliases = discover_brand(json_documents, args.brand)
        if not brand_name:
            raise ValueError("unknown_subject: brand name cannot be inferred; supply --brand")

        sources: list[dict[str, Any]] = []
        source_ids: set[str] = set()
        source_registry_items = registry_records(json_documents, "sources")
        for index, record in enumerate(source_registry_items, 1):
            raw_id = normal(record.get("source_id"))
            source_id = raw_id if raw_id.startswith("src_") else identifier("src", raw_id, f"registry_{index:03d}")
            if source_id in source_ids:
                continue
            source_ids.add(source_id)
            usage, qualification = status_for(
                " ".join(normal(record.get(key_name)) for key_name in ("title", "notes", "content_status")),
                record.get("publication_authorization") or record.get("allowed_usage"),
            )
            sources.append({
                "source_id": source_id,
                "title": normal(record.get("title")) or f"企业资料 {index}",
                "source_kind": source_kind(record),
                "url": record.get("url") if isinstance(record.get("url"), str) else None,
                "file_path": record.get("file_path") if isinstance(record.get("file_path"), str) else None,
                "usage_status": usage,
                "qualification": qualification,
            })

        facts: list[dict[str, Any]] = []
        fact_ids: set[str] = set()
        claims = registry_records(json_documents, "claims")
        for index, record in enumerate(claims, 1):
            statement = normal(record.get("claim_text") or record.get("statement") or record.get("text"))
            if not statement:
                continue
            raw_id = normal(record.get("claim_id") or record.get("fact_id"))
            fact_id = raw_id if re.fullmatch(r"(?:fact|clm)_[a-z0-9][a-z0-9_-]{2,100}", raw_id) else identifier("fact", raw_id, f"registry_{index:03d}")
            if fact_id in fact_ids:
                continue
            fact_ids.add(fact_id)
            explicit = record.get("allowed_usage") or record.get("verification_status") or record.get("content_status")
            usage, qualification = status_for(statement + " " + normal(record.get("reason")), explicit)
            bound_sources = [str(item) for item in record.get("source_ids", []) if str(item) in source_ids]
            facts.append({
                "fact_id": fact_id,
                "statement": statement,
                "about_entities": [str(item) for item in record.get("about_entities", []) if normal(item)] or [brand_name],
                "source_ids": list(dict.fromkeys(bound_sources)),
                "usage_status": usage,
                "qualification": qualification,
            })

        supplemental_candidate_names = ingest_supplemental_research(
            args.supplemental_research, sources, source_ids, facts, fact_ids,
        )

        monitoring = load_object(args.monitoring_context)
        answer_source_ids: dict[str, list[str]] = defaultdict(list)
        url_source_ids: dict[str, str] = {}
        if monitoring:
            for index, record in enumerate(monitoring.get("source_observations", []), 1):
                if not isinstance(record, dict) or not normal(record.get("url")):
                    continue
                url = normal(record.get("url"))
                source_id = identifier("src", f"monitor_{index}_{url}", f"monitor_{index:03d}")
                url_source_ids[url] = source_id
                if source_id in source_ids:
                    continue
                source_ids.add(source_id)
                sources.append({
                    "source_id": source_id,
                    "title": normal(record.get("title") or record.get("publisher")) or f"监控引用 {index}",
                    "source_kind": "monitoring", "url": url, "file_path": None,
                    "usage_status": "qualified",
                    "qualification": "可用于候选发现与追溯监控答案；具体竞品事实仍应由该条链接的正文或官方资料支持",
                })
            for answer in monitoring.get("answers", []):
                if not isinstance(answer, dict):
                    continue
                answer_id = normal(answer.get("answer_id"))
                for citation in answer.get("citations", []):
                    if not isinstance(citation, dict):
                        continue
                    source_id = url_source_ids.get(normal(citation.get("url")))
                    if source_id:
                        answer_source_ids[answer_id].append(source_id)

        images, image_role_overrides, visual_warnings = materialize_visuals(
            merged_image_records(json_documents, document_asset_roots), job_root,
        )

        for file_index, root in enumerate(expanded, 1):
            files = [root] if root.is_file() else [item for item in root.rglob("*") if item.is_file() and not item.is_symlink()]
            for item in files:
                if item.suffix.casefold() in IMAGE_SUFFIXES:
                    # Unregistered files have no usable rights declaration.  Do
                    # not copy them into the stable article asset directory.
                    continue
                if item.suffix.casefold() not in TEXT_SUFFIXES | {".docx", ".pptx", ".xlsx", ".pdf"}:
                    continue
                text = read_text(item)
                if not normal(text):
                    continue
                source_id = identifier("src", item.stem, f"upload_{file_index:03d}")
                suffix_counter = 2
                base_id = source_id
                while source_id in source_ids:
                    source_id = f"{base_id}_{suffix_counter}"
                    suffix_counter += 1
                source_ids.add(source_id)
                usage, qualification = status_for(item.name + " " + text[:5000])
                sources.append({
                    "source_id": source_id, "title": item.name, "source_kind": "user_upload",
                    "url": None, "file_path": item.name, "usage_status": usage,
                    "qualification": qualification,
                })
                if len(facts) >= 100:
                    continue
                for sentence_index, statement in enumerate(fact_candidates(text)[:12], 1):
                    fact_id = identifier("fact", f"{item.stem}_{sentence_index}", f"upload_{file_index:03d}_{sentence_index:02d}")
                    if fact_id in fact_ids:
                        continue
                    fact_ids.add(fact_id)
                    fact_usage, fact_qualification = status_for(statement, usage)
                    facts.append({
                        "fact_id": fact_id, "statement": statement,
                        "about_entities": [brand_name], "source_ids": [source_id],
                        "usage_status": fact_usage, "qualification": fact_qualification or qualification,
                    })

    if not sources and not facts:
        raise ValueError("no_usable_content: inputs contain no readable text, Registry fact or source")
    if not any(item["usage_status"] in {"usable", "qualified"} for item in facts):
        raise ValueError("restricted_core_dependency: all extracted facts are excluded")
    e2 = load_object(args.e2_analysis)
    scope = load_object(args.scope_analysis)
    foundation = job.get("entry_category") == "foundation_start"
    if not foundation and (not e2 or not monitoring):
        raise ValueError("research_context_missing: ordinary E3 requires E2 analysis and normalized monitoring context")
    if not foundation:
        if question_key(monitoring.get("question")) != question_key(question):
            raise ValueError("research_question_mismatch: monitoring context differs from the formal question")
        if question_key(e2.get("question")) != question_key(question):
            raise ValueError("research_question_mismatch: E2 analysis differs from the formal question")

    derived = monitoring.get("derived") if isinstance(monitoring.get("derived"), dict) else {}
    answer_landscape = [item for item in derived.get("answer_landscape", []) if isinstance(item, dict)]
    brand_names = {brand_name.casefold(), *(item.casefold() for item in brand_aliases)}
    source_kind_by_id = {item["source_id"]: item["source_kind"] for item in sources}

    def entity_fact_ids(name: str) -> list[str]:
        folded = name.casefold()
        return list(dict.fromkeys(
            str(item["fact_id"]) for item in facts
            if any(normal(entity).casefold() == folded for entity in item.get("about_entities", []))
            and item.get("usage_status") in {"usable", "qualified"}
        ))

    brand_fact_ids = entity_fact_ids(brand_name)
    if not brand_fact_ids:
        brand_fact_ids = [str(item["fact_id"]) for item in facts if item.get("usage_status") in {"usable", "qualified"}][:20]
    brand_source_ids = list(dict.fromkeys(
        source_id for item in facts if str(item.get("fact_id")) in brand_fact_ids for source_id in item.get("source_ids", [])
    ))
    brand_answer_ids = [
        str(item["answer_id"]) for item in answer_landscape
        if any(normal(entity).casefold() in brand_names for entity in item.get("entities", []))
    ]
    candidate_profiles: list[dict[str, Any]] = [{
        "entity_id": "entity_featured_brand", "display_name": brand_name, "role": "featured_brand",
        "mention_count": len(brand_answer_ids), "answer_ids": list(dict.fromkeys(brand_answer_ids)),
        "source_ids": brand_source_ids, "fact_ids": brand_fact_ids, "evidence_status": "brand_supported",
    }]
    order_signals = {
        normal(item.get("entity")): [int(value) for value in item.get("positions", []) if isinstance(value, int)]
        for item in derived.get("candidate_order_signals", []) if isinstance(item, dict) and normal(item.get("entity"))
    }
    competitor_items: list[dict[str, Any]] = []
    for index, competitor in enumerate(derived.get("competitors", []), 1):
        if not isinstance(competitor, dict):
            continue
        name = normal(competitor.get("name"))
        if not name or name.casefold() in brand_names:
            continue
        answer_ids = list(dict.fromkeys(normal(value) for value in competitor.get("answer_ids", []) if normal(value)))
        candidate_source_ids = list(dict.fromkeys(
            source_id for answer_id in answer_ids for source_id in answer_source_ids.get(answer_id, [])
        ))
        candidate_fact_ids = entity_fact_ids(name)
        candidate_fact_source_ids = list(dict.fromkeys(
            source_id for fact in facts if str(fact.get("fact_id")) in candidate_fact_ids
            for source_id in fact.get("source_ids", [])
        ))
        candidate_source_ids = list(dict.fromkeys([*candidate_fact_source_ids, *candidate_source_ids]))
        has_public_fact = any(
            source_kind_by_id.get(source_id) in {"third_party_public", "runtime_research", "first_party_public"}
            for fact in facts if str(fact.get("fact_id")) in candidate_fact_ids for source_id in fact.get("source_ids", [])
        )
        competitor_items.append({
            "entity_id": identifier("entity", name, f"candidate_{index:02d}"),
            "display_name": name,
            "role": "comparison_target" if job.get("entry_category") == "competitor_comparison" else "candidate",
            "mention_count": len(answer_ids), "answer_ids": answer_ids,
            "source_ids": candidate_source_ids, "fact_ids": candidate_fact_ids,
            "evidence_status": "publicly_supported" if has_public_fact else "discovery_only",
            "_average_position": (
                sum(order_signals.get(name, [])) / len(order_signals[name]) if order_signals.get(name) else 999
            ),
        })
    observed_competitor_names = {normal(item.get("display_name")) for item in competitor_items}
    for index, name in enumerate(sorted(supplemental_candidate_names - observed_competitor_names), len(competitor_items) + 1):
        if not name or name.casefold() in brand_names:
            continue
        candidate_fact_ids = entity_fact_ids(name)
        candidate_source_ids = list(dict.fromkeys(
            source_id for fact in facts if str(fact.get("fact_id")) in candidate_fact_ids
            for source_id in fact.get("source_ids", [])
        ))
        has_public_fact = bool(candidate_fact_ids and candidate_source_ids) and any(
            source_kind_by_id.get(source_id) in {"third_party_public", "runtime_research", "first_party_public"}
            for source_id in candidate_source_ids
        )
        competitor_items.append({
            "entity_id": identifier("entity", name, f"candidate_{index:02d}"),
            "display_name": name,
            "role": "comparison_target" if job.get("entry_category") == "competitor_comparison" else "candidate",
            "mention_count": 0,
            "answer_ids": [],
            "source_ids": candidate_source_ids,
            "fact_ids": candidate_fact_ids,
            "evidence_status": "publicly_supported" if has_public_fact else "discovery_only",
            "_average_position": 999,
        })
    competitor_items.sort(key=lambda item: (item["_average_position"], -int(item["mention_count"]), item["display_name"]))
    for item in competitor_items:
        item.pop("_average_position", None)
    candidate_profiles.extend(competitor_items[:20])

    def is_reader_question(value: str) -> bool:
        folded = value.casefold()
        if not value or value.startswith("尚未回答"):
            return False
        if any(token in value for token in ("是否需要我", "是否需要继续", "是否需要进一步", "是否需要把")):
            return False
        if any(token in folded for token in ("secondary menu", "main menu", "jump to", "navigation", "permalink")):
            return False
        # The public article is Chinese.  Reject navigation fragments and
        # headings that contain no Chinese reader intent.
        return bool(re.search(r"[\u3400-\u9fff]", value))

    reader_questions = list(dict.fromkeys([
        value for item in [
            *derived.get("recurring_subquestions", []),
            *derived.get("unanswered_subquestions", []),
        ] if (value := normal(item)) and is_reader_question(value)
    ]))
    if not reader_questions:
        for document in json_documents:
            for item in document.get("questions", []) if isinstance(document.get("questions"), list) else []:
                value = normal(
                    (item.get("question") or item.get("question_text")) if isinstance(item, dict) else item
                )
                if value and is_reader_question(value):
                    reader_questions.append(value)
        reader_questions = list(dict.fromkeys(reader_questions))[:30]

    public_constraints = [
        "已支持的品牌事实直接陈述；内部的资料状态、校验动作和思考过程不进入正文。",
        "监控答案中的提及与顺序只用于候选发现和结构判断，不写成市场排名或口碑共识。",
        "第一方资料可支持客户品牌的身份、产品、服务、流程、公开价格与限制，不单独推出市场第一、行业领先或竞品劣势。",
        "无法支持的非核心主张直接省略；决策必需的动态信息改写为一次性查询、预约或现场确认动作。",
    ]
    excluded_facts = sum(item["usage_status"] == "excluded" for item in facts)
    qualified_facts = sum(item["usage_status"] == "qualified" for item in facts)
    if qualified_facts:
        public_constraints.append("带时间、地区、版本或专业条件的事实，把具体限定紧邻写入对应句子。")

    suggested_pattern = (e2.get("recommendation") or {}).get("recommended_pattern_id") or ("P14" if foundation else None)
    visuals = []
    for image in images:
        kind = normal(image.get("asset_kind")).casefold()
        if image_role_overrides.get(str(image["image_id"])):
            roles = image_role_overrides[str(image["image_id"])]
        elif "logo" in kind:
            roles = ["brand_editorial"]
        elif any(token in kind for token in ("certificate", "screenshot", "case", "product", "proof")):
            roles = ["prove"]
        elif any(token in kind for token in ("diagram", "flow", "chart", "infographic")):
            roles = ["explain", "navigate"]
        else:
            roles = ["brand_editorial"]
        visuals.append({
            "image_id": image["image_id"], "file_path": image["file_path"],
            "asset_kind": image["asset_kind"], "rights_status": image["rights_status"],
            "usage_status": image["usage_status"], "credit": image.get("credit"),
            "notes": image.get("notes"),
            "usable_for": roles if image.get("usage_status") == "usable" else [],
        })
    payload = {
        "schema_version": "2.3.0",
        "job_id": job.get("job_id"),
        "brand": {"canonical_name": brand_name, "aliases": brand_aliases},
        "entry_category": job.get("entry_category"),
        "primary_question": question,
        "question_origin": task.get("question_origin") or ("foundation_derived" if job.get("entry_category") == "foundation_start" else "upload_inferred"),
        "scope": scope_context(scope, question),
        "voice_profile": voice_profile(json_documents, str(job.get("entry_category") or "")),
        "brand_priority_angle": choose_priority_angle(
            json_documents, str(job.get("entry_category") or ""), suggested_pattern,
            {str(item["fact_id"]) for item in facts}, brand_name, facts, question,
        ),
        "facts": facts,
        "sources": sources,
        "images": images,
        "answer_landscape": answer_landscape,
        "candidate_profiles": candidate_profiles,
        "benchmark_moves": benchmark_moves(e2),
        "reader_questions": reader_questions,
        "public_constraints": list(dict.fromkeys(public_constraints)),
        "medical_or_legal_safety": medical_safety(question),
        "visual_assets": visuals,
        "research_summary": research_context(e2, foundation),
    }
    validate_root(payload, "working_context.schema.json", "E3 working context")
    write_json(args.output, payload)
    print(json.dumps({
        "stage": "E3", "status": "completed_with_limits" if excluded_facts or qualified_facts or archive_warnings or visual_warnings else "completed",
        "job_id": payload["job_id"], "brand": brand_name,
        "facts": len(facts), "usable_or_qualified_facts": sum(item["usage_status"] != "excluded" for item in facts),
        "sources": len(sources), "images": len(images),
        "candidates": len(candidate_profiles), "benchmarks": len(payload["benchmark_moves"]),
        "excluded_facts": excluded_facts, "qualified_facts": qualified_facts,
        "visual_warnings": len(visual_warnings), "archive_warnings": len(archive_warnings),
        "output": str(args.output),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
