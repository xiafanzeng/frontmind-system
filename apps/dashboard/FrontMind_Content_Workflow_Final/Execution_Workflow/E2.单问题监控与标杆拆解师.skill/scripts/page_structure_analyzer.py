#!/usr/bin/env python3
"""Safely inspect E2 Top20 pages without snapshot or hash ledgers."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import socket
import tempfile
import unicodedata
from datetime import datetime, timezone
from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


ARTICLE_FORMS = {
    "editorial_article", "brand_feature", "news_article", "comparison_review",
    "tutorial_documentation", "case_study", "research_pdf", "official_longform",
}
NON_ARTICLE_FORMS = {
    "homepage", "company_registry", "database_listing", "encyclopedia",
    "search_result", "patent_record", "short_video", "social_post",
    "download_shell", "unknown",
}
PATTERN_ID_RE = re.compile(r"P(?:0[1-9]|1[0-6])")
BENCHMARK_REVIEW_LIST_FIELDS = (
    "structure_observation", "subquestions_observed", "evidence_positions_observed",
    "visual_observation", "strengths", "weaknesses", "do_not_copy",
)
BENCHMARK_REVIEW_TEXT_FIELDS = (
    "faq_observation", "selection_rationale", "research_note",
)
TRACKING_QUERY_KEYS = {
    "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source", "spm",
}
TECHNICAL_IMPLEMENTATION_RE = re.compile(
    r"(?:\bapi\b|\bsdk\b|系统架构|部署架构|接口文档|接口调用|容器部署|"
    r"依赖安装|配置文件|认证令牌|数据流|故障排查|回滚|吞吐量|延迟|负载均衡)",
    re.I,
)
OPEN_RECOMMENDATION_RE = re.compile(
    r"(?:有哪些|哪些|哪几家|多家|候选名单|推荐榜|排行榜).{0,12}(?:推荐|值得|机构|品牌|医院)|"
    r"(?:推荐|值得).{0,8}(?:哪些|哪几家|多家)",
)
NAMED_COMPARISON_RE = re.compile(r"(?:\bvs\.?\b|versus|对比|比较|区别|哪个更适合)", re.I)


def normal(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip().casefold()


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


def canonical_lookup_url(value: str) -> str | None:
    """Return a stable research-lookup URL without weakening fetch safety.

    This canonical form is used only after a page has been fetched and its
    body extracted.  It therefore cannot turn an unavailable title into a
    classified article.
    """
    try:
        parsed = urlsplit(value)
        scheme = parsed.scheme.casefold()
        hostname = (parsed.hostname or "").casefold().rstrip(".")
        if scheme not in {"http", "https"} or not hostname:
            return None
        if hostname.startswith("www."):
            hostname = hostname[4:]
        port = parsed.port
    except ValueError:
        return None
    netloc = hostname
    if port and port != (443 if scheme == "https" else 80):
        netloc = f"{hostname}:{port}"
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    if path != "/":
        path = path.rstrip("/")
    query = []
    for name, value in parse_qsl(parsed.query, keep_blank_values=True):
        folded = name.casefold()
        if folded.startswith("utm_") or folded.startswith("hubs_") or folded in TRACKING_QUERY_KEYS:
            continue
        query.append((name, value))
    # HTTP benchmark URLs commonly redirect to HTTPS.  Research identity is
    # host/path/query, while the network fetch still validates the real URL.
    return urlunsplit(("https", netloc, path, urlencode(sorted(query)), ""))


def benchmark_url_index(research: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for pattern in research.get("patterns", []):
        if not isinstance(pattern, dict):
            continue
        pattern_id = str(pattern.get("pattern_id") or "")
        if not PATTERN_ID_RE.fullmatch(pattern_id):
            continue
        for benchmark in pattern.get("benchmarks", []):
            if not isinstance(benchmark, dict):
                continue
            lookup = canonical_lookup_url(str(benchmark.get("url") or ""))
            observations = [
                str(item).strip() for item in benchmark.get("structure_observation", [])
                if str(item).strip()
            ]
            if not lookup or not observations:
                continue
            review = {
                "pattern_id": pattern_id,
                "benchmark_id": str(benchmark.get("benchmark_id") or "benchmark"),
                "title": str(benchmark.get("title") or "").strip(),
            }
            for field in BENCHMARK_REVIEW_LIST_FIELDS:
                review[field] = [
                    str(item).strip() for item in benchmark.get(field, [])
                    if str(item).strip()
                ]
            for field in BENCHMARK_REVIEW_TEXT_FIELDS:
                review[field] = str(benchmark.get(field) or "").strip()
            if any(not review[field] for field in (*BENCHMARK_REVIEW_LIST_FIELDS, *BENCHMARK_REVIEW_TEXT_FIELDS)):
                continue
            result.setdefault(lookup, []).append(review)
    return result


def unique_benchmark_match(
    index: dict[str, list[dict[str, Any]]], final_url: str,
) -> dict[str, Any] | None:
    lookup = canonical_lookup_url(final_url)
    matches = index.get(lookup or "", [])
    return matches[0] if len(matches) == 1 else None


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


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.current_heading: str | None = None
        self.title_mode = False
        self.text: list[str] = []
        self.title: list[str] = []
        self.headings: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        if tag in {"script", "style", "noscript", "svg", "canvas"}:
            self.hidden += 1
        if tag == "title":
            self.title_mode = True
        if tag in {"h1", "h2", "h3"}:
            self.current_heading = tag

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag in {"script", "style", "noscript", "svg", "canvas"} and self.hidden:
            self.hidden -= 1
        if tag == "title":
            self.title_mode = False
        if tag == self.current_heading:
            self.current_heading = None

    def handle_data(self, data: str) -> None:
        if self.hidden:
            return
        item = re.sub(r"\s+", " ", data).strip()
        if not item:
            return
        self.text.append(item)
        if self.title_mode:
            self.title.append(item)
        if self.current_heading:
            self.headings.append(item)


def public_addresses(hostname: str, port: int) -> list[str]:
    addresses: list[str] = []
    for _family, _socktype, _proto, _canonname, sockaddr in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM):
        raw = str(sockaddr[0])
        ip = ipaddress.ip_address(raw)
        if not ip.is_global:
            raise ValueError(f"unsafe URL resolves to non-public address: {raw}")
        addresses.append(raw)
    if not addresses:
        raise ValueError("URL hostname did not resolve")
    return sorted(set(addresses))


def validate_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("only absolute HTTP(S) URLs are allowed")
    port = parsed.port or (443 if parsed.scheme.casefold() == "https" else 80)
    if port not in {80, 443}:
        raise ValueError("only ports 80 and 443 are allowed")
    public_addresses(parsed.hostname, port)


def fetch(url: str, timeout: float, max_bytes: int) -> tuple[str, str, bytes]:
    opener = build_opener(NoRedirect())
    current = url
    for _redirect in range(6):
        validate_url(current)
        request = Request(current, headers={"User-Agent": "FrontMind-Structure-Research/2.3", "Accept": "text/html,application/pdf;q=0.9"})
        try:
            response = opener.open(request, timeout=timeout)
        except HTTPError as exc:
            if exc.code in {301, 302, 303, 307, 308}:
                location = exc.headers.get("Location")
                if not location:
                    raise ValueError("redirect response has no Location") from exc
                current = urljoin(current, location)
                continue
            raise ValueError(f"HTTP {exc.code}") from exc
        except (URLError, OSError, TimeoutError) as exc:
            raise ValueError(f"page unavailable: {exc}") from exc
        content_type = (response.headers.get_content_type() or "").casefold()
        length = response.headers.get("Content-Length")
        if length and int(length) > max_bytes:
            raise ValueError("response exceeds size limit")
        body = response.read(max_bytes + 1)
        if len(body) > max_bytes:
            raise ValueError("response exceeds size limit")
        return current, content_type, body
    raise ValueError("too many redirects")


def extract_html(body: bytes) -> tuple[str, str, list[str]]:
    decoded = body.decode("utf-8", errors="replace")
    parser = PageParser()
    parser.feed(decoded)
    text = " ".join(parser.text)
    if len(text) < 80:
        raise ValueError("page contains too little visible text")
    return " ".join(parser.title)[:500], text[:200_000], list(dict.fromkeys(parser.headings))[:40]


def extract_pdf(body: bytes) -> tuple[str, str, list[str]]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover
        raise ValueError("pypdf is unavailable") from exc
    reader = PdfReader(BytesIO(body))
    if len(reader.pages) > 200:
        raise ValueError("PDF exceeds 200 pages")
    chunks = [(page.extract_text() or "") for page in reader.pages]
    text = re.sub(r"\s+", " ", " ".join(chunks)).strip()
    if len(text) < 80:
        raise ValueError("PDF contains too little extractable text")
    headings = [item.strip() for item in re.findall(r"(?:^|\n)([^\n]{3,100})(?=\n)", "\n".join(chunks))[:40]]
    return "", text[:200_000], list(dict.fromkeys(headings))


def detect_form(url: str, mime: str, title: str, headings: list[str], text: str) -> str:
    parsed = urlsplit(url)
    host = (parsed.hostname or "").casefold()
    path = parsed.path.casefold()
    sample = normal(" ".join([title, *headings[:20], text[:20_000]]))
    if "pdf" in mime or path.endswith(".pdf"):
        return "research_pdf"
    if any(token in host for token in ("wikipedia", "baike.baidu", "zh.wikipedia")):
        return "encyclopedia"
    if any(token in host for token in ("youtube", "bilibili", "douyin", "vimeo")):
        return "short_video"
    if any(token in host for token in ("weibo", "x.com", "twitter", "linkedin")) and len(text) < 2500:
        return "social_post"
    if "patent" in host or "/patent" in path or "专利" in sample[:500]:
        return "patent_record"
    if path in {"", "/", "/index.html", "/index.htm"} and len(headings) < 3:
        return "homepage"
    if any(token in sample for token in ("案例研究", "客户案例", "case study", "成功案例")):
        return "case_study"
    if any(token in sample for token in ("对比", "比较", "versus", " vs ", "排行榜", "推荐榜")):
        return "comparison_review"
    if any(token in sample for token in ("操作步骤", "使用方法", "教程", "how to", "documentation", "安装指南")):
        return "tutorial_documentation"
    if any(token in sample for token in ("新闻稿", "发布会", "宣布", "获悉", "news release")):
        return "news_article"
    if any(token in sample for token in ("品牌故事", "公司简介", "企业专访", "品牌特写")):
        return "brand_feature"
    if len(text) >= 1500 and len(headings) >= 2:
        return "official_longform" if any(token in path for token in ("/blog", "/news", "/article", "/insight")) else "editorial_article"
    return "unknown"


def pattern_map(registry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(item.get("id")): item
        for item in registry.get("patterns", []) if isinstance(item, dict) and re.fullmatch(r"P(?:0[1-9]|1[0-6])", str(item.get("id") or ""))
    }


def cue_hits(cues: list[Any], sample: str) -> list[str]:
    return [str(cue) for cue in cues if normal(cue) and normal(cue) in sample]


def ngram_similarity(left: str, right: str) -> float:
    def grams(value: str) -> set[str]:
        compact = re.sub(r"[^0-9a-z\u3400-\u9fff]+", "", normal(value))
        return {compact[index:index + 2] for index in range(max(0, len(compact) - 1))}
    first, second = grams(left), grams(right)
    if not first or not second:
        return 0.0
    return round(len(first & second) / len(first | second), 4)


def classify(
    registry: dict[str, Any], question: str, content_form: str,
    title: str, headings: list[str], text: str,
) -> dict[str, Any]:
    heading_sample = normal(" ".join([title, *headings]))
    body_sample = normal(text[:80_000])
    sample = normal(" ".join([heading_sample, body_sample]))
    question_sample = normal(question)
    intent_sample = normal(" ".join([question_sample, heading_sample]))
    open_recommendation = bool(OPEN_RECOMMENDATION_RE.search(intent_sample))
    named_comparison = bool(NAMED_COMPARISON_RE.search(intent_sample))
    technical_implementation = bool(TECHNICAL_IMPLEMENTATION_RE.search(sample))
    scores: list[dict[str, Any]] = []
    for pattern_id, pattern in pattern_map(registry).items():
        contract = pattern.get("classification_contract") if isinstance(pattern.get("classification_contract"), dict) else {}
        eligible = set(contract.get("eligible_content_forms") or [])
        if eligible and content_form not in eligible:
            continue
        intent_ids: list[str] = []
        component_ids: list[str] = []
        negative_ids: list[str] = []
        score = 0.0
        for signal in contract.get("positive_intent_signals") or []:
            if not isinstance(signal, dict):
                continue
            heading_hits = cue_hits(signal.get("cues") or [], intent_sample)
            body_hits = cue_hits(signal.get("cues") or [], body_sample)
            hits = list(dict.fromkeys([*heading_hits, *body_hits]))
            if hits:
                # Intent in the formal question/title is more diagnostic than
                # a generic word buried in body copy.
                score += (2.5 if heading_hits else 1.1) + min(len(hits), 3) * 0.25
                intent_ids.append(str(signal.get("signal_id") or hits[0]))
        for signal in contract.get("typical_structure_signals") or []:
            if not isinstance(signal, dict):
                continue
            heading_hits = cue_hits(signal.get("cues") or [], heading_sample)
            body_hits = cue_hits(signal.get("cues") or [], body_sample)
            hits = list(dict.fromkeys([*heading_hits, *body_hits]))
            if hits:
                score += (1.8 if heading_hits else 0.7) + min(len(hits), 3) * 0.2
                component_ids.append(str(signal.get("component_id") or hits[0]))
        trigger_hits = cue_hits(pattern.get("trigger_signals") or [], question_sample)
        score += min(len(trigger_hits), 2) * 1.1
        for signal in contract.get("exclusion_signals") or []:
            if not isinstance(signal, dict):
                continue
            if cue_hits(signal.get("cues") or [], sample):
                score -= 2.0
                negative_ids.append(str(signal.get("signal_id") or "negative_signal"))

        # Adjacent-pattern resolution uses only observable question/page
        # semantics.  It prevents generic words such as "安全" or "验证"
        # from turning a consumer recommendation article into P11.
        if open_recommendation:
            if pattern_id == "P02":
                score += 3.0
            elif pattern_id in {"P01", "P03", "P11"}:
                score -= 1.5
        if named_comparison:
            if pattern_id == "P03":
                score += 2.0
            elif pattern_id == "P02" and not open_recommendation:
                score -= 1.0
        if pattern_id == "P11" and not technical_implementation:
            score -= 4.0
        if content_form == "research_pdf" and pattern_id == "P10":
            score += 1.0
        elif content_form == "case_study" and pattern_id == "P12":
            score += 1.0
        elif content_form == "news_article" and pattern_id == "P13":
            score += 1.0
        elif content_form == "brand_feature" and pattern_id == "P14":
            score += 1.0
        elif content_form == "tutorial_documentation" and pattern_id in {"P08", "P11"}:
            score += 0.75
        if score > 0 and (intent_ids or component_ids):
            scores.append({
                "score": score,
                "pattern_id": pattern_id,
                "intent_ids": list(dict.fromkeys(intent_ids)),
                "component_ids": list(dict.fromkeys(component_ids)),
                "negative_ids": list(dict.fromkeys(negative_ids)),
            })
    if not scores:
        return {
            "primary_pattern_id": None,
            "alternative_pattern_ids": [],
            "classification_confidence": 0.0,
            "matched_intent_signal_ids": [],
            "matched_structure_component_ids": [],
            "negative_signal_ids": [],
            "question_similarity": ngram_similarity(question, " ".join([title, *headings])),
            "classification_rationale": "页面正文可访问，但未出现足以支持某个 P 模式的结构信号",
        }
    scores.sort(key=lambda item: (-float(item["score"]), str(item["pattern_id"])))
    winner = scores[0]
    best = float(winner["score"])
    runner_up = float(scores[1]["score"]) if len(scores) > 1 else 0.0
    margin = max(0.0, best - runner_up)
    confidence = min(0.98, round(0.5 + best / 20 + margin / 20, 4))
    matched = [*winner["intent_ids"], *winner["component_ids"]]
    alternatives = [
        str(item["pattern_id"]) for item in scores[1:4]
        if float(item["score"]) >= max(1.0, best * 0.55)
    ]
    return {
        "primary_pattern_id": str(winner["pattern_id"]),
        "alternative_pattern_ids": alternatives,
        "classification_confidence": confidence,
        "matched_intent_signal_ids": winner["intent_ids"],
        "matched_structure_component_ids": winner["component_ids"],
        "negative_signal_ids": winner["negative_ids"],
        "question_similarity": ngram_similarity(question, " ".join([title, *headings])),
        "classification_rationale": f"正文结构命中 {', '.join(matched[:6])}，并结合正式问题归入 {winner['pattern_id']}",
    }


def classify_from_benchmark(
    match: dict[str, Any], question: str, title: str, headings: list[str],
) -> dict[str, Any]:
    pattern_id = str(match["pattern_id"])
    benchmark_id = str(match["benchmark_id"])
    return {
        "primary_pattern_id": pattern_id,
        "alternative_pattern_ids": [],
        "classification_confidence": 0.97,
        # A benchmark URL match is provenance, not an intent/component cue;
        # leaving these arrays empty avoids inventing Registry signal hits.
        "matched_intent_signal_ids": [],
        "matched_structure_component_ids": [],
        "negative_signal_ids": [],
        "question_similarity": ngram_similarity(question, " ".join([title, *headings])),
        "classification_rationale": (
            f"最终 URL 唯一命中已语义复审的预研标杆 {benchmark_id}；"
            f"页面正文可分析，因此按签名研究索引归入 {pattern_id}"
        ),
    }


def empty_classification(reason: str) -> dict[str, Any]:
    return {
        "primary_pattern_id": None,
        "alternative_pattern_ids": [],
        "classification_confidence": 0.0,
        "matched_intent_signal_ids": [],
        "matched_structure_component_ids": [],
        "negative_signal_ids": [],
        "question_similarity": 0.0,
        "classification_rationale": reason,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect E2 pages without persistent snapshots")
    parser.add_argument("--source-pool", type=Path, required=True)
    parser.add_argument("--pattern-registry", type=Path, required=True)
    parser.add_argument("--pattern-research-index", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=12)
    parser.add_argument("--max-bytes", type=int, default=5 * 1024 * 1024)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()

    pool_document = load_object(args.source_pool)
    registry = load_object(args.pattern_registry)
    research = load_object(args.pattern_research_index)
    benchmark_index = benchmark_url_index(research)
    pool = pool_document.get("cited_content_pool") if isinstance(pool_document.get("cited_content_pool"), list) else []
    observations: list[dict[str, Any]] = []
    canonical_first: dict[str, int] = {}
    for item in pool:
        rank = int(item.get("raw_rank"))
        url = str(item.get("canonical_url") or "")
        first = canonical_first.setdefault(url, rank)
        if first != rank:
            observations.append({
                "observation_id": f"obs_rank_{rank:02d}", "raw_rank": rank,
                "status": "duplicate_alias", "content_form": None,
                **empty_classification(f"与原始排行 {first} 为同一 canonical URL"),
                "structure_summary": None, "benchmark_review": None,
                "notes": [f"与原始排行 {first} 为同一 canonical URL"],
            })
            continue
        if args.offline:
            observations.append({
                "observation_id": f"obs_rank_{rank:02d}", "raw_rank": rank,
                "status": "unavailable", "content_form": None,
                **empty_classification("离线模式未访问页面"),
                "structure_summary": None, "benchmark_review": None,
                "notes": ["离线模式未访问页面；后续由签名预研模板承接结构"],
            })
            continue
        try:
            final_url, mime, body = fetch(url, args.timeout, args.max_bytes)
            if "pdf" in mime or final_url.casefold().endswith(".pdf"):
                title, text, headings = extract_pdf(body)
            elif mime in {"text/html", "application/xhtml+xml", "text/plain", "application/octet-stream"} or not mime:
                title, text, headings = extract_html(body)
            else:
                raise ValueError(f"unsupported MIME: {mime}")
            form = detect_form(final_url, mime, title or str(item.get("content_title") or ""), headings, text)
            if form in NON_ARTICLE_FORMS:
                observations.append({
                    "observation_id": f"obs_rank_{rank:02d}", "raw_rank": rank,
                    "status": "non_article", "content_form": form,
                    **empty_classification("页面属于非文章形态，不参与 P 类型投票"),
                    "structure_summary": " → ".join(headings[:12])[:2000] or None,
                    "benchmark_review": None,
                    "notes": ["页面可访问，但内容形态不参与 P 类型投票"],
                })
                continue
            benchmark = unique_benchmark_match(benchmark_index, final_url)
            if benchmark is not None:
                classification = classify_from_benchmark(
                    benchmark, str(pool_document.get("question") or ""),
                    title or str(item.get("content_title") or ""), headings,
                )
            else:
                classification = classify(
                    registry, str(pool_document.get("question") or ""), form,
                    title or str(item.get("content_title") or ""), headings, text,
                )
            if classification["primary_pattern_id"] is None:
                observations.append({
                    "observation_id": f"obs_rank_{rank:02d}", "raw_rank": rank,
                    "status": "unavailable", "content_form": form, **classification,
                    "structure_summary": " → ".join(headings[:12])[:2000] or None,
                    "benchmark_review": None,
                    "notes": [classification["classification_rationale"]],
                })
            else:
                extracted_structure = " → ".join(headings[:12])[:2000] or None
                research_structure = (
                    "；".join(benchmark.get("structure_observation", [])[:3])[:2000]
                    if benchmark is not None else None
                )
                structure_summary = extracted_structure
                notes = [classification["classification_rationale"]]
                if research_structure:
                    structure_summary = "｜".join(
                        item for item in (extracted_structure, f"预研结构观察：{research_structure}") if item
                    )[:2000]
                    notes.extend(benchmark.get("structure_observation", [])[:3])
                observations.append({
                    "observation_id": f"obs_rank_{rank:02d}", "raw_rank": rank,
                    "status": "classified_article", "content_form": form, **classification,
                    "structure_summary": structure_summary or " → ".join(
                        classification["matched_structure_component_ids"][:8]
                    )[:2000] or classification["classification_rationale"],
                    "benchmark_review": ({
                        "benchmark_id": benchmark["benchmark_id"],
                        **{field: benchmark[field] for field in BENCHMARK_REVIEW_LIST_FIELDS},
                        **{field: benchmark[field] for field in BENCHMARK_REVIEW_TEXT_FIELDS},
                    } if benchmark is not None else None),
                    "notes": notes,
                })
        except ValueError as exc:
            status = "unsafe_url" if "unsafe" in str(exc).casefold() or "http(s)" in str(exc).casefold() else "unavailable"
            observations.append({
                "observation_id": f"obs_rank_{rank:02d}", "raw_rank": rank,
                "status": status, "content_form": None,
                **empty_classification(str(exc)[:500]),
                "structure_summary": None, "benchmark_review": None,
                "notes": [str(exc)[:500]],
            })

    payload = {
        "schema_version": "2.3.0",
        "artifact_type": "E2_page_structure_analysis",
        "job_id": pool_document.get("job_id"),
        "question": pool_document.get("question"),
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "content_observations": observations,
    }
    write_json(args.output, payload)
    print(json.dumps({
        "stage": "E2", "status": "completed_with_limits" if any(item["status"] != "classified_article" for item in observations) else "completed",
        "classified_articles": sum(item["status"] == "classified_article" for item in observations),
        "observations": len(observations), "output": str(args.output),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
