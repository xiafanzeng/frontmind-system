#!/usr/bin/env python3
"""Positive and adversarial regression tests for visible source equality."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "reference_equivalence.py"
SPEC = importlib.util.spec_from_file_location("frontmind_reference_equivalence", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
reference_source_contract = MODULE.reference_source_contract


def model(reference_ids: list[str]) -> dict:
    return {
        "lead": {"claim_ids": ["clm_one"]},
        "sections": [],
        "faq": [],
        "conclusion": {"claim_ids": []},
        "references": [
            {"source_id": source_id, "display_name": source_id}
            for source_id in reference_ids
        ],
    }


def registry(*, original: dict | None = None) -> dict:
    return {
        "claims": [{
            "claim_id": "clm_one",
            "source_ids": ["src_used"],
            "original_evidence": original,
        }]
    }


class ReferenceEquivalenceTests(unittest.TestCase):
    def test_exact_visible_source_set_passes(self) -> None:
        result = reference_source_contract(model(["src_used"]), registry())
        self.assertTrue(result["valid"])
        self.assertEqual(result["errors"], [])

    def test_unused_visible_source_is_rejected(self) -> None:
        result = reference_source_contract(model(["src_used", "src_unrelated"]), registry())
        self.assertFalse(result["valid"])
        self.assertIn(
            "visible_references_not_used_by_article_claims:src_unrelated",
            result["errors"],
        )

    def test_hidden_original_source_is_rejected(self) -> None:
        result = reference_source_contract(model(["src_used"]), registry(original={
            "authorization_status": "public_approved",
            "source_ids": ["src_hidden_original"],
            "record_refs": [],
        }))
        self.assertIn(
            "original_evidence_sources_must_be_claim_sources:clm_one:src_hidden_original",
            result["errors"],
        )

    def test_record_ref_only_original_requires_named_source(self) -> None:
        result = reference_source_contract(model(["src_used"]), registry(original={
            "authorization_status": "anonymized_approved",
            "source_ids": [],
            "record_refs": ["records/case.json"],
        }))
        self.assertIn(
            "authorized_original_evidence_requires_visible_source_id:clm_one",
            result["errors"],
        )


if __name__ == "__main__":
    unittest.main()
