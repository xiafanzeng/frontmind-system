#!/usr/bin/env python3
"""Safely retrieve the raw Dashboard Top20 and emit machine page analysis.

The retriever never discovers or backfills URLs.  It finalizes every rank from
the signed source-pool artifact as one of the five v2.1 statuses.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import io
import ipaddress
import json
import os
import re
import socket
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from e2_pattern_contract import file_sha256, load_object  # noqa: E402
from schema_validation import validate_schema  # noqa: E402


ALLOWED_PORTS = {80, 443}
ALLOWED_MIME = {
    "text/html", "application/xhtml+xml", "text/plain", "application/pdf",
}
MAX_REDIRECTS = 5
MAX_EXTRACT_CHARS = 2_000_000
MAX_SHORT_EXCERPT_CHARS = 500
MAX_CUE_CONTEXT_CHARS = 80
MAX_CUE_CONTEXT_TOTAL_CHARS = 2_000
MAX_OBSERVED_CUES = 50
CLASSIFIER_VERSION = "frontmind-e2-structural-heuristic-v2.1.0"
NON_ARTICLE_DOMAIN_FORMS = {
    "qcc.com": "company_registry", "tianyancha.com": "company_registry",
    "aiqicha.baidu.com": "company_registry", "shuidi.cn": "company_registry",
    "wikipedia.org": "encyclopedia", "baike.baidu.com": "encyclopedia",
    "baike.com": "encyclopedia", "patents.google.com": "patent_record",
    "patentstar.com.cn": "patent_record", "douyin.com": "short_video",
    "iesdouyin.com": "short_video", "bilibili.com": "short_video",
    "weibo.com": "social_post", "xiaohongshu.com": "social_post",
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


class VisibleHTML(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hidden_depth = 0
        self.current_heading: str | None = None
        self.title_depth = 0
        self.title_parts: list[str] = []
        self.text_parts: list[str] = []
        self.headings: dict[str, list[str]] = {"h1": [], "h2": [], "h3": []}
        self.heading_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "template", "svg"}:
            self.hidden_depth += 1
        elif tag == "title":
            self.title_depth += 1
        elif tag in self.headings:
            self.current_heading = tag
            self.heading_parts = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "template", "svg"} and self.hidden_depth:
            self.hidden_depth -= 1
        elif tag == "title" and self.title_depth:
            self.title_depth -= 1
        elif tag == self.current_heading:
            value = clean_text(" ".join(self.heading_parts))
            if value and len(self.headings[tag]) < {"h1": 5, "h2": 60, "h3": 120}[tag]:
                self.headings[tag].append(value[:500])
            self.current_heading = None
            self.heading_parts = []

    def handle_data(self, data: str) -> None:
        if self.hidden_depth:
            return
        value = clean_text(data)
        if not value:
            return
        if self.title_depth:
            self.title_parts.append(value)
        if self.current_heading:
            self.heading_parts.append(value)
        self.text_parts.append(value)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", html.unescape(str(value or "")))).strip()


def atomic_bytes(path: Path, content: bytes) -> None:
    if path.exists() or path.is_symlink():
        raise FileExistsError(f"refusing to overwrite E2 retrieval artifact: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    atomic_bytes(path, json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8"))


def relative_inside(root: Path, path: Path, label: str, *, must_exist: bool = True) -> str:
    root = root.resolve()
    resolved = path.resolve(strict=must_exist)
    try:
        return resolved.relative_to(root).as_posix()
    except ValueError as exc:
        raise ValueError(f"{label} must remain inside --package-root") from exc


def _public_addresses(hostname: str, port: int) -> list[str]:
    try:
        results = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError(f"DNS resolution failed for {hostname}") from exc
    addresses = sorted({str(item[4][0]) for item in results})
    if not addresses:
        raise ValueError(f"DNS returned no addresses for {hostname}")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise ValueError(f"SSRF guard rejected non-global address for {hostname}")
    return addresses


def validate_public_url(url: str) -> list[str]:
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("only absolute HTTP(S) URLs are retrievable")
    if parsed.username or parsed.password:
        raise ValueError("URL userinfo is forbidden")
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise ValueError("URL port is invalid") from exc
    if port not in ALLOWED_PORTS:
        raise ValueError("only ports 80 and 443 are allowed")
    try:
        literal = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        return _public_addresses(parsed.hostname, port)
    else:
        if not literal.is_global:
            raise ValueError("SSRF guard rejected a non-global IP literal")
        return [str(literal)]


def _response_peer_address(response: Any) -> str:
    candidates = [
        getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None),
        getattr(getattr(response, "fp", None), "_sock", None),
        getattr(response, "_sock", None),
    ]
    for candidate in candidates:
        if candidate is None or not hasattr(candidate, "getpeername"):
            continue
        peer = candidate.getpeername()
        if isinstance(peer, tuple) and peer:
            return str(peer[0]).split("%", 1)[0]
    raise ValueError("SSRF guard could not verify the connected peer address")


def _validate_peer_address(peer: str, approved_addresses: list[str]) -> None:
    try:
        address = ipaddress.ip_address(peer)
        approved = {ipaddress.ip_address(value) for value in approved_addresses}
    except ValueError as exc:
        raise ValueError("SSRF guard received an invalid peer address") from exc
    if not address.is_global:
        raise ValueError("SSRF guard rejected a non-global connected peer")
    if address not in approved:
        raise ValueError("SSRF guard rejected DNS rebinding or an unapproved connected peer")


def retrieve_url(url: str, timeout: float, max_bytes: int) -> dict[str, Any]:
    # Do not inherit environment proxies: their private peer would obscure the
    # destination socket and make DNS/peer binding unverifiable.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    redirects: list[str] = []
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        approved_addresses = validate_public_url(current)
        request = Request(
            current,
            headers={
                "User-Agent": "FrontMind-E2-Research/2.1 (+content-workflow)",
                "Accept": "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.8",
                "Accept-Encoding": "identity",
            },
            method="GET",
        )
        try:
            response = opener.open(request, timeout=timeout)
        except HTTPError as exc:
            if exc.code in {301, 302, 303, 307, 308}:
                location = exc.headers.get("Location")
                if not location:
                    raise ValueError(f"HTTP {exc.code} redirect has no Location") from exc
                if len(redirects) >= MAX_REDIRECTS:
                    raise ValueError("redirect limit exceeded") from exc
                current = urljoin(current, location)
                redirects.append(current)
                continue
            raise ValueError(f"HTTP request failed with status {exc.code}") from exc
        except URLError as exc:
            raise ValueError(f"HTTP request failed: {exc.reason}") from exc
        with response:
            connected_peer_ip = _response_peer_address(response)
            _validate_peer_address(connected_peer_ip, approved_addresses)
            status = int(getattr(response, "status", response.getcode()))
            mime = str(response.headers.get_content_type() or "").lower()
            if mime not in ALLOWED_MIME:
                raise ValueError(f"unsupported MIME type: {mime or 'missing'}")
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > max_bytes:
                raise ValueError(f"response exceeds max bytes: {content_length}")
            body = response.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise ValueError(f"response exceeds max bytes: {max_bytes}")
            if not body:
                raise ValueError("response body is empty")
            return {
                "final_url": current,
                "redirect_chain": redirects,
                "http_status": status,
                "mime_type": mime,
                "body": body,
                "charset": response.headers.get_content_charset(),
                "approved_addresses": approved_addresses,
                "connected_peer_ip": connected_peer_ip,
            }
    raise ValueError("redirect limit exceeded")


def extract_html(body: bytes, charset: str | None) -> tuple[str, str | None, dict[str, list[str]]]:
    encoding = charset or "utf-8"
    try:
        source = body.decode(encoding, errors="replace")
    except LookupError:
        source = body.decode("utf-8", errors="replace")
    parser = VisibleHTML()
    parser.feed(source)
    visible = clean_text("\n".join(parser.text_parts))[:MAX_EXTRACT_CHARS]
    title = clean_text(" ".join(parser.title_parts))[:1000] or None
    if not visible:
        raise ValueError("HTML extraction produced no visible text")
    return visible, title, parser.headings


def extract_pdf(body: bytes) -> tuple[str, str | None, dict[str, list[str]]]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise ValueError("PDF snapshot captured but pypdf is unavailable for safe text extraction") from exc
    reader = PdfReader(io.BytesIO(body), strict=True)
    if len(reader.pages) > 200:
        raise ValueError("PDF exceeds the 200-page extraction safety limit")
    parts: list[str] = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
        if sum(len(value) for value in parts) > MAX_EXTRACT_CHARS:
            break
    visible = clean_text("\n".join(parts))[:MAX_EXTRACT_CHARS]
    if not visible:
        raise ValueError("PDF contains no extractable text")
    metadata = reader.metadata or {}
    title = clean_text(getattr(metadata, "title", None) or metadata.get("/Title"))[:1000] or None
    return visible, title, {"h1": [], "h2": [], "h3": []}


def _domain_form(url: str) -> str | None:
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    for domain, form in NON_ARTICLE_DOMAIN_FORMS.items():
        if host == domain or host.endswith(f".{domain}"):
            return form
    if re.search(r"/(search|s)($|/|\?)", path):
        return "search_result"
    if path in {"", "/", "/index.html", "/index.htm"}:
        return "homepage"
    return None


def detect_form(url: str, mime: str, title: str, headings: dict[str, list[str]], body: str) -> tuple[str, bool]:
    domain_form = _domain_form(url)
    if domain_form:
        return domain_form, False
    combined = clean_text(" ".join([title, *headings.get("h1", []), *headings.get("h2", [])[:10], body[:5000]])).casefold()
    if mime == "application/pdf":
        return "research_pdf", True
    rules = (
        ("case_study", ("案例", "客户实践", "case study", "项目复盘")),
        ("comparison_review", ("对比", "评测", "vs", "哪个好", "排行榜", "推荐榜")),
        ("tutorial_documentation", ("教程", "操作步骤", "如何配置", "documentation", "api reference", "使用指南")),
        ("news_article", ("新闻", "发布会", "签约", "获批", "上线", "公告", "记者")),
        ("brand_feature", ("品牌故事", "企业深度", "发展历程", "创始人", "团队与能力")),
    )
    for form, signals in rules:
        if any(signal in combined for signal in signals):
            return form, True
    if urlsplit(url).path.lower().startswith(("/docs", "/documentation", "/developer", "/api")):
        return "tutorial_documentation", True
    return "editorial_article", True


def _question_similarity(question: str, page_text: str) -> float:
    query = set(re.findall(r"[\w\u4e00-\u9fff]{2,}", clean_text(question).casefold()))
    page = set(re.findall(r"[\w\u4e00-\u9fff]{2,}", clean_text(page_text[:20000]).casefold()))
    if not query:
        return 0
    return round(len(query & page) / len(query), 6)


def _all_signed_cues(registry: dict[str, Any]) -> set[str]:
    cues: set[str] = set()
    for pattern in registry.get("patterns", []):
        if not isinstance(pattern, dict):
            continue
        contract = pattern.get("classification_contract") if isinstance(pattern.get("classification_contract"), dict) else {}
        for group in ("positive_intent_signals", "typical_structure_signals", "exclusion_signals"):
            for signal in contract.get(group, []):
                if not isinstance(signal, dict):
                    continue
                cues.update(clean_text(cue).casefold() for cue in signal.get("cues", []) if clean_text(cue))
    return cues


def _priority_witness_cues(
    classification: dict[str, Any] | None, registry: dict[str, Any], body: str,
) -> list[str]:
    if not isinstance(classification, dict):
        return []
    lowered = clean_text(body).casefold()
    result: list[str] = []

    pattern_by_id = {
        str(item.get("id")): item
        for item in registry.get("patterns", []) if isinstance(item, dict) and item.get("id")
    }

    def add_witnesses(pattern_id: str, selected_ids: dict[str, set[str]] | None) -> None:
        pattern = pattern_by_id.get(pattern_id, {})
        contract = pattern.get("classification_contract") if isinstance(pattern.get("classification_contract"), dict) else {}
        for classification_key, group, identifier_key in (
            ("matched_intent_signal_ids", "positive_intent_signals", "signal_id"),
            ("matched_structure_component_ids", "typical_structure_signals", "component_id"),
            ("negative_signal_ids", "exclusion_signals", "signal_id"),
        ):
            allowed_ids = selected_ids.get(classification_key, set()) if selected_ids is not None else None
            for signal in contract.get(group, []):
                if not isinstance(signal, dict) or not signal.get(identifier_key):
                    continue
                if allowed_ids is not None and str(signal.get(identifier_key)) not in allowed_ids:
                    continue
                witness = next(
                    (
                        clean_text(cue).casefold() for cue in signal.get("cues", [])
                        if clean_text(cue) and clean_text(cue).casefold() in lowered
                    ),
                    None,
                )
                if witness and witness not in result:
                    result.append(witness)

    primary = str(classification.get("primary_pattern_id") or "")
    add_witnesses(primary, {
        key: {str(value) for value in classification.get(key, [])}
        for key in (
            "matched_intent_signal_ids", "matched_structure_component_ids", "negative_signal_ids",
        )
    })
    # Human review may correct only from evidence already present in the
    # immutable extract. Preserve one cue per actually observed signed signal
    # for the machine-declared confusable alternatives before filling extras.
    for alternative in classification.get("alternative_pattern_ids", []):
        add_witnesses(str(alternative), None)
    return result


def observed_cue_contexts(
    body: str, allowed_cues: set[str], priority_cues: list[str] | None = None,
) -> dict[str, str]:
    lowered = clean_text(body).casefold()
    contexts: dict[str, str] = {}
    priority = list(dict.fromkeys(clean_text(cue).casefold() for cue in (priority_cues or []) if clean_text(cue)))
    if len(priority) > MAX_OBSERVED_CUES:
        raise ValueError("classification requires more cue witnesses than the 50-cue copyright cap")
    candidates = priority + sorted(set(allowed_cues) - set(priority))
    occupied: list[tuple[int, int]] = []
    total_chars = 0
    for cue in candidates:
        if len(contexts) >= MAX_OBSERVED_CUES:
            break
        required = cue in priority
        if not cue or len(cue) > MAX_CUE_CONTEXT_CHARS:
            if required:
                raise ValueError("a required signed cue exceeds the short-context copyright cap")
            continue
        index = lowered.find(cue)
        if index < 0:
            continue
        flank = max(0, (MAX_CUE_CONTEXT_CHARS - len(cue)) // 2)
        start, end = max(0, index - flank), min(len(lowered), index + len(cue) + flank)
        overlaps = any(start < prior_end and prior_start < end for prior_start, prior_end in occupied)
        if overlaps and not required:
            continue
        context = lowered[start:end][:MAX_CUE_CONTEXT_CHARS]
        if overlaps:
            # A required ID must retain a witness key, but repeated surrounding
            # prose is not copied twice.
            context = cue
        if context in contexts.values() and not required:
            continue
        if total_chars + len(context) > MAX_CUE_CONTEXT_TOTAL_CHARS:
            if not required:
                break
            context = cue
            if total_chars + len(context) > MAX_CUE_CONTEXT_TOTAL_CHARS:
                raise ValueError("required cue witnesses exceed the 2000-character copyright cap")
        contexts[cue] = context
        total_chars += len(context)
        if not overlaps:
            occupied.append((start, end))
    return contexts


def classify_article(
    form: str, title: str, headings: dict[str, list[str]], body: str, question: str,
    registry: dict[str, Any], research: dict[str, Any], snapshot_sha256: str,
) -> dict[str, Any] | None:
    combined = clean_text(" ".join([
        title, *headings.get("h1", []), *headings.get("h2", [])[:20], body[:30000],
    ])).casefold()
    scored: list[tuple[int, str, list[str], list[str], list[str]]] = []
    for pattern in registry.get("patterns", []):
        if not isinstance(pattern, dict):
            continue
        pattern_id = str(pattern.get("id") or "")
        contract = pattern.get("classification_contract") if isinstance(pattern.get("classification_contract"), dict) else {}
        if form not in set(contract.get("eligible_content_forms", [])):
            continue
        intent_ids = [
            str(signal.get("signal_id"))
            for signal in contract.get("positive_intent_signals", [])
            if isinstance(signal, dict) and signal.get("signal_id") and any(
                clean_text(cue).casefold() in combined for cue in signal.get("cues", []) if clean_text(cue)
            )
        ]
        component_ids = [
            str(signal.get("component_id"))
            for signal in contract.get("typical_structure_signals", [])
            if isinstance(signal, dict) and signal.get("component_id") and any(
                clean_text(cue).casefold() in combined for cue in signal.get("cues", []) if clean_text(cue)
            )
        ]
        negative_ids = [
            str(signal.get("signal_id"))
            for signal in contract.get("exclusion_signals", [])
            if isinstance(signal, dict) and signal.get("signal_id") and any(
                clean_text(cue).casefold() in combined for cue in signal.get("cues", []) if clean_text(cue)
            )
        ]
        score = 3 * len(intent_ids) + 2 * len(component_ids) + 1 - 3 * len(negative_ids)
        scored.append((score, pattern_id, intent_ids, component_ids, negative_ids))
    scored.sort(key=lambda item: (-item[0], item[1]))
    viable = [item for item in scored if item[2] and item[3] and item[0] > 0]
    if not viable:
        return None
    best_score, primary, intent_ids, component_ids, negative_ids = viable[0]
    primary_pattern = next(
        (item for item in registry.get("patterns", [])
         if isinstance(item, dict) and item.get("id") == primary),
        {},
    )
    primary_contract = primary_pattern.get("classification_contract") if isinstance(primary_pattern.get("classification_contract"), dict) else {}
    confusable = {
        str(item.get("pattern_id"))
        for item in primary_contract.get("confusable_patterns", [])
        if isinstance(item, dict) and item.get("pattern_id")
    }
    alternatives = [
        pattern_id for score, pattern_id, *_ in scored
        if score > 0 and pattern_id in confusable
    ][:3]
    confidence = min(0.95, max(0.35, 0.5 + 0.04 * max(best_score, 0)))
    return {
        "primary_pattern_id": primary,
        "alternative_pattern_ids": alternatives,
        "classification_confidence": round(confidence, 6),
        "matched_intent_signal_ids": intent_ids,
        "matched_structure_component_ids": component_ids,
        "negative_signal_ids": negative_ids,
        "content_form": form,
        "question_similarity": _question_similarity(question, combined),
        "classification_rationale": (
            f"页面被识别为 {form}；结构与意图信号最接近 {primary}。"
            "该结果来自可复核标题、标题层级和正文抽取，仅作为 E2 建议，需由 E4 决定或人工校正。"
        ),
        "snapshot_sha256": snapshot_sha256,
        "registry_sha256": "filled_by_pattern_analysis_builder",
        "classifier_version": CLASSIFIER_VERSION,
        "review_status": "machine_classified",
    }


def _snapshot_payload(
    original_url: str, fetched: dict[str, Any], accessed_at: str, body: bytes,
) -> dict[str, Any]:
    """Create an immutable response receipt without persisting third-party content."""
    return {
        "schema_version": "2.1.0",
        "artifact_type": "E2_http_response_receipt",
        "original_url": original_url,
        "final_url": fetched["final_url"],
        "redirect_chain": list(fetched["redirect_chain"]),
        "http_status": int(fetched["http_status"]),
        "mime_type": str(fetched["mime_type"]),
        "accessed_at": accessed_at,
        "response_bytes": len(body),
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "approved_addresses": list(fetched.get("approved_addresses") or []),
        "connected_peer_ip": fetched.get("connected_peer_ip"),
    }


def _extract_payload(
    *, title: str, headings: dict[str, list[str]], visible: str,
    snapshot_sha256: str, body_sha256: str, registry: dict[str, Any],
    classification: dict[str, Any] | None,
) -> dict[str, Any]:
    """Persist only structural facts and short, signed-cue contexts.

    Full HTML, PDF bytes and full visible text stay in memory and are never
    written to the package.  This keeps the benchmark analysis reproducible
    without making the workflow a copy of the cited article.
    """
    return {
        "schema_version": "2.1.0",
        "artifact_type": "E2_page_structure_extract",
        "page_title": title[:1000],
        "heading_summary": headings,
        "short_excerpt": visible[:MAX_SHORT_EXCERPT_CHARS],
        "visible_text_length": len(visible),
        "body_sha256": body_sha256,
        "snapshot_sha256": snapshot_sha256,
        # Preserve witnesses for the selected P and declared confusable
        # alternatives first, then add non-overlapping signed cues only within
        # the strict copyright caps.
        "observed_cues": observed_cue_contexts(
            visible, _all_signed_cues(registry),
            _priority_witness_cues(classification, registry, visible),
        ),
    }


def _empty_receipt(original_url: str, reason: str, status: str = "not_attempted") -> dict[str, Any]:
    return {
        "original_url": original_url, "final_url": None, "redirect_chain": [], "http_status": None,
        "mime_type": None, "accessed_at": None, "page_title": None, "extraction_status": status,
        "snapshot_relative_path": None, "snapshot_sha256": None,
        "extract_relative_path": None, "extract_sha256": None,
        "heading_summary": {"h1": [], "h2": [], "h3": []}, "failure_reason": reason,
    }


def build_page_analysis(
    source_pool: dict[str, Any], registry: dict[str, Any], research: dict[str, Any],
    package_root: Path, artifact_dir: Path, fetcher: Callable[[str, float, int], dict[str, Any]],
    timeout: float, max_bytes: int,
) -> dict[str, Any]:
    observations: list[dict[str, Any]] = []
    canonical_first: dict[str, int] = {}
    for item in source_pool["cited_content_pool"]:
        rank = int(item["raw_rank"])
        original_url = str(item["original_url"])
        canonical_url = str(item["canonical_url"])
        first_rank = canonical_first.setdefault(canonical_url, rank)
        if first_rank != rank:
            observations.append({
                "raw_rank": rank, "status": "duplicate_alias", "review_status": "machine_classified", "content_form": None,
                "retrieval_receipt": _empty_receipt(original_url, f"canonical alias of raw rank {first_rank}"),
                "classification": None,
            })
            continue
        try:
            validate_public_url(original_url)
        except ValueError as exc:
            observations.append({
                "raw_rank": rank, "status": "unsafe_url", "review_status": "machine_classified", "content_form": None,
                "retrieval_receipt": _empty_receipt(original_url, str(exc)), "classification": None,
            })
            continue
        accessed_at = datetime.now(timezone.utc).isoformat()
        try:
            fetched = fetcher(original_url, timeout, max_bytes)
        except Exception as exc:
            observations.append({
                "raw_rank": rank, "status": "unavailable", "review_status": "machine_classified", "content_form": None,
                "retrieval_receipt": _empty_receipt(original_url, str(exc), "failed"), "classification": None,
            })
            continue
        mime = str(fetched["mime_type"])
        body = bytes(fetched["body"])
        rank_dir = artifact_dir / f"rank_{rank:02d}"
        snapshot_payload = _snapshot_payload(original_url, fetched, accessed_at, body)
        snapshot = rank_dir / "snapshot.json"
        atomic_json(snapshot, snapshot_payload)
        snapshot_relative = relative_inside(package_root, snapshot, "retrieval snapshot")
        snapshot_digest = file_sha256(snapshot)
        try:
            if mime == "application/pdf":
                visible, title, headings = extract_pdf(body)
            else:
                visible, title, headings = extract_html(body, fetched.get("charset"))
        except ValueError as exc:
            observations.append({
                "raw_rank": rank, "status": "unavailable", "review_status": "machine_classified", "content_form": None,
                "retrieval_receipt": {
                    "original_url": original_url, "final_url": fetched["final_url"],
                    "redirect_chain": fetched["redirect_chain"], "http_status": fetched["http_status"],
                    "mime_type": mime, "accessed_at": accessed_at, "page_title": None,
                    "extraction_status": "failed", "snapshot_relative_path": snapshot_relative,
                    "snapshot_sha256": snapshot_digest, "extract_relative_path": None, "extract_sha256": None,
                    "heading_summary": {"h1": [], "h2": [], "h3": []}, "failure_reason": str(exc),
                },
                "classification": None,
            })
            continue
        form, is_article = detect_form(fetched["final_url"], mime, title or str(item["content_title"]), headings, visible)
        page_title = (title or str(item["content_title"]))[:1000]
        classification = (
            classify_article(
                form, page_title, headings, visible, source_pool["question"],
                registry, research, snapshot_digest,
            )
            if is_article else None
        )
        extract_path = rank_dir / "extract.json"
        try:
            extract_payload = _extract_payload(
                title=page_title,
                headings=headings,
                visible=visible,
                snapshot_sha256=snapshot_digest,
                body_sha256=snapshot_payload["body_sha256"],
                registry=registry,
                classification=classification,
            )
            validate_schema(
                extract_payload,
                Path(__file__).resolve().parents[1] / "templates" / "page_structure_extract.schema.json",
                f"E2 rank {rank} page structure extract",
            )
            if sum(len(value) for value in extract_payload["observed_cues"].values()) > MAX_CUE_CONTEXT_TOTAL_CHARS:
                raise ValueError(f"E2 rank {rank} cue contexts exceed the 2000-character copyright cap")
        except ValueError as exc:
            observations.append({
                "raw_rank": rank, "status": "unavailable", "review_status": "machine_classified",
                "content_form": None,
                "retrieval_receipt": {
                    "original_url": original_url, "final_url": fetched["final_url"],
                    "redirect_chain": fetched["redirect_chain"], "http_status": fetched["http_status"],
                    "mime_type": mime, "accessed_at": accessed_at, "page_title": page_title,
                    "extraction_status": "failed", "snapshot_relative_path": snapshot_relative,
                    "snapshot_sha256": snapshot_digest, "extract_relative_path": None,
                    "extract_sha256": None, "heading_summary": headings,
                    "failure_reason": f"copyright-safe structural extract failed: {exc}"[:1000],
                },
                "classification": None,
            })
            continue
        atomic_json(extract_path, extract_payload)
        extract_relative = relative_inside(package_root, extract_path, "retrieval extract")
        receipt = {
            "original_url": original_url, "final_url": fetched["final_url"],
            "redirect_chain": fetched["redirect_chain"], "http_status": fetched["http_status"],
            "mime_type": mime, "accessed_at": accessed_at,
            "page_title": page_title,
            "extraction_status": "extracted" if (not is_article or classification) else "failed",
            "snapshot_relative_path": snapshot_relative,
            "snapshot_sha256": snapshot_digest, "extract_relative_path": extract_relative,
            "extract_sha256": file_sha256(extract_path), "heading_summary": headings,
            "failure_reason": (
                None if (not is_article or classification) else
                "page extraction succeeded but no signed intent-and-structure cue pair supported an article pattern"
            ),
        }
        final_status = "non_article" if not is_article else ("classified_article" if classification else "unavailable")
        observations.append({
            "raw_rank": rank, "status": final_status, "review_status": "machine_classified",
            "content_form": form if final_status != "unavailable" else None,
            "retrieval_receipt": receipt, "classification": classification,
        })
    return {
        "schema_version": "2.1.0",
        "job_id": source_pool["job_id"],
        "question": source_pool["question"],
        "classifier_version": CLASSIFIER_VERSION,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "source_pool_sha256": "filled_by_cli",
        "pattern_registry_sha256": "filled_by_cli",
        "pattern_research_index_sha256": "filled_by_cli",
        "content_observations": observations,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-pool", type=Path, required=True)
    parser.add_argument("--pattern-registry", type=Path, required=True)
    parser.add_argument("--pattern-research-index", type=Path, required=True)
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--max-bytes", type=int, default=10 * 1024 * 1024)
    args = parser.parse_args()
    package_root = args.package_root.resolve()
    for path, label in (
        (args.source_pool, "--source-pool"), (args.pattern_registry, "--pattern-registry"),
        (args.pattern_research_index, "--pattern-research-index"),
    ):
        if not path.is_file():
            raise FileNotFoundError(path)
        relative_inside(package_root, path, label)
    artifact_relative = relative_inside(package_root, args.artifact_dir, "--artifact-dir", must_exist=False)
    output_relative = relative_inside(package_root, args.output, "--output", must_exist=False)
    artifact_dir = package_root / artifact_relative
    if artifact_dir.exists() or artifact_dir.is_symlink():
        raise FileExistsError("--artifact-dir must be a new path; refusing mixed or stale retrieval state")
    if args.output.exists() or args.output.is_symlink():
        raise FileExistsError("--output already exists")
    if not 1 <= args.timeout <= 60 or not 64 * 1024 <= args.max_bytes <= 25 * 1024 * 1024:
        raise ValueError("timeout must be 1-60 seconds and max-bytes 64 KiB-25 MiB")
    source_pool, registry, research = (
        load_object(args.source_pool), load_object(args.pattern_registry), load_object(args.pattern_research_index)
    )
    result = build_page_analysis(
        source_pool, registry, research, package_root, artifact_dir,
        retrieve_url, args.timeout, args.max_bytes,
    )
    result["source_pool_sha256"] = file_sha256(args.source_pool)
    result["pattern_registry_sha256"] = file_sha256(args.pattern_registry)
    result["pattern_research_index_sha256"] = file_sha256(args.pattern_research_index)
    atomic_json(package_root / output_relative, result)
    statuses: dict[str, int] = {}
    for item in result["content_observations"]:
        statuses[item["status"]] = statuses.get(item["status"], 0) + 1
    print(json.dumps({
        "status": "passed", "job_id": result["job_id"], "raw_pool_size": len(result["content_observations"]),
        "final_status_counts": dict(sorted(statuses.items())), "output": output_relative,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
