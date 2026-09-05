#!/usr/bin/env python3
"""Regression tests for S2's fail-closed first-party publication gate."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = Path(__file__).resolve().parents[3]
ADAPTER_PATH = SKILL_ROOT / "scripts" / "kb_v4_adapter.py"
FIXTURE_ROOT = PACKAGE_ROOT / "shared" / "fixtures" / "minimal_reference_pack"

SPEC = importlib.util.spec_from_file_location("frontmind_s2_adapter", ADAPTER_PATH)
assert SPEC and SPEC.loader
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)


def authorization_payload(source_ids: list[str], authorization: str = "public_approved") -> dict:
    return {
        "schema_version": "2.0.0",
        "brand": "匿名示例企业",
        "authorization_id": "auth_fixture_release_001",
        "reviewer": "fixture-reviewer",
        "reviewer_role": "publication-owner",
        "reviewed_at": "2026-08-11T09:00:00+08:00",
        "authorizations": [
            {
                "source_id": source_id,
                "publication_authorization": authorization,
                "authorization_basis": "品牌负责人书面确认",
                "evidence_refs": ["approval/fixture-authorization-record"],
                "anonymization_attestation": (
                    "已删除客户和人员识别信息" if authorization == "anonymized_approved" else ""
                ),
                "notes": "fixture only",
            }
            for source_id in source_ids
        ],
    }


class PublicationAuthorizationUnitTests(unittest.TestCase):
    def source(self, source_id: str, raw_type: str, origin: str = "kbv4") -> dict:
        return ADAPTER.source_item(
            source_id, raw_type, source_id, "", origin,
            "test locator", "document", file_path="sources/knowledge_base/source.md",
        )

    def test_official_and_project_labels_start_internal(self) -> None:
        for raw_type in ("official website", "客户项目记录", "first_party_reference"):
            with self.subTest(raw_type=raw_type):
                source = self.source(f"src_{raw_type.encode('utf-8').hex()[:12]}", raw_type)
                self.assertEqual(source["source_type"], "first_party_internal")
                self.assertEqual(source["source_origin_class"], "first_party_internal")
                self.assertEqual(source["publication_authorization"], "internal_only")

    def test_no_manifest_leaves_every_candidate_internal(self) -> None:
        sources = {"src_owned_source": self.source("src_owned_source", "official")}
        candidates = ADAPTER.publication_candidate_ids(sources)
        self.assertEqual(candidates, ["src_owned_source"])
        self.assertEqual(sources["src_owned_source"]["publication_authorization"], "internal_only")

    def test_exact_approval_promotes_canonical_owned_source(self) -> None:
        sources = {"src_owned_source": self.source("src_owned_source", "internal")}
        summary, errors = ADAPTER.validate_and_apply_publication_authorizations(
            authorization_payload(["src_owned_source"]),
            brand="匿名示例企业", sources=sources, candidate_ids=["src_owned_source"],
        )
        self.assertEqual(errors, [])
        self.assertEqual(summary["status"], "applied")
        self.assertEqual(sources["src_owned_source"]["source_type"], "first_party_official")
        self.assertEqual(sources["src_owned_source"]["source_origin_class"], "first_party_official")
        self.assertEqual(sources["src_owned_source"]["publication_authorization"], "public_approved")

    def test_fake_id_is_atomic_failure(self) -> None:
        sources = {"src_owned_source": self.source("src_owned_source", "internal")}
        original = deepcopy(sources)
        summary, errors = ADAPTER.validate_and_apply_publication_authorizations(
            authorization_payload(["src_owned_source", "src_forged_source"]),
            brand="匿名示例企业", sources=sources, candidate_ids=["src_owned_source"],
        )
        self.assertEqual(summary["status"], "invalid")
        self.assertTrue(any("unknown source_ids" in error for error in errors))
        self.assertEqual(sources, original)

    def test_third_party_id_cannot_be_promoted(self) -> None:
        sources = {
            "src_owned_source": self.source("src_owned_source", "internal"),
            "src_media_source": self.source("src_media_source", "editorial media"),
        }
        original = deepcopy(sources)
        summary, errors = ADAPTER.validate_and_apply_publication_authorizations(
            authorization_payload(["src_owned_source", "src_media_source"]),
            brand="匿名示例企业", sources=sources, candidate_ids=["src_owned_source"],
        )
        self.assertEqual(summary["status"], "invalid")
        self.assertTrue(any("non-candidate/third-party" in error for error in errors))
        self.assertEqual(sources, original)

    def test_explicit_internal_only_is_a_valid_reviewed_state(self) -> None:
        sources = {"src_owned_source": self.source("src_owned_source", "客户项目记录")}
        summary, errors = ADAPTER.validate_and_apply_publication_authorizations(
            authorization_payload(["src_owned_source"], "internal_only"),
            brand="匿名示例企业", sources=sources, candidate_ids=["src_owned_source"],
        )
        self.assertEqual(errors, [])
        self.assertEqual(summary["status"], "applied")
        self.assertEqual(sources["src_owned_source"]["publication_authorization"], "internal_only")


class PublicationAuthorizationCliTests(unittest.TestCase):
    def run_adapter(self, output: Path, authorization: Path | None = None) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable, "-B", str(ADAPTER_PATH),
            "--brand", "匿名示例企业",
            "--kb", str(FIXTURE_ROOT / "sources" / "original_kb.zip"),
            "--output-dir", str(output),
        ]
        if authorization:
            command.extend(["--publication-authorizations", str(authorization)])
        return subprocess.run(command, text=True, capture_output=True, check=False)

    def test_two_pass_cli_keeps_internal_then_promotes_and_restores_claim(self) -> None:
        with tempfile.TemporaryDirectory(prefix="frontmind-s2-auth-test-") as temporary:
            root = Path(temporary)
            first = root / "first"
            result = self.run_adapter(first)
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            source_registry = json.loads(next(first.glob("S2_*_source_registry.json")).read_text(encoding="utf-8"))
            self.assertEqual(source_registry["sources"][0]["publication_authorization"], "internal_only")
            claim_registry = json.loads(next(first.glob("S2_*_claim_registry.json")).read_text(encoding="utf-8"))
            self.assertEqual(claim_registry["claims"][0]["allowed_usage"], "internal_only")

            source_id = source_registry["sources"][0]["source_id"]
            authorization_path = root / "source_publication_authorizations.json"
            authorization_path.write_text(
                json.dumps(authorization_payload([source_id]), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            second = root / "second"
            result = self.run_adapter(second, authorization_path)
            self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
            source_registry = json.loads(next(second.glob("S2_*_source_registry.json")).read_text(encoding="utf-8"))
            self.assertEqual(source_registry["sources"][0]["publication_authorization"], "public_approved")
            self.assertEqual(source_registry["sources"][0]["source_type"], "first_party_official")
            claim_registry = json.loads(next(second.glob("S2_*_claim_registry.json")).read_text(encoding="utf-8"))
            self.assertIn(claim_registry["claims"][0]["allowed_usage"], {"public_fact", "public_with_qualification"})
            report = json.loads(next(second.glob("S2_*_adapter_report.json")).read_text(encoding="utf-8"))
            self.assertEqual(report["publication_authorizations"]["status"], "applied")
            canonical_authorization = second / "S2_匿名示例企业_source_publication_authorizations.json"
            self.assertEqual(report["publication_authorizations"]["file_name"], canonical_authorization.name)
            self.assertEqual(canonical_authorization.read_bytes(), authorization_path.read_bytes())
            self.assertRegex(report["publication_authorizations"]["sha256"], r"^[a-f0-9]{64}$")


if __name__ == "__main__":
    unittest.main()
