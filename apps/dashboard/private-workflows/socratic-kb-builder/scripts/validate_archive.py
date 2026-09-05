#!/usr/bin/env python3
"""Validate a dashboard-enterprise-v1 knowledge-base ZIP deterministically."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from PIL import Image, UnidentifiedImageError
except ImportError:  # The service still performs an independent native decode.
    Image = None
    UnidentifiedImageError = OSError

MIB = 1024 * 1024
MAX_COMPRESSED_BYTES = 250 * MIB
MAX_UNCOMPRESSED_BYTES = 200 * MIB
MAX_IMAGE_BYTES = 30 * MIB
MAX_FILES = 1_500
REQUIRED_LOGO_IMAGES = 1
MAX_USER_UPLOAD_IMAGES = 99
MAX_IMAGES = REQUIRED_LOGO_IMAGES + MAX_USER_UPLOAD_IMAGES
MIN_LEAVES = 30
MAX_LEAVES = 115
TARGET_FORMAL_CHARACTERS_MIN = 80_000
TARGET_FORMAL_CHARACTERS_MAX = 120_000
MAX_FORMAL_CHARACTERS = 180_000
MAX_EVIDENCE_CHARACTERS = 3_000_000
# 30 official documents plus as many as 100 customer uploads.
MAX_PARSED_DOCUMENTS = 130
MAX_PUBLIC_QUERIES = 30
MAX_OFFICIAL_PAGES = 120
CONTENT_STATUSES = {"complete", "limited_evidence", "needs_verification"}
IMAGE_SELECTION_STATUSES = {"target_met", "source_limited", "budget_limited"}
REQUIRED_IMAGE_DISCOVERY_METHODS = {
    "img",
    "srcset",
    "lazy_load",
    "picture",
    "css_background",
    "open_graph",
    "gallery",
    "official_document",
    "customer_upload",
}
OFFICIAL_LOGO_SOURCE_KINDS = {
    "official_web",
    "official_document",
    "official_logo_upload",
}
UPLOAD_SOURCE_KINDS = {"official_logo_upload", "user_upload"}

FORMAL_START = "<!-- FRONTMIND_FORMAL_CONTENT_START -->"
FORMAL_END = "<!-- FRONTMIND_FORMAL_CONTENT_END -->"
ALLOWED_DOCUMENT_KINDS = {"overview", "leaf", "evidence", "report", "index"}
ALLOWED_EVIDENCE_STATUSES = {
    "verified_first_party",
    "verified_authoritative",
    "supported_third_party",
    "inferred",
    "needs_verification",
    "not_applicable",
}
EVIDENCE_STATUS_COUNT_KEYS = {
    "verified_first_party": "verifiedFirstParty",
    "verified_authoritative": "verifiedAuthoritative",
    "supported_third_party": "supportedThirdParty",
    "inferred": "inferred",
    "needs_verification": "needsVerification",
    "not_applicable": "notApplicable",
}
IMAGE_TYPES = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
REQUIRED_ROOT_FILES = {
    "README.md",
    "00_completeness.json",
    "00_package_manifest.json",
    "00_knowledge_tree.md",
    "00_crawl_coverage_report.md",
    "00_web_intelligence_report.md",
    "00_source_index.md",
    "00_media_gaps.md",
    "09_media_assets/asset_inventory.md",
    "10_reference_assets/reference_asset_inventory.md",
}
ASSET_TYPES = {"brand_identity", "customer_supplied"}
DISPLAY_ROLES = {"badge", "inline"}
USER_UPLOAD_SOURCE_MIME_TYPES = {
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/tiff",
    "image/vnd.microsoft.icon",
    "image/webp",
    "image/x-icon",
}
MANIFEST_KEYS = {
    "schemaVersion",
    "profile",
    "buildRevision",
    "documents",
    "assets",
    "counts",
    "imageSelection",
}
DOCUMENT_KEYS = {
    "id",
    "path",
    "kind",
    "title",
    "branchId",
    "branchTitle",
    "order",
    "evidenceStatus",
    "sourceIds",
    "evidenceDocumentIds",
    "assetIds",
    "customerVisible",
    "evidenceCharacters",
    "requiredFormalCharacters",
    "contentStatus",
    "productFamilyId",
}
DOCUMENT_REQUIRED_KEYS = {
    "id",
    "path",
    "kind",
    "title",
    "sourceIds",
    "assetIds",
    "customerVisible",
}
ASSET_KEYS = {
    "id",
    "path",
    "sha256",
    "mimeType",
    "bytes",
    "width",
    "height",
    "caption",
    "alt",
    "branchId",
    "documentIds",
    "sourcePageUrl",
    "sourceAssetUrl",
    "sourceDocumentPath",
    "sourceKind",
    "sourceUploadIndex",
    "sourceUploadFileId",
    "sourceUploadSha256",
    "sourceUploadFilename",
    "sourceUploadMimeType",
    "sourceUploadSizeBytes",
    "ownership",
    "assetType",
    "displayRole",
}
ASSET_REQUIRED_KEYS = {
    "id",
    "path",
    "sha256",
    "mimeType",
    "bytes",
    "width",
    "height",
    "caption",
    "branchId",
    "documentIds",
    "sourceKind",
    "ownership",
    "assetType",
    "displayRole",
}
COUNTS_KEYS = {
    "totalFiles",
    "customerVisibleCharacters",
    "evidenceCharacters",
    "packagedImages",
}
IMAGE_SELECTION_KEYS = {
    "status",
    "discoveredCandidateImages",
    "inspectedCandidateImages",
    "eligibleFirstPartyImages",
    "rejectedCandidateImages",
    "scannedSourcePages",
    "discoveryMethods",
    "rejectionReasons",
    "stopReason",
    "candidates",
    "shortfallReason",
}


class Validation:
    def __init__(self) -> None:
        self.errors: list[str] = []

    def require(self, condition: bool, message: str) -> bool:
        if not condition:
            self.errors.append(message)
        return condition


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def safe_relative_name(name: str) -> bool:
    if not name or "\x00" in name or "\\" in name:
        return False
    path = PurePosixPath(name)
    return (
        not path.is_absolute()
        and not re.match(r"^[A-Za-z]:", name)
        and ".." not in path.parts
    )


def normalized_entries(
    infos: list[zipfile.ZipInfo], validation: Validation
) -> tuple[dict[str, zipfile.ZipInfo], str | None]:
    files: list[tuple[PurePosixPath, zipfile.ZipInfo]] = []
    for info in infos:
        original = info.filename
        if not validation.require(
            safe_relative_name(original), f"unsafe ZIP path: {original!r}"
        ):
            continue
        if info.flag_bits & 0x1:
            validation.errors.append(f"encrypted ZIP entry is forbidden: {original}")
        unix_mode = (info.external_attr >> 16) & 0o170000
        if unix_mode == 0o120000:
            validation.errors.append(f"symbolic link is forbidden: {original}")
        if info.is_dir():
            continue
        if info.file_size > 0 and info.compress_size > 0:
            ratio = info.file_size / info.compress_size
            if ratio > 200:
                validation.errors.append(
                    f"suspicious compression ratio ({ratio:.1f}): {original}"
                )
        files.append((PurePosixPath(original), info))

    first_parts = {path.parts[0] for path, _ in files if path.parts}
    use_root = (
        len(first_parts) == 1
        and files
        and all(len(path.parts) > 1 for path, _ in files)
    )
    validation.require(
        bool(use_root),
        "archive must contain exactly one company-named root directory",
    )
    root = next(iter(first_parts)) if use_root else None
    result: dict[str, zipfile.ZipInfo] = {}
    for path, info in files:
        relative = PurePosixPath(*path.parts[1:]) if root else path
        key = relative.as_posix()
        if key in result:
            validation.errors.append(f"duplicate normalized ZIP path: {key}")
        result[key] = info
    return result, root


def read_json(
    archive: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
    name: str,
    validation: Validation,
) -> dict[str, Any] | None:
    info = entries.get(name)
    if not validation.require(info is not None, f"missing required file: {name}"):
        return None
    try:
        value = json.loads(archive.read(info).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        validation.errors.append(f"invalid UTF-8 JSON in {name}: {exc}")
        return None
    if not validation.require(isinstance(value, dict), f"{name} must be an object"):
        return None
    return value


def require_string(
    obj: dict[str, Any],
    key: str,
    where: str,
    validation: Validation,
    *,
    optional: bool = False,
) -> str:
    value = obj.get(key)
    if optional and value is None:
        return ""
    if not isinstance(value, str) or not value.strip():
        validation.errors.append(f"{where}.{key} must be a non-empty string")
        return ""
    return value.strip()


def require_string_list(
    obj: dict[str, Any], key: str, where: str, validation: Validation
) -> list[str]:
    value = obj.get(key)
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        validation.errors.append(f"{where}.{key} must be a string array")
        return []
    return [item.strip() for item in value]


def require_exact_keys(
    obj: dict[str, Any],
    *,
    allowed: set[str],
    required: set[str],
    where: str,
    validation: Validation,
) -> None:
    actual = set(obj)
    unexpected = sorted(actual - allowed)
    missing = sorted(required - actual)
    validation.require(not unexpected, f"{where} has unexpected fields: {unexpected}")
    validation.require(not missing, f"{where} is missing fields: {missing}")


def validate_source_upload_provenance(
    obj: dict[str, Any],
    where: str,
    validation: Validation,
    *,
    source_label: str = "customer upload",
) -> tuple[str, str, str]:
    required = {
        "sourceUploadSha256",
        "sourceUploadFilename",
        "sourceUploadMimeType",
    }
    validation.require(
        required <= set(obj),
        f"{where} {source_label} requires sourceUploadSha256, "
        "sourceUploadFilename and sourceUploadMimeType",
    )
    digest = require_string(
        obj, "sourceUploadSha256", where, validation, optional=True
    ).lower()
    filename = require_string(
        obj, "sourceUploadFilename", where, validation, optional=True
    )
    mime_type = require_string(
        obj, "sourceUploadMimeType", where, validation, optional=True
    ).lower()
    validation.require(
        obj.get("sourceUploadSha256") == digest
        and bool(re.fullmatch(r"[0-9a-f]{64}", digest)),
        f"{where}.sourceUploadSha256 must be 64 lowercase hexadecimal characters",
    )
    validation.require(
        bool(filename)
        and obj.get("sourceUploadFilename") == filename
        and filename not in {".", ".."}
        and "/" not in filename
        and "\\" not in filename
        and len(filename) <= 255
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in filename
        ),
        f"{where}.sourceUploadFilename must be a safe basename",
    )
    validation.require(
        obj.get("sourceUploadMimeType") == mime_type
        and mime_type in USER_UPLOAD_SOURCE_MIME_TYPES,
        f"{where}.sourceUploadMimeType must be a normalized supported image MIME type",
    )
    return digest, filename, mime_type


def validate_official_logo_upload_provenance(
    obj: dict[str, Any],
    where: str,
    validation: Validation,
    *,
    packaged_sha256: str,
    packaged_mime_type: str,
    packaged_bytes: Any,
) -> str:
    digest, _, mime_type = validate_source_upload_provenance(
        obj,
        where,
        validation,
        source_label="official_logo_upload",
    )
    required = {
        "sourceUploadIndex",
        "sourceUploadFileId",
        "sourceUploadSizeBytes",
    }
    validation.require(
        required <= set(obj),
        f"{where} official_logo_upload requires sourceUploadIndex, "
        "sourceUploadFileId and sourceUploadSizeBytes in addition to the "
        "standard upload provenance fields",
    )
    upload_index = obj.get("sourceUploadIndex")
    upload_file_id = obj.get("sourceUploadFileId")
    upload_size_bytes = obj.get("sourceUploadSizeBytes")
    validation.require(
        isinstance(upload_index, int)
        and not isinstance(upload_index, bool)
        and upload_index == 0,
        f"{where}.sourceUploadIndex must equal 0",
    )
    validation.require(
        isinstance(upload_file_id, str)
        and bool(upload_file_id.strip())
        and upload_file_id == upload_file_id.strip()
        and len(upload_file_id) <= 512
        and not any(
            ord(character) < 32 or ord(character) == 127
            for character in upload_file_id
        ),
        f"{where}.sourceUploadFileId must be a safe non-empty identifier",
    )
    validation.require(
        isinstance(upload_size_bytes, int)
        and not isinstance(upload_size_bytes, bool)
        and upload_size_bytes > 0
        and upload_size_bytes == packaged_bytes,
        f"{where}.sourceUploadSizeBytes must equal the packaged Logo byte length",
    )
    validation.require(
        digest == packaged_sha256,
        f"{where}.sourceUploadSha256 must equal the packaged Logo SHA-256",
    )
    validation.require(
        mime_type == packaged_mime_type
        and mime_type in set(IMAGE_TYPES.values()),
        f"{where}.sourceUploadMimeType must equal the packaged AVIF, GIF, JPEG, PNG or WebP MIME type",
    )
    return digest


def image_magic_matches(data: bytes, mime: str) -> bool:
    if mime == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime == "image/gif":
        return data.startswith((b"GIF87a", b"GIF89a"))
    if mime == "image/webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if mime == "image/avif":
        return (
            len(data) >= 16
            and data[4:8] == b"ftyp"
            and any(brand in data[8:32] for brand in (b"avif", b"avis"))
        )
    return False


def image_dimensions(data: bytes, mime: str) -> tuple[int, int] | None:
    if mime == "image/png" and len(data) >= 24:
        return (
            int.from_bytes(data[16:20], "big"),
            int.from_bytes(data[20:24], "big"),
        )
    if mime == "image/gif" and len(data) >= 10:
        return (
            int.from_bytes(data[6:8], "little"),
            int.from_bytes(data[8:10], "little"),
        )
    if mime == "image/jpeg" and len(data) >= 4:
        offset = 2
        while offset + 9 < len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            marker = data[offset + 1]
            if marker in {0xD8, 0xD9}:
                offset += 2
                continue
            segment_length = int.from_bytes(data[offset + 2 : offset + 4], "big")
            if segment_length < 2 or offset + 2 + segment_length > len(data):
                break
            if marker in {
                0xC0,
                0xC1,
                0xC2,
                0xC3,
                0xC5,
                0xC6,
                0xC7,
                0xC9,
                0xCA,
                0xCB,
                0xCD,
                0xCE,
                0xCF,
            }:
                return (
                    int.from_bytes(data[offset + 7 : offset + 9], "big"),
                    int.from_bytes(data[offset + 5 : offset + 7], "big"),
                )
            offset += 2 + segment_length
        return None
    if mime == "image/webp" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8X":
            return (
                int.from_bytes(data[24:27], "little") + 1,
                int.from_bytes(data[27:30], "little") + 1,
            )
        if chunk == b"VP8L" and data[20] == 0x2F and len(data) >= 25:
            packed = int.from_bytes(data[21:25], "little")
            return ((packed & 0x3FFF) + 1, ((packed >> 14) & 0x3FFF) + 1)
        if chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
            return (
                int.from_bytes(data[26:28], "little") & 0x3FFF,
                int.from_bytes(data[28:30], "little") & 0x3FFF,
            )
        return None
    if mime == "image/avif":
        offset = data.find(b"ispe")
        if offset >= 4 and offset + 16 <= len(data):
            box_size = int.from_bytes(data[offset - 4 : offset], "big")
            if box_size >= 20 and offset - 4 + box_size <= len(data):
                return (
                    int.from_bytes(data[offset + 8 : offset + 12], "big"),
                    int.from_bytes(data[offset + 12 : offset + 16], "big"),
                )
    return None


def decoded_image_dimensions(data: bytes, mime: str) -> tuple[int, int] | None:
    dimensions = image_dimensions(data, mime)
    if not image_magic_matches(data, mime) or not dimensions or 0 in dimensions:
        return None
    if dimensions[0] * dimensions[1] > 40_000_000:
        return None
    if Image is None:
        return dimensions
    expected_format = {
        "image/png": "PNG",
        "image/jpeg": "JPEG",
        "image/gif": "GIF",
        "image/webp": "WEBP",
        "image/avif": "AVIF",
    }[mime]
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != expected_format or image.size != dimensions:
                return None
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
    except (OSError, SyntaxError, ValueError, UnidentifiedImageError):
        # Pillow builds without an AVIF plugin cannot decode a valid AVIF.
        # The service performs a mandatory native libvips decode afterwards.
        return dimensions if mime == "image/avif" else None
    return dimensions


def formal_block(content: str, path: str, validation: Validation) -> str:
    start_count = content.count(FORMAL_START)
    end_count = content.count(FORMAL_END)
    if start_count != 1 or end_count != 1:
        validation.errors.append(
            f"{path} must contain exactly one formal-content marker pair"
        )
        return ""
    start = content.index(FORMAL_START) + len(FORMAL_START)
    end = content.index(FORMAL_END)
    if end <= start:
        validation.errors.append(f"{path} has reversed formal-content markers")
        return ""
    return content[start:end]


def strip_leading_frontmatter(content: str) -> str:
    return re.sub(
        r"^\ufeff?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)",
        "",
        content,
        count=1,
    )


def countable_markdown_text(content: str, *, remove_headings: bool) -> str:
    value = strip_leading_frontmatter(content)
    value = re.sub(r"<!--[\s\S]*?-->", "", value)
    value = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", value)
    value = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"https?://[^\s)>\]]+", "", value, flags=re.IGNORECASE)
    value = re.sub(r"<[^>]+>", "", value)
    if remove_headings:
        value = re.sub(r"(?m)^#{1,6}\s+.*$", "", value)
    else:
        value = re.sub(r"(?m)^#{1,6}\s+", "", value)
    return value


SOURCE_INVENTORY_HEADER = re.compile(
    r"^(?:(?:原始|证据|引用|参考|数据)?来源(?:链接|网址|url)?|"
    r"出处|证据链接|参考资料|链接|网址|sources?|references?|"
    r"source(?:url|link|page)?|reference(?:url|link)?|url)$",
    re.IGNORECASE,
)

SOURCE_INVENTORY_SECTION_HEADING = re.compile(
    r"(?:^(?:(?:原始|证据|引用|参考|数据|官方|公开|第一方|第三方)"
    r"来源(?:清单|索引|链接|网址|url)?|"
    r"来源(?:清单|索引|链接|网址|url|与证据|和证据)?|出处|证据链接|"
    r"参考资料|素材清单|展示素材|机器清单|证据状态|状态头|sources?|"
    r"references?|sources? and references?|references? and sources?|"
    r"asset inventory)$)|(?:来源(?:清单|索引)|原始来源|素材清单|"
    r"展示素材|机器清单|source index|reference list|asset inventory)$",
    re.IGNORECASE,
)


def heading_is_source_inventory(value: str) -> bool:
    normalized = unicodedata.normalize("NFKC", value)
    normalized = normalized.replace("*", "").replace("_", "").replace("`", "")
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return bool(SOURCE_INVENTORY_SECTION_HEADING.search(normalized))


def contains_source_inventory_heading(content: str) -> bool:
    for line in content.splitlines():
        heading = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if heading and heading_is_source_inventory(heading.group(1)):
            return True
    return False


def table_is_source_inventory(table_lines: list[str]) -> bool:
    if not table_lines:
        return False
    header = table_lines[0].strip()
    if not header.startswith("|"):
        return False
    if header.endswith("|"):
        header = header[1:-1]
    else:
        header = header[1:]
    cells = [
        re.sub(r"\s+", "", unicodedata.normalize("NFKC", cell))
        .replace("*", "")
        .replace("_", "")
        .replace("`", "")
        .strip()
        for cell in header.split("|")
    ]
    return any(cell and SOURCE_INVENTORY_HEADER.fullmatch(cell) for cell in cells)


def source_inventory_tables(content: str) -> list[list[str]]:
    lines = content.splitlines(keepends=True)
    tables: list[list[str]] = []
    index = 0
    while index < len(lines):
        if not lines[index].strip().startswith("|"):
            index += 1
            continue
        table: list[str] = []
        while index < len(lines) and lines[index].strip().startswith("|"):
            table.append(lines[index])
            index += 1
        if table_is_source_inventory(table):
            tables.append(table)
    return tables


def strip_source_inventory_tables(content: str) -> str:
    lines = content.splitlines(keepends=True)
    retained: list[str] = []
    index = 0
    while index < len(lines):
        if not lines[index].strip().startswith("|"):
            retained.append(lines[index])
            index += 1
            continue
        table: list[str] = []
        while index < len(lines) and lines[index].strip().startswith("|"):
            table.append(lines[index])
            index += 1
        if not table_is_source_inventory(table):
            retained.extend(table)
    return "".join(retained)


def effective_characters(content: str) -> int:
    value = unicodedata.normalize("NFKC", content)
    value = re.sub(r"\s", "", value)
    value = re.sub(
        r"""[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]""",
        "",
        value,
    )
    return len(value)

def normalized_formal_shingles(content: str) -> set[str]:
    value = unicodedata.normalize("NFKC", content).lower()
    value = re.sub(r"\d+", "#", value)
    value = re.sub(
        r"""[\s!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]+""",
        "",
        value,
    )
    return {value[index : index + 5] for index in range(max(0, len(value) - 4))}


def normalized_formal_similarity(left: str, right: str) -> float:
    left_shingles = normalized_formal_shingles(left)
    right_shingles = normalized_formal_shingles(right)
    if not left_shingles or not right_shingles:
        return 0.0
    return len(left_shingles & right_shingles) / len(
        left_shingles | right_shingles
    )


def formal_requirement(
    *,
    kind: str,
    is_product_branch: bool,
    evidence_characters: int,
) -> tuple[int, str]:
    if evidence_characters <= 0:
        return (60 if kind == "overview" else 40), "needs_verification"
    if kind == "overview":
        target = 5_000 if is_product_branch else 2_500
        proportional = int(evidence_characters * 0.25)
        return max(120, min(target, proportional)), (
            "complete" if proportional >= target else "limited_evidence"
        )
    proportional = int(evidence_characters * 0.20)
    return max(80, min(500, proportional)), (
        "complete" if proportional >= 500 else "limited_evidence"
    )


def validate_archive(path: Path) -> list[str]:
    validation = Validation()
    if not path.is_file():
        return [f"archive does not exist: {path}"]
    validation.require(
        path.stat().st_size <= MAX_COMPRESSED_BYTES,
        f"compressed archive exceeds {MAX_COMPRESSED_BYTES} bytes",
    )

    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        return [f"invalid ZIP archive: {exc}"]

    with archive:
        bad_crc = archive.testzip()
        validation.require(bad_crc is None, f"ZIP CRC failed: {bad_crc}")
        entries, _root = normalized_entries(archive.infolist(), validation)
        validation.require(bool(entries), "archive contains no ordinary files")
        validation.require(
            len(entries) <= MAX_FILES,
            f"archive contains {len(entries)} files; maximum is {MAX_FILES}",
        )
        total_uncompressed = sum(info.file_size for info in entries.values())
        validation.require(
            total_uncompressed <= MAX_UNCOMPRESSED_BYTES,
            f"uncompressed archive exceeds {MAX_UNCOMPRESSED_BYTES} bytes",
        )
        allowed_suffixes = {
            ".avif",
            ".csv",
            ".doc",
            ".docx",
            ".gif",
            ".jpeg",
            ".jpg",
            ".json",
            ".md",
            ".pdf",
            ".png",
            ".ppt",
            ".pptx",
            ".sha256",
            ".webp",
            ".xls",
            ".xlsx",
        }
        forbidden_entries = {
            name
            for name in entries
            if PurePosixPath(name).suffix.lower() not in allowed_suffixes
        }
        validation.require(
            not forbidden_entries,
            "archive contains unsupported executable, webpage, or raw file "
            f"types: {sorted(forbidden_entries)[:8]}",
        )
        for required in REQUIRED_ROOT_FILES:
            validation.require(required in entries, f"missing required file: {required}")

        completeness = read_json(
            archive, entries, "00_completeness.json", validation
        )
        validation.require(
            completeness is not None,
            "00_completeness.json must retain its existing object contract",
        )
        manifest = read_json(
            archive, entries, "00_package_manifest.json", validation
        )
        if manifest is None:
            return validation.errors

        require_exact_keys(
            manifest,
            allowed=MANIFEST_KEYS,
            required=MANIFEST_KEYS,
            where="manifest",
            validation=validation,
        )
        validation.require(
            manifest.get("schemaVersion") == 4,
            "00_package_manifest.json schemaVersion must be 4",
        )
        validation.require(
            manifest.get("profile") == "dashboard-enterprise-v1",
            "00_package_manifest.json profile must be dashboard-enterprise-v1",
        )
        validation.require(
            isinstance(manifest.get("buildRevision"), int)
            and not isinstance(manifest.get("buildRevision"), bool)
            and manifest.get("buildRevision") >= 0,
            "00_package_manifest.json buildRevision must be a non-negative integer",
        )

        documents_value = manifest.get("documents")
        assets_value = manifest.get("assets")
        counts = manifest.get("counts")
        image_selection = manifest.get("imageSelection")
        validation.require(
            isinstance(documents_value, list), "manifest.documents must be an array"
        )
        validation.require(
            isinstance(assets_value, list), "manifest.assets must be an array"
        )
        validation.require(isinstance(counts, dict), "manifest.counts must be an object")
        validation.require(
            isinstance(image_selection, dict),
            "manifest.imageSelection must be an object",
        )
        if not isinstance(documents_value, list):
            documents_value = []
        if not isinstance(assets_value, list):
            assets_value = []
        if not isinstance(counts, dict):
            counts = {}
        if not isinstance(image_selection, dict):
            image_selection = {}
        product_branch_ids = {
            str(document.get("branchId", "")).strip()
            for document in documents_value
            if isinstance(document, dict)
            and document.get("kind") == "leaf"
            and isinstance(document.get("productFamilyId"), str)
            and bool(document.get("productFamilyId", "").strip())
        }
        require_exact_keys(
            counts,
            allowed=COUNTS_KEYS,
            required=COUNTS_KEYS,
            where="manifest.counts",
            validation=validation,
        )

        document_ids: set[str] = set()
        document_paths: set[str] = set()
        documents: dict[str, dict[str, Any]] = {}
        formal_total = 0
        evidence_total = 0
        leaf_count = 0
        first_leaf_id: str | None = None
        branch_leaf_ids: dict[str, list[str]] = {}
        branch_overviews: dict[str, int] = {}
        formal_hashes: dict[str, str] = {}
        formal_paragraph_paths: dict[str, list[str]] = {}
        formal_samples: list[tuple[str, str]] = []
        document_effective_characters: dict[str, int] = {}
        evidence_paths_by_hash: dict[str, str] = {}
        product_family_ids: set[str] = set()
        actual_leaf_status_counts = {
            status: 0 for status in ALLOWED_EVIDENCE_STATUSES
        }

        referenced_evidence_ids: set[str] = set()
        for index, raw_document in enumerate(documents_value):
            where = f"manifest.documents[{index}]"
            if not isinstance(raw_document, dict):
                validation.errors.append(f"{where} must be an object")
                continue
            require_exact_keys(
                raw_document,
                allowed=DOCUMENT_KEYS,
                required=DOCUMENT_REQUIRED_KEYS,
                where=where,
                validation=validation,
            )
            doc_id = require_string(raw_document, "id", where, validation)
            doc_path = require_string(raw_document, "path", where, validation)
            kind = require_string(raw_document, "kind", where, validation)
            title = require_string(raw_document, "title", where, validation)
            source_ids = require_string_list(
                raw_document, "sourceIds", where, validation
            )
            asset_ids = require_string_list(
                raw_document, "assetIds", where, validation
            )
            _ = source_ids, asset_ids
            validation.require(
                kind in ALLOWED_DOCUMENT_KINDS,
                f"{where}.kind must be one of {sorted(ALLOWED_DOCUMENT_KINDS)}",
            )
            validation.require(
                isinstance(raw_document.get("customerVisible"), bool),
                f"{where}.customerVisible must be boolean",
            )
            if "order" in raw_document:
                validation.require(
                    is_number(raw_document["order"]), f"{where}.order must be numeric"
                )
            if doc_id:
                validation.require(
                    doc_id not in document_ids, f"duplicate document id: {doc_id}"
                )
                document_ids.add(doc_id)
                documents[doc_id] = raw_document
            if doc_path:
                validation.require(
                    safe_relative_name(doc_path), f"unsafe document path: {doc_path}"
                )
                validation.require(
                    doc_path not in document_paths,
                    f"duplicate document path: {doc_path}",
                )
                document_paths.add(doc_path)
                validation.require(
                    doc_path in entries, f"manifest document is missing: {doc_path}"
                )
                validation.require(
                    PurePosixPath(doc_path).suffix.lower() == ".md",
                    f"manifest document must be Markdown: {doc_path}",
                )

            branch_id = require_string(
                raw_document, "branchId", where, validation, optional=True
            )
            evidence_status = require_string(
                raw_document,
                "evidenceStatus",
                where,
                validation,
                optional=True,
            )
            customer_visible = raw_document.get("customerVisible") is True
            if customer_visible:
                validation.require(
                    kind in {"overview", "leaf"},
                    f"{where} customerVisible documents must be overview or leaf",
                )
            if evidence_status:
                validation.require(
                    evidence_status in ALLOWED_EVIDENCE_STATUSES,
                    f"{where}.evidenceStatus must be one of "
                    f"{sorted(ALLOWED_EVIDENCE_STATUSES)}",
                )
            if kind in {"overview", "leaf"}:
                require_exact_keys(
                    raw_document,
                    allowed=DOCUMENT_KEYS,
                    required=(
                        DOCUMENT_REQUIRED_KEYS
                        | {
                            "evidenceDocumentIds",
                            "evidenceCharacters",
                            "requiredFormalCharacters",
                            "contentStatus",
                        }
                        | ({"branchTitle", "order"} if kind == "leaf" else set())
                    ),
                    where=where,
                    validation=validation,
                )
                validation.require(
                    customer_visible,
                    f"{where} {kind} must be customerVisible",
                )
                validation.require(
                    bool(branch_id), f"{where}.{kind} requires branchId"
                )
                validation.require(
                    evidence_status in ALLOWED_EVIDENCE_STATUSES,
                    f"{where}.evidenceStatus must be one of "
                    f"{sorted(ALLOWED_EVIDENCE_STATUSES)}",
                )
                if evidence_status not in {
                    "needs_verification",
                    "not_applicable",
                }:
                    validation.require(
                        bool(source_ids),
                        f"{where} evidence-backed content requires sourceIds",
                    )
                evidence_characters = raw_document.get("evidenceCharacters")
                evidence_document_ids = require_string_list(
                    raw_document, "evidenceDocumentIds", where, validation
                )
                required_formal_characters = raw_document.get(
                    "requiredFormalCharacters"
                )
                content_status = raw_document.get("contentStatus")
                validation.require(
                    isinstance(evidence_characters, int)
                    and not isinstance(evidence_characters, bool)
                    and evidence_characters >= 0,
                    f"{where}.evidenceCharacters must be a non-negative integer",
                )
                validation.require(
                    isinstance(required_formal_characters, int)
                    and not isinstance(required_formal_characters, bool)
                    and required_formal_characters >= 0,
                    f"{where}.requiredFormalCharacters must be a non-negative integer",
                )
                validation.require(
                    content_status in CONTENT_STATUSES,
                    f"{where}.contentStatus must be one of {sorted(CONTENT_STATUSES)}",
                )
                if isinstance(evidence_characters, int) and not isinstance(
                    evidence_characters, bool
                ):
                    expected_required, expected_status = formal_requirement(
                        kind=kind,
                        is_product_branch=branch_id in product_branch_ids,
                        evidence_characters=evidence_characters,
                    )
                    validation.require(
                        required_formal_characters == expected_required,
                        f"{where}.requiredFormalCharacters must be "
                        f"{expected_required}, got {required_formal_characters!r}",
                    )
                    validation.require(
                        content_status == expected_status,
                        f"{where}.contentStatus must be {expected_status}",
                    )
                    if evidence_characters == 0:
                        validation.require(
                            evidence_status
                            in {"needs_verification", "not_applicable"},
                            f"{where} without evidence must use a gap evidenceStatus",
                        )
                product_family_id = require_string(
                    raw_document,
                    "productFamilyId",
                    where,
                    validation,
                    optional=True,
                )
                if kind == "leaf" and product_family_id:
                    product_family_ids.add(product_family_id)
                elif product_family_id:
                    validation.errors.append(
                        f"{where}.productFamilyId is only allowed on product/service leaves"
                    )
                _ = evidence_document_ids
            if kind == "leaf":
                branch_title = require_string(
                    raw_document, "branchTitle", where, validation
                )
                order = raw_document.get("order")
                validation.require(
                    bool(branch_title), f"{where}.leaf requires branchTitle"
                )
                validation.require(
                    isinstance(order, int)
                    and not isinstance(order, bool)
                    and order == leaf_count,
                    f"{where}.order must equal zero-based manifest leaf position "
                    f"{leaf_count}",
                )
                leaf_count += 1
                if first_leaf_id is None:
                    first_leaf_id = doc_id
                branch_leaf_ids.setdefault(branch_id, []).append(doc_id)
                if evidence_status in actual_leaf_status_counts:
                    actual_leaf_status_counts[evidence_status] += 1
            elif kind == "overview":
                branch_overviews[branch_id] = branch_overviews.get(branch_id, 0) + 1

            if not doc_path or doc_path not in entries:
                continue
            try:
                content = archive.read(entries[doc_path]).decode("utf-8")
            except UnicodeDecodeError:
                validation.errors.append(f"document is not UTF-8: {doc_path}")
                continue
            if customer_visible:
                formal = formal_block(content, doc_path, validation)
                validation.require(
                    not source_inventory_tables(formal),
                    f"{doc_path} formal block contains a source-inventory table",
                )
                validation.require(
                    not contains_source_inventory_heading(formal),
                    f"{doc_path} formal block contains an evidence, source, "
                    "status, or asset-inventory section",
                )
                validation.require(
                    not bool(
                        re.search(
                            r"(?im)^\s*>\s*.*(?:状态|status)\s*[:：].*"
                            r"(?:来源|source)\s*[:：]",
                            formal,
                        )
                    ),
                    f"{doc_path} formal block contains a status/source header",
                )
                countable_formal = countable_markdown_text(
                    strip_source_inventory_tables(formal), remove_headings=True
                )
                formal_count = effective_characters(countable_formal)
                formal_total += formal_count
                if formal_count >= 80:
                    formal_samples.append((doc_path, countable_formal))
                required_formal_characters = raw_document.get(
                    "requiredFormalCharacters"
                )
                if isinstance(required_formal_characters, int) and not isinstance(
                    required_formal_characters, bool
                ):
                    validation.require(
                        formal_count >= required_formal_characters,
                        f"{doc_path} has {formal_count} formal characters; "
                        f"evidence-proportional requirement is "
                        f"{required_formal_characters}",
                    )
                normalized_formal = re.sub(
                    r"\s+",
                    "",
                    unicodedata.normalize("NFKC", countable_formal),
                )
                if normalized_formal:
                    digest = hashlib.sha256(
                        normalized_formal.encode("utf-8")
                    ).hexdigest()
                    previous = formal_hashes.get(digest)
                    validation.require(
                        previous is None,
                        f"duplicate formal content: {previous} and {doc_path}",
                    )
                    formal_hashes[digest] = doc_path
                for paragraph in re.split(r"\n\s*\n", countable_formal):
                    normalized_paragraph = re.sub(
                        r"\s+",
                        "",
                        unicodedata.normalize("NFKC", paragraph),
                    )
                    if effective_characters(normalized_paragraph) < 120:
                        continue
                    paragraph_digest = hashlib.sha256(
                        re.sub(r"\d+", "#", normalized_paragraph).encode("utf-8")
                    ).hexdigest()
                    paths = formal_paragraph_paths.setdefault(
                        paragraph_digest, []
                    )
                    if doc_path not in paths:
                        paths.append(doc_path)
            else:
                countable_evidence = countable_markdown_text(
                    content, remove_headings=False
                )
                evidence_count = effective_characters(countable_evidence)
                evidence_total += evidence_count
                if doc_id:
                    document_effective_characters[doc_id] = evidence_count
                if kind == "evidence":
                    normalized_evidence = re.sub(
                        r"""[\s!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~，。！？；：“”‘’（）【】《》…—·]+""",
                        "",
                        unicodedata.normalize("NFKC", countable_evidence).lower(),
                    )
                    if normalized_evidence:
                        digest = hashlib.sha256(
                            normalized_evidence.encode("utf-8")
                        ).hexdigest()
                        previous = evidence_paths_by_hash.get(digest)
                        validation.require(
                            previous is None,
                            f"duplicate normalized evidence content: "
                            f"{previous} and {doc_path}",
                        )
                        evidence_paths_by_hash[digest] = doc_path

        validation.require(
            bool(product_family_ids),
            "schema v4 must declare at least one product/service family",
        )
        validation.require(
            "" not in product_branch_ids,
            "product/service leaves with productFamilyId require branchId",
        )
        for index, raw_document in enumerate(documents_value):
            if (
                isinstance(raw_document, dict)
                and raw_document.get("kind") == "leaf"
                and raw_document.get("branchId") in product_branch_ids
            ):
                validation.require(
                    isinstance(raw_document.get("productFamilyId"), str)
                    and bool(raw_document.get("productFamilyId", "").strip()),
                    f"manifest.documents[{index}] product/service branch leaf "
                    "requires productFamilyId",
                )

        for index, raw_document in enumerate(documents_value):
            if not isinstance(raw_document, dict) or raw_document.get("kind") not in {
                "overview",
                "leaf",
            }:
                continue
            where = f"manifest.documents[{index}]"
            related_evidence_ids = require_string_list(
                raw_document, "evidenceDocumentIds", where, validation
            )
            referenced_evidence_ids.update(related_evidence_ids)
            validation.require(
                len(set(related_evidence_ids)) == len(related_evidence_ids),
                f"{where}.evidenceDocumentIds must be unique",
            )
            related_source_ids = set(raw_document.get("sourceIds") or [])
            actual_related_evidence = 0
            for evidence_id in related_evidence_ids:
                evidence_document = documents.get(evidence_id)
                validation.require(
                    evidence_document is not None
                    and evidence_document.get("kind") == "evidence"
                    and evidence_document.get("customerVisible") is False,
                    f"{where} references a non-evidence document: {evidence_id}",
                )
                if evidence_document is None:
                    continue
                validation.require(
                    isinstance(evidence_document.get("branchId"), str)
                    and bool(evidence_document.get("branchId", "").strip())
                    and evidence_document.get("branchId")
                    == raw_document.get("branchId"),
                    f"{where} evidence document {evidence_id} must explicitly "
                    "belong to the same branchId",
                )
                evidence_sources = set(evidence_document.get("sourceIds") or [])
                validation.require(
                    bool(related_source_ids & evidence_sources),
                    f"{where} evidence document {evidence_id} must share a sourceId",
                )
                actual_related_evidence += document_effective_characters.get(
                    evidence_id, 0
                )
            validation.require(
                raw_document.get("evidenceCharacters") == actual_related_evidence,
                f"{where}.evidenceCharacters must equal validator-recomputed "
                f"evidence characters {actual_related_evidence}",
            )
        for doc_id, raw_document in documents.items():
            if raw_document.get("kind") == "evidence":
                validation.require(
                    raw_document.get("customerVisible") is False
                    and doc_id in referenced_evidence_ids,
                    f"v4 evidence document must be referenced by at least one "
                    f"overview/leaf: {raw_document.get('path', doc_id)}",
                )

        validation.require(
            MIN_LEAVES <= leaf_count <= MAX_LEAVES,
            f"manifest contains {leaf_count} leaf documents; expected {MIN_LEAVES}–{MAX_LEAVES}",
        )
        for branch_id in branch_leaf_ids:
            validation.require(
                branch_overviews.get(branch_id) == 1,
                f"branch {branch_id!r} must have exactly one overview",
            )
        for branch_id in branch_overviews:
            validation.require(
                branch_id in branch_leaf_ids,
                f"branch {branch_id!r} has an overview but no leaf",
            )
        repeated_template = next(
            (
                paths
                for paths in formal_paragraph_paths.values()
                if len(paths) >= 3
            ),
            None,
        )
        validation.require(
            repeated_template is None,
            "formal content repeats the same template paragraph across "
            f"{repeated_template or []}",
        )
        repeated_pair = next(
            (
                (left_path, right_path)
                for left_index, (left_path, left_text) in enumerate(formal_samples)
                for right_path, right_text in formal_samples[left_index + 1 :]
                if normalized_formal_similarity(left_text, right_text) >= 0.82
            ),
            None,
        )
        validation.require(
            repeated_pair is None,
            f"formal content is substantially duplicated across {repeated_pair}",
        )

        markdown_paths = {
            name for name in entries if PurePosixPath(name).suffix.lower() == ".md"
        }
        validation.require(
            markdown_paths <= document_paths,
            "every Markdown file must be registered in manifest.documents; "
            f"missing {sorted(markdown_paths - document_paths)[:8]}",
        )

        completeness_acquisition: dict[str, Any] = {}
        if completeness is not None:
            require_exact_keys(
                completeness,
                allowed={"counts", "acquisition", "gaps", "evaluatedAt"},
                required={"counts", "acquisition", "gaps", "evaluatedAt"},
                where="00_completeness.json",
                validation=validation,
            )
            completeness_counts = completeness.get("counts")
            completeness_acquisition_value = completeness.get("acquisition")
            validation.require(
                isinstance(completeness_counts, dict),
                "00_completeness.json.counts must be an object",
            )
            validation.require(
                isinstance(completeness_acquisition_value, dict),
                "00_completeness.json.acquisition must be an object",
            )
            if not isinstance(completeness_counts, dict):
                completeness_counts = {}
            if isinstance(completeness_acquisition_value, dict):
                completeness_acquisition = completeness_acquisition_value
            require_exact_keys(
                completeness_counts,
                allowed={"totalLeaves", *EVIDENCE_STATUS_COUNT_KEYS.values()},
                required={"totalLeaves", *EVIDENCE_STATUS_COUNT_KEYS.values()},
                where="00_completeness.json.counts",
                validation=validation,
            )
            for key in {"totalLeaves", *EVIDENCE_STATUS_COUNT_KEYS.values()}:
                value = completeness_counts.get(key)
                validation.require(
                    isinstance(value, int)
                    and not isinstance(value, bool)
                    and value >= 0,
                    f"00_completeness.json.counts.{key} must be a "
                    "non-negative integer",
                )
            validation.require(
                completeness_counts.get("totalLeaves") == leaf_count,
                "00_completeness.json.counts.totalLeaves must equal the "
                "actual leaf-document count",
            )
            for status, key in EVIDENCE_STATUS_COUNT_KEYS.items():
                validation.require(
                    completeness_counts.get(key)
                    == actual_leaf_status_counts[status],
                    f"00_completeness.json.counts.{key} does not match "
                    f"leaf evidenceStatus={status}",
                )
            require_exact_keys(
                completeness_acquisition,
                allowed={"officialPages", "images", "documents", "webQueries"},
                required={"officialPages", "images", "documents", "webQueries"},
                where="00_completeness.json.acquisition",
                validation=validation,
            )
            for dimension in (
                "officialPages",
                "images",
                "documents",
                "webQueries",
            ):
                raw_count = completeness_acquisition.get(dimension)
                validation.require(
                    isinstance(raw_count, dict),
                    f"00_completeness.json.acquisition.{dimension} "
                    "must be an object",
                )
                if not isinstance(raw_count, dict):
                    continue
                require_exact_keys(
                    raw_count,
                    allowed={"completed", "total"},
                    required={"completed", "total"},
                    where=f"00_completeness.json.acquisition.{dimension}",
                    validation=validation,
                )
                completed = raw_count.get("completed")
                total = raw_count.get("total")
                validation.require(
                    isinstance(completed, int)
                    and not isinstance(completed, bool)
                    and completed >= 0,
                    f"acquisition.{dimension}.completed must be a "
                    "non-negative integer",
                )
                validation.require(
                    isinstance(total, int)
                    and not isinstance(total, bool)
                    and total >= 0,
                    f"acquisition.{dimension}.total must be a "
                    "non-negative integer",
                )
                if isinstance(completed, int) and isinstance(total, int):
                    validation.require(
                        completed <= total,
                        f"acquisition.{dimension}.completed cannot exceed total",
                    )
            official_completed = (
                completeness_acquisition.get("officialPages", {}).get(
                    "completed"
                )
                if isinstance(
                    completeness_acquisition.get("officialPages"), dict
                )
                else None
            )
            documents_completed = (
                completeness_acquisition.get("documents", {}).get("completed")
                if isinstance(completeness_acquisition.get("documents"), dict)
                else None
            )
            query_count = completeness_acquisition.get("webQueries")
            validation.require(
                not isinstance(official_completed, int)
                or official_completed <= MAX_OFFICIAL_PAGES,
                f"parsed official pages exceed {MAX_OFFICIAL_PAGES}",
            )
            validation.require(
                not isinstance(documents_completed, int)
                or documents_completed <= MAX_PARSED_DOCUMENTS,
                f"parsed documents exceed {MAX_PARSED_DOCUMENTS}",
            )
            if isinstance(query_count, dict):
                validation.require(
                    all(
                        not isinstance(query_count.get(key), int)
                        or query_count[key] <= MAX_PUBLIC_QUERIES
                        for key in ("completed", "total")
                    ),
                    f"public-web queries exceed {MAX_PUBLIC_QUERIES}",
                )
            gaps = completeness.get("gaps")
            validation.require(
                isinstance(gaps, list)
                and all(
                    isinstance(gap, str) and bool(gap.strip()) for gap in gaps
                ),
                "00_completeness.json.gaps must be a string array",
            )
            evaluated_at = completeness.get("evaluatedAt")
            validation.require(
                isinstance(evaluated_at, str)
                and bool(
                    re.fullmatch(
                        r"\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}"
                        r"(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?",
                        evaluated_at,
                    )
                ),
                "00_completeness.json.evaluatedAt must be RFC3339 or YYYY-MM-DD",
            )

        asset_ids: set[str] = set()
        asset_paths: set[str] = set()
        asset_hashes: set[str] = set()
        source_upload_hashes: set[str] = set()
        image_bytes_total = 0
        assets: dict[str, dict[str, Any]] = {}
        official_logo_asset_ids: set[str] = set()
        user_upload_asset_ids: set[str] = set()
        for index, raw_asset in enumerate(assets_value):
            where = f"manifest.assets[{index}]"
            if not isinstance(raw_asset, dict):
                validation.errors.append(f"{where} must be an object")
                continue
            require_exact_keys(
                raw_asset,
                allowed=ASSET_KEYS,
                required=ASSET_REQUIRED_KEYS,
                where=where,
                validation=validation,
            )
            asset_id = require_string(raw_asset, "id", where, validation)
            asset_path = require_string(raw_asset, "path", where, validation)
            digest = require_string(raw_asset, "sha256", where, validation).lower()
            mime = require_string(raw_asset, "mimeType", where, validation).lower()
            require_string(raw_asset, "caption", where, validation)
            require_string(raw_asset, "alt", where, validation, optional=True)
            asset_branch_id = require_string(
                raw_asset, "branchId", where, validation
            )
            source_page_url = require_string(
                raw_asset,
                "sourcePageUrl",
                where,
                validation,
                optional=True,
            )
            source_asset_url = require_string(
                raw_asset,
                "sourceAssetUrl",
                where,
                validation,
                optional=True,
            )
            source_document_path = require_string(
                raw_asset,
                "sourceDocumentPath",
                where,
                validation,
                optional=True,
            )
            source_kind = require_string(
                raw_asset,
                "sourceKind",
                where,
                validation,
            )
            ownership = require_string(raw_asset, "ownership", where, validation)
            asset_type = require_string(raw_asset, "assetType", where, validation)
            display_role = require_string(
                raw_asset, "displayRole", where, validation
            )
            related_documents = require_string_list(
                raw_asset, "documentIds", where, validation
            )
            validation.require(
                ownership == "first_party",
                f"{where}.ownership must be first_party",
            )
            is_user_upload = source_kind == "user_upload"
            is_official_logo_upload = source_kind == "official_logo_upload"
            is_customer_upload = source_kind in UPLOAD_SOURCE_KINDS
            validation.require(
                source_kind in OFFICIAL_LOGO_SOURCE_KINDS | {"user_upload"},
                f"{where}.sourceKind is invalid",
            )
            if is_customer_upload:
                validation.require(
                    not source_page_url
                    and not source_asset_url
                    and not source_document_path,
                    f"{where} customer upload must not claim a discovered URL "
                    "or source document",
                )
                if is_official_logo_upload:
                    source_upload_sha256 = (
                        validate_official_logo_upload_provenance(
                            raw_asset,
                            where,
                            validation,
                            packaged_sha256=digest,
                            packaged_mime_type=mime,
                            packaged_bytes=raw_asset.get("bytes"),
                        )
                    )
                else:
                    source_upload_sha256, _, _ = (
                        validate_source_upload_provenance(
                            raw_asset,
                            where,
                            validation,
                            source_label=source_kind,
                        )
                    )
                if source_upload_sha256:
                    validation.require(
                        source_upload_sha256 not in source_upload_hashes,
                        f"duplicate original customer upload hash: {source_upload_sha256}",
                    )
                    source_upload_hashes.add(source_upload_sha256)
                if is_user_upload:
                    validation.require(
                        asset_type == "customer_supplied"
                        and display_role == "inline",
                        f"{where} user_upload must use customer_supplied/inline",
                    )
                    validation.require(
                        not {
                            "sourceUploadIndex",
                            "sourceUploadFileId",
                            "sourceUploadSizeBytes",
                        }
                        & set(raw_asset),
                        f"{where} user_upload must not carry official Logo "
                        "upload ledger fields",
                    )
                if is_official_logo_upload:
                    validation.require(
                        asset_type == "brand_identity" and display_role == "badge",
                        f"{where} official_logo_upload must use brand_identity/badge",
                    )
            else:
                validation.require(
                    bool(source_page_url)
                    or (
                        bool(source_document_path)
                        and source_document_path in entries
                    ),
                    f"{where} official Logo requires a public source page or packaged source document",
                )
                validation.require(
                    not {
                        "sourceUploadSha256",
                        "sourceUploadFilename",
                        "sourceUploadMimeType",
                        "sourceUploadIndex",
                        "sourceUploadFileId",
                        "sourceUploadSizeBytes",
                    }
                    & set(raw_asset),
                    f"{where} official Logo must not carry user-upload provenance",
                )
                validation.require(
                    source_kind in {"official_web", "official_document"},
                    f"{where} non-upload asset must be an official Logo source",
                )
                validation.require(
                    asset_type == "brand_identity" and display_role == "badge",
                    f"{where} official Logo must use brand_identity/badge",
                )
            validation.require(
                asset_type in ASSET_TYPES and display_role in DISPLAY_ROLES,
                f"{where} has an invalid assetType/displayRole combination",
            )
            for key, url in (
                ("sourcePageUrl", source_page_url),
                ("sourceAssetUrl", source_asset_url),
            ):
                if not url:
                    continue
                validation.require(
                    bool(
                        re.fullmatch(
                            r"https?://[^/\s:@]+(?::\d+)?(?:/[^@\s]*)?",
                            url,
                            flags=re.IGNORECASE,
                        )
                    )
                    and "@" not in url.split("://", 1)[-1].split("/", 1)[0],
                    f"{where}.{key} must be a credential-free HTTP(S) URL",
                )
            for key in ("bytes", "width", "height"):
                value = raw_asset.get(key)
                validation.require(
                    is_number(value) and int(value) > 0,
                    f"{where}.{key} must be a positive number",
                )
            validation.require(
                bool(re.fullmatch(r"[0-9a-f]{64}", digest)),
                f"{where}.sha256 must be 64 lowercase hexadecimal characters",
            )
            if asset_id:
                validation.require(
                    asset_id not in asset_ids, f"duplicate asset id: {asset_id}"
                )
                asset_ids.add(asset_id)
                assets[asset_id] = raw_asset
                if is_user_upload:
                    user_upload_asset_ids.add(asset_id)
                else:
                    official_logo_asset_ids.add(asset_id)
            if asset_path:
                validation.require(
                    safe_relative_name(asset_path), f"unsafe asset path: {asset_path}"
                )
                validation.require(
                    asset_path not in asset_paths, f"duplicate asset path: {asset_path}"
                )
                asset_paths.add(asset_path)
            suffix = PurePosixPath(asset_path).suffix.lower()
            expected_mime = IMAGE_TYPES.get(suffix)
            validation.require(
                expected_mime is not None,
                f"unsupported image extension for {asset_path}",
            )
            validation.require(
                expected_mime == mime,
                f"MIME/extension mismatch for {asset_path}: {mime}",
            )
            info = entries.get(asset_path)
            if not validation.require(
                info is not None, f"manifest asset is missing: {asset_path}"
            ):
                continue
            data = archive.read(info)
            actual_digest = hashlib.sha256(data).hexdigest()
            validation.require(
                raw_asset.get("bytes") == len(data),
                f"declared byte length does not match {asset_path}",
            )
            validation.require(
                digest == actual_digest, f"SHA-256 does not match {asset_path}"
            )
            validation.require(
                image_magic_matches(data, mime),
                f"magic bytes do not match {mime} for {asset_path}",
            )
            dimensions = decoded_image_dimensions(data, mime)
            validation.require(
                dimensions is not None,
                f"could not decode a valid image for {asset_path}",
            )
            if dimensions is not None:
                validation.require(
                    raw_asset.get("width") == dimensions[0]
                    and raw_asset.get("height") == dimensions[1],
                    f"declared dimensions do not match {asset_path}",
                )
                if not is_user_upload:
                    validation.require(
                        dimensions[0] >= 256 and dimensions[1] >= 256,
                        f"{asset_path} does not meet the badge image quality minimum",
                    )
            validation.require(
                actual_digest not in asset_hashes,
                f"duplicate image content hash: {asset_path}",
            )
            asset_hashes.add(actual_digest)
            image_bytes_total += len(data)
            if is_user_upload:
                validation.require(
                    bool(related_documents)
                    and len(set(related_documents)) == len(related_documents)
                    and all(
                        document_id in documents
                        and documents[document_id].get("kind") == "leaf"
                        for document_id in related_documents
                    ),
                    f"{where}.documentIds must contain one or more unique supplemented leaves",
                )
                validation.require(
                    any(
                        document_id in documents
                        and documents[document_id].get("branchId")
                        == asset_branch_id
                        for document_id in related_documents
                    ),
                    f"{where}.branchId must match at least one supplemented leaf",
                )
            else:
                validation.require(
                    related_documents == [first_leaf_id],
                    f"{where}.documentIds must contain only the first leaf",
                )
            for document_id in related_documents:
                validation.require(
                    document_id in documents,
                    f"{where} references unknown document: {document_id}",
                )
                if document_id in documents:
                    validation.require(
                        documents[document_id].get("customerVisible") is True,
                        f"{where} may only link packaged images to customer-visible documents",
                    )
                    if not is_user_upload:
                        validation.require(
                            documents[document_id].get("branchId")
                            == asset_branch_id,
                            f"{where}.branchId must match linked document "
                            f"{document_id}",
                        )

        actual_image_paths = {
            name
            for name in entries
            if PurePosixPath(name).suffix.lower() in IMAGE_TYPES
        }
        unsupported_images = {
            name
            for name in entries
            if PurePosixPath(name).suffix.lower()
            in {".svg", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".ico"}
        }
        validation.require(
            not unsupported_images,
            "unsupported or non-rasterized image files are packaged: "
            f"{sorted(unsupported_images)[:8]}",
        )
        validation.require(
            actual_image_paths == asset_paths,
            "image files and manifest.assets paths differ; "
            f"unlisted={sorted(actual_image_paths - asset_paths)[:8]}, "
            f"missing={sorted(asset_paths - actual_image_paths)[:8]}",
        )
        validation.require(
            len(official_logo_asset_ids) == REQUIRED_LOGO_IMAGES,
            "archive must contain exactly one non-user_upload official company Logo",
        )
        validation.require(
            len(user_upload_asset_ids) <= MAX_USER_UPLOAD_IMAGES,
            f"archive contains more than {MAX_USER_UPLOAD_IMAGES} customer-uploaded images",
        )
        validation.require(
            1 <= len(asset_paths) <= MAX_IMAGES,
            f"archive must contain 1–{MAX_IMAGES} real packaged images",
        )
        validation.require(
            image_bytes_total <= MAX_IMAGE_BYTES,
            f"packaged images use {image_bytes_total} bytes; maximum is {MAX_IMAGE_BYTES}",
        )

        for doc_id, document in documents.items():
            for asset_id in require_string_list(
                document, "assetIds", f"document {doc_id}", validation
            ):
                validation.require(
                    asset_id in assets,
                    f"document {doc_id} references unknown asset: {asset_id}",
                )
                if asset_id in assets:
                    validation.require(
                        doc_id in assets[asset_id].get("documentIds", []),
                        f"asset relationship is not reciprocal: {doc_id} / {asset_id}",
                    )
        for asset_id, asset in assets.items():
            for doc_id in asset.get("documentIds", []):
                if doc_id in documents:
                    validation.require(
                        asset_id in documents[doc_id].get("assetIds", []),
                        f"document relationship is not reciprocal: {doc_id} / {asset_id}",
                    )

        selection_status = image_selection.get("status")
        discovered = image_selection.get("discoveredCandidateImages")
        inspected = image_selection.get("inspectedCandidateImages")
        eligible = image_selection.get("eligibleFirstPartyImages")
        rejected = image_selection.get("rejectedCandidateImages")
        scanned_pages = image_selection.get("scannedSourcePages")
        discovery_methods = image_selection.get("discoveryMethods")
        rejection_reasons = image_selection.get("rejectionReasons")
        stop_reason = image_selection.get("stopReason")
        candidates = image_selection.get("candidates")
        shortfall = image_selection.get("shortfallReason")
        require_exact_keys(
            image_selection,
            allowed=IMAGE_SELECTION_KEYS,
            required=IMAGE_SELECTION_KEYS
            - (
                set()
                if selection_status in {"source_limited", "budget_limited"}
                else {"shortfallReason"}
            ),
            where="manifest.imageSelection",
            validation=validation,
        )
        validation.require(
            selection_status == "target_met",
            "new dashboard-enterprise-v1 archives require imageSelection.status target_met",
        )
        for key, value in (
            ("discoveredCandidateImages", discovered),
            ("inspectedCandidateImages", inspected),
            ("eligibleFirstPartyImages", eligible),
            ("rejectedCandidateImages", rejected),
            ("scannedSourcePages", scanned_pages),
        ):
            validation.require(
                isinstance(value, int)
                and not isinstance(value, bool)
                and value >= 0,
                f"imageSelection.{key} must be a non-negative integer",
            )
        if all(
            isinstance(value, int) and not isinstance(value, bool)
            for value in (discovered, inspected, eligible, rejected)
        ):
            validation.require(
                inspected <= discovered,
                "inspectedCandidateImages cannot exceed discoveredCandidateImages",
            )
            validation.require(
                inspected == eligible + rejected,
                "inspectedCandidateImages must equal eligible plus rejected candidates",
            )
            validation.require(
                len(official_logo_asset_ids) <= eligible,
                "official Logo count cannot exceed eligibleFirstPartyImages",
            )
        validation.require(
            isinstance(candidates, list),
            "imageSelection.candidates must be an array",
        )
        eligible_candidates: list[dict[str, Any]] = []
        rejected_candidates: list[dict[str, Any]] = []
        uninspected_candidates: list[dict[str, Any]] = []
        candidate_keys: set[str] = set()
        if isinstance(candidates, list):
            for index, candidate in enumerate(candidates):
                where = f"imageSelection.candidates[{index}]"
                if not isinstance(candidate, dict):
                    validation.errors.append(f"{where} must be an object")
                    continue
                status = candidate.get("status")
                required_candidate_keys = {"method", "status"}
                if status == "eligible":
                    required_candidate_keys.add("assetId")
                elif status == "rejected":
                    required_candidate_keys.add("rejectionReason")
                require_exact_keys(
                    candidate,
                    allowed=required_candidate_keys
                    | {
                        "url",
                        "sourcePageUrl",
                        "sourceDocumentPath",
                        "sourceKind",
                        "assetId",
                        "rejectionReason",
                    },
                    required=required_candidate_keys,
                    where=where,
                    validation=validation,
                )
                url = require_string(
                    candidate, "url", where, validation, optional=True
                )
                source_page = require_string(
                    candidate,
                    "sourcePageUrl",
                    where,
                    validation,
                    optional=True,
                )
                source_document = require_string(
                    candidate,
                    "sourceDocumentPath",
                    where,
                    validation,
                    optional=True,
                )
                candidate_source_kind = require_string(
                    candidate,
                    "sourceKind",
                    where,
                    validation,
                    optional=True,
                )
                method = require_string(candidate, "method", where, validation)
                validation.require(
                    method in REQUIRED_IMAGE_DISCOVERY_METHODS,
                    f"{where}.method is invalid",
                )
                if candidate_source_kind:
                    validation.require(
                        candidate_source_kind in OFFICIAL_LOGO_SOURCE_KINDS,
                        f"{where}.sourceKind is invalid",
                    )
                for key, candidate_url in (
                    ("url", url),
                    ("sourcePageUrl", source_page),
                ):
                    if not candidate_url:
                        continue
                    validation.require(
                        bool(
                            re.fullmatch(
                                r"https?://[^/\s:@]+(?::\d+)?(?:/[^@\s]*)?",
                                candidate_url,
                                flags=re.IGNORECASE,
                            )
                        )
                        and "@"
                        not in candidate_url.split("://", 1)[-1].split("/", 1)[0],
                        f"{where}.{key} must be a credential-free HTTP(S) URL",
                    )
                if method == "customer_upload":
                    validation.require(
                        candidate_source_kind == "official_logo_upload",
                        f"{where} customer_upload must use "
                        "sourceKind official_logo_upload",
                    )
                    validation.require(
                        not url and not source_page and not source_document,
                        f"{where} customer_upload must not claim a source URL "
                        "or packaged source document",
                    )
                    candidate_upload_key = (
                        "official_logo_upload:"
                        f"{candidate.get('assetId') or candidate.get('rejectionReason') or status}"
                    )
                else:
                    candidate_upload_key = ""
                    validation.require(
                        candidate_source_kind != "official_logo_upload",
                        f"{where} official_logo_upload must use method "
                        "customer_upload",
                    )
                    validation.require(
                        bool(url)
                        or (
                            bool(source_document)
                            and source_document in entries
                        ),
                        f"{where} requires a source URL or packaged source document",
                    )
                validation.require(
                    status in {"eligible", "rejected", "uninspected"},
                    f"{where}.status is invalid",
                )
                candidate_key = (
                    candidate_upload_key
                    or url
                    or f"{source_document}:{candidate.get('assetId') or candidate.get('rejectionReason') or status}"
                )
                validation.require(
                    candidate_key not in candidate_keys,
                    f"duplicate image candidate: {candidate_key}",
                )
                candidate_keys.add(candidate_key)
                if status == "eligible":
                    eligible_candidates.append(candidate)
                    asset_id = require_string(
                        candidate, "assetId", where, validation
                    )
                    asset = assets.get(asset_id)
                    if method == "customer_upload":
                        validation.require(
                            asset is not None
                            and candidate.get("rejectionReason") is None
                            and asset.get("sourceKind")
                            == "official_logo_upload"
                            and candidate_source_kind
                            == "official_logo_upload",
                            f"{where} does not match its packaged uploaded Logo",
                        )
                    else:
                        validation.require(
                            asset is not None
                            and candidate.get("rejectionReason") is None
                            and asset.get("sourceAssetUrl")
                            == candidate.get("url")
                            and asset.get("sourcePageUrl")
                            == candidate.get("sourcePageUrl")
                            and asset.get("sourceDocumentPath")
                            == candidate.get("sourceDocumentPath")
                            and (
                                not candidate_source_kind
                                or asset.get("sourceKind")
                                == candidate_source_kind
                            ),
                            f"{where} does not match its packaged asset",
                        )
                elif status == "rejected":
                    rejected_candidates.append(candidate)
                    validation.require(
                        candidate.get("assetId") is None
                        and isinstance(candidate.get("rejectionReason"), str)
                        and bool(candidate.get("rejectionReason", "").strip()),
                        f"{where} must contain only a rejectionReason",
                    )
                elif status == "uninspected":
                    uninspected_candidates.append(candidate)
                    validation.require(
                        candidate.get("assetId") is None
                        and candidate.get("rejectionReason") is None,
                        f"{where} cannot contain a result",
                    )
        if all(
            isinstance(value, int) and not isinstance(value, bool)
            for value in (discovered, inspected, eligible, rejected)
        ):
            validation.require(
                len(candidate_keys) == discovered
                and len(eligible_candidates) == eligible
                and len(rejected_candidates) == rejected
                and len(eligible_candidates) + len(rejected_candidates)
                == inspected
                and inspected + len(uninspected_candidates) == discovered,
                "image candidate ledger does not match aggregate counts",
            )
            validation.require(
                {
                    candidate.get("assetId")
                    for candidate in eligible_candidates
                    if candidate.get("assetId")
                }
                == official_logo_asset_ids,
                "the official Logo must appear exactly once as eligible; "
                "generic user_upload images must not enter imageSelection",
            )
        validation.require(
            isinstance(discovery_methods, list)
            and all(
                isinstance(method, str) and bool(method.strip())
                for method in discovery_methods
            ),
            "imageSelection.discoveryMethods must be a string array",
        )
        if isinstance(discovery_methods, list):
            validation.require(
                bool(discovery_methods)
                and {str(method).strip() for method in discovery_methods}
                <= REQUIRED_IMAGE_DISCOVERY_METHODS,
                "imageSelection.discoveryMethods must record only methods "
                "actually used to obtain the official company Logo",
            )
        validation.require(
            isinstance(stop_reason, str) and bool(stop_reason.strip()),
            "imageSelection.stopReason must be a non-empty string",
        )
        rejection_total = 0
        validation.require(
            isinstance(rejection_reasons, list),
            "imageSelection.rejectionReasons must be an array",
        )
        if isinstance(rejection_reasons, list):
            for index, reason in enumerate(rejection_reasons):
                where = f"imageSelection.rejectionReasons[{index}]"
                validation.require(
                    isinstance(reason, dict)
                    and set(reason) == {"reason", "count"}
                    and isinstance(reason.get("reason"), str)
                    and bool(reason.get("reason", "").strip())
                    and isinstance(reason.get("count"), int)
                    and not isinstance(reason.get("count"), bool)
                    and reason.get("count", -1) >= 0,
                    f"{where} must contain a reason and non-negative count",
                )
                if isinstance(reason, dict) and isinstance(reason.get("count"), int):
                    rejection_total += reason["count"]
        if isinstance(rejected, int) and not isinstance(rejected, bool):
            validation.require(
                rejection_total == rejected,
                "image rejection-reason counts must equal rejectedCandidateImages",
            )
        if (
            isinstance(eligible, int)
            and not isinstance(eligible, bool)
            and isinstance(discovered, int)
            and isinstance(inspected, int)
        ):
            official_completed = (
                completeness_acquisition.get("officialPages", {}).get(
                    "completed"
                )
                if isinstance(
                    completeness_acquisition.get("officialPages"), dict
                )
                else None
            )
            validation.require(
                isinstance(official_completed, int)
                and isinstance(scanned_pages, int)
                and scanned_pages <= official_completed,
                "scannedSourcePages cannot exceed successfully parsed official pages",
            )
            if selection_status == "target_met":
                validation.require(
                    len(uninspected_candidates) == 0
                    and len(official_logo_asset_ids) == REQUIRED_LOGO_IMAGES
                    and all(
                        asset.get("assetType") == "brand_identity"
                        and asset.get("displayRole") == "badge"
                        and asset.get("documentIds") == [first_leaf_id]
                        for asset_id, asset in assets.items()
                        if asset_id in official_logo_asset_ids
                    ),
                    "target_met requires exactly one official company Logo "
                    "linked only to the first leaf",
                )
                validation.require(
                    "shortfallReason" not in image_selection,
                    "target_met must omit imageSelection.shortfallReason",
                )
            else:
                validation.require(
                    len(official_logo_asset_ids) == eligible,
                    "limited image status must package every eligible Logo",
                )
                validation.require(
                    isinstance(shortfall, str) and bool(shortfall.strip()),
                    "limited image status requires a concrete shortfallReason",
                )
                if selection_status == "source_limited":
                    validation.require(
                        inspected == discovered,
                        "source_limited requires every discovered candidate to be inspected",
                    )
                if selection_status == "budget_limited":
                    validation.require(
                        inspected < discovered,
                        "budget_limited requires uninspected discovered candidates",
                    )
            discovered_images = (
                completeness_acquisition.get("images", {}).get("total")
                if isinstance(completeness_acquisition.get("images"), dict)
                else None
            )
            validation.require(
                not isinstance(discovered_images, int)
                or discovered == discovered_images,
                "discoveredCandidateImages must equal acquisition.images.total",
            )

        packaged_completed = (
            completeness_acquisition.get("images", {}).get("completed")
            if isinstance(completeness_acquisition.get("images"), dict)
            else None
        )
        validation.require(
            packaged_completed == len(official_logo_asset_ids),
            "00_completeness.json acquisition.images.completed must equal "
            "the official Logo count; generic user_upload images are excluded",
        )
        crawl_report_info = entries.get("00_crawl_coverage_report.md")
        if crawl_report_info is not None:
            try:
                crawl_report = archive.read(crawl_report_info).decode("utf-8")
            except UnicodeDecodeError:
                crawl_report = ""
            reported_logo_count: int | None = None
            for pattern in (
                r"(?:企业)?官方\s*Logo[^\n|]{0,30}"
                r"(?:成功下载|已下载|已保存|保存并打包|downloaded|packaged|saved)"
                r"[^\d]{0,12}([\d,]+)",
                r"(?:成功下载|已下载|已保存|保存并打包|downloaded|packaged|saved)"
                r"[^\n|]{0,30}(?:企业)?官方\s*Logo[^\d]{0,12}([\d,]+)",
            ):
                match = re.search(pattern, crawl_report, flags=re.IGNORECASE)
                if match:
                    reported_logo_count = int(match.group(1).replace(",", ""))
                    break
            if reported_logo_count is not None:
                validation.require(
                    reported_logo_count == len(official_logo_asset_ids),
                    "crawl report saved-Logo count does not match the official Logo asset",
                )
            reported_upload_count: int | None = None
            for pattern in (
                r"(?:客户|用户)(?:补充)?上传(?:图片|图像)[^\n|]{0,30}"
                r"(?:已保留|已保存|已打包|packaged|saved)[^\d]{0,12}([\d,]+)",
                r"(?:已保留|已保存|已打包|packaged|saved)[^\n|]{0,30}"
                r"(?:客户|用户)(?:补充)?上传(?:图片|图像)[^\d]{0,12}([\d,]+)",
            ):
                match = re.search(pattern, crawl_report, flags=re.IGNORECASE)
                if match:
                    reported_upload_count = int(match.group(1).replace(",", ""))
                    break
            if reported_upload_count is not None:
                validation.require(
                    reported_upload_count == len(user_upload_asset_ids),
                    "crawl report customer-upload count does not match packaged user uploads",
                )

        expected_counts = {
            "totalFiles": len(entries),
            "customerVisibleCharacters": formal_total,
            "evidenceCharacters": evidence_total,
            "packagedImages": len(asset_paths),
        }
        for key, actual in expected_counts.items():
            validation.require(
                counts.get(key) == actual,
                f"manifest.counts.{key} must be {actual}, got {counts.get(key)!r}",
            )
        validation.require(
            formal_total <= MAX_FORMAL_CHARACTERS,
            f"customer-visible formal content has {formal_total} characters; "
            f"maximum is {MAX_FORMAL_CHARACTERS}",
        )
        validation.require(
            evidence_total <= MAX_EVIDENCE_CHARACTERS,
            f"evidence content has {evidence_total} characters; "
            f"maximum is {MAX_EVIDENCE_CHARACTERS}",
        )

    return validation.errors


def canonical_markdown(value: str) -> str:
    without_bom = value[1:] if value.startswith("\ufeff") else value
    normalized = unicodedata.normalize("NFC", without_bom)
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip(" \t") for line in normalized.split("\n")).strip()


def canonical_packaged_leaf(value: str) -> str:
    if value.count(FORMAL_START) == 1 and value.count(FORMAL_END) == 1:
        start = value.index(FORMAL_START) + len(FORMAL_START)
        end = value.index(FORMAL_END)
        if end > start:
            return canonical_markdown(value[start:end])
    return canonical_markdown(value)


def _single_zip_entry_ending(
    archive: zipfile.ZipFile, suffix: str, validation: Validation, where: str
) -> str | None:
    matches = [
        info.filename
        for info in archive.infolist()
        if not info.is_dir()
        and safe_relative_name(info.filename)
        and (info.filename == suffix or info.filename.endswith("/" + suffix))
    ]
    if not validation.require(
        len(matches) == 1,
        f"{where} must contain exactly one {suffix}; found {len(matches)}",
    ):
        return None
    return matches[0]


def validate_finalization_binding(
    archive_path: Path,
    finalization_input_path: Path,
    expected_input_sha256: str | None = None,
    expected_operation_id: str | None = None,
    expected_turn_id: str | None = None,
) -> list[str]:
    """Cross-check a generated archive against its server-authored final input.

    The standalone archive contract proves internal consistency. This second
    check proves that the model copied the exact approved nodes and provenance
    supplied for this operation instead of inventing an upload id or source.
    """

    validation = Validation()
    if not finalization_input_path.is_file():
        return [f"finalization input does not exist: {finalization_input_path}"]
    if expected_input_sha256 is not None:
        digest = hashlib.sha256()
        try:
            with finalization_input_path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError as exc:
            return [f"cannot hash finalization input: {exc}"]
        validation.require(
            re.fullmatch(r"[a-f0-9]{64}", expected_input_sha256) is not None
            and digest.hexdigest() == expected_input_sha256,
            "finalization input SHA-256 does not match the current turn prompt",
        )
    try:
        output_zip = zipfile.ZipFile(archive_path)
        input_zip = zipfile.ZipFile(finalization_input_path)
    except (OSError, zipfile.BadZipFile) as exc:
        return [f"invalid finalization binding ZIP: {exc}"]

    with output_zip, input_zip:
        validation.require(
            input_zip.testzip() is None,
            f"finalization input ZIP CRC failed: {input_zip.testzip()}",
        )
        input_infos = [info for info in input_zip.infolist() if not info.is_dir()]
        validation.require(
            len(input_infos) <= 300,
            "finalization input contains too many files",
        )
        validation.require(
            sum(info.file_size for info in input_infos) <= 100 * MIB,
            "finalization input exceeds 100 MiB uncompressed",
        )
        validation.require(
            all(safe_relative_name(info.filename) for info in input_infos),
            "finalization input contains an unsafe path",
        )
        try:
            ledger_raw = input_zip.read("FINALIZATION_INPUT.json")
            ledger = json.loads(ledger_raw.decode("utf-8"))
        except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            return [f"invalid FINALIZATION_INPUT.json: {exc}"]
        if not isinstance(ledger, dict):
            return ["FINALIZATION_INPUT.json must be an object"]
        validation.require(
            ledger.get("kind") == "frontmind.knowledge-base.finalization-input"
            and ledger.get("schemaVersion") == 1,
            "FINALIZATION_INPUT.json kind/schemaVersion is invalid",
        )
        if expected_operation_id is not None:
            validation.require(
                ledger.get("operationId") == expected_operation_id,
                "FINALIZATION_INPUT.operationId does not match the current turn",
            )
        if expected_turn_id is not None:
            validation.require(
                ledger.get("turnId") == expected_turn_id,
                "FINALIZATION_INPUT.turnId does not match the current turn",
            )

        output_manifest_name = _single_zip_entry_ending(
            output_zip,
            "00_package_manifest.json",
            validation,
            "generated archive",
        )
        if output_manifest_name is None:
            return validation.errors
        output_root = output_manifest_name[: -len("00_package_manifest.json")]
        try:
            manifest = json.loads(output_zip.read(output_manifest_name).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return [f"invalid generated 00_package_manifest.json: {exc}"]
        if not isinstance(manifest, dict):
            return ["generated 00_package_manifest.json must be an object"]

        required_package = ledger.get("requiredPackage")
        validation.require(
            isinstance(required_package, dict),
            "FINALIZATION_INPUT.json.requiredPackage must be an object",
        )
        if isinstance(required_package, dict):
            for key in ("schemaVersion", "profile", "buildRevision"):
                validation.require(
                    manifest.get(key) == required_package.get(key),
                    f"generated manifest.{key} must exactly equal "
                    f"FINALIZATION_INPUT.requiredPackage.{key}",
                )

        input_nodes = ledger.get("nodes")
        output_documents = manifest.get("documents")
        validation.require(
            isinstance(input_nodes, list),
            "FINALIZATION_INPUT.json.nodes must be an array",
        )
        validation.require(
            isinstance(output_documents, list),
            "generated manifest.documents must be an array",
        )
        if not isinstance(input_nodes, list):
            input_nodes = []
        if not isinstance(output_documents, list):
            output_documents = []
        output_leaves = {
            item.get("id"): item
            for item in output_documents
            if isinstance(item, dict)
            and item.get("kind") == "leaf"
            and isinstance(item.get("id"), str)
        }
        validation.require(
            len(output_leaves) == len(input_nodes),
            "generated leaf count must equal FINALIZATION_INPUT node count",
        )
        expected_node_ids: list[str] = []
        for index, raw_node in enumerate(input_nodes):
            where = f"FINALIZATION_INPUT.nodes[{index}]"
            if not isinstance(raw_node, dict):
                validation.errors.append(f"{where} must be an object")
                continue
            node_id = raw_node.get("id")
            expected_node_ids.append(str(node_id or ""))
            validation.require(
                raw_node.get("status") in {"confirmed", "direct_prefilled"},
                f"{where}.status must be confirmed or direct_prefilled",
            )
            output_node = output_leaves.get(node_id)
            if not validation.require(
                isinstance(output_node, dict),
                f"generated archive is missing exact leaf id {node_id!r}",
            ):
                continue
            for input_key, output_key in (
                ("id", "id"),
                ("title", "title"),
                ("branchId", "branchId"),
                ("branchTitle", "branchTitle"),
                ("order", "order"),
            ):
                validation.require(
                    output_node.get(output_key) == raw_node.get(input_key),
                    f"generated leaf {node_id!r}.{output_key} must exactly equal {where}.{input_key}",
                )
            approved_path = raw_node.get("approvedContentPath")
            output_path = output_node.get("path")
            if not isinstance(approved_path, str) or not safe_relative_name(
                approved_path
            ):
                validation.errors.append(f"{where}.approvedContentPath is invalid")
                continue
            if not isinstance(output_path, str) or not safe_relative_name(output_path):
                validation.errors.append(
                    f"generated leaf {node_id!r}.path is invalid"
                )
                continue
            try:
                approved_bytes = input_zip.read(approved_path)
                packaged_bytes = output_zip.read(output_root + output_path)
                approved_text = approved_bytes.decode("utf-8")
                packaged_text = packaged_bytes.decode("utf-8")
            except (KeyError, UnicodeDecodeError) as exc:
                validation.errors.append(
                    f"cannot read exact leaf {node_id!r} content: {exc}"
                )
                continue
            approved = canonical_markdown(approved_text)
            packaged = canonical_packaged_leaf(packaged_text)
            approved_hash = hashlib.sha256(approved.encode("utf-8")).hexdigest()
            packaged_hash = hashlib.sha256(packaged.encode("utf-8")).hexdigest()
            validation.require(
                raw_node.get("contentSha256") == approved_hash,
                f"{where}.contentSha256 does not match approvedContentPath bytes",
            )
            validation.require(
                packaged_hash == approved_hash,
                f"generated leaf {node_id!r} formal content differs from the approved node",
            )
        validation.require(
            set(output_leaves) == set(expected_node_ids),
            "generated leaf ids must exactly equal FINALIZATION_INPUT node ids",
        )

        input_assets = ledger.get("assets")
        output_assets = manifest.get("assets")
        validation.require(
            isinstance(input_assets, list),
            "FINALIZATION_INPUT.json.assets must be an array",
        )
        validation.require(
            isinstance(output_assets, list),
            "generated manifest.assets must be an array",
        )
        if not isinstance(input_assets, list):
            input_assets = []
        if not isinstance(output_assets, list):
            output_assets = []
        validation.require(
            len(output_assets) == len(input_assets),
            "generated asset count must equal FINALIZATION_INPUT asset count",
        )
        unmatched_output = [item for item in output_assets if isinstance(item, dict)]
        provenance_keys = {
            "branchId",
            "documentIds",
            "sourceKind",
            "sourceUploadIndex",
            "sourceUploadFileId",
            "sourceUploadFilename",
            "sourceUploadMimeType",
            "sourceUploadSizeBytes",
            "sourceUploadSha256",
            "sourcePageUrl",
            "sourceAssetUrl",
            "sourceDocumentPath",
            "ownership",
            "assetType",
            "displayRole",
        }
        for index, raw_asset in enumerate(input_assets):
            where = f"FINALIZATION_INPUT.assets[{index}]"
            if not isinstance(raw_asset, dict):
                validation.errors.append(f"{where} must be an object")
                continue
            input_descriptor = raw_asset.get("input")
            required_manifest = raw_asset.get("requiredManifest")
            if not isinstance(input_descriptor, dict) or not isinstance(
                required_manifest, dict
            ):
                validation.errors.append(
                    f"{where}.input and requiredManifest must be objects"
                )
                continue
            input_path = input_descriptor.get("path")
            if not isinstance(input_path, str) or not safe_relative_name(input_path):
                validation.errors.append(f"{where}.input.path is invalid")
                continue
            try:
                source_bytes = input_zip.read(input_path)
            except KeyError:
                validation.errors.append(f"{where}.input.path is missing")
                continue
            source_sha256 = hashlib.sha256(source_bytes).hexdigest()
            validation.require(
                input_descriptor.get("sha256") == source_sha256,
                f"{where}.input.sha256 does not match bundled source bytes",
            )
            validation.require(
                input_descriptor.get("sizeBytes") == len(source_bytes),
                f"{where}.input.sizeBytes does not match bundled source bytes",
            )
            kind = raw_asset.get("kind")
            if kind == "official_logo":
                matches = [
                    item
                    for item in unmatched_output
                    if item.get("sha256") == source_sha256
                    and item.get("assetType") == "brand_identity"
                ]
            else:
                matches = [
                    item
                    for item in unmatched_output
                    if item.get("sourceUploadSha256") == source_sha256
                    and item.get("assetType") == "customer_supplied"
                ]
            if not validation.require(
                len(matches) == 1,
                f"generated archive must uniquely bind {where} by its server-authored source hash",
            ):
                continue
            output_asset = matches[0]
            unmatched_output.remove(output_asset)
            for key, expected in required_manifest.items():
                validation.require(
                    output_asset.get(key) == expected,
                    f"generated asset {output_asset.get('id')!r}.{key} must exactly equal {where}.requiredManifest.{key}",
                )
            unexpected_provenance = {
                key
                for key in provenance_keys
                if key in output_asset and key not in required_manifest
            }
            validation.require(
                not unexpected_provenance,
                f"generated asset {output_asset.get('id')!r} invents provenance fields not present in requiredManifest: {sorted(unexpected_provenance)}",
            )
            output_asset_path = output_asset.get("path")
            if isinstance(output_asset_path, str) and safe_relative_name(
                output_asset_path
            ):
                try:
                    packaged_asset_bytes = output_zip.read(
                        output_root + output_asset_path
                    )
                except KeyError:
                    validation.errors.append(
                        f"generated asset path is missing: {output_asset_path}"
                    )
                else:
                    if kind == "official_logo":
                        validation.require(
                            packaged_asset_bytes == source_bytes,
                            "generated official Logo bytes must exactly equal the Dashboard-bound raster input Logo",
                        )
            else:
                validation.errors.append(
                    f"generated asset {output_asset.get('id')!r}.path is invalid"
                )
        validation.require(
            not unmatched_output,
            "generated archive contains assets not authorized by FINALIZATION_INPUT",
        )

    return validation.errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a dashboard-enterprise-v1 knowledge-base ZIP."
    )
    parser.add_argument("archive", type=Path)
    parser.add_argument(
        "--finalization-input",
        type=Path,
        help="Cross-check against the exact server-authored finalization input ZIP.",
    )
    parser.add_argument("--expected-finalization-sha256")
    parser.add_argument("--expected-operation-id")
    parser.add_argument("--expected-turn-id")
    args = parser.parse_args()
    errors = validate_archive(args.archive.resolve())
    if args.finalization_input is not None:
        if not all(
            (
                args.expected_finalization_sha256,
                args.expected_operation_id,
                args.expected_turn_id,
            )
        ):
            errors.append(
                "--finalization-input requires --expected-finalization-sha256, "
                "--expected-operation-id and --expected-turn-id"
            )
        else:
            errors.extend(
                validate_finalization_binding(
                    args.archive.resolve(),
                    args.finalization_input.resolve(),
                    args.expected_finalization_sha256,
                    args.expected_operation_id,
                    args.expected_turn_id,
                )
            )
    if errors:
        print(f"INVALID: {len(errors)} error(s)", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("VALID dashboard-enterprise-v1 archive")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
