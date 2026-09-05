#!/usr/bin/env python3
"""Relational and physical validation shared by E2 and E3 v2.1 gates."""

from __future__ import annotations

import hashlib
import importlib.util
import ipaddress
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


FINAL_STATUSES = {
    "classified_article", "non_article", "unavailable", "duplicate_alias", "unsafe_url",
}
ARTICLE_FORMS = {
    "editorial_article", "brand_feature", "news_article", "comparison_review",
    "tutorial_documentation", "case_study", "research_pdf", "official_longform",
}
NON_ARTICLE_FORMS = {
    "homepage", "company_registry", "database_listing", "encyclopedia", "search_result",
    "patent_record", "short_video", "social_post", "download_shell", "unknown",
}
SNAPSHOT_ARTIFACT_KEYS = {
    "schema_version", "artifact_type", "original_url", "final_url", "redirect_chain",
    "http_status", "mime_type", "accessed_at", "response_bytes", "body_sha256",
    "approved_addresses", "connected_peer_ip",
}
EXTRACT_ARTIFACT_KEYS = {
    "schema_version", "artifact_type", "page_title", "heading_summary", "short_excerpt",
    "visible_text_length", "body_sha256", "snapshot_sha256", "observed_cues",
}
HUMAN_REVIEW_RECEIPT_KEYS = {
    "schema_version", "job_id", "review_id", "reviewer", "reviewer_role", "reviewed_at",
    "automatic_page_analysis_ref", "review_input_ref", "reviewed_page_analysis_ref",
    "decisions", "attestation",
}
HUMAN_CLASSIFICATION_FIELDS = {
    "primary_pattern_id", "alternative_pattern_ids", "classification_confidence",
    "matched_intent_signal_ids", "matched_structure_component_ids", "negative_signal_ids",
    "content_form", "question_similarity", "classification_rationale", "review_status",
}
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: dict[str, Any]) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def load_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _normal_text(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip().casefold()


def _load_structural_json(
    path: Path | None, label: str, max_bytes: int, errors: list[str],
) -> dict[str, Any] | None:
    if path is None:
        return None
    if path.suffix.lower() != ".json":
        errors.append(f"{label} must be a structural JSON artifact, never saved source HTML/PDF/text")
        return None
    try:
        if path.stat().st_size > max_bytes:
            errors.append(f"{label} exceeds the structural-artifact size limit")
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"{label} is not readable structural JSON: {exc}")
        return None
    if not isinstance(value, dict):
        errors.append(f"{label} must contain a JSON object")
        return None
    return value


def _signed_cues(contract: dict[str, Any], group: str, id_key: str) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for item in contract.get(group, []):
        if not isinstance(item, dict) or not item.get(id_key):
            continue
        result[str(item[id_key])] = {
            _normal_text(cue) for cue in item.get("cues", []) if _normal_text(cue)
        }
    return result


def resolve_artifact(root: Path, stored: Any, errors: list[str], label: str) -> Path | None:
    text = str(stored or "")
    candidate = Path(text)
    if not text or candidate.is_absolute() or ".." in candidate.parts or "\\" in text:
        errors.append(f"{label} must be a non-traversing package-relative path")
        return None
    root = root.resolve()
    resolved = (root / candidate).resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        errors.append(f"{label} escapes package root")
        return None
    if (root / candidate).is_symlink():
        errors.append(f"{label} must not be a symlink")
        return None
    return resolved


def allowed_patterns(registry: dict[str, Any], entry: str, subintent: str | None) -> set[str]:
    route = (registry.get("routing") or {}).get(entry)
    if not isinstance(route, dict):
        return set()
    primary = set(route.get("primary_patterns") or [])
    if entry == "product_scenario" and subintent:
        primary = set((route.get("subintent_routing") or {}).get(subintent) or [])
    return primary | set(route.get("secondary_patterns") or [])



