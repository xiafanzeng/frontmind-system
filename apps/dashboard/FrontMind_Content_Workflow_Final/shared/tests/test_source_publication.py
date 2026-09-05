#!/usr/bin/env python3

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from source_publication import source_is_publishable, source_usage_status, validate_source_publication


class SourcePublicationTests(unittest.TestCase):
    def test_ordinary_user_upload_is_usable_without_approval_ledger(self) -> None:
        source = {"source_id": "src_upload", "source_type": "first_party_official", "usage_status": "usable"}
        self.assertEqual(source_usage_status(source), "usable")
        self.assertTrue(source_is_publishable(source))
        self.assertEqual(validate_source_publication(source), [])

    def test_explicit_internal_or_confidential_content_is_excluded(self) -> None:
        for value in (
            {"source_type": "first_party_internal", "usage_status": "usable"},
            {"source_type": "first_party_official", "confidentiality": "confidential"},
            {"source_type": "first_party_official", "usage_status": "excluded"},
        ):
            self.assertEqual(source_usage_status(value), "excluded")
            self.assertFalse(source_is_publishable(value))

    def test_qualified_content_remains_usable_with_limits(self) -> None:
        source = {"source_type": "first_party_official", "usage_status": "qualified"}
        self.assertEqual(source_usage_status(source), "qualified")
        self.assertTrue(source_is_publishable(source))

    def test_legacy_signature_is_tolerated_but_receipt_state_is_ignored(self) -> None:
        source = {
            "source_type": "first_party_official",
            "publication_authorization": "not_applicable",
            "usage_status": "usable",
        }
        self.assertEqual(validate_source_publication(source, "base_pack", {"obsolete": True}), [])
        self.assertTrue(source_is_publishable(source, "runtime", {"obsolete": True}))


if __name__ == "__main__":
    unittest.main()
