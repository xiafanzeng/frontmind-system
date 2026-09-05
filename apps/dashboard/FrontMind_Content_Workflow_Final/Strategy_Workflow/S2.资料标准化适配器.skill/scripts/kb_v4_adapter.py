#!/usr/bin/env python3
"""Build lightweight v2.2 content registries from any usable S1 input."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse
from xml.etree import ElementTree


DOCUMENT_EXTENSIONS = {".json", ".md", ".txt", ".html", ".htm", ".csv", ".tsv", ".pdf", ".docx", ".pptx", ".xlsx"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".svg"}
MAX_FILES = 5_000
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
EXPLICIT_INTERNAL = ("仅供内部", "内部资料", "内部培训", "保密", "confidential", "internal only")
HIGH_RISK_INSTRUCTIONS = ("注射剂量", "注射层次", "手术步骤", "操作步骤", "麻醉剂量", "用药剂量", "处方剂量")
PII_PATTERNS = (
    re.compile(r"(?<!\d)\d{17}[0-9Xx](?!\d)"),
    re.compile(r"(?:患者|客户|求美者)(?:姓名|身份证|病历号)[:：]?\s*[^\s，。]{2,32}"),
)


def stable_id(prefix: str, value: str, length: int = 16) -> str:
    token = hashlib.sha1(value.encode("utf-8")).hexdigest()[:length]
    return f"{prefix}_{token}"


def safe_relative(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and ".." not in path.parts and "\\" not in name


def safe_output_path(root: Path, relative: str) -> Path:
    if not safe_relative(relative):
        raise ValueError(f"unsafe material path: {relative}")
    destination = (root / PurePosixPath(relative)).resolve()
    if root.resolve() not in destination.parents:
        raise ValueError(f"material path escapes output: {relative}")
    return destination


def load_materials(path: Path) -> dict[str, bytes]:
    materials: dict[str, bytes] = {}
    if path.is_dir():
        total = 0
        for item in sorted(path.rglob("*")):
            if item.is_symlink() or not item.is_file():
                continue
            relative = item.relative_to(path).as_posix()
            if item.suffix.lower() in DOCUMENT_EXTENSIONS | IMAGE_EXTENSIONS:
                size = item.stat().st_size
                if size > MAX_FILE_BYTES:
                    raise ValueError(f"material file is too large to process safely: {relative}")
                total += size
                if total > MAX_TOTAL_BYTES or len(materials) >= MAX_FILES:
                    raise ValueError("material directory exceeds safe processing limits")
                materials[relative] = item.read_bytes()
        return materials
    if not path.is_file():
        raise ValueError("input does not exist")
    if path.suffix.lower() in DOCUMENT_EXTENSIONS | IMAGE_EXTENSIONS:
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("input file is too large to process safely")
        materials[path.name] = path.read_bytes()
        return materials
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            names: set[str] = set()
            total = 0
            for item in archive.infolist():
                if item.is_dir():
                    continue
                if not safe_relative(item.filename):
                    raise ValueError(f"unsafe archive member path: {item.filename}")
                if item.filename in names:
                    raise ValueError(f"duplicate archive member path: {item.filename}")
                names.add(item.filename)
                mode = (item.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    continue
                if PurePosixPath(item.filename).suffix.lower() in DOCUMENT_EXTENSIONS | IMAGE_EXTENSIONS:
                    if item.file_size > MAX_FILE_BYTES:
                        raise ValueError(f"archive member is too large to process safely: {item.filename}")
                    if item.compress_size and item.file_size / item.compress_size > MAX_COMPRESSION_RATIO:
                        raise ValueError(f"archive member exceeds the safe compression ratio: {item.filename}")
                    total += item.file_size
                    if total > MAX_TOTAL_BYTES or len(materials) >= MAX_FILES:
                        raise ValueError("archive exceeds safe processing limits")
                    materials[item.filename] = archive.read(item)
        return materials
    raise ValueError("unsupported input file format")


def strip_markup(value: str) -> str:
    value = re.sub(r"<script\b[^>]*>.*?</script>", " ", value, flags=re.I | re.S)
    value = re.sub(r"<style\b[^>]*>.*?</style>", " ", value, flags=re.I | re.S)
    value = re.sub(r"<[^>]+>", "\n", value)
    value = html.unescape(value)
    return re.sub(r"\n{3,}", "\n\n", value).strip()


def extract_ooxml(data: bytes, prefixes: tuple[str, ...]) -> str:
    values: list[str] = []
    import io

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for name in sorted(archive.namelist()):
                if not name.endswith(".xml") or not any(name.startswith(prefix) for prefix in prefixes):
                    continue
                try:
                    root = ElementTree.fromstring(archive.read(name))
                except (ElementTree.ParseError, KeyError):
                    continue
                text_values = [node.text.strip() for node in root.iter() if node.tag.rsplit("}", 1)[-1] in {"t", "v"} and node.text and node.text.strip()]
                if text_values:
                    values.append(" ".join(text_values))
    except zipfile.BadZipFile:
        return ""
    return "\n".join(values)


def extract_pdf(data: bytes) -> str:
    with tempfile.TemporaryDirectory() as temp_dir:
        source = Path(temp_dir) / "source.pdf"
        target = Path(temp_dir) / "source.txt"
        source.write_bytes(data)
        try:
            subprocess.run(["pdftotext", "-layout", str(source), str(target)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        except (FileNotFoundError, subprocess.SubprocessError):
            return ""
        return target.read_text(encoding="utf-8", errors="ignore") if target.exists() else ""


def extract_text(name: str, data: bytes) -> str:
    suffix = PurePosixPath(name).suffix.lower()
    if suffix in {".md", ".txt", ".csv", ".tsv"}:
        return data.decode("utf-8", errors="ignore").strip()
    if suffix == ".json":
        try:
            return json.dumps(json.loads(data.decode("utf-8")), ensure_ascii=False, indent=2)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return data.decode("utf-8", errors="ignore").strip()
    if suffix in {".html", ".htm"}:
        return strip_markup(data.decode("utf-8", errors="ignore"))
    if suffix == ".docx":
        return extract_ooxml(data, ("word/",))
    if suffix == ".pptx":
        return extract_ooxml(data, ("ppt/slides/", "ppt/notesSlides/"))
    if suffix == ".xlsx":
        return extract_ooxml(data, ("xl/worksheets/", "xl/sharedStrings.xml"))
    if suffix == ".pdf":
        return extract_pdf(data)
    return ""


def normalize_text(value: str, limit: int = 80_000) -> str:
    value = value.replace("\x00", "")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value).strip()
    return value[:limit]


def usability(path: str, text: str) -> tuple[str, str | None]:
    probe = f"{path}\n{text[:20_000]}".lower()
    if any(keyword.lower() in probe for keyword in EXPLICIT_INTERNAL):
        return "excluded", "explicitly_internal_or_confidential"
    if any(pattern.search(text) for pattern in PII_PATTERNS):
        return "excluded", "personal_information_detected"
    if any(keyword in text for keyword in HIGH_RISK_INSTRUCTIONS):
        # Keep a safe, non-procedural summary available to the writing layer,
        # while preventing the underlying dosage/layer/step detail from being
        # copied as a public fact.  Excluding the entire document would also
        # erase benign service identity, qualified team and verification facts.
        return "qualified", "high_risk_detail_summary_only"
    if not text.strip():
        return "qualified", "content_requires_manual_reading"
    if any(keyword in text for keyword in ("价格", "报价", "截至", "有效期")):
        return "qualified", "time_or_condition_sensitive"
    return "usable", None


def first_statement(text: str, fallback: str) -> str:
    """Return the first publishable assertion, never a document heading.

    Working-set nodes are usually Markdown documents whose first non-empty line is
    an H1 copied from the knowledge-tree title.  Treating that line as a claim
    turns S4 positioning and priority angles into fragments such as
    ``品牌主张：……``.  Prefer the first substantive paragraph and keep the title
    only as a last-resort label when extraction yields no prose at all.
    """

    fallback_normalized = re.sub(r"\s+", " ", fallback).strip()
    candidates: list[str] = []
    in_frontmatter = False
    in_fence = False
    for block in re.split(r"\n\s*\n", text):
        cleaned_lines: list[str] = []
        for raw_line in block.splitlines():
            stripped = raw_line.strip()
            if stripped == "---":
                in_frontmatter = not in_frontmatter
                continue
            if in_frontmatter:
                continue
            if stripped.startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence or not stripped:
                continue
            if re.match(r"^#{1,6}\s+", stripped):
                continue
            if re.match(r"^\|?\s*:?-{3,}", stripped):
                continue
            stripped = re.sub(r"^(?:[-*+]\s+|\d+[.)]\s+|>\s*)", "", stripped)
            stripped = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", stripped)
            stripped = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", stripped)
            stripped = re.sub(r"[*_`]+", "", stripped).strip()
            if not stripped or stripped.startswith(("来源", "Source", "http://", "https://")):
                continue
            cleaned_lines.append(stripped)
        candidate = re.sub(r"\s+", " ", " ".join(cleaned_lines)).strip()
        if not candidate or candidate == fallback_normalized:
            continue
        # A short colon-ended line is normally another section label, not prose.
        if len(candidate) < 24 and candidate.endswith(("：", ":")):
            continue
        if len(candidate) >= 12:
            candidates.append(candidate[:500])

    if candidates:
        title_probe = re.sub(r"(?:总览|概览|项目|体系|信息|介绍|口径)", "", fallback_normalized)
        title_terms = {
            title_probe[index:index + length]
            for length in (2, 3)
            for index in range(max(0, len(title_probe) - length + 1))
            if re.fullmatch(r"[\u3400-\u9fff]+", title_probe[index:index + length])
        }
        internal_markers = ("统计口径", "授权统计", "客户物料", "待补充", "资料缺失", "未确认")

        def editorial_score(candidate: str) -> tuple[int, int]:
            relevance = sum(2 if len(term) == 3 else 1 for term in title_terms if term in candidate)
            relevance -= 6 * sum(marker in candidate for marker in internal_markers)
            prose = 2 if re.search(r"[。！？；.!?;]", candidate) else 0
            return relevance + prose, min(len(candidate), 240)

        return max(candidates, key=editorial_score)
    return (candidates[0] if candidates else fallback_normalized)[:500]


def claim_type(path: str, text: str, knowledge_kind: str = "") -> str:
    """Classify the assertion's editorial role without keyword leakage.

    The previous implementation scanned an entire source document and treated a
    single incidental word (for example ``收费主体``) as a price claim.  Working-set
    branch metadata is a much stronger signal and is therefore evaluated before
    broad lexical fallbacks; only explicit price/specification language can
    override it.
    """

    probe = f"{path} {text[:1800]}".casefold()
    kind = str(knowledge_kind or "").casefold()
    if re.search(r"(?:价格|报价|收费标准|费用(?:为|是|包含|构成)|\d+(?:\.\d+)?\s*元|price\b)", probe):
        return "price"
    if re.search(r"(?:规格|型号|技术参数|尺寸|容量|spec(?:ification)?\b)", probe):
        return "specification"
    branch_roles = {
        "services": "product",
        "team": "capability",
        "capability": "capability",
        "differentiation": "capability",
        "cases": "case_result",
        "compliance": "limitation",
        "cooperation": "capability",
        "identity": "knowledge_statement",
    }
    if kind in branch_roles:
        return branch_roles[kind]
    for keywords, value in (
        (("限制", "风险", "禁忌", "不适合", "不得", "limitation"), "limitation"),
        (("案例", "项目记录", "case"), "case_result"),
        (("产品", "服务", "项目", "service", "product"), "product"),
        (("能力", "团队", "医师", "流程", "交付", "capability"), "capability"),
        (("事件", "发布", "news"), "event"),
    ):
        if any(keyword in probe for keyword in keywords):
            return value
    return "knowledge_statement"


def json_object(materials: dict[str, bytes], basename: str) -> tuple[str | None, dict | None]:
    for name, data in materials.items():
        if PurePosixPath(name).name != basename:
            continue
        try:
            value = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            return name, value
    return None, None


def copy_material(root: Path, area: str, name: str, data: bytes) -> str:
    relative = PurePosixPath(name)
    cleaned = "/".join(part for part in relative.parts if part not in {".", ""})
    destination = safe_output_path(root, f"{area}/{cleaned}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return destination.relative_to(root.resolve()).as_posix()


def copy_at_relative_path(root: Path, relative: str, data: bytes) -> str:
    destination = safe_output_path(root, relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return destination.relative_to(root.resolve()).as_posix()


def adapt_existing_registry(value: dict, registry_type: str) -> dict:
    list_key = {"knowledge_registry": "knowledge_units", "source_registry": "sources", "claim_registry": "claims", "image_registry": "images"}[registry_type]
    items = value.get(list_key) if isinstance(value.get(list_key), list) else []
    normalized: list[dict] = []
    for raw in items:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        for key in tuple(name for name in item if "sha256" in name.lower() or name.lower().endswith("fingerprint")):
            item.pop(key, None)
        if registry_type == "source_registry":
            allowed = item.get("allowed_usage")
            item["usage_status"] = "excluded" if item.get("publication_authorization") in {"internal_only", "prohibited"} else ("qualified" if allowed == "public_with_qualification" else "usable")
            for key in tuple(name for name in item if name.startswith("review") or name.startswith("authorization_") or name.endswith("_authorization")):
                item.pop(key, None)
            if item.get("source_origin_class") == "runtime_approved":
                item["source_origin_class"] = "runtime_research"
        elif registry_type == "claim_registry":
            item["usage_status"] = "excluded" if item.get("allowed_usage") in {"internal_only", "do_not_use"} else ("qualified" if item.get("allowed_usage") == "public_with_qualification" else "usable")
        elif registry_type == "image_registry":
            image_id = item.get("image_id") or item.get("asset_id")
            if not image_id or not isinstance(item.get("file_path"), str) or not item.get("file_path"):
                continue
            item["image_id"] = image_id
            item.pop("asset_id", None)
            if item.get("rights_status") == "restricted_not_allowed":
                item["rights_status"] = "prohibited"
            role_map = {
                "cover": "brand_editorial", "decorative": "brand_editorial",
                "comparison": "explain", "process_explanation": "explain",
                "product_proof": "prove", "case_proof": "prove", "event_proof": "prove", "data_evidence": "prove",
                "entity_proof": "entity_proof",
            }
            item["allowed_roles"] = list(dict.fromkeys(role_map.get(str(role), "navigate") for role in item.get("allowed_roles", [])))
            item["usage_status"] = "usable" if item.get("rights_status") in {"approved", "approved_with_credit"} else "excluded"
        else:
            item["usage_status"] = "excluded" if item.get("content_status") in {"internal_only", "blocked"} else ("qualified" if item.get("evidence_status") in {"partial", "unverified"} else "usable")
        normalized.append(item)
    return {"schema_version": "2.2.0", "registry_type": registry_type, list_key: normalized}


def existing_registries(materials: dict[str, bytes]) -> tuple[dict[str, dict], str] | None:
    pack_name, pack = json_object(materials, "reference_pack.json")
    if not pack:
        return None
    pack_parent = PurePosixPath(pack_name or "").parent
    prefix = "" if str(pack_parent) == "." else pack_parent.as_posix()
    paths = pack.get("registries") if isinstance(pack.get("registries"), dict) else {}
    aliases = {
        "knowledge_registry": ("knowledge_registry_path", "knowledge"),
        "source_registry": ("source_registry_path", "sources"),
        "claim_registry": ("claim_registry_path", "claims"),
        "image_registry": ("image_registry_path", "images"),
    }
    output: dict[str, dict] = {}
    for registry_type, keys in aliases.items():
        path = next((paths.get(key) for key in keys if isinstance(paths.get(key), str)), None)
        resolved_path = path if path in materials else f"{prefix}/{path}" if prefix and f"{prefix}/{path}" in materials else None
        if not resolved_path:
            return None
        try:
            value = json.loads(materials[resolved_path].decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict):
            return None
        output[registry_type] = adapt_existing_registry(value, registry_type)
    return output, prefix


def build_registries(brand: str, materials: dict[str, bytes], output_dir: Path) -> tuple[dict[str, dict], list[str]]:
    reused_result = existing_registries(materials)
    if reused_result:
        reused, pack_prefix = reused_result
        warnings = ["Existing Reference Pack registries were adapted to v2.2 usage states without historical audit bindings."]
        for name, data in materials.items():
            relative = name[len(pack_prefix) + 1:] if pack_prefix and name.startswith(f"{pack_prefix}/") else name
            if relative.startswith(("sources/", "assets/")):
                copy_at_relative_path(output_dir, relative, data)
        return reused, warnings

    _, bundle = json_object(materials, "BUNDLE.json")
    company_site = ""
    leaf_meta: dict[str, dict] = {}
    evidence_meta: dict[str, dict] = {}
    if bundle and bundle.get("kind") == "frontmind.kb-working-set":
        company = bundle.get("company") if isinstance(bundle.get("company"), dict) else {}
        company_site = str(company.get("website") or "")
        leaf_meta = {str(item.get("contentPath")): item for item in bundle.get("leaves", []) if isinstance(item, dict) and item.get("contentPath")}
        evidence_meta = {str(item.get("path")): item for item in bundle.get("evidenceLedger", []) if isinstance(item, dict) and item.get("path")}

    knowledge_units: list[dict] = []
    sources: list[dict] = []
    claims: list[dict] = []
    images: list[dict] = []
    warnings: list[str] = []
    source_by_material: dict[str, str] = {}
    company_domain = urlparse(company_site).netloc.lower().removeprefix("www.")

    for name, data in sorted(materials.items()):
        suffix = PurePosixPath(name).suffix.lower()
        if suffix in IMAGE_EXTENSIONS:
            package_path = copy_material(output_dir, "assets", name, data)
            images.append({
                "image_id": stable_id("img", name),
                "asset_kind": "logo" if "logo" in name.lower() else "unknown",
                "file_path": package_path,
                "mime_type": {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml"}.get(suffix),
                "source_kind": "client_submitted",
                "rights_status": "unknown",
                "semantic_tags": [PurePosixPath(name).stem],
                "allowed_roles": ["brand_editorial"],
                "usage_status": "excluded",
            })
            continue
        if suffix not in DOCUMENT_EXTENSIONS or PurePosixPath(name).name in {"reference_pack.json", "BUNDLE.json", "00_package_manifest.json"}:
            continue
        text = normalize_text(extract_text(name, data))
        status, reason = usability(name, text)
        package_path = copy_material(output_dir, "sources", name, data)
        meta = evidence_meta.get(name, {})
        source_url_candidate = str(meta.get("sourceUrl") or "").strip()
        parsed_candidate = urlparse(source_url_candidate)
        source_url = source_url_candidate if parsed_candidate.scheme in {"http", "https"} and parsed_candidate.netloc else None
        source_id = stable_id("src", name)
        source_by_material[name] = source_id
        source_domain = urlparse(source_url).netloc.lower().removeprefix("www.") if source_url else ""
        first_party = bool(company_domain and source_domain and (source_domain == company_domain or source_domain.endswith(f".{company_domain}"))) or not source_url
        source_type = "first_party_internal" if status == "excluded" else ("first_party_official" if first_party else "editorial_media")
        sources.append({
            "source_id": source_id,
            "title": str(leaf_meta.get(name, {}).get("title") or PurePosixPath(name).stem),
            "publisher": brand if first_party else (source_domain or None),
            "source_type": source_type,
            "source_origin_class": "first_party_internal" if status == "excluded" else ("first_party_official" if first_party else "third_party_public"),
            "authority_tier": 1 if first_party else 2,
            "url": source_url,
            "file_path": package_path,
            "accessed_at": str(meta.get("retrievedAt") or datetime.now(timezone.utc).isoformat()),
            "language": "zh-CN",
            "notes": reason,
            "evidence_precision": "document",
            "usage_status": status,
        })
        if not text:
            warnings.append(f"Text extraction was unavailable for {name}; the original file remains available as a qualified source.")
        if name.startswith("evidence/"):
            continue
        leaf = leaf_meta.get(name, {})
        evidence_paths = [str(path) for path in leaf.get("evidencePaths", []) if isinstance(path, str)]
        source_ids = [source_by_material[path] for path in evidence_paths if path in source_by_material]
        if not source_ids:
            source_ids = [source_id]
        knowledge_id = stable_id("kn", name)
        title = str(leaf.get("title") or PurePosixPath(name).stem)
        knowledge_units.append({
            "knowledge_id": knowledge_id,
            "title": title,
            "kind": str(leaf.get("branchId") or "document"),
            "content": text,
            "package_path": package_path,
            "source_ids": source_ids,
            "evidence_document_refs": evidence_paths,
            "asset_ids": [stable_id("img", str(asset_id)) for asset_id in leaf.get("assetIds", []) if asset_id],
            "evidence_status": "verified" if status == "usable" else ("partial" if status == "qualified" else "unverified"),
            "content_status": "customer_visible" if status != "excluded" else "internal_only",
            "evidence_precision": "document",
            "usage_status": status,
        })
        claim_status = "verified" if status == "usable" else ("verified_with_limits" if status == "qualified" else "disallowed")
        claims.append({
            "claim_id": stable_id("clm", name),
            "claim_text": first_statement(text, title),
            "claim_type": claim_type(name, first_statement(text, title), str(leaf.get("branchId") or "")),
            "importance": "supporting",
            "about_entities": [brand],
            "source_ids": source_ids,
            "knowledge_ids": [knowledge_id],
            "evidence_precision": "document",
            "reason": reason,
            "verification_status": claim_status,
            "allowed_usage": "public_fact" if status == "usable" else ("public_with_qualification" if status == "qualified" else "do_not_use"),
            "usage_status": status,
        })

    if bundle and bundle.get("kind") == "frontmind.kb-working-set":
        # Evidence files sort before nodes in most archives, but repair any leaf links deterministically.
        source_map = {item["file_path"].removeprefix("sources/"): item["source_id"] for item in sources if item.get("file_path")}
        for unit, claim in zip(knowledge_units, claims):
            refs = unit.get("evidence_document_refs", [])
            linked = [source_map[ref] for ref in refs if ref in source_map]
            if linked:
                unit["source_ids"] = linked
                claim["source_ids"] = linked

    if not knowledge_units and not sources:
        raise ValueError("no usable documents could be normalized")
    return {
        "knowledge_registry": {"schema_version": "2.2.0", "registry_type": "knowledge_registry", "knowledge_units": knowledge_units},
        "source_registry": {"schema_version": "2.2.0", "registry_type": "source_registry", "sources": sources},
        "claim_registry": {"schema_version": "2.2.0", "registry_type": "claim_registry", "claims": claims},
        "image_registry": {"schema_version": "2.2.0", "registry_type": "image_registry", "images": images},
    }, warnings


def add_gallery(materials: dict[str, bytes], gallery: Path | None) -> None:
    if not gallery:
        return
    if not gallery.is_dir():
        raise ValueError("--gallery must be a directory")
    for item in sorted(gallery.rglob("*")):
        if item.is_symlink() or not item.is_file() or item.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        materials[f"gallery/{item.relative_to(gallery).as_posix()}"] = item.read_bytes()


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize usable enterprise material into v2.2 registries")
    parser.add_argument("--brand", required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--s1-intake", type=Path)
    parser.add_argument("--gallery", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        brand = args.brand.strip()
        if not brand:
            raise ValueError("--brand must be non-empty")
        if args.s1_intake:
            intake = json.loads(args.s1_intake.read_text(encoding="utf-8"))
            if intake.get("stage") != "S1_material_intake" or intake.get("brand") != brand:
                raise ValueError("S1 intake does not describe this brand")
        materials = load_materials(args.input.resolve())
        add_gallery(materials, args.gallery.resolve() if args.gallery else None)
        if not materials:
            raise ValueError("input contains no supported material")
        args.output_dir.mkdir(parents=True, exist_ok=True)
        registries, warnings = build_registries(brand, materials, args.output_dir)
        label = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_-]+", "_", brand).strip("_") or "brand"
        paths = {
            "knowledge_registry": args.output_dir / f"S2_{label}_knowledge_registry.json",
            "source_registry": args.output_dir / f"S2_{label}_source_registry.json",
            "claim_registry": args.output_dir / f"S2_{label}_claim_registry.json",
            "image_registry": args.output_dir / f"S2_{label}_image_registry.json",
        }
        for key, path in paths.items():
            path.write_text(json.dumps(registries[key], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        counts = {
            "knowledge": len(registries["knowledge_registry"]["knowledge_units"]),
            "sources": len(registries["source_registry"]["sources"]),
            "claims": len(registries["claim_registry"]["claims"]),
            "images": len(registries["image_registry"]["images"]),
        }
        statuses = {status: 0 for status in ("usable", "qualified", "excluded")}
        for registry in registries.values():
            collection = next((value for key, value in registry.items() if key not in {"schema_version", "registry_type"}), [])
            for item in collection:
                statuses[item.get("usage_status", "qualified")] += 1
        status = "completed_with_limits" if statuses["qualified"] or statuses["excluded"] or warnings else "completed"
        report = {
            "schema_version": "2.2.0",
            "stage": "S2_material_normalization",
            "status": status,
            "brand": brand,
            "input_kind": intake.get("input", {}).get("input_kind") if args.s1_intake else "direct_material",
            "counts": counts,
            "usage_status_counts": statuses,
            "warnings": warnings,
        }
        report_path = args.output_dir / f"S2_{label}_adapter_report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
        parser.error(str(exc))
    print(json.dumps({"stage": "S2", "status": status, "counts": counts, "warnings": len(warnings)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
