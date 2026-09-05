#!/usr/bin/env python3
"""Normalize canonical FrontMind KB v4, S1 facts, and images into registries."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import mimetypes
import re
import shutil
import struct
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit


SCHEMA_VERSION = "2.0.0"
CANONICAL_KB_VERSION = 4
CANONICAL_PROFILE = "dashboard-enterprise-v1"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".ico"}
PRECISIONS = {"exact", "claim", "branch", "document", "source", "none", "unknown"}
PUBLICATION_AUTHORIZATIONS = {"public_approved", "anonymized_approved", "internal_only"}
AUTHORIZATION_ID = re.compile(r"^auth_[a-z0-9][a-z0-9_-]{2,80}$")
AUTHORIZATION_FIELDS = {
    "schema_version", "brand", "authorization_id", "reviewer",
    "reviewer_role", "reviewed_at", "authorizations",
}
AUTHORIZATION_ENTRY_FIELDS = {
    "source_id", "publication_authorization", "authorization_basis",
    "evidence_refs", "anonymization_attestation", "notes",
}
UNSAFE_AUTHORIZATION_REF_PARTS = ("file://", "../")


def unsafe_authorization_ref(value: Any) -> bool:
    """Reject local absolute/traversal references without embedding host paths."""

    if not isinstance(value, str) or not value.strip():
        return True
    raw = value.strip()
    if any(part in raw for part in UNSAFE_AUTHORIZATION_REF_PARTS):
        return True
    return PurePosixPath(raw).is_absolute() or PureWindowsPath(raw).is_absolute()


def normalize_precision(value: Any) -> str:
    """Map upstream precision labels into the package-root registry contract."""
    raw = str(value or "none").strip().lower()
    if raw == "section":
        return "document"
    return raw if raw in PRECISIONS else "unknown"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_id(namespace: str, seed: str, length: int = 12) -> str:
    """Return a canonical root-schema ID while retaining the origin in seed."""
    if "source" in namespace:
        prefix = "src"
    elif "knowledge" in namespace:
        prefix = "kn"
    elif "claim" in namespace:
        prefix = "clm"
    elif "asset" in namespace or "image" in namespace:
        prefix = "img"
    else:
        raise ValueError(f"unsupported ID namespace: {namespace}")
    hint = re.sub(r"[^a-z0-9]+", "_", namespace.lower()).strip("_")[:28] or "item"
    return f"{prefix}_{hint}_{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:length]}"


def kb_source_id(raw_id: str) -> str:
    return stable_id("kbv4_source", raw_id)


def kb_knowledge_id(raw_id: str) -> str:
    return stable_id("kbv4_knowledge", raw_id)


def kb_asset_id(raw_id: str) -> str:
    return stable_id("kbv4_asset", raw_id)


def safe_brand(value: str) -> str:
    cleaned = re.sub(r"[^\w\-\u4e00-\u9fff]+", "_", value.strip(), flags=re.UNICODE).strip("_")
    return cleaned or "brand"


def safe_path_reference(value: str | None) -> str | None:
    """Return a portable, non-identifying alias for an upstream local path.

    Absolute and parent-traversing paths are useful while locating an input
    asset, but must never be serialized into a reusable Reference Pack.
    """
    raw = str(value or "").strip()
    if not raw:
        return None
    posix = PurePosixPath(raw.replace("\\", "/"))
    if raw.startswith("~") or posix.is_absolute() or PureWindowsPath(raw).is_absolute() or ".." in posix.parts:
        suffix = Path(posix.name).suffix.lower()
        return f"external_asset_{hashlib.sha256(raw.encode('utf-8')).hexdigest()[:12]}{suffix}"
    return posix.as_posix()


def normalize_url(url: str) -> str:
    raw = url.strip()
    if not raw:
        return ""
    parts = urlsplit(raw)
    scheme = parts.scheme.lower()
    host = parts.netloc.lower()
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    if path != "/":
        path = path.rstrip("/")
    return urlunsplit((scheme, host, path, parts.query, ""))


def load_json_file(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


class PackageReader:
    """Read a ZIP or directory without extracting untrusted paths."""

    def __init__(self, source: Path):
        self.source = source.resolve()
        self.archive: zipfile.ZipFile | None = None
        if self.source.is_file():
            if not zipfile.is_zipfile(self.source):
                raise ValueError(f"KB input is not a ZIP: {self.source}")
            self.archive = zipfile.ZipFile(self.source)
            names = [name for name in self.archive.namelist() if not name.endswith("/")]
            for name in names:
                posix = PurePosixPath(name)
                if posix.is_absolute() or ".." in posix.parts:
                    raise ValueError(f"unsafe ZIP member: {name}")
            self.names = names
            self.fingerprint = digest_file(self.source)
        elif self.source.is_dir():
            self.names = [path.relative_to(self.source).as_posix() for path in self.source.rglob("*") if path.is_file()]
            listing = "\n".join(f"{name}:{digest_file(self.source / name)}" for name in sorted(self.names))
            self.fingerprint = digest_bytes(listing.encode("utf-8"))
        else:
            raise ValueError(f"KB input does not exist: {self.source}")

        manifests = [name for name in self.names if name == "00_package_manifest.json" or name.endswith("/00_package_manifest.json")]
        self.manifest_name = sorted(manifests, key=lambda value: (value.count("/"), len(value)))[0] if manifests else None
        self.prefix = str(PurePosixPath(self.manifest_name).parent) if self.manifest_name else ""
        if self.prefix == ".":
            self.prefix = ""

    def close(self) -> None:
        if self.archive:
            self.archive.close()

    def member_name(self, relative_path: str) -> str:
        clean = PurePosixPath(relative_path).as_posix().lstrip("/")
        return f"{self.prefix}/{clean}" if self.prefix else clean

    def exists(self, relative_path: str) -> bool:
        return self.member_name(relative_path) in self.names

    def read_bytes(self, relative_path: str) -> bytes:
        name = self.member_name(relative_path)
        if name not in self.names:
            raise FileNotFoundError(relative_path)
        if self.archive:
            return self.archive.read(name)
        return (self.source / name).read_bytes()

    def read_text(self, relative_path: str) -> str:
        return self.read_bytes(relative_path).decode("utf-8", errors="replace")

    def relative_names(self) -> list[str]:
        if not self.prefix:
            return list(self.names)
        prefix = self.prefix + "/"
        return [name[len(prefix):] for name in self.names if name.startswith(prefix)]


def formal_content(markdown: str) -> str:
    match = re.search(
        r"<!--\s*FRONTMIND_FORMAL_CONTENT_START\s*-->(.*?)<!--\s*FRONTMIND_FORMAL_CONTENT_END\s*-->",
        markdown,
        flags=re.DOTALL | re.IGNORECASE,
    )
    return (match.group(1) if match else markdown).strip()


def parse_source_index(markdown: str) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for line in markdown.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 3 or cells[0] in {"来源ID", "Source ID"} or set(cells[0]) <= {"-", ":"}:
            continue
        result[cells[0]] = {"type": cells[1], "description": cells[2]}
    return result


def image_dimensions(data: bytes, suffix: str) -> tuple[int | None, int | None]:
    """Read positive intrinsic pixel dimensions, including SVG ``viewBox``.

    Explicit SVG ``width``/``height`` remain authoritative when both are
    usable absolute lengths.  A positive ``viewBox`` width/height is the
    fallback for the common responsive-SVG case where those attributes are
    absent or expressed as percentages.
    """

    def svg_length(value: str | None) -> int | None:
        if not value:
            return None
        match = re.fullmatch(
            r"\s*\+?((?:\d+(?:\.\d*)?)|(?:\.\d+))\s*(px|pt|pc|mm|cm|in)?\s*",
            value,
            flags=re.IGNORECASE,
        )
        if not match:
            return None
        number = float(match.group(1))
        if number <= 0:
            return None
        unit = (match.group(2) or "px").lower()
        factors = {"px": 1.0, "pt": 96 / 72, "pc": 16.0, "mm": 96 / 25.4, "cm": 96 / 2.54, "in": 96.0}
        return max(1, math.ceil(number * factors[unit]))

    try:
        if suffix == ".png" and data.startswith(b"\x89PNG\r\n\x1a\n"):
            return struct.unpack(">II", data[16:24])
        if suffix in {".jpg", ".jpeg"} and data.startswith(b"\xff\xd8"):
            index = 2
            while index + 9 < len(data):
                if data[index] != 0xFF:
                    index += 1
                    continue
                marker = data[index + 1]
                index += 2
                if marker in {0xD8, 0xD9}:
                    continue
                length = struct.unpack(">H", data[index:index + 2])[0]
                if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                    height, width = struct.unpack(">HH", data[index + 3:index + 7])
                    return width, height
                index += length
        if suffix == ".gif" and data[:6] in {b"GIF87a", b"GIF89a"}:
            return struct.unpack("<HH", data[6:10])
        if suffix == ".svg":
            text = data[:8192].decode("utf-8", errors="ignore")
            root = re.search(r"<svg\b(?P<attrs>[^>]*)>", text, flags=re.IGNORECASE | re.DOTALL)
            if not root:
                return None, None
            attrs = root.group("attrs")

            def attribute(name: str) -> str | None:
                match = re.search(rf"\b{name}\s*=\s*([\"'])(.*?)\1", attrs, flags=re.IGNORECASE | re.DOTALL)
                return match.group(2) if match else None

            explicit_width = svg_length(attribute("width"))
            explicit_height = svg_length(attribute("height"))
            if explicit_width is not None and explicit_height is not None:
                return explicit_width, explicit_height
            view_box = attribute("viewBox")
            if view_box:
                values = [part for part in re.split(r"[\s,]+", view_box.strip()) if part]
                if len(values) == 4:
                    width_value, height_value = float(values[2]), float(values[3])
                    if width_value > 0 and height_value > 0:
                        return max(1, math.ceil(width_value)), max(1, math.ceil(height_value))
    except (ValueError, OverflowError, struct.error):
        pass
    return None, None


def canonical_source_type(raw: str) -> tuple[str, int]:
    value = raw.lower()
    if any(token in value for token in ("regulation", "standard", "监管", "标准")):
        return "regulation_standard", 1
    if any(token in value for token in ("paper", "research", "dataset", "论文", "研究", "数据")):
        return "primary_data_research", 1
    if any(token in value for token in ("official", "官网", "官方")):
        return "first_party_official", 2
    if any(token in value for token in ("internal", "first_party", "first-party", "内部", "未公开")):
        return "first_party_internal", 2
    if any(token in value for token in ("client", "customer", "project", "客户", "项目")):
        return "authorized_project_record", 2
    if any(token in value for token in ("media", "news", "媒体", "新闻")):
        return "editorial_media", 3
    if any(token in value for token in ("database", "数据库")):
        return "professional_database", 2
    if any(token in value for token in ("expert", "专家")):
        return "named_expert", 2
    if any(token in value for token in ("review", "community", "forum", "评论", "社区")):
        return "community_review", 4
    return "aggregator", 4


def source_item(
    source_id: str,
    source_type: str,
    description: str,
    url: str,
    origin: str,
    locator: str,
    precision: str,
    *,
    file_path: str | None = None,
    source_document_id: str | None = None,
    evidence_status: str | None = None,
    content_status: str | None = None,
) -> dict[str, Any]:
    normalized_type, authority = canonical_source_type(source_type)
    if normalized_type in {"first_party_official", "authorized_project_record"}:
        # A label such as official/project/client is evidence classification,
        # not publication consent.  Every S2 first-party source starts closed;
        # only the exact per-source authorization manifest below can promote a
        # canonical KB-owned source into first_party_official.
        normalized_type = "first_party_internal"
    if normalized_type == "first_party_official":
        source_origin_class = "first_party_official"
    elif normalized_type == "first_party_internal":
        source_origin_class = "first_party_internal"
    elif normalized_type == "authorized_project_record" or origin == "runtime":
        source_origin_class = "runtime_approved"
    else:
        source_origin_class = "third_party_public"
    publication_authorization: str | None = None
    if normalized_type == "first_party_internal":
        publication_authorization = "internal_only"
    elif source_origin_class == "runtime_approved":
        publication_authorization = "runtime_approved"
    return {
        "source_id": source_id,
        "title": description or source_id,
        "publisher": None,
        "source_type": normalized_type,
        "source_origin_class": source_origin_class,
        **(
            {"publication_authorization": publication_authorization}
            if publication_authorization is not None
            else {}
        ),
        "authority_tier": authority,
        "url": url or None,
        "file_path": file_path if not url else None,
        "published_at": None,
        "accessed_at": now_iso(),
        "language": None,
        "notes": f"normalized from upstream source type: {source_type or 'unknown'}",
        "origin": origin,
        "locator": locator or None,
        "source_document_id": source_document_id,
        "evidence_status": evidence_status,
        "content_status": content_status,
        "evidence_precision": normalize_precision(precision),
    }


def timezone_aware_datetime(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def publication_candidate_ids(sources: dict[str, dict[str, Any]]) -> list[str]:
    """Return the exact canonical KB-owned first-party set requiring review."""
    return sorted(
        source_id for source_id, source in sources.items()
        if source.get("origin") == "kbv4"
        and source.get("source_type") == "first_party_internal"
        and source.get("source_origin_class") == "first_party_internal"
        and source.get("publication_authorization") == "internal_only"
    )


def publication_authorization_template(
    brand: str,
    candidate_ids: list[str],
) -> dict[str, Any]:
    """Create a deliberately unfinished engineer-facing authorization form."""
    return {
        "schema_version": SCHEMA_VERSION,
        "brand": brand,
        "authorization_id": "auth_replace_with_stable_id",
        "reviewer": "",
        "reviewer_role": "",
        "reviewed_at": "",
        "authorizations": [
            {
                "source_id": source_id,
                "publication_authorization": "internal_only",
                "authorization_basis": "",
                "evidence_refs": [],
                "anonymization_attestation": "",
                "notes": "",
            }
            for source_id in candidate_ids
        ],
    }


def validate_and_apply_publication_authorizations(
    payload: Any,
    *,
    brand: str,
    sources: dict[str, dict[str, Any]],
    candidate_ids: list[str],
) -> tuple[dict[str, Any], list[str]]:
    """Atomically apply an exact-set, per-source publication decision file.

    The input must cover every and only canonical KB-owned first-party source.
    Unknown, third-party, legacy S1 and runtime source IDs are never promotable.
    """
    errors: list[str] = []
    summary: dict[str, Any] = {
        "status": "invalid",
        "candidate_source_ids": candidate_ids,
        "decisions": [],
    }
    if not isinstance(payload, dict):
        return summary, ["publication authorizations root must be an object"]
    if set(payload) != AUTHORIZATION_FIELDS:
        errors.append(f"publication authorizations top-level fields must be exactly {sorted(AUTHORIZATION_FIELDS)}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"publication authorizations schema_version must be {SCHEMA_VERSION}")
    if payload.get("brand") != brand:
        errors.append("publication authorizations brand must match --brand")
    authorization_id = str(payload.get("authorization_id") or "")
    if not AUTHORIZATION_ID.fullmatch(authorization_id):
        errors.append("publication authorization_id must match auth_[a-z0-9_-]")
    for field in ("reviewer", "reviewer_role"):
        if not str(payload.get(field) or "").strip():
            errors.append(f"publication authorizations {field} is required")
    if not timezone_aware_datetime(payload.get("reviewed_at")):
        errors.append("publication authorizations reviewed_at must be a timezone-aware date-time")

    entries = payload.get("authorizations")
    if not isinstance(entries, list):
        errors.append("publication authorizations must be an array")
        entries = []
    entry_by_id: dict[str, dict[str, Any]] = {}
    for index, entry in enumerate(entries):
        label = f"publication authorizations[{index}]"
        if not isinstance(entry, dict) or set(entry) != AUTHORIZATION_ENTRY_FIELDS:
            errors.append(f"{label} must contain exactly {sorted(AUTHORIZATION_ENTRY_FIELDS)}")
            continue
        source_id = str(entry.get("source_id") or "")
        if not source_id.startswith("src_"):
            errors.append(f"{label}.source_id must start with src_")
        elif source_id in entry_by_id:
            errors.append(f"{label}.source_id is duplicated: {source_id}")
        else:
            entry_by_id[source_id] = entry
        authorization = entry.get("publication_authorization")
        if authorization not in PUBLICATION_AUTHORIZATIONS:
            errors.append(f"{label}.publication_authorization is invalid")
        if len(str(entry.get("authorization_basis") or "").strip()) < 3:
            errors.append(f"{label}.authorization_basis is required")
        refs = entry.get("evidence_refs")
        if not isinstance(refs, list) or not refs or len(refs) != len(set(refs)):
            errors.append(f"{label}.evidence_refs must be non-empty and unique")
        elif any(unsafe_authorization_ref(ref) for ref in refs):
            errors.append(f"{label}.evidence_refs contains a blank or unsafe reference")
        attestation = str(entry.get("anonymization_attestation") or "").strip()
        if authorization == "anonymized_approved" and len(attestation) < 3:
            errors.append(f"{label}.anonymization_attestation is required for anonymized approval")
        if authorization != "anonymized_approved" and attestation:
            errors.append(f"{label}.anonymization_attestation must be blank unless anonymized_approved")

    expected = set(candidate_ids)
    provided = set(entry_by_id)
    missing = sorted(expected - provided)
    extra = sorted(provided - expected)
    if missing:
        errors.append(f"publication authorizations omit canonical first-party source_ids: {missing}")
    if extra:
        known_non_candidates = sorted(source_id for source_id in extra if source_id in sources)
        unknown = sorted(set(extra) - set(known_non_candidates))
        if known_non_candidates:
            errors.append(f"publication authorizations cannot promote non-candidate/third-party source_ids: {known_non_candidates}")
        if unknown:
            errors.append(f"publication authorizations reference unknown source_ids: {unknown}")
    if errors:
        return summary, errors

    decisions: list[dict[str, Any]] = []
    for source_id in candidate_ids:
        entry = entry_by_id[source_id]
        source = sources[source_id]
        authorization = entry["publication_authorization"]
        if authorization in {"public_approved", "anonymized_approved"}:
            source["source_type"] = "first_party_official"
            source["source_origin_class"] = "first_party_official"
            source["publication_authorization"] = authorization
        else:
            source["source_type"] = "first_party_internal"
            source["source_origin_class"] = "first_party_internal"
            source["publication_authorization"] = "internal_only"
        audit = (
            f"publication authorization {authorization_id}: {authorization}; "
            f"reviewer={payload['reviewer']} ({payload['reviewer_role']}); "
            f"reviewed_at={payload['reviewed_at']}; basis={entry['authorization_basis']}; "
            f"evidence_refs={','.join(entry['evidence_refs'])}"
        )
        if entry.get("anonymization_attestation"):
            audit += f"; anonymization={entry['anonymization_attestation']}"
        if entry.get("notes"):
            audit += f"; notes={entry['notes']}"
        source["notes"] = f"{str(source.get('notes') or '').strip()}\n{audit}".strip()
        decisions.append({
            "source_id": source_id,
            "publication_authorization": authorization,
            "resulting_source_type": source["source_type"],
            "resulting_source_origin_class": source["source_origin_class"],
        })
    summary.update({
        "status": "applied",
        "authorization_id": authorization_id,
        "reviewer": payload["reviewer"],
        "reviewer_role": payload["reviewer_role"],
        "reviewed_at": payload["reviewed_at"],
        "decisions": decisions,
    })
    return summary, []


def add_source(registry: dict[str, dict[str, Any]], item: dict[str, Any]) -> str:
    source_id = str(item["source_id"])
    if source_id not in registry:
        registry[source_id] = item
    else:
        existing = registry[source_id]
        for key, value in item.items():
            if existing.get(key) in {None, "", "unknown"} and value not in {None, ""}:
                existing[key] = value
    return source_id


def iter_scalar_leaves(value: Any, prefix: str) -> Iterable[tuple[str, Any, dict[str, Any] | None]]:
    """Yield meaningful scalar leaves while keeping a containing metadata dict."""
    if isinstance(value, dict):
        metadata = value if any(key in value for key in ("confidence", "source_url", "source_type", "evidenceStatus")) else None
        for key, child in value.items():
            if key in {"confidence", "source_url", "source_type", "timestamp", "excerpt", "local_path"}:
                continue
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            if isinstance(child, (dict, list)):
                yield from iter_scalar_leaves(child, child_prefix)
            elif child not in {None, ""}:
                yield child_prefix, child, metadata
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_prefix = f"{prefix}[{index}]"
            if isinstance(child, (dict, list)):
                yield from iter_scalar_leaves(child, child_prefix)
            elif child not in {None, ""}:
                yield child_prefix, child, None
    elif value not in {None, ""}:
        yield prefix, value, None


def evidence_matches(path: str, evidence: list[dict[str, Any]]) -> list[dict[str, Any]]:
    matches = []
    normalized_path = path.removeprefix("facts.").removeprefix("claims.")
    for item in evidence:
        ref = str(item.get("claim_ref") or "").strip()
        if not ref:
            continue
        normalized_ref = ref.removeprefix("facts.").removeprefix("claims.")
        if normalized_ref == normalized_path or normalized_path.startswith(normalized_ref + ".") or normalized_ref.startswith(normalized_path + "."):
            matches.append(item)
    return matches


def register_s1_sources(evidence: list[dict[str, Any]], sources: dict[str, dict[str, Any]], s1_file_path: str) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for index, item in enumerate(evidence):
        url = str(item.get("source_url") or "")
        source_type = str(item.get("source_type") or "unknown")
        seed = normalize_url(url) or f"{source_type}:{item.get('excerpt', '')}:{index}"
        source_id = stable_id("s1_source", seed)
        mapping[index] = add_source(
            sources,
            source_item(
                source_id,
                source_type,
                str(item.get("excerpt") or item.get("claim_ref") or "S1 evidence"),
                url,
                "s1",
                str(item.get("claim_ref") or ""),
                "claim" if item.get("claim_ref") else "none",
                file_path=s1_file_path,
                evidence_status="verified" if item.get("confidence", 0) >= 0.8 else "unverified",
                content_status="source_evidence",
            ),
        )
        sources[source_id]["published_at"] = item.get("timestamp") if isinstance(item.get("timestamp"), str) and "T" in item.get("timestamp", "") else None
    return mapping


def claim_type_for_path(path: str, section: str) -> str:
    lowered = path.lower()
    if section == "claims":
        return "capability"
    if any(token in lowered for token in ("company", "team", "certification", "brand_assets")):
        return "identity"
    if "product" in lowered:
        return "product"
    if any(token in lowered for token in ("technology", "technical", "feature")):
        return "capability"
    if "price" in lowered:
        return "price"
    if any(token in lowered for token in ("financial", "market", "count", "rate", "amount")):
        return "statistic"
    if any(token in lowered for token in ("client", "case")):
        return "case_result"
    if "competition" in lowered:
        return "comparison"
    return "specification"


def build_s1_claims(payload: dict[str, Any], sources: dict[str, dict[str, Any]], warnings: list[str], s1_file_path: str) -> list[dict[str, Any]]:
    evidence_raw = payload.get("evidence") or []
    evidence = [item for item in evidence_raw if isinstance(item, dict)]
    evidence_source_ids = register_s1_sources(evidence, sources, s1_file_path)
    result: list[dict[str, Any]] = []

    for section, claim_type in (("facts", "fact"), ("claims", "brand_claim")):
        for path, value, metadata in iter_scalar_leaves(payload.get(section, {}), section):
            matches = evidence_matches(path, evidence)
            match_source_refs = [evidence_source_ids[index] for index, item in enumerate(evidence) if item in matches]
            confidences = [float(item["confidence"]) for item in matches if isinstance(item.get("confidence"), (int, float))]
            if metadata and isinstance(metadata.get("confidence"), (int, float)):
                confidences.append(float(metadata["confidence"]))
            confidence = max(confidences) if confidences else None
            source_types = {str(item.get("source_type") or "") for item in matches}
            if metadata and metadata.get("source_type"):
                source_types.add(str(metadata["source_type"]))
            if "ai_inference" in source_types or (confidence is not None and confidence < 0.5):
                verification_status, allowed_usage = "disallowed", "do_not_use"
                reason = "AI inference or confidence below 0.5"
            elif claim_type == "brand_claim":
                verification_status, allowed_usage = (
                    ("verified_with_limits", "public_with_qualification")
                    if matches else ("needs_verification", "internal_only")
                )
                reason = "Brand claim must remain attributed" if matches else "Brand claim has no matched evidence"
            elif matches and (confidence is None or confidence >= 0.8) and source_types - {"client_statement", "ai_inference"}:
                verification_status, allowed_usage = "verified", "public_fact"
                reason = "S1 fact has claim-level evidence"
            elif matches:
                verification_status, allowed_usage = "verified_with_limits", "public_with_qualification"
                reason = "Evidence is first-party, low-confidence, or not independently verifiable"
            else:
                verification_status, allowed_usage = "needs_verification", "internal_only"
                reason = "No S1 evidence matches this fact path"
            statement = str(value) if isinstance(value, str) else f"{path}: {value}"
            result.append({
                "claim_id": stable_id("s1_claim", path),
                "claim_text": statement,
                "claim_type": claim_type_for_path(path, section),
                "origin": "s1",
                "knowledge_ids": [],
                "source_ids": sorted(set(match_source_refs)),
                "evidence_document_refs": [f"s1:evidence:{evidence.index(item)}" for item in matches],
                "evidence_status": "verified" if matches else "missing",
                "content_status": "source_fact" if claim_type == "fact" else "brand_claim",
                "evidence_precision": "claim" if matches else "none",
                "evidence_excerpt": next((str(item.get("excerpt")) for item in matches if item.get("excerpt")), None),
                "scope": path,
                "as_of": None,
                "verification_status": verification_status,
                "allowed_usage": allowed_usage,
                "reason": reason,
            })
    if not evidence:
        warnings.append("S1 facts file contains no structured evidence array")
    return result


def rights_for_asset(metadata: dict[str, Any], origin: str, has_file: bool) -> tuple[str, str, list[str]]:
    provided_by = str(metadata.get("provided_by") or metadata.get("ownership") or "").lower()
    source_kind = str(metadata.get("sourceKind") or metadata.get("source_kind") or "").lower()
    explicit = str(metadata.get("rights_status") or "").lower()
    license_markers = any(
        metadata.get(key)
        for key in ("license", "license_name", "license_url", "credit", "attribution_text")
    )
    is_licensed_third_party = (
        explicit == "licensed"
        or source_kind in {"licensed", "licensed_third_party", "third_party_licensed"}
        or provided_by in {"licensed_third_party", "third_party_licensed", "licensor"}
        or license_markers
    )
    if explicit in {"approved", "approved_with_credit", "restricted_not_allowed", "unknown"}:
        status = explicit
    elif explicit == "approved_first_party":
        status = "approved"
    elif explicit == "licensed":
        status = "approved_with_credit" if (metadata.get("credit") or metadata.get("attribution_text")) else "approved"
    elif explicit in {"reference_only", "blocked"}:
        status = "restricted_not_allowed"
    elif explicit == "review_required":
        status = "unknown"
    elif provided_by in {"client", "customer", "first_party"} or origin == "kbv4" and provided_by == "first_party":
        status = "approved"
    elif source_kind == "official_web" or provided_by in {"web_crawl", "official_web"}:
        status = "unknown"
    else:
        status = "restricted_not_allowed"
    if not has_file and status in {"approved", "approved_with_credit"}:
        status = "unknown"
    if is_licensed_third_party:
        # Rights and provenance are separate dimensions.  A licence without a
        # credit requirement is still third-party provenance; never relabel it
        # as a first-party download merely because its status normalizes to
        # ``approved``.
        canonical_kind = "licensed_third_party"
    elif origin == "client_gallery" or provided_by in {"client", "customer"}:
        canonical_kind = "client_submitted"
    elif status == "approved_with_credit":
        canonical_kind = "licensed_third_party"
    elif origin == "kbv4" or source_kind == "official_web" or provided_by in {"first_party", "official_web", "web_crawl"}:
        canonical_kind = "first_party_download" if has_file else "first_party_reference"
    else:
        canonical_kind = "first_party_reference"
    asset_type = str(metadata.get("assetType") or metadata.get("asset_type") or "").lower()
    display_role = str(metadata.get("displayRole") or metadata.get("display_role") or "").lower()
    roles = ["decorative"]
    if "product" in asset_type:
        roles = ["product_proof"]
    elif any(token in asset_type for token in ("case_study", "customer_case", "case_proof")):
        roles = ["case_proof"]
    elif "event" in asset_type:
        roles = ["event_proof"]
    elif any(token in asset_type for token in ("data", "chart")):
        roles = ["data_evidence"]
    elif any(token in asset_type for token in ("brand", "identity", "logo")) or display_role == "badge":
        roles = ["entity_proof"]
    return status, canonical_kind, roles


def asset_kind_for(metadata: dict[str, Any], allowed_roles: list[str]) -> str:
    """Derive an explicit visual kind; downstream never infers a Logo from approval alone."""
    asset_type = str(metadata.get("assetType") or metadata.get("asset_type") or "").lower()
    if "entity_proof" in allowed_roles and (
        "logo" in asset_type
        or "brand_identity" in asset_type
    ):
        return "logo"
    if "product_proof" in allowed_roles:
        return "product"
    if "case_proof" in allowed_roles:
        return "case"
    if "event_proof" in allowed_roles:
        return "event"
    if "data_evidence" in allowed_roles:
        return "data_visual"
    if any(token in asset_type for token in ("brand", "team", "office", "factory", "certificate")):
        return "brand_image"
    if asset_type:
        return "decorative"
    return "unknown"


def add_asset(
    assets: list[dict[str, Any]],
    asset_by_sha: dict[str, dict[str, Any]],
    *,
    asset_id: str,
    data: bytes | None,
    original_path: str | None,
    url: str | None,
    metadata: dict[str, Any],
    origin: str,
    output_assets: Path,
    source_ref: str | None,
) -> str:
    portable_original_path = safe_path_reference(original_path)
    suffix = Path(original_path or urlsplit(url or "").path).suffix.lower()
    sha = digest_bytes(data) if data is not None else None
    if sha and sha in asset_by_sha:
        existing = asset_by_sha[sha]
        alias = " | ".join(value for value in (asset_id, origin, portable_original_path, url) if value)
        if alias not in existing["aliases"]:
            existing["aliases"].append(alias)
        return str(existing["asset_id"])
    local_path = None
    width = metadata.get("width")
    height = metadata.get("height")
    if data is not None:
        width_detected, height_detected = image_dimensions(data, suffix)
        width = width or width_detected
        height = height or height_detected
        output_assets.mkdir(parents=True, exist_ok=True)
        file_name = f"{sha[:20]}{suffix or '.bin'}"
        destination = output_assets / file_name
        if not destination.exists():
            destination.write_bytes(data)
        local_path = f"assets/{file_name}"
    rights_status, source_kind, allowed_roles = rights_for_asset(metadata, origin, data is not None)
    asset_kind = asset_kind_for(metadata, allowed_roles)
    mime_value = metadata.get("mimeType") or metadata.get("mime_type") or mimetypes.guess_type(original_path or url or "")[0]
    if mime_value not in {"image/png", "image/jpeg", "image/webp", "image/svg+xml"}:
        mime_value = None
        if rights_status in {"approved", "approved_with_credit"}:
            rights_status = "unknown"
    item = {
        "asset_id": asset_id,
        "asset_kind": asset_kind,
        "origin": origin,
        "source_document_id": (
            (metadata.get("documentIds") or [None])[0]
            if isinstance(metadata.get("documentIds"), list)
            else metadata.get("source_document_id")
        ),
        "file_path": local_path,
        "url": url,
        "sha256": sha,
        "mime_type": mime_value,
        "width": width,
        "height": height,
        "caption": metadata.get("caption") or metadata.get("description"),
        "alt_text": metadata.get("alt") or metadata.get("alt_text"),
        "source_ids": [source_ref] if source_ref else [],
        "source_kind": source_kind,
        "ownership": metadata.get("ownership") or metadata.get("provided_by") or "unknown",
        "rights_status": rights_status,
        "attribution_text": metadata.get("credit") or metadata.get("attribution_text"),
        "license_name": metadata.get("licenseName") or metadata.get("license_name"),
        "license_url": metadata.get("licenseUrl") or metadata.get("license_url"),
        "semantic_tags": sorted(set(filter(None, [
            str(metadata.get("assetType") or metadata.get("asset_type") or "image"),
            str(metadata.get("displayRole") or metadata.get("display_role") or ""),
            str(metadata.get("branchId") or ""),
            *(f"document:{value}" for value in (metadata.get("documentIds") or []) if value),
        ]))),
        "allowed_roles": allowed_roles,
        "depicts_real_event_or_case": any(
            token in str(metadata.get("assetType") or metadata.get("asset_type") or "").lower()
            for token in ("case_study", "customer_case", "case_proof", "real_event", "event_photo")
        ),
        "evidence_status": metadata.get("evidenceStatus") or ("verified_asset" if data is not None else "unverified_reference"),
        "content_status": metadata.get("contentStatus") or "visual_asset",
        "evidence_precision": "exact" if data is not None and sha else "source",
        "aliases": sorted(set(filter(None, [portable_original_path, metadata.get("id")]))),
    }
    assets.append(item)
    if sha:
        asset_by_sha[sha] = item
    return asset_id


def find_local_asset(raw_path: str, manifest_path: Path | None, assets_root: Path | None) -> Path | None:
    candidate = Path(raw_path).expanduser()
    if candidate.is_absolute() and candidate.is_file():
        return candidate.resolve()
    candidates: list[Path] = []
    if manifest_path:
        candidates.append(manifest_path.parent / candidate)
    if assets_root:
        candidates.append(assets_root / candidate)
        parts = candidate.parts
        if parts and parts[0] in {"visual_assets", "assets"}:
            candidates.append(assets_root / Path(*parts[1:]))
    for item in candidates:
        resolved = item.resolve()
        if resolved.is_file():
            return resolved
    return None


def iter_asset_records(value: Any, path: str = "") -> Iterable[tuple[str, dict[str, Any]]]:
    if isinstance(value, dict):
        raw_path = value.get("local_path") or value.get("file_path")
        url = value.get("source_asset_url") or value.get("source_url") or value.get("url")
        suffix = Path(str(raw_path or urlsplit(str(url or "")).path)).suffix.lower()
        if raw_path or suffix in IMAGE_SUFFIXES:
            yield path or "asset", value
        for key, child in value.items():
            if isinstance(child, (dict, list)):
                yield from iter_asset_records(child, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from iter_asset_records(child, f"{path}[{index}]")


def write_registry(output_dir: Path, brand: str, registry_type: str, items: list[dict[str, Any]]) -> Path:
    file_path = output_dir / f"S2_{safe_brand(brand)}_{registry_type}_registry.json"
    id_key = {"knowledge": "knowledge_id", "source": "source_id", "claim": "claim_id", "image": "asset_id"}[registry_type]
    array_key = {"knowledge": "knowledge_units", "source": "sources", "claim": "claims", "image": "images"}[registry_type]
    payload = {
        "schema_version": SCHEMA_VERSION,
        "registry_type": f"{registry_type}_registry",
        array_key: sorted(items, key=lambda item: str(item.get(id_key, ""))),
    }
    with file_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return file_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Adapt FrontMind canonical KB v4 and S1 into content registries")
    parser.add_argument("--brand", required=True)
    parser.add_argument("--kb", required=True, help="Canonical KB v4 ZIP or directory")
    parser.add_argument("--s1-facts")
    parser.add_argument("--s1-visual-manifest")
    parser.add_argument("--s1-assets-root")
    parser.add_argument("--gallery")
    parser.add_argument(
        "--publication-authorizations",
        help="v2 exact-set source_publication_authorizations.json; omit to keep all first-party sources internal_only",
    )
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--legacy-policy", choices=["quarantine", "reject"], default="quarantine")
    args = parser.parse_args()

    kb_path = Path(args.kb).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    output_assets = output_dir / "assets"
    warnings: list[str] = []
    fatal_errors: list[str] = []
    fingerprints: dict[str, str] = {}
    knowledge: list[dict[str, Any]] = []
    sources: dict[str, dict[str, Any]] = {}
    claims: list[dict[str, Any]] = []
    assets: list[dict[str, Any]] = []
    asset_by_sha: dict[str, dict[str, Any]] = {}
    mode = "unknown"
    manifest_summary: dict[str, Any] = {}

    try:
        reader = PackageReader(kb_path)
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        parser.error(str(exc))
    fingerprints["kb"] = reader.fingerprint
    try:
        if reader.manifest_name:
            manifest = json.loads(reader.read_text("00_package_manifest.json"))
            schema_version = manifest.get("schemaVersion")
            profile = manifest.get("profile")
            manifest_summary = {
                "schemaVersion": schema_version,
                "profile": profile,
                "buildRevision": manifest.get("buildRevision"),
                "documents": len(manifest.get("documents") or []),
                "assets": len(manifest.get("assets") or []),
            }
            if schema_version == CANONICAL_KB_VERSION and profile == CANONICAL_PROFILE:
                mode = "canonical_v4"
            elif schema_version == CANONICAL_KB_VERSION:
                mode = "incompatible_profile"
                fatal_errors.append(f"KB v4 profile must be {CANONICAL_PROFILE}, got {profile}")
            else:
                mode = "legacy_quarantine"
                message = f"KB manifest is not canonical v4: schemaVersion={schema_version}, profile={profile}"
                (fatal_errors if args.legacy_policy == "reject" else warnings).append(message)
        else:
            manifest = None
            mode = "legacy_quarantine"
            message = "KB has no 00_package_manifest.json; documents are quarantined"
            (fatal_errors if args.legacy_policy == "reject" else warnings).append(message)

        if mode == "canonical_v4":
            canonical_asset_ids: dict[str, str] = {}
            source_index = parse_source_index(reader.read_text("00_source_index.md")) if reader.exists("00_source_index.md") else {}
            source_ids: set[str] = set()
            for doc in manifest.get("documents") or []:
                source_ids.update(str(value) for value in doc.get("sourceIds") or [])
            for raw_id in sorted(source_ids):
                details = source_index.get(raw_id, {})
                add_source(
                    sources,
                    source_item(
                        kb_source_id(raw_id),
                        details.get("type", "first_party_document"),
                        details.get("description", raw_id),
                        "",
                        "kbv4",
                        "branch-level source index",
                        "branch",
                        file_path="sources/knowledge_base/00_source_index.md",
                        source_document_id=raw_id,
                        evidence_status="verified_first_party",
                        content_status="source_index",
                    ),
                )

            for doc in manifest.get("documents") or []:
                raw_path = str(doc.get("path") or "")
                if not raw_path or not reader.exists(raw_path):
                    fatal_errors.append(f"manifest document missing: {raw_path or doc.get('id')}")
                    continue
                raw_text = reader.read_text(raw_path)
                content = formal_content(raw_text)
                precision = normalize_precision(doc.get("evidence_precision") or ("branch" if doc.get("evidenceDocumentIds") else "none"))
                knowledge_id = kb_knowledge_id(str(doc.get("id")))
                raw_evidence_status = str(doc.get("evidenceStatus") or "unknown")
                raw_content_status = str(doc.get("contentStatus") or "unknown")
                item = {
                    "knowledge_id": knowledge_id,
                    "source_document_id": doc.get("id"),
                    "title": doc.get("title") or Path(raw_path).stem,
                    "kind": doc.get("kind") or "document",
                    "branch_id": doc.get("branchId"),
                    "content": content,
                    "package_path": f"sources/knowledge_base/{raw_path}",
                    "customer_visible": bool(doc.get("customerVisible")),
                    "source_ids": [kb_source_id(str(value)) for value in doc.get("sourceIds") or []],
                    "evidence_document_refs": [kb_knowledge_id(str(value)) for value in doc.get("evidenceDocumentIds") or []],
                    "asset_ids": [kb_asset_id(str(value)) for value in doc.get("assetIds") or []],
                    "origin": "kbv4",
                    "evidence_status": "verified" if raw_evidence_status.startswith("verified") else ("partial" if "partial" in raw_evidence_status else "unverified"),
                    "content_status": "customer_visible" if doc.get("customerVisible") else "internal_only",
                    "evidence_precision": precision,
                    "content_sha256": digest_bytes(content.encode("utf-8")),
                }
                knowledge.append(item)
                if item["customer_visible"]:
                    limited = raw_content_status == "limited_evidence"
                    qualified = limited or precision not in {"exact", "claim"}
                    claims.append({
                        "claim_id": stable_id("kbv4_claim", str(doc.get("id"))),
                        "claim_text": content,
                        "claim_type": "knowledge_statement",
                        "origin": "kbv4",
                        "knowledge_ids": [knowledge_id],
                        "source_ids": item["source_ids"],
                        "evidence_document_refs": item["evidence_document_refs"],
                        "evidence_status": raw_evidence_status,
                        "content_status": raw_content_status,
                        "evidence_precision": precision,
                        "evidence_excerpt": content,
                        "scope": raw_path,
                        "as_of": None,
                        "verification_status": "verified_with_limits" if qualified else "verified",
                        "allowed_usage": "public_with_qualification" if qualified else "public_fact",
                        "reason": "limited_evidence or non-claim-level support" if qualified else "claim-level evidence available",
                    })

            for raw_asset in manifest.get("assets") or []:
                raw_path = str(raw_asset.get("path") or "")
                if not raw_path or not reader.exists(raw_path):
                    fatal_errors.append(f"manifest asset missing: {raw_path or raw_asset.get('id')}")
                    continue
                data = reader.read_bytes(raw_path)
                actual_sha = digest_bytes(data)
                expected_sha = str(raw_asset.get("sha256") or "")
                if expected_sha and actual_sha != expected_sha:
                    fatal_errors.append(f"asset hash mismatch: {raw_path}")
                    continue
                page_url = str(raw_asset.get("sourcePageUrl") or "")
                source_ref = None
                if page_url:
                    source_ref = stable_id("kbv4_asset_source", normalize_url(page_url))
                    add_source(sources, source_item(source_ref, str(raw_asset.get("sourceKind") or "asset_source"), str(raw_asset.get("caption") or raw_path), page_url, "kbv4", raw_path, "document", source_document_id=str(raw_asset.get("id") or ""), evidence_status="verified_asset", content_status="visual_asset"))
                normalized_asset_id = add_asset(
                    assets,
                    asset_by_sha,
                    asset_id=kb_asset_id(str(raw_asset.get("id"))),
                    data=data,
                    original_path=raw_path,
                    url=str(raw_asset.get("sourceAssetUrl") or "") or None,
                    metadata=raw_asset,
                    origin="kbv4",
                    output_assets=output_assets,
                    source_ref=source_ref,
                )
                canonical_asset_ids[kb_asset_id(str(raw_asset.get("id")))] = normalized_asset_id
            for item in knowledge:
                item["asset_ids"] = sorted({canonical_asset_ids.get(value, value) for value in item.get("asset_ids") or []})
        else:
            for raw_path in sorted(name for name in reader.relative_names() if name.lower().endswith(".md")):
                content = formal_content(reader.read_text(raw_path))
                knowledge_id = stable_id("legacy_knowledge", raw_path)
                knowledge.append({
                    "knowledge_id": knowledge_id,
                    "title": Path(raw_path).stem,
                    "kind": "legacy_document",
                    "content": content,
                    "package_path": f"sources/knowledge_base/{raw_path}",
                    "customer_visible": False,
                    "source_ids": [],
                    "evidence_document_refs": [],
                    "asset_ids": [],
                    "origin": "legacy",
                    "evidence_status": "unverified",
                    "content_status": "blocked",
                    "evidence_precision": "none",
                    "content_sha256": digest_bytes(content.encode("utf-8")),
                })
                claims.append({
                    "claim_id": stable_id("legacy_claim", raw_path),
                    "claim_text": content,
                    "claim_type": "knowledge_statement",
                    "origin": "legacy",
                    "knowledge_ids": [knowledge_id],
                    "source_ids": [],
                    "evidence_document_refs": [],
                    "evidence_status": "unknown",
                    "content_status": "quarantined_legacy",
                    "evidence_precision": "none",
                    "evidence_excerpt": None,
                    "scope": raw_path,
                    "as_of": None,
                    "verification_status": "disallowed",
                    "allowed_usage": "do_not_use",
                    "reason": "Legacy material has no canonical evidence contract",
                })
    finally:
        reader.close()

    s1_facts_path = Path(args.s1_facts).expanduser().resolve() if args.s1_facts else None
    if s1_facts_path:
        try:
            s1_payload = load_json_file(s1_facts_path)
            if not isinstance(s1_payload, dict):
                raise ValueError("root must be an object")
            s1_fingerprint = digest_file(s1_facts_path)
            fingerprints["s1_facts"] = s1_fingerprint
            # S1 is a source artifact, not merely an ingest-time convenience.
            # Carry an immutable, safely named copy beside the registries so a
            # downstream Reference Pack can remain self-contained.
            s1_relative = f"sources/s1/facts_{s1_fingerprint[:12]}.json"
            s1_destination = output_dir / s1_relative
            s1_destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(s1_facts_path, s1_destination)
            claims.extend(build_s1_claims(s1_payload, sources, warnings, s1_relative))
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            fatal_errors.append(f"invalid S1 facts: {exc}")

    visual_manifest_path = Path(args.s1_visual_manifest).expanduser().resolve() if args.s1_visual_manifest else None
    assets_root = Path(args.s1_assets_root).expanduser().resolve() if args.s1_assets_root else None
    if visual_manifest_path:
        try:
            visual_payload = load_json_file(visual_manifest_path)
            fingerprints["s1_visual_manifest"] = digest_file(visual_manifest_path)
            for record_path, metadata in iter_asset_records(visual_payload):
                raw_path = str(metadata.get("local_path") or metadata.get("file_path") or "")
                url = str(metadata.get("source_asset_url") or metadata.get("source_url") or metadata.get("url") or "") or None
                local_file = find_local_asset(raw_path, visual_manifest_path, assets_root) if raw_path else None
                data = local_file.read_bytes() if local_file else None
                safe_raw_path = safe_path_reference(raw_path)
                if raw_path and not local_file:
                    warnings.append(f"S1 visual asset not found: {safe_raw_path or record_path}")
                source_ref = None
                if url:
                    source_ref = stable_id("s1_asset_source", normalize_url(url))
                    add_source(sources, source_item(source_ref, str(metadata.get("source_type") or "asset_source"), str(metadata.get("description") or record_path), url, "s1", record_path, "document"))
                add_asset(
                    assets,
                    asset_by_sha,
                    asset_id=stable_id("s1_asset", raw_path or url or record_path),
                    data=data,
                    original_path=raw_path or (str(local_file) if local_file else None),
                    url=url,
                    metadata=metadata,
                    origin="s1",
                    output_assets=output_assets,
                    source_ref=source_ref,
                )
        except (OSError, json.JSONDecodeError) as exc:
            fatal_errors.append(f"invalid S1 visual manifest: {exc}")

    if args.gallery:
        gallery = Path(args.gallery).expanduser().resolve()
        if not gallery.is_dir():
            fatal_errors.append(f"gallery directory does not exist: {gallery}")
        else:
            gallery_listing = []
            for path in sorted(item for item in gallery.rglob("*") if item.is_file() and item.suffix.lower() in IMAGE_SUFFIXES):
                data = path.read_bytes()
                rel = path.relative_to(gallery).as_posix()
                gallery_listing.append(f"{rel}:{digest_bytes(data)}")
                add_asset(
                    assets,
                    asset_by_sha,
                    asset_id=stable_id("gallery_asset", rel),
                    data=data,
                    original_path=rel,
                    url=None,
                    metadata={"provided_by": "client", "asset_type": "gallery_image"},
                    origin="client_gallery",
                    output_assets=output_assets,
                    source_ref=None,
                )
            fingerprints["gallery"] = digest_bytes("\n".join(gallery_listing).encode("utf-8"))

    # Publication consent is deliberately separate from knowledge intake.  A
    # first pass emits stable source IDs and a fillable template; a second pass
    # with --publication-authorizations rebuilds the registries atomically.
    candidate_ids = publication_candidate_ids(sources)
    authorization_summary: dict[str, Any] = {
        "status": "not_supplied",
        "candidate_source_ids": candidate_ids,
        "decisions": [],
    }
    authorization_path = (
        Path(args.publication_authorizations).expanduser().resolve()
        if args.publication_authorizations else None
    )
    if authorization_path:
        if not authorization_path.is_file():
            fatal_errors.append(f"publication authorizations file does not exist: {authorization_path.name}")
            authorization_summary["status"] = "invalid"
        else:
            try:
                authorization_payload = load_json_file(authorization_path)
                authorization_summary, authorization_errors = validate_and_apply_publication_authorizations(
                    authorization_payload,
                    brand=args.brand,
                    sources=sources,
                    candidate_ids=candidate_ids,
                )
                canonical_authorization_path = (
                    output_dir / f"S2_{safe_brand(args.brand)}_source_publication_authorizations.json"
                )
                if not authorization_errors:
                    if authorization_path != canonical_authorization_path.resolve():
                        shutil.copy2(authorization_path, canonical_authorization_path)
                    authorization_summary["file_name"] = canonical_authorization_path.name
                else:
                    authorization_summary["file_name"] = authorization_path.name
                authorization_summary["sha256"] = digest_file(authorization_path)
                fatal_errors.extend(authorization_errors)
            except (OSError, json.JSONDecodeError) as exc:
                fatal_errors.append(f"invalid publication authorizations: {exc}")
                authorization_summary["status"] = "invalid"
    template_path = output_dir / f"S2_{safe_brand(args.brand)}_source_publication_authorizations.template.json"
    with template_path.open("w", encoding="utf-8") as handle:
        json.dump(publication_authorization_template(args.brand, candidate_ids), handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    authorization_summary["template_file"] = template_path.name

    # Fail closed if normalization accidentally approved unsupported objects.
    source_by_id = sources
    for claim in claims:
        # Field-local evidence alignment downstream needs an explicit entity
        # anchor.  S2 only emits claims from this brand's KB/S1 materials, so
        # the canonical brand is the conservative minimum when the upstream
        # package does not provide a more specific offering/entity label.
        if not claim.get("about_entities"):
            claim["about_entities"] = [args.brand]
        if claim.get("allowed_usage") == "public_fact" and not claim.get("source_ids"):
            claim["allowed_usage"] = "internal_only"
            claim["verification_status"] = "needs_verification"
            claim["reason"] = "Adapter safety downgrade: approved claim has no source reference"
            warnings.append(f"downgraded unsupported claim: {claim.get('claim_id')}")
        internal_refs = sorted(
            source_id for source_id in claim.get("source_ids") or []
            if (source_by_id.get(source_id) or {}).get("source_origin_class") == "first_party_internal"
            or (source_by_id.get(source_id) or {}).get("publication_authorization") == "internal_only"
        )
        if claim.get("allowed_usage") in {"public_fact", "public_with_qualification"} and internal_refs:
            claim["allowed_usage"] = "internal_only"
            claim["verification_status"] = "needs_verification"
            claim["reason"] = f"Publication authorization required for first-party source_ids: {internal_refs}"
            warnings.append(f"downgraded claim pending first-party publication authorization: {claim.get('claim_id')}")
    for asset in assets:
        if asset.get("rights_status") in {"approved", "approved_with_credit"} and asset.get("origin") not in {"kbv4", "s1", "client_gallery"}:
            asset["rights_status"] = "unknown"

    registry_paths = {
        "knowledge": write_registry(output_dir, args.brand, "knowledge", knowledge),
        "source": write_registry(output_dir, args.brand, "source", list(sources.values())),
        "claim": write_registry(output_dir, args.brand, "claim", claims),
        "image": write_registry(output_dir, args.brand, "image", assets),
    }
    report = {
        "schema_version": SCHEMA_VERSION,
        "brand": args.brand,
        "generated_at": now_iso(),
        "mode": mode,
        "canonical": mode == "canonical_v4",
        "manifest": manifest_summary,
        "input_fingerprints": fingerprints,
        "publication_authorizations": authorization_summary,
        "registries": {key: path.name for key, path in registry_paths.items()},
        "counts": {"knowledge": len(knowledge), "sources": len(sources), "claims": len(claims), "images": len(assets)},
        "warnings": sorted(set(warnings)),
        "fatal_errors": sorted(set(fatal_errors)),
        "input_mode": "canonical_plus_s1" if s1_facts_path or visual_manifest_path else "canonical_direct",
        "formal_handoff_ready": mode == "canonical_v4" and not fatal_errors,
    }
    report_path = output_dir / f"S2_{safe_brand(args.brand)}_adapter_report.json"
    with report_path.open("w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps({"report": str(report_path), **report["counts"], "fatal_errors": len(fatal_errors), "warnings": len(set(warnings))}, ensure_ascii=False))
    return 2 if fatal_errors else 0


if __name__ == "__main__":
    sys.exit(main())