def _root_pattern_decision_module():
    path = Path(__file__).resolve().parents[2] / "shared" / "pattern_decision.py"
    spec = importlib.util.spec_from_file_location("frontmind_root_pattern_decision_e2", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"root pattern decision authority unavailable: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_ROOT_PATTERN_DECISION = _root_pattern_decision_module()
# The root shared module is the semantic SSOT.  This alias keeps E2/E3 callers
# stable while ensuring generation and independent verification use the same
# user-locked arithmetic and tie-break implementation.
compute_e2_recommendation = _ROOT_PATTERN_DECISION.compute_e2_recommendation


def _research_component_ids(index: dict[str, Any]) -> set[str]:
    result: set[str] = set()
    for item in index.get("patterns", []):
        if not isinstance(item, dict):
            continue
        contract = item.get("design_contract") if isinstance(item.get("design_contract"), dict) else {}
        components = item.get("structure_components", []) or contract.get("structure_components", []) or []
        for component in components:
            if isinstance(component, dict) and component.get("component_id"):
                result.add(str(component["component_id"]))
    return result


def validate_e2_relations(
    analysis: dict[str, Any], package_root: Path, pattern_registry_path: Path,
    pattern_research_index_path: Path, source_workbook_path: Path | None = None,
) -> tuple[list[str], dict[str, str]]:
    """Validate exact sets, file hashes and signed classification provenance.

    JSON Schema owns shape validation.  This function owns relations that JSON
    Schema cannot express and returns the exact physical files E3 must freeze.
    """
    errors: list[str] = []
    frozen: dict[str, str] = {}
    package_root = package_root.resolve()
    registry = load_object(pattern_registry_path)
    research = load_object(pattern_research_index_path)
    registry_digest = file_sha256(pattern_registry_path)
    research_digest = file_sha256(pattern_research_index_path)
    valid_patterns = {
        str(item.get("id")) for item in registry.get("patterns", [])
        if isinstance(item, dict) and item.get("id")
    }
    pattern_contracts = {
        str(item.get("id")): item.get("classification_contract")
        for item in registry.get("patterns", [])
        if isinstance(item, dict) and isinstance(item.get("classification_contract"), dict)
    }
    all_signed_observed_cues: set[str] = set()
    for contract in pattern_contracts.values():
        for group in ("positive_intent_signals", "typical_structure_signals", "exclusion_signals"):
            id_key = "component_id" if group == "typical_structure_signals" else "signal_id"
            for cues in _signed_cues(contract, group, id_key).values():
                all_signed_observed_cues.update(cues)
    registry_components = {
        str(component.get("component_id"))
        for item in registry.get("patterns", []) if isinstance(item, dict)
        for component in (item.get("structure_components", []) or [])
        if isinstance(component, dict) and component.get("component_id")
    }
    if valid_patterns != {f"P{number:02d}" for number in range(1, 17)}:
        errors.append("signed pattern registry must contain P01-P16 exactly once")
    if analysis.get("pattern_registry_ref", {}).get("sha256") != registry_digest:
        errors.append("E2 pattern_registry_ref hash differs from supplied signed registry")
    if analysis.get("pattern_research_index_ref", {}).get("sha256") != research_digest:
        errors.append("E2 pattern_research_index_ref hash differs from supplied signed research index")

    workbook_ref = analysis.get("source_workbook_receipt") or {}
    workbook = resolve_artifact(package_root, workbook_ref.get("source_path"), errors, "source_workbook_receipt.source_path")
    if source_workbook_path is not None and workbook and workbook != source_workbook_path.resolve():
        errors.append("source_workbook_receipt.source_path differs from supplied workbook")
    if workbook and (not workbook.is_file() or file_sha256(workbook) != workbook_ref.get("sha256")):
        errors.append("Dashboard source workbook is missing or its SHA256 changed")
    elif workbook:
        frozen[workbook_ref["source_path"]] = str(workbook_ref["sha256"])

    pool = analysis.get("cited_content_pool") if isinstance(analysis.get("cited_content_pool"), list) else []
    observations = analysis.get("content_observations") if isinstance(analysis.get("content_observations"), list) else []
    pool_by_rank: dict[int, dict[str, Any]] = {}
    for item in pool:
        if not isinstance(item, dict) or not isinstance(item.get("raw_rank"), int):
            continue
        rank = item["raw_rank"]
        if rank in pool_by_rank:
            errors.append(f"duplicate cited_content_pool raw_rank: {rank}")
        pool_by_rank[rank] = item
    observation_by_rank: dict[int, dict[str, Any]] = {}
    observation_ids: set[str] = set()
    for item in observations:
        if not isinstance(item, dict) or not isinstance(item.get("raw_rank"), int):
            continue
        rank = item["raw_rank"]
        observation_id = str(item.get("observation_id") or "")
        if rank in observation_by_rank:
            errors.append(f"duplicate content_observations raw_rank: {rank}")
        if observation_id in observation_ids:
            errors.append(f"duplicate content_observations observation_id: {observation_id}")
        observation_by_rank[rank] = item
        observation_ids.add(observation_id)
    if set(pool_by_rank) != set(observation_by_rank):
        errors.append("content_observations must cover every and only raw Top20 pool rank exactly once")
    expected_ranks = set(range(1, 21))
    contiguous = set(range(1, max(pool_by_rank, default=0) + 1))
    if set(pool_by_rank) != contiguous:
        errors.append("cited_content_pool raw ranks must be contiguous 1..N; gaps are forbidden")
    if set(pool_by_rank) == expected_ranks and analysis.get("pool_status") != "complete_pool":
        errors.append("a complete raw Top20 rank set must use pool_status=complete_pool")
    if set(pool_by_rank) != expected_ranks and analysis.get("pool_status") != "partial_pool":
        errors.append("a short or gapped raw Top20 rank set must use pool_status=partial_pool")

    canonical_first_rank: dict[str, int] = {}
    research_components = _research_component_ids(research)
    classifier_version = analysis.get("classifier_version")
    human_review_by_rank: dict[int, dict[str, Any]] = {}
    for rank in sorted(set(pool_by_rank) & set(observation_by_rank)):
        pool_item = pool_by_rank[rank]
        observation = observation_by_rank[rank]
        canonical_url = str(pool_item.get("canonical_url") or "")
        status = observation.get("status")
        review_status = observation.get("review_status")
        if review_status not in {"machine_classified", "human_confirmed", "human_corrected"}:
            errors.append(f"rank {rank} observation review_status is invalid")
        if review_status in {"human_confirmed", "human_corrected"}:
            human_review_by_rank[rank] = observation
        if status in {"unavailable", "duplicate_alias", "unsafe_url"} and review_status != "machine_classified":
            errors.append(f"rank {rank} {status} cannot carry an unprovable human review state")
        if observation.get("canonical_url") != canonical_url:
            errors.append(f"rank {rank} observation canonical_url differs from raw pool")
        if observation.get("observation_id") != f"obs_rank_{rank:02d}":
            errors.append(f"rank {rank} observation_id must be obs_rank_{rank:02d}")
        first_rank = canonical_first_rank.setdefault(canonical_url, rank)
        if first_rank != rank and status != "duplicate_alias":
            errors.append(f"rank {rank} repeats canonical URL from rank {first_rank} and must be duplicate_alias")
        if first_rank == rank and status == "duplicate_alias":
            errors.append(f"rank {rank} is the first canonical URL occurrence and cannot be duplicate_alias")
        if status not in FINAL_STATUSES:
            errors.append(f"rank {rank} has an invalid final status")
            continue
        receipt = observation.get("retrieval_receipt") if isinstance(observation.get("retrieval_receipt"), dict) else {}
        if receipt.get("original_url") != pool_item.get("original_url"):
            errors.append(f"rank {rank} retrieval original_url differs from raw pool")
        extraction = receipt.get("extraction_status")
        if status == "classified_article" and extraction not in {"extracted", "partial"}:
            errors.append(f"rank {rank} classified article requires an extracted or partial page")
        if status == "non_article" and extraction not in {"extracted", "partial"}:
            errors.append(f"rank {rank} non-article classification requires an extracted or partial page")
        if status in {"duplicate_alias", "unsafe_url"} and extraction != "not_attempted":
            errors.append(f"rank {rank} {status} must not attempt retrieval")
        if status == "unavailable" and (extraction != "failed" or not receipt.get("failure_reason")):
            errors.append(f"rank {rank} unavailable page requires failed extraction and failure_reason")
        retrieval_artifacts: dict[str, Path] = {}
        for path_key, hash_key in (
            ("snapshot_relative_path", "snapshot_sha256"),
            ("extract_relative_path", "extract_sha256"),
        ):
            stored, expected = receipt.get(path_key), receipt.get(hash_key)
            if stored is None and expected is None:
                continue
            artifact = resolve_artifact(package_root, stored, errors, f"rank {rank} retrieval_receipt.{path_key}")
            if not artifact or not artifact.is_file() or file_sha256(artifact) != expected:
                errors.append(f"rank {rank} retrieval {path_key} is missing or its SHA256 changed")
            else:
                frozen[str(stored)] = str(expected)
                retrieval_artifacts[path_key] = artifact

        snapshot_document = _load_structural_json(
            retrieval_artifacts.get("snapshot_relative_path"),
            f"rank {rank} snapshot", 16 * 1024, errors,
        )
        extract_document = _load_structural_json(
            retrieval_artifacts.get("extract_relative_path"),
            f"rank {rank} extract", 256 * 1024, errors,
        )
        if status in {"classified_article", "non_article"} and not (snapshot_document and extract_document):
            errors.append(f"rank {rank} analyzed page requires both structural snapshot and extract JSON artifacts")
        if extract_document is not None and snapshot_document is None:
            errors.append(f"rank {rank} extract cannot exist without its structural snapshot receipt")
        if snapshot_document is not None:
            if set(snapshot_document) != SNAPSHOT_ARTIFACT_KEYS:
                errors.append(f"rank {rank} snapshot JSON fields differ from the v2.1 response-receipt contract")
            if (
                snapshot_document.get("schema_version") != "2.1.0"
                or snapshot_document.get("artifact_type") != "E2_http_response_receipt"
            ):
                errors.append(f"rank {rank} snapshot JSON has the wrong type or version")
            for key in ("original_url", "final_url", "redirect_chain", "http_status", "mime_type", "accessed_at"):
                if snapshot_document.get(key) != receipt.get(key):
                    errors.append(f"rank {rank} snapshot JSON {key} differs from retrieval receipt")
            if not isinstance(snapshot_document.get("response_bytes"), int) or snapshot_document.get("response_bytes", 0) <= 0:
                errors.append(f"rank {rank} snapshot JSON response_bytes must be a positive integer")
            if not SHA256_RE.fullmatch(str(snapshot_document.get("body_sha256") or "")):
                errors.append(f"rank {rank} snapshot JSON body_sha256 is invalid")
            approved_addresses = snapshot_document.get("approved_addresses")
            connected_peer_ip = snapshot_document.get("connected_peer_ip")
            try:
                approved_ips = {
                    ipaddress.ip_address(value) for value in approved_addresses
                } if isinstance(approved_addresses, list) and approved_addresses else set()
                connected_ip = ipaddress.ip_address(str(connected_peer_ip))
            except ValueError:
                approved_ips, connected_ip = set(), None
            if (
                connected_ip is None or not connected_ip.is_global
                or connected_ip not in approved_ips
                or any(not value.is_global for value in approved_ips)
            ):
                errors.append(f"rank {rank} snapshot lacks a valid DNS-approved global connected peer")
        if extract_document is not None:
            if set(extract_document) != EXTRACT_ARTIFACT_KEYS:
                errors.append(f"rank {rank} extract JSON fields differ from the v2.1 structural-extract contract")
            if (
                extract_document.get("schema_version") != "2.1.0"
                or extract_document.get("artifact_type") != "E2_page_structure_extract"
            ):
                errors.append(f"rank {rank} extract JSON has the wrong type or version")
            if extract_document.get("page_title") != receipt.get("page_title"):
                errors.append(f"rank {rank} extract page_title differs from retrieval receipt")
            if extract_document.get("heading_summary") != receipt.get("heading_summary"):
                errors.append(f"rank {rank} extract heading_summary differs from retrieval receipt")
            if len(str(extract_document.get("short_excerpt") or "")) > 500:
                errors.append(f"rank {rank} extract short_excerpt exceeds 500 characters")
            if not isinstance(extract_document.get("visible_text_length"), int) or extract_document.get("visible_text_length", 0) <= 0:
                errors.append(f"rank {rank} extract visible_text_length must be a positive integer")
            if snapshot_document and extract_document.get("body_sha256") != snapshot_document.get("body_sha256"):
                errors.append(f"rank {rank} extract body_sha256 differs from the response receipt")
            if extract_document.get("snapshot_sha256") != receipt.get("snapshot_sha256"):
                errors.append(f"rank {rank} extract is not bound to the structural snapshot receipt")
            observed_cues = extract_document.get("observed_cues")
            if not isinstance(observed_cues, dict) or len(observed_cues) > 50:
                errors.append(f"rank {rank} extract observed_cues must be an object with at most 50 short contexts")
            else:
                total_context_chars = sum(len(str(value)) for value in observed_cues.values())
                if total_context_chars > 2000:
                    errors.append(f"rank {rank} extract cue contexts exceed the 2000-character total cap")
                if len({str(value) for value in observed_cues.values()}) != len(observed_cues):
                    errors.append(f"rank {rank} extract cue contexts contain duplicated prose")
                for cue, context in observed_cues.items():
                    normalized_cue = _normal_text(cue)
                    normalized_context = _normal_text(context)
                    if not normalized_cue or len(str(context)) > 80 or normalized_cue not in normalized_context:
                        errors.append(f"rank {rank} extract cue context is unsigned, too long, or does not witness its cue")

        classification = observation.get("classification")
        if status != "classified_article":
            if classification is not None:
                errors.append(f"rank {rank} non-classified status must have classification=null")
            if status == "non_article" and observation.get("content_form") not in NON_ARTICLE_FORMS:
                errors.append(f"rank {rank} non_article requires a canonical non-article content_form")
            if status not in {"non_article", "classified_article"} and observation.get("content_form") is not None:
                errors.append(f"rank {rank} {status} must have content_form=null")
            continue
        if observation.get("content_form") not in ARTICLE_FORMS or not isinstance(classification, dict):
            errors.append(f"rank {rank} classified_article requires article content_form and classification")
            continue
        pattern_id = str(classification.get("primary_pattern_id") or "")
        alternatives = set(str(value) for value in classification.get("alternative_pattern_ids", []))
        if pattern_id not in valid_patterns or alternatives - valid_patterns or pattern_id in alternatives:
            errors.append(f"rank {rank} classification contains invalid/duplicate P IDs")
        if classification.get("content_form") != observation.get("content_form"):
            errors.append(f"rank {rank} classification.content_form differs from observation")
        if classification.get("snapshot_sha256") != receipt.get("snapshot_sha256"):
            errors.append(f"rank {rank} classification is not bound to the retrieval snapshot")
        if classification.get("registry_sha256") != registry_digest:
            errors.append(f"rank {rank} classification is not bound to the signed registry")
        if classification.get("classifier_version") != classifier_version:
            errors.append(f"rank {rank} classification classifier_version differs from E2")
        if classification.get("review_status") != review_status:
            errors.append(f"rank {rank} observation/classification review_status mismatch")
        components = set(str(value) for value in classification.get("matched_structure_component_ids", []))
        if any(not value.startswith(f"{pattern_id}_component_") for value in components):
            errors.append(f"rank {rank} structure component IDs must belong to primary_pattern_id")
        if components - (registry_components & research_components):
            errors.append(f"rank {rank} classification references components not shared by signed registry and research index")
        contract = pattern_contracts.get(pattern_id, {})
        positive_cues = _signed_cues(contract, "positive_intent_signals", "signal_id")
        structure_cues = _signed_cues(contract, "typical_structure_signals", "component_id")
        negative_cues = _signed_cues(contract, "exclusion_signals", "signal_id")
        matched_intents = set(classification.get("matched_intent_signal_ids", []))
        matched_components = set(classification.get("matched_structure_component_ids", []))
        matched_negatives = set(classification.get("negative_signal_ids", []))
        if matched_intents - set(positive_cues):
            errors.append(f"rank {rank} classification references unknown positive intent signal IDs")
        if matched_components - set(structure_cues):
            errors.append(f"rank {rank} classification references unknown structure component IDs")
        if matched_negatives - set(negative_cues):
            errors.append(f"rank {rank} classification references unknown exclusion signal IDs")
        if observation.get("content_form") not in set(contract.get("eligible_content_forms", [])):
            errors.append(f"rank {rank} content_form is ineligible for primary_pattern_id under signed classifier contract")
        observed_cues = extract_document.get("observed_cues", {}) if isinstance(extract_document, dict) else {}
        observed_keys = {_normal_text(value) for value in observed_cues}
        if observed_keys - all_signed_observed_cues:
            errors.append(f"rank {rank} extract contains cues not signed by the P01-P16 registry")
        for label, identifiers, cue_map in (
            ("intent", matched_intents, positive_cues),
            ("structure", matched_components, structure_cues),
            ("negative", matched_negatives, negative_cues),
        ):
            for identifier in identifiers:
                if not (cue_map.get(str(identifier), set()) & observed_keys):
                    errors.append(f"rank {rank} claimed {label} ID {identifier} has no witnessed cue in hashed extract")

    human_ref = analysis.get("human_review_receipt_ref")
    if not human_review_by_rank:
        if human_ref is not None:
            errors.append("all-machine E2 analysis must set human_review_receipt_ref=null")
    elif not isinstance(human_ref, dict):
        errors.append("human-reviewed classifications require human_review_receipt_ref")
    else:
        review_receipt_path = resolve_artifact(
            package_root, human_ref.get("path"), errors, "human_review_receipt_ref.path",
        )
        review_receipt: dict[str, Any] | None = None
        if (
            review_receipt_path is None or not review_receipt_path.is_file()
            or file_sha256(review_receipt_path) != human_ref.get("sha256")
        ):
            errors.append("human review receipt is missing or its SHA256 changed")
        else:
            frozen[str(human_ref["path"])] = str(human_ref["sha256"])
            review_receipt = _load_structural_json(
                review_receipt_path, "human review receipt", 256 * 1024, errors,
            )
        if review_receipt is not None:
            if set(review_receipt) != HUMAN_REVIEW_RECEIPT_KEYS:
                errors.append("human review receipt fields differ from the exact v2.1 contract")
            if (
                review_receipt.get("schema_version") != "2.1.0"
                or review_receipt.get("job_id") != analysis.get("job_id")
                or not re.fullmatch(r"e2review_[a-z0-9][a-z0-9_-]{5,80}", str(review_receipt.get("review_id") or ""))
            ):
                errors.append("human review receipt type/status/job binding is invalid")
            referenced_documents: dict[str, dict[str, Any]] = {}
            for ref_key in (
                "automatic_page_analysis_ref", "review_input_ref", "reviewed_page_analysis_ref",
            ):
                ref = review_receipt.get(ref_key) if isinstance(review_receipt.get(ref_key), dict) else {}
                artifact = resolve_artifact(package_root, ref.get("path"), errors, f"human review {ref_key}.path")
                if artifact is None or not artifact.is_file() or file_sha256(artifact) != ref.get("sha256"):
                    errors.append(f"human review {ref_key} is missing or its SHA256 changed")
                    continue
                frozen[str(ref["path"])] = str(ref["sha256"])
                value = _load_structural_json(artifact, f"human review {ref_key}", 4 * 1024 * 1024, errors)
                if value is not None:
                    referenced_documents[ref_key] = value
            automatic_analysis = referenced_documents.get("automatic_page_analysis_ref", {})
            review_input = referenced_documents.get("review_input_ref", {})
            reviewed_analysis = referenced_documents.get("reviewed_page_analysis_ref", {})
            if (
                review_input.get("job_id") != analysis.get("job_id")
                or review_input.get("reviewer") != review_receipt.get("reviewer")
                or review_input.get("reviewer_role") != review_receipt.get("reviewer_role")
                or review_input.get("review_id") != review_receipt.get("review_id")
                or review_input.get("attestation") != review_receipt.get("attestation")
                or (review_input.get("reviewed_at") or review_receipt.get("reviewed_at")) != review_receipt.get("reviewed_at")
            ):
                errors.append("human review input identity/reviewer/time differs from its receipt")
            receipt_decisions = review_receipt.get("decisions")
            decision_by_observation = {
                str(item.get("observation_id")): item
                for item in receipt_decisions if isinstance(item, dict)
            } if isinstance(receipt_decisions, list) else {}
            expected_observations = {f"obs_rank_{rank:02d}" for rank in human_review_by_rank}
            if len(decision_by_observation) != len(receipt_decisions or []) or set(decision_by_observation) != expected_observations:
                errors.append("human review receipt decisions must exactly cover all human-reviewed ranks")
            automatic_by_rank = {
                int(item.get("raw_rank")): item
                for item in automatic_analysis.get("content_observations", [])
                if isinstance(item, dict) and isinstance(item.get("raw_rank"), int)
            }
            reviewed_by_rank = {
                int(item.get("raw_rank")): item
                for item in reviewed_analysis.get("content_observations", [])
                if isinstance(item, dict) and isinstance(item.get("raw_rank"), int)
            }
            for rank, final_observation in human_review_by_rank.items():
                classification = final_observation.get("classification")
                decision = decision_by_observation.get(f"obs_rank_{rank:02d}", {})
                expected_decision = "confirmed" if final_observation.get("review_status") == "human_confirmed" else "corrected"
                final_pattern = classification.get("primary_pattern_id") if isinstance(classification, dict) else None
                automatic_item = automatic_by_rank.get(rank, {})
                automatic_classification = automatic_item.get("classification") if isinstance(automatic_item, dict) else None
                automatic_pattern = (
                    automatic_classification.get("primary_pattern_id")
                    if isinstance(automatic_classification, dict) else None
                )
                if (
                    decision.get("decision") != expected_decision
                    or decision.get("automatic_pattern_id") != automatic_pattern
                    or decision.get("final_pattern_id") != final_pattern
                    or decision.get("final_review_status") != final_observation.get("review_status")
                    or not 10 <= len(str(decision.get("rationale") or "").strip()) <= 2000
                ):
                    errors.append(f"human review action differs from final review_status at rank {rank}")
                reviewed_item = reviewed_by_rank.get(rank, {})
                reviewed_classification = reviewed_item.get("classification") if isinstance(reviewed_item, dict) else None
                if (
                    reviewed_item.get("status") != final_observation.get("status")
                    or reviewed_item.get("review_status") != final_observation.get("review_status")
                    or reviewed_item.get("content_form") != final_observation.get("content_form")
                ):
                    errors.append(f"final E2 observation differs from hash-bound human review at rank {rank}")
                if isinstance(classification, dict):
                    if not isinstance(reviewed_classification, dict):
                        errors.append(f"human reviewed page analysis lacks classification at rank {rank}")
                        continue
                    final_subset = {key: classification.get(key) for key in HUMAN_CLASSIFICATION_FIELDS}
                    reviewed_subset = {key: reviewed_classification.get(key) for key in HUMAN_CLASSIFICATION_FIELDS}
                    if final_subset != reviewed_subset:
                        errors.append(f"final E2 classification differs from hash-bound human review at rank {rank}")
                elif reviewed_classification is not None:
                    errors.append(f"final non-article differs from hash-bound human review at rank {rank}")

    recommendation = analysis.get("recommendation") if isinstance(analysis.get("recommendation"), dict) else {}
    recommended = str(recommendation.get("recommended_pattern_id") or "")
    allowed = allowed_patterns(
        registry, str(analysis.get("entry_category") or ""), analysis.get("product_scenario_subintent"),
    )
    if recommended not in allowed:
        errors.append(f"E2 recommended pattern {recommended!r} is outside the signed entry/subintent route")
    if recommendation.get("advisory_only") is not True:
        errors.append("E2 recommendation must remain advisory_only=true; E4 owns the decision")
    try:
        expected_recommendation = compute_e2_recommendation(
            pool, observations, registry,
            str(analysis.get("entry_category") or ""),
            analysis.get("product_scenario_subintent"),
            str(analysis.get("question") or ""),
        )
    except (KeyError, TypeError, ValueError) as exc:
        errors.append(f"E2 recommendation cannot be recomputed from signed inputs: {exc}")
    else:
        if recommendation != expected_recommendation:
            errors.append(
                "E2 recommendation differs from deterministic recomputation of pool, classifications, "
                "citation_count × confidence, route and tie-break rules"
            )
    if any("内容状态" in str(key) or str(key) in {"content_status", "monitor_catalog_status"} for key in _walk_keys(analysis)):
        errors.append("Dashboard 内容状态 must not be serialized into E2 artifacts")
    errors.extend(
        f"root semantic authority: {message}"
        for message in _ROOT_PATTERN_DECISION.validate_e2_pattern_analysis(analysis, registry)
    )
    return errors, dict(sorted(frozen.items()))


def _walk_keys(value: Any):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from _walk_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_keys(child)
