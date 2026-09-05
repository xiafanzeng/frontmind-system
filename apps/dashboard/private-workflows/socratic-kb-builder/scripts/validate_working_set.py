#!/usr/bin/env python3
"""Validate the portable v5 working-set or leaf-patch ZIP contract."""

from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import pathlib
import re
import sys
import unicodedata
import urllib.parse
import zipfile

SHA256 = re.compile(r"^[a-f0-9]{64}$")
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$")
POLICY_PATH = pathlib.Path(__file__).resolve().parents[1] / "references" / "working-set-policy.json"
WORKING_SET_POLICY = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
if WORKING_SET_POLICY.get("schemaVersion") != 1:
    raise ValueError("unsupported working-set policy schema")
ARCHIVE_POLICY = WORKING_SET_POLICY["archive"]
EVIDENCE_POLICY = WORKING_SET_POLICY["evidence"]
AUTHORITY_POLICY = WORKING_SET_POLICY["authority"]
MAX_COMPRESSED = int(ARCHIVE_POLICY["maxCompressedBytes"])
MAX_UNCOMPRESSED = int(ARCHIVE_POLICY["maxUncompressedBytes"])
MAX_FILES = int(ARCHIVE_POLICY["maxEntryCount"])
MAX_COMPRESSION_RATIO = float(ARCHIVE_POLICY["maxCompressionRatio"])
MAX_ASSET_BYTES = int(ARCHIVE_POLICY["maxAssetBytes"])
TEXT_EVIDENCE_EXTENSIONS = frozenset(EVIDENCE_POLICY["textExtensions"])
TEXT_EVIDENCE_MIME_TYPES = frozenset(EVIDENCE_POLICY["textMimeTypes"])
RESEARCH_DIMENSION_IDS = (
    "enterprise_identity",
    "team_and_organization",
    "products_and_services",
    "capabilities_and_delivery",
    "industries_scenarios_and_cases",
    "differentiation_and_evidence",
    "cooperation_delivery_and_support",
)
FORBIDDEN_NODE_MARKER = re.compile(r"FRONTMIND_FORMAL_CONTENT_(?:START|END)")
FORBIDDEN_NODE_HEADING = re.compile(
    r"^\s*#{1,6}\s+(?:资料元数据|证据与核验说明|证据与核验|证据说明)\s*#*\s*$",
    re.MULTILINE,
)
FORBIDDEN_NODE_KEY = re.compile(
    r"^\s*(?:[-*+]\s+)?(?:documentRole|evidenceStatus|sourceIds|"
    r"evidenceDocumentIds|sameBranchEvidenceDocumentIds|evidenceCharacters|"
    r"formalCharacters|requiredFormalCharacters)\s*[:：=]",
    re.MULTILINE,
)
ASSET_TYPES = {
    "brand_identity",
    "product_ui",
    "product_diagram",
    "case_photo",
    "team_photo",
    "environment_photo",
    "certificate_badge",
    "document_figure",
    "customer_supplied",
    "other",
}
ASSET_DISPLAY_ROLES = {"hero", "inline", "badge"}


def fail(message: str) -> None:
    raise ValueError(message)


def normalized_media_type(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.split(";", 1)[0].strip().lower()
    return normalized or None


def is_text_evidence_path(value: str) -> bool:
    return pathlib.PurePosixPath(value).suffix.lower() in TEXT_EVIDENCE_EXTENSIONS


def evaluate_archive_policy(value: dict) -> bool:
    entries = value.get("entries")
    compressed_bytes = value.get("compressedBytes")
    if (
        isinstance(compressed_bytes, bool)
        or not isinstance(compressed_bytes, int)
        or not 0 < compressed_bytes <= MAX_COMPRESSED
        or not isinstance(entries, list)
        or not 1 <= len(entries) <= MAX_FILES
    ):
        return False
    total_uncompressed = 0
    for entry in entries:
        if not isinstance(entry, dict):
            return False
        compressed = entry.get("compressedBytes")
        uncompressed = entry.get("uncompressedBytes")
        if (
            isinstance(compressed, bool)
            or isinstance(uncompressed, bool)
            or not isinstance(compressed, int)
            or not isinstance(uncompressed, int)
            or compressed < 0
            or uncompressed < 0
        ):
            return False
        total_uncompressed += uncompressed
        if uncompressed > 0 and (
            compressed <= 0 or uncompressed / compressed > MAX_COMPRESSION_RATIO
        ):
            return False
    return total_uncompressed <= MAX_UNCOMPRESSED


def working_set_policy_probe(value: dict) -> dict:
    retained: list[str] = []
    dropped: list[str] = []
    warnings: list[dict] = []
    archive = value.get("archive")
    if archive is not None and (
        not isinstance(archive, dict) or not evaluate_archive_policy(archive)
    ):
        return {
            "accepted": False,
            "retained": retained,
            "dropped": dropped,
            "warnings": warnings,
            "hardFailure": "archiveSafety",
        }
    authority = value.get("authority")
    if isinstance(authority, dict) and authority.get("matches") is False:
        mode = authority.get("mode")
        field = authority.get("field")
        authority_mode = AUTHORITY_POLICY.get(mode, {})
        if field in authority_mode.get("hard", []):
            return {
                "accepted": False,
                "retained": retained,
                "dropped": dropped,
                "warnings": warnings,
                "hardFailure": field,
            }
        if field in authority_mode.get("serverOwned", []):
            warnings.append(
                dict(WORKING_SET_POLICY["warnings"]["serverCoordinateNormalized"])
            )
    evidence = value.get("evidence")
    if isinstance(evidence, dict):
        evidence_path = str(evidence.get("path", ""))
        media_type = normalized_media_type(evidence.get("mimeType"))
        if not is_text_evidence_path(evidence_path):
            dropped.append(evidence_path)
            warnings.append(dict(EVIDENCE_POLICY["optionalBinary"]["warning"]))
        elif (
            (media_type is not None and media_type not in TEXT_EVIDENCE_MIME_TYPES)
            or evidence.get("present") is False
            or evidence.get("digestMatches") is False
            or evidence.get("utf8") is False
            or evidence.get("nonEmpty") is False
        ):
            dropped.append(evidence_path)
            warnings.append(dict(EVIDENCE_POLICY["optionalInvalidText"]["warning"]))
        else:
            retained.append(evidence_path)
    return {
        "accepted": True,
        "retained": retained,
        "dropped": dropped,
        "warnings": warnings,
        "hardFailure": None,
    }


def add_diagnostic_warning(diagnostics: dict, warning: dict) -> None:
    if warning not in diagnostics["warnings"]:
        diagnostics["warnings"].append(dict(warning))


def record_evidence_drop(
    diagnostics: dict, evidence_path: str, warning: dict
) -> None:
    if evidence_path not in diagnostics["dropped"]:
        diagnostics["dropped"].append(evidence_path)
    add_diagnostic_warning(diagnostics, warning)


def safe_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        fail("unsafe path")
    path = pathlib.PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        fail("unsafe path")
    return value


def reject_duplicate_pairs(pairs: list[tuple[str, object]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def exact_json(value: str) -> object:
    return json.loads(value, object_pairs_hook=reject_duplicate_pairs)


def read_json(archive: zipfile.ZipFile, name: str) -> dict:
    try:
        text = archive.read(name).decode("utf-8-sig")
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"invalid {name}: {error}")
    try:
        value = exact_json(text)
    except (ValueError, json.JSONDecodeError):
        fenced = re.fullmatch(
            r"\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*",
            text,
            re.IGNORECASE,
        )
        if fenced is None or "```" in fenced.group(1):
            fail(f"invalid {name}")
        try:
            value = exact_json(fenced.group(1))
        except (ValueError, json.JSONDecodeError) as error:
            fail(f"invalid {name}: {error}")
    if isinstance(value, str):
        try:
            value = exact_json(value)
        except (ValueError, json.JSONDecodeError) as error:
            fail(f"invalid {name}: {error}")
        if isinstance(value, str):
            fail(f"invalid {name}: repeatedly serialized JSON")
    if not isinstance(value, dict):
        fail(f"{name} must be an object")
    return value


def declared_file(archive: zipfile.ZipFile, path: object, digest: object) -> str:
    name = safe_path(path)
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        fail(f"invalid sha256 for {name}")
    try:
        payload = archive.read(name)
    except KeyError:
        fail(f"missing {name}")
    if hashlib.sha256(payload).hexdigest() != digest:
        fail(f"sha256 mismatch for {name}")
    return name


def optional_declared_file(
    archive: zipfile.ZipFile, path: object, digest: object
) -> tuple[str, bytes | None, bool]:
    """Bind a safe optional component without upgrading its quality to ZIP failure."""
    name = safe_path(path)
    try:
        payload = archive.read(name)
    except KeyError:
        return name, None, False
    valid_digest = isinstance(digest, str) and SHA256.fullmatch(digest)
    matches = bool(valid_digest) and hashlib.sha256(payload).hexdigest() == digest
    return name, payload, matches


def detected_image_mime(payload: bytes) -> str | None:
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if payload.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if payload.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP":
        return "image/webp"
    if len(payload) >= 16 and payload[4:8] == b"ftyp" and (
        b"avif" in payload[8:32] or b"avis" in payload[8:32]
    ):
        return "image/avif"
    return None


def require_expected(expected: dict, names: tuple[str, ...]) -> None:
    missing = [name for name in names if expected.get(name) is None]
    if missing:
        fail(f"missing expected coordinate flags: {', '.join(missing)}")


def exact_coordinate(manifest: dict, key: str, expected: object) -> None:
    if manifest.get(key) != expected:
        fail(f"{key} does not match the expected task coordinate")


def canonical_company_name(value: object) -> str:
    if not isinstance(value, str):
        fail("invalid company name")
    normalized = " ".join(unicodedata.normalize("NFKC", value).split())
    if not normalized or len(normalized) > 255:
        fail("invalid company name")
    return normalized


def canonical_company_website(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        fail("invalid company website")
    raw = unicodedata.normalize("NFKC", value).strip()
    if not raw:
        return None
    if (
        len(raw) > 2048
        or raw.startswith("//")
        or "\n" in raw
        or "\r" in raw
        or "#" in raw
    ):
        fail("invalid company website")
    candidate = raw if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", raw) else f"https://{raw}"
    authority = re.split(r"[/?#]", candidate.split("://", 1)[1], maxsplit=1)[0]
    if not authority or "@" in authority:
        fail("invalid company website")
    try:
        parsed = urllib.parse.urlsplit(candidate)
        raw_hostname = urllib.parse.unquote(parsed.hostname or "")
        port = parsed.port
    except (UnicodeError, ValueError):
        fail("invalid company website")

    # WHATWG URL uses non-transitional IDNA. Python's built-in `idna` codec is
    # IDNA 2003 and would incorrectly collapse e.g. `faß.de` to `fass.de`.
    # Normalize each Unicode label and encode it directly with Punycode so the
    # frozen Dashboard hostname (`xn--fa-hia.de`) and Provider Unicode spelling
    # converge without depending on a non-stdlib package in the Skill runtime.
    normalized_hostname = (
        unicodedata.normalize("NFKC", raw_hostname)
        .replace("\u3002", ".")
        .replace("\uff0e", ".")
        .replace("\uff61", ".")
        .lower()
    )
    try:
        if ":" in normalized_hostname:
            hostname = ipaddress.IPv6Address(normalized_hostname).compressed
        else:
            labels = normalized_hostname.split(".")
            encoded_labels: list[str] = []
            for label in labels:
                if not label:
                    encoded_labels.append("")
                    continue
                if any(character.isspace() or unicodedata.category(character).startswith("C") for character in label):
                    fail("invalid company website")
                try:
                    ascii_label = label.encode("ascii").decode("ascii")
                except UnicodeEncodeError:
                    ascii_label = f"xn--{label.encode('punycode').decode('ascii')}"
                if len(ascii_label) > 63:
                    fail("invalid company website")
                encoded_labels.append(ascii_label)
            hostname = ".".join(encoded_labels)
    except (UnicodeError, ValueError):
        fail("invalid company website")
    if (
        parsed.scheme not in ("http", "https")
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        fail("invalid company website")
    if (parsed.scheme == "http" and port == 80) or (parsed.scheme == "https" and port == 443):
        port = None
    host = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname
    netloc = f"{host}:{port}" if port is not None else host
    return urllib.parse.urlunsplit(
        (parsed.scheme, netloc, parsed.path or "/", parsed.query, "")
    )


def expected_company_identity(value: str | None) -> dict:
    if not value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        fail("invalid --expected-company-base64url")
    try:
        padding = "=" * ((4 - len(value) % 4) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(value + padding))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        fail("invalid --expected-company-base64url")
    if not isinstance(decoded, dict) or set(decoded) != {"name", "website"}:
        fail("invalid --expected-company-base64url")
    name = canonical_company_name(decoded.get("name"))
    website = decoded.get("website")
    if website is not None:
        if not isinstance(website, str) or canonical_company_website(website) != website:
            fail("invalid frozen company website")
    return {"name": name, "website": website}


def positive_integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        fail(f"invalid {label}")
    return value


def bounded_integer(value: object, label: str, maximum: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > maximum
    ):
        fail(f"{label} must be an integer between 0 and {maximum}")
    return value


def exact_object_keys(
    value: object,
    required: set[str],
    label: str,
    optional: set[str] | None = None,
) -> dict:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    allowed = required | (optional or set())
    if not required.issubset(value) or not set(value).issubset(allowed):
        fail(f"{label} fields do not match the contract")
    return value


def validate_asset_fields(value: object, label: str) -> dict:
    required = {
        "assetId", "path", "sha256", "mimeType", "bytes", "width",
        "height", "provenance", "documentIds",
    }
    if not isinstance(value, dict) or not required.issubset(value):
        fail(f"{label} fields do not match the contract")
    asset_type = value.get("assetType")
    display_role = value.get("displayRole")
    caption = value.get("caption")
    # Presentation fields are deliberately soft. Known values survive the
    # Dashboard canonicalizer; unknown values and unknown extra fields are
    # dropped there instead of rejecting otherwise safe bytes.
    if asset_type is not None and asset_type not in ASSET_TYPES:
        pass
    if display_role is not None and display_role not in ASSET_DISPLAY_ROLES:
        pass
    if caption is not None and not isinstance(caption, str):
        pass
    if not isinstance(value.get("provenance"), dict):
        fail(f"{label}.provenance must be an object")
    if not isinstance(value.get("documentIds"), list):
        fail(f"{label}.documentIds must be an array")
    return value


def customer_markdown_title(
    payload: bytes, label: str, expected_title: object | None = None
) -> str:
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError:
        fail(f"{label} must be UTF-8 Markdown")
    text = unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n")
    if (
        FORBIDDEN_NODE_MARKER.search(text)
        or FORBIDDEN_NODE_HEADING.search(text)
        or FORBIDDEN_NODE_KEY.search(text)
    ):
        fail(f"{label} contains internal workflow content")
    lines = text.split("\n")
    first_index = next((index for index, line in enumerate(lines) if line.strip()), None)
    if first_index is None:
        fail(f"{label} is empty")
    title_match = re.fullmatch(r"#\s+(.+?)\s*", lines[first_index])
    if not title_match:
        fail(f"{label} must start with one non-empty level-one title")
    title = title_match.group(1).strip()
    if not title:
        fail(f"{label} title is empty")
    body_lines = lines[first_index + 1 :]
    if any(re.match(r"^#\s+", line) for line in body_lines):
        fail(f"{label} contains more than one level-one title")
    body = "\n".join(body_lines).strip()
    if not body or not any(character.isalnum() for character in body):
        fail(f"{label} body is empty")
    if expected_title is not None:
        if not isinstance(expected_title, str) or not expected_title.strip():
            fail(f"{label} manifest title is invalid")
        manifest_title = unicodedata.normalize("NFC", expected_title.strip())
        if title != manifest_title:
            fail(f"{label} title does not match its manifest leaf")
    return title


def research_leaf_ids(value: object, leaf_ids: set[str], label: str) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 115:
        fail(f"{label} must contain 1-115 leaf ids")
    normalized = [item.strip() if isinstance(item, str) else "" for item in value]
    if (
        any(not leaf_id or leaf_id not in leaf_ids for leaf_id in normalized)
        or len(set(normalized)) != len(normalized)
    ):
        fail(f"{label} contains an unknown or duplicate leaf id")
    return normalized


def validate_research_coverage(
    value: object,
    leaf_ids: set[str],
    expected_uploads_read: int,
    evidence_source_count: int,
) -> None:
    coverage = exact_object_keys(
        value,
        {
            "officialPages", "publicQueries", "officialDocuments", "uploadsRead",
            "sourceCount", "productFamilies", "dimensions", "stopReason",
        },
        "researchCoverage",
        {"limitationReason"},
    )
    pages = exact_object_keys(
        coverage.get("officialPages"),
        {"discovered", "attempted", "succeeded", "failed"},
        "researchCoverage.officialPages",
    )
    discovered = bounded_integer(
        pages.get("discovered"), "researchCoverage.officialPages.discovered", 10_000
    )
    attempted = bounded_integer(
        pages.get("attempted"), "researchCoverage.officialPages.attempted", 200
    )
    succeeded = bounded_integer(
        pages.get("succeeded"), "researchCoverage.officialPages.succeeded", 120
    )
    failed = bounded_integer(
        pages.get("failed"), "researchCoverage.officialPages.failed", 200
    )
    if attempted > discovered or succeeded + failed != attempted:
        fail("researchCoverage official-page arithmetic is inconsistent")
    public_queries = bounded_integer(
        coverage.get("publicQueries"), "researchCoverage.publicQueries", 30
    )
    official_documents = bounded_integer(
        coverage.get("officialDocuments"), "researchCoverage.officialDocuments", 30
    )
    uploads_read = bounded_integer(
        coverage.get("uploadsRead"), "researchCoverage.uploadsRead", 100
    )
    source_count = bounded_integer(
        coverage.get("sourceCount"), "researchCoverage.sourceCount", 2_000
    )
    if public_queries < 6:
        fail("researchCoverage.publicQueries must be at least 6")
    if source_count < 1:
        fail("researchCoverage.sourceCount must be at least 1")
    if uploads_read != expected_uploads_read:
        fail("researchCoverage.uploadsRead does not match the expected customer uploads")
    if source_count != evidence_source_count:
        fail("researchCoverage.sourceCount must equal the retained evidence ledger")

    families = coverage.get("productFamilies")
    if not isinstance(families, list) or not 1 <= len(families) <= 115:
        fail("researchCoverage.productFamilies must contain 1-115 families")
    family_ids: list[str] = []
    for index, raw_family in enumerate(families):
        family = exact_object_keys(
            raw_family,
            {"id", "name", "leafIds"},
            f"researchCoverage.productFamilies[{index}]",
        )
        family_id = family.get("id").strip() if isinstance(family.get("id"), str) else ""
        family_name = family.get("name").strip() if isinstance(family.get("name"), str) else ""
        if not family_id or len(family_id) > 191 or not family_name or len(family_name) > 255:
            fail(f"researchCoverage.productFamilies[{index}] has an invalid id or name")
        research_leaf_ids(
            family.get("leafIds"),
            leaf_ids,
            f"researchCoverage.productFamilies[{index}].leafIds",
        )
        family_ids.append(family_id)
    if len(set(family_ids)) != len(family_ids):
        fail("researchCoverage.productFamilies contains duplicate ids")

    dimensions = coverage.get("dimensions")
    if not isinstance(dimensions, list) or len(dimensions) != len(RESEARCH_DIMENSION_IDS):
        fail("researchCoverage.dimensions must contain the seven business dimensions")
    dimension_ids: list[str] = []
    for index, raw_dimension in enumerate(dimensions):
        dimension = exact_object_keys(
            raw_dimension,
            {"id", "status", "leafIds"},
            f"researchCoverage.dimensions[{index}]",
        )
        dimension_id = dimension.get("id")
        if dimension_id not in RESEARCH_DIMENSION_IDS:
            fail(f"researchCoverage.dimensions[{index}].id is invalid")
        if dimension.get("status") not in {"covered", "gap"}:
            fail(f"researchCoverage.dimensions[{index}].status is invalid")
        research_leaf_ids(
            dimension.get("leafIds"),
            leaf_ids,
            f"researchCoverage.dimensions[{index}].leafIds",
        )
        dimension_ids.append(dimension_id)
    if set(dimension_ids) != set(RESEARCH_DIMENSION_IDS) or len(set(dimension_ids)) != len(dimension_ids):
        fail("researchCoverage.dimensions must cover each business dimension exactly once")

    stop_reason = coverage.get("stopReason")
    if stop_reason not in {"coverage_complete", "source_limited", "budget_reached"}:
        fail("researchCoverage.stopReason is invalid")
    raw_limitation = coverage.get("limitationReason")
    limitation = raw_limitation.strip() if isinstance(raw_limitation, str) else None
    if "limitationReason" in coverage and not limitation:
        fail("researchCoverage.limitationReason cannot be empty")
    if limitation and len(limitation) > 2_000:
        fail("researchCoverage.limitationReason is too long")
    if stop_reason == "coverage_complete":
        if succeeded < 12 or limitation:
            fail("coverage_complete requires at least 12 successful official pages and no limitationReason")
    elif stop_reason == "source_limited":
        if attempted != discovered or not limitation or len(limitation) < 8:
            fail("source_limited requires an exhausted official-page queue and a specific limitationReason")
    elif (
        succeeded < 12
        or not limitation
        or len(limitation) < 8
        or not (
            succeeded == 120
            or attempted == 200
            or public_queries == 30
            or official_documents == 30
        )
    ):
        fail("budget_reached requires sufficient official coverage, a reached budget cap and a specific limitationReason")


def validate_bundle(
    archive: zipfile.ZipFile, manifest: dict, expected: dict, diagnostics: dict
) -> set[str]:
    require_expected(
        expected,
        (
            "operation_id",
            "build_id",
            "generation",
            "content_version",
            "skill_content_hash",
            "tree_policy_version",
            "company_identity",
            "uploads_read",
        ),
    )
    required = {
        "kind", "schemaVersion", "operationId", "buildId", "generation",
        "contentVersion", "skill", "treePolicyVersion", "company",
        "researchCoverage", "branches", "evidenceLedger", "leaves", "assets", "logo", "counts",
    }
    if set(manifest) != required:
        fail("BUNDLE.json fields do not match the contract")
    if manifest.get("kind") != "frontmind.kb-working-set" or manifest.get("schemaVersion") != 1:
        fail("invalid bundle identity")
    exact_coordinate(manifest, "operationId", expected["operation_id"])
    coordinate_warning = WORKING_SET_POLICY["warnings"]["serverCoordinateNormalized"]
    for key, expected_key in (
        ("buildId", "build_id"),
        ("generation", "generation"),
        ("contentVersion", "content_version"),
        ("treePolicyVersion", "tree_policy_version"),
    ):
        if manifest.get(key) != expected[expected_key]:
            add_diagnostic_warning(diagnostics, coordinate_warning)
    if expected["content_version"] != 1:
        fail("initial contentVersion must be 1")
    skill = manifest.get("skill")
    expected_skill = {
        "name": "socratic-kb-builder",
        "version": "5",
        "contentHash": expected["skill_content_hash"],
    }
    if skill != expected_skill:
        add_diagnostic_warning(diagnostics, coordinate_warning)
    if expected["tree_policy_version"] != 2:
        fail("treePolicyVersion must be 2")
    company = manifest.get("company")
    try:
        actual_company = {
            "name": canonical_company_name(company.get("name")),
            "website": canonical_company_website(company.get("website")),
        }
    except (AttributeError, TypeError, ValueError):
        actual_company = None
    if actual_company != expected["company_identity"]:
        add_diagnostic_warning(diagnostics, coordinate_warning)
    leaves = manifest.get("leaves")
    branches = manifest.get("branches")
    assets = manifest.get("assets")
    if not isinstance(leaves, list) or not 30 <= len(leaves) <= 115:
        fail("bundle must contain 30-115 leaves")
    if not isinstance(branches, list) or not branches:
        fail("bundle branches are missing")
    if not isinstance(assets, list) or len(assets) > 100:
        fail("bundle assets are invalid")
    declared = {"BUNDLE.json"}
    branch_map: dict[str, str] = {}
    for index, branch in enumerate(branches):
        if not isinstance(branch, dict) or set(branch) != {"branchId", "title", "ordinal"}:
            fail("invalid branch")
        if branch.get("ordinal") != index or not SAFE_ID.fullmatch(str(branch.get("branchId", ""))):
            fail("branch order/id is invalid")
        branch_map[branch["branchId"]] = str(branch.get("title", ""))
    leaf_ids: set[str] = set()
    asset_refs: dict[str, set[str]] = {}
    ledger = manifest.get("evidenceLedger")
    if not isinstance(ledger, list):
        fail("bundle evidenceLedger is missing")
    evidence_by_path: dict[str, dict] = {}
    skipped_binary_evidence_paths: set[str] = set()
    for entry in ledger:
        required_evidence = {"path", "sha256", "leafId", "sourceUrl", "retrievedAt"}
        if not isinstance(entry, dict) or set(entry) != required_evidence:
            fail("invalid evidence ledger entry")
        name = safe_path(entry.get("path"))
        if not is_text_evidence_path(name):
            # The consumer contract classifies optional evidence before UTF-8
            # decoding and removes binary copies from the canonical ledger.
            # A producer may therefore validate a content-first result without
            # interpreting, hashing or publishing those copied bytes.
            if name in skipped_binary_evidence_paths or name in evidence_by_path:
                fail("evidence path is duplicate")
            try:
                archive.getinfo(name)
            except KeyError:
                # Missing optional evidence is also removed by the consumer.
                pass
            else:
                declared.add(name)
            skipped_binary_evidence_paths.add(name)
            record_evidence_drop(
                diagnostics,
                name,
                EVIDENCE_POLICY["optionalBinary"]["warning"],
            )
            continue
        name, payload, matches = optional_declared_file(
            archive, name, entry.get("sha256")
        )
        try:
            evidence_text = payload.decode("utf-8") if payload is not None else ""
        except UnicodeDecodeError:
            evidence_text = ""
        if name in evidence_by_path:
            fail("evidence path is duplicate")
        if payload is None or not matches or not evidence_text.strip():
            if payload is not None:
                declared.add(name)
            skipped_binary_evidence_paths.add(name)
            record_evidence_drop(
                diagnostics,
                name,
                EVIDENCE_POLICY["optionalInvalidText"]["warning"],
            )
            continue
        evidence_by_path[name] = entry
        diagnostics["retained"].append(name)
    for index, leaf in enumerate(leaves):
        required_leaf = {
            "leafId", "branchId", "branchTitle", "title", "ordinal",
            "contentPath", "contentSha256", "evidencePaths", "assetIds",
        }
        if not isinstance(leaf, dict) or not required_leaf.issubset(leaf) or not set(leaf).issubset(required_leaf | {"productFamilyId"}):
            fail("invalid leaf")
        leaf_id = str(leaf.get("leafId", ""))
        if leaf.get("ordinal") != index or not SAFE_ID.fullmatch(leaf_id) or leaf_id in leaf_ids:
            fail("leaf order/id is invalid")
        leaf_ids.add(leaf_id)
        if branch_map.get(str(leaf.get("branchId", ""))) != leaf.get("branchTitle"):
            fail("leaf branch does not resolve")
        content_path = declared_file(archive, leaf.get("contentPath"), leaf.get("contentSha256"))
        content_parts = pathlib.PurePosixPath(content_path).parts
        if (
            content_path in declared
            or len(content_parts) != 2
            or content_parts[0] != "nodes"
            or not content_parts[1].endswith(".md")
        ):
            fail("leaf body is duplicate or empty")
        customer_markdown_title(
            archive.read(content_path),
            f"leaf {leaf_id} body",
            leaf.get("title"),
        )
        declared.add(content_path)
        evidence_paths = leaf.get("evidencePaths")
        if not isinstance(evidence_paths, list):
            fail("leaf evidencePaths is invalid")
        for evidence_path in evidence_paths:
            name = safe_path(evidence_path)
            if name in skipped_binary_evidence_paths:
                # Keep the physical optional byte accounted for, but do not
                # require it to resolve into the canonical text ledger.
                continue
            if name in declared:
                fail("evidence path is duplicated")
            if evidence_by_path.get(name, {}).get("leafId") != leaf_id:
                fail("evidence ledger does not resolve to the leaf")
            declared.add(name)
        refs = leaf.get("assetIds")
        if not isinstance(refs, list) or any(not SAFE_ID.fullmatch(str(value)) for value in refs):
            fail("leaf assetIds is invalid")
        for asset_id in refs:
            asset_refs.setdefault(str(asset_id), set()).add(leaf_id)
    asset_ids: set[str] = set()
    for asset_index, raw_asset in enumerate(assets):
        asset = validate_asset_fields(raw_asset, f"assets[{asset_index}]")
        asset_id = str(asset.get("assetId", ""))
        if not SAFE_ID.fullmatch(asset_id) or asset_id in asset_ids:
            fail("asset id is invalid")
        asset_ids.add(asset_id)
        name = declared_file(archive, asset.get("path"), asset.get("sha256"))
        payload = archive.read(name)
        if (
            name in declared
            or asset.get("bytes") != len(payload)
            or len(payload) > MAX_ASSET_BYTES
        ):
            fail("asset path/size is invalid")
        declared.add(name)
        document_ids = asset.get("documentIds")
        if not isinstance(document_ids, list) or set(map(str, document_ids)) != asset_refs.get(asset_id, set()):
            fail("asset documentIds are not bidirectional")
    if set(evidence_by_path) != {
        path
        for path in declared
        if path.startswith("evidence/")
        and path not in skipped_binary_evidence_paths
    }:
        fail("evidence ledger contains an unreferenced file")
    if asset_ids != set(asset_refs):
        fail("leaf asset reference does not resolve")
    validate_research_coverage(
        manifest.get("researchCoverage"),
        leaf_ids,
        expected["uploads_read"],
        len(evidence_by_path),
    )
    counts = manifest.get("counts")
    if counts != {"leaves": len(leaves), "evidenceFiles": len(evidence_by_path), "assets": len(assets)}:
        fail("bundle counts are invalid")
    logo = manifest.get("logo")
    if not isinstance(logo, dict) or set(logo) != {"status", "assetId"}:
        fail("logo state is invalid")
    if logo.get("status") == "available":
        if logo.get("assetId") not in asset_ids:
            fail("logo asset does not resolve")
    elif logo != {"status": "missing", "assetId": None}:
        fail("logo state is invalid")
    return declared


def validate_patch(
    archive: zipfile.ZipFile, manifest: dict, expected: dict, diagnostics: dict
) -> set[str]:
    require_expected(
        expected,
        (
            "operation_id",
            "build_id",
            "generation",
            "base_content_version",
            "base_working_set_sha256",
            "target_leaf_id",
        ),
    )
    required = {
        "kind", "schemaVersion", "operationId", "buildId", "generation",
        "baseContentVersion", "baseWorkingSetSha256", "targetLeafId",
        "contentPath", "contentSha256", "evidence", "assets",
    }
    if set(manifest) != required:
        fail("PATCH.json fields do not match the contract")
    if manifest.get("kind") != "frontmind.kb-node-patch" or manifest.get("schemaVersion") != 1:
        fail("invalid patch identity")
    exact_coordinate(manifest, "operationId", expected["operation_id"])
    coordinate_warning = WORKING_SET_POLICY["warnings"]["serverCoordinateNormalized"]
    for key, expected_key in (
        ("buildId", "build_id"),
        ("generation", "generation"),
        ("baseContentVersion", "base_content_version"),
    ):
        if manifest.get(key) != expected[expected_key]:
            add_diagnostic_warning(diagnostics, coordinate_warning)
    exact_coordinate(
        manifest,
        "baseWorkingSetSha256",
        expected["base_working_set_sha256"],
    )
    exact_coordinate(manifest, "targetLeafId", expected["target_leaf_id"])
    target = str(manifest.get("targetLeafId", ""))
    if not SAFE_ID.fullmatch(target) or not SHA256.fullmatch(str(manifest.get("baseWorkingSetSha256", ""))):
        fail("invalid patch coordinates")
    declared = {"PATCH.json"}
    body, body_payload, body_matches = optional_declared_file(
        archive, manifest.get("contentPath"), manifest.get("contentSha256")
    )
    if body_payload is not None:
        declared.add(body)
    if body_payload is not None and body_matches:
        try:
            customer_markdown_title(body_payload, "patch body")
        except ValueError:
            # Dashboard retains the previous body when this component is bad.
            pass
    evidence = manifest.get("evidence")
    assets = manifest.get("assets")
    if not isinstance(evidence, dict) or set(evidence) != {"add", "remove"}:
        fail("patch evidence delta is invalid")
    if not isinstance(assets, dict) or set(assets) != {"add", "remove"}:
        fail("patch asset delta is invalid")
    evidence_add = evidence.get("add")
    evidence_remove = evidence.get("remove")
    assets_add = assets.get("add")
    assets_remove = assets.get("remove")
    if not all(
        isinstance(value, list)
        for value in (evidence_add, evidence_remove, assets_add, assets_remove)
    ):
        fail("patch component deltas must be arrays")
    evidence_add_paths: list[str] = []
    for item in evidence_add:
        if not isinstance(item, dict) or set(item) != {"path", "sha256"}:
            fail("patch evidence addition is invalid")
        name, payload, _matches = optional_declared_file(
            archive, item.get("path"), item.get("sha256")
        )
        prefix = f"evidence/{target}/"
        if not name.startswith(prefix) or name in evidence_add_paths:
            fail("patch evidence is outside the target leaf")
        valid_text = is_text_evidence_path(name)
        if payload is not None and valid_text:
            try:
                valid_text = bool(payload.decode("utf-8").strip())
            except UnicodeDecodeError:
                valid_text = False
        if payload is None or not _matches or not valid_text:
            record_evidence_drop(
                diagnostics,
                name,
                EVIDENCE_POLICY["optionalInvalidText"]["warning"],
            )
        else:
            diagnostics["retained"].append(name)
        evidence_add_paths.append(name)
        if payload is not None:
            declared.add(name)
    normalized_evidence_remove = [safe_path(value) for value in evidence_remove]
    if (
        len(set(normalized_evidence_remove)) != len(normalized_evidence_remove)
        or set(evidence_add_paths).intersection(normalized_evidence_remove)
    ):
        fail("patch evidence delta is duplicated or conflicting")

    asset_ids: list[str] = []
    asset_paths: list[str] = []
    for asset_index, raw_asset in enumerate(assets_add):
        asset = validate_asset_fields(
            raw_asset, f"assets.add[{asset_index}]"
        )
        if set(asset.get("documentIds", [])) != {target}:
            fail("patch asset is outside the target leaf")
        asset_id = asset.get("assetId")
        if not isinstance(asset_id, str) or not SAFE_ID.fullmatch(asset_id):
            fail("patch asset id is invalid")
        name, payload, matches = optional_declared_file(
            archive, asset.get("path"), asset.get("sha256")
        )
        if asset_id in asset_ids or name in asset_paths:
            fail("patch asset identity is duplicated")
        asset_ids.append(asset_id)
        asset_paths.append(name)
        provenance = asset.get("provenance", {})
        claims_frozen = (
            asset.get("assetType") == "customer_supplied"
            or provenance.get("sourceKind") == "user_upload"
            or "originalUploadSha256" in provenance
            or "sourceUploadSha256" in provenance
        )
        actual_sha256 = hashlib.sha256(payload).hexdigest() if payload else None
        declared_mime = (
            asset.get("mimeType", "").split(";", 1)[0].strip().lower()
            if isinstance(asset.get("mimeType"), str)
            else ""
        )
        claimed_source_hashes = [
            provenance.get(key)
            for key in ("originalUploadSha256", "sourceUploadSha256")
            if key in provenance
        ]
        if claims_frozen and (
            payload is None
            or not matches
            or isinstance(asset.get("bytes"), bool)
            or not isinstance(asset.get("bytes"), int)
            or asset.get("bytes") != len(payload)
            or detected_image_mime(payload) != declared_mime
            or any(claimed != actual_sha256 for claimed in claimed_source_hashes)
        ):
            fail("frozen patch asset bytes do not match its declaration")
        if payload is not None:
            declared.add(name)
    normalized_assets_remove = []
    for value in assets_remove:
        if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
            fail("patch asset removal id is invalid")
        normalized_assets_remove.append(value)
    if (
        len(set(normalized_assets_remove)) != len(normalized_assets_remove)
        or set(asset_ids).intersection(normalized_assets_remove)
    ):
        fail("patch asset delta is duplicated or conflicting")
    return declared


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Validate a FrontMind working-set or leaf-patch ZIP against "
            "frozen task coordinates."
        )
    )
    parser.add_argument("--expected-operation-id")
    parser.add_argument("--expected-build-id")
    parser.add_argument("--expected-generation", type=int)
    parser.add_argument("--expected-content-version", type=int)
    parser.add_argument("--expected-skill-content-hash")
    parser.add_argument("--expected-tree-policy-version", type=int)
    parser.add_argument("--expected-company-base64url")
    parser.add_argument("--expected-uploads-read", type=int)
    parser.add_argument("--expected-base-content-version", type=int)
    parser.add_argument("--expected-base-working-set-sha256")
    parser.add_argument("--expected-target-leaf-id")
    parser.add_argument("--diagnostics-json", action="store_true")
    parser.add_argument("archive")
    args = parser.parse_args()
    expected = {
        "operation_id": args.expected_operation_id,
        "build_id": args.expected_build_id,
        "generation": args.expected_generation,
        "content_version": args.expected_content_version,
        "skill_content_hash": args.expected_skill_content_hash,
        "tree_policy_version": args.expected_tree_policy_version,
        "company_identity": expected_company_identity(args.expected_company_base64url)
        if args.expected_company_base64url
        else None,
        "uploads_read": args.expected_uploads_read,
        "base_content_version": args.expected_base_content_version,
        "base_working_set_sha256": args.expected_base_working_set_sha256,
        "target_leaf_id": args.expected_target_leaf_id,
    }
    for key in ("operation_id", "build_id"):
        value = expected[key]
        if value is not None and not SAFE_ID.fullmatch(value):
            fail(f"invalid --expected-{key.replace('_', '-')}")
    for key in (
        "generation",
        "content_version",
        "tree_policy_version",
        "base_content_version",
    ):
        value = expected[key]
        if value is not None:
            positive_integer(value, f"--expected-{key.replace('_', '-')}")
    if expected["skill_content_hash"] is not None and not SHA256.fullmatch(
        expected["skill_content_hash"]
    ):
        fail("invalid --expected-skill-content-hash")
    if expected["base_working_set_sha256"] is not None and not SHA256.fullmatch(
        expected["base_working_set_sha256"]
    ):
        fail("invalid --expected-base-working-set-sha256")
    if expected["target_leaf_id"] is not None and not SAFE_ID.fullmatch(
        expected["target_leaf_id"]
    ):
        fail("invalid --expected-target-leaf-id")
    if expected["uploads_read"] is not None:
        bounded_integer(
            expected["uploads_read"], "--expected-uploads-read", 100
        )
    archive_path = pathlib.Path(args.archive)
    compressed_archive_bytes = archive_path.stat().st_size
    if not 0 < compressed_archive_bytes <= MAX_COMPRESSED:
        fail("archive compressed bytes are invalid")
    diagnostics = {"retained": [], "dropped": [], "warnings": []}
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if not 1 <= len(entries) <= MAX_FILES:
            fail("archive file count is invalid")
        if sum(item.file_size for item in entries) > MAX_UNCOMPRESSED:
            fail("archive is too large")
        names: set[str] = set()
        portable_names: set[str] = set()
        for item in entries:
            name = safe_path(item.filename)
            portable_name = unicodedata.normalize("NFC", name).lower()
            if (
                item.is_dir()
                or name in names
                or portable_name in portable_names
                or item.flag_bits & 1
                or (item.external_attr >> 16) & 0o170000 == 0o120000
            ):
                fail("archive contains an unsafe entry")
            if item.file_size > 0 and (
                item.compress_size <= 0
                or item.file_size / item.compress_size > MAX_COMPRESSION_RATIO
            ):
                fail("archive compression ratio is invalid")
            names.add(name)
            portable_names.add(portable_name)
        if "BUNDLE.json" in names and "PATCH.json" not in names:
            manifest = read_json(archive, "BUNDLE.json")
            declared = validate_bundle(archive, manifest, expected, diagnostics)
            label = "frontmind.kb-working-set.v1"
        elif "PATCH.json" in names and "BUNDLE.json" not in names:
            manifest = read_json(archive, "PATCH.json")
            declared = validate_patch(archive, manifest, expected, diagnostics)
            label = "frontmind.kb-node-patch.v1"
        else:
            fail("archive must contain exactly one contract manifest")
        if not declared.issubset(names):
            fail("archive is missing declared files")
    if args.diagnostics_json:
        print(
            json.dumps(
                {
                    "accepted": True,
                    "label": label,
                    "retained": diagnostics["retained"],
                    "dropped": diagnostics["dropped"],
                    "warnings": diagnostics["warnings"],
                    "hardFailure": None,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    else:
        print(f"VALID {label}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(f"INVALID: {error}", file=sys.stderr)
        raise SystemExit(1)
