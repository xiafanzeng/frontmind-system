#!/usr/bin/env python3
"""Tests for the v2.3 content-first v2.2/v2.1 Reference Pack reader."""

from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from validate_package import DirectoryView, ZipView, validate


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = PACKAGE_ROOT / "shared/fixtures/minimal_reference_pack"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def make_registries(root: Path) -> None:
    for name, array_key in (
        ("knowledge", "knowledge_units"),
        ("source", "sources"),
        ("claim", "claims"),
        ("image", "images"),
    ):
        write_json(
            root / f"registries/{name}_registry.json",
            {"schema_version": "2.2.0", "registry_type": f"{name}_registry", array_key: []},
        )


def make_v22(root: Path) -> None:
    make_registries(root)
    write_json(root / "materials/index.json", {"schema_version": "2.2.0", "items": []})
    write_json(
        root / "reference_pack.json",
        {
            "schema_version": "2.2.0",
            "profile": "frontmind-content-reference-pack-v2.2",
            "pack_id": "rp_anonymous_v22",
            "version": 1,
            "created_at": "2026-08-17T00:00:00Z",
            "brand": {"canonical_name": "匿名示例企业", "aliases": []},
            "material_index_path": "materials/index.json",
            "registries": {
                "knowledge_registry_path": "registries/knowledge_registry.json",
                "source_registry_path": "registries/source_registry.json",
                "claim_registry_path": "registries/claim_registry.json",
                "image_registry_path": "registries/image_registry.json",
            },
            "writing_assets": {
                "information_architecture_path": None,
                "trend_viewpoints_path": None,
                "voice_path": None,
                "visual_rules_path": None,
                "question_library_path": None,
            },
            "warnings": [],
        },
    )


def make_v21(root: Path, *, conventional_layout: bool = True) -> None:
    if conventional_layout:
        make_registries(root)
        registries: dict[str, str] = {
            "knowledge_registry_path": "registries/knowledge_registry.json",
            "source_registry_path": "registries/source_registry.json",
            "claim_registry_path": "registries/claim_registry.json",
            "image_registry_path": "registries/image_registry.json",
        }
    else:
        write_json(root / "legacy/content.json", {"brand_fact": "匿名示例企业提供示例服务"})
        registries = {}
    write_json(
        root / "reference_pack.json",
        {
            "schema_version": "2.1.0",
            "profile": "frontmind-content-reference-pack-v2.1",
            "pack_id": "rp_anonymous_v21",
            "brand": {"canonical_name": "匿名示例企业", "aliases": []},
            "registries": registries,
        },
    )


class LightweightReferencePackTests(unittest.TestCase):
    def test_checked_in_fixture_and_temporary_zip_pass(self) -> None:
        report = validate(DirectoryView(FIXTURE))
        self.assertEqual(report["status"], "pass", report)
        self.assertEqual(report["pack_schema_version"], "2.2.0")

        with tempfile.TemporaryDirectory(prefix="frontmind-v22-zip-") as temporary:
            archive_path = Path(temporary) / "pack.zip"
            with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
                for path in FIXTURE.rglob("*"):
                    if path.is_file():
                        archive.write(path, path.relative_to(FIXTURE).as_posix())
            report = validate(ZipView(archive_path))
            self.assertEqual(report["status"], "pass", report)

    def test_v21_conventional_pack_is_accepted_without_rebuilding(self) -> None:
        with tempfile.TemporaryDirectory(prefix="frontmind-v21-pack-") as temporary:
            root = Path(temporary) / "pack"
            root.mkdir()
            make_v21(root)
            report = validate(DirectoryView(root))
            self.assertEqual(report["status"], "pass", report)
            self.assertTrue(any("compatibility" in warning for warning in report["warnings"]))

    def test_v21_noncanonical_layout_is_read_by_content_availability(self) -> None:
        with tempfile.TemporaryDirectory(prefix="frontmind-v21-content-") as temporary:
            root = Path(temporary) / "pack"
            root.mkdir()
            make_v21(root, conventional_layout=False)
            report = validate(DirectoryView(root))
            self.assertEqual(report["status"], "pass", report)

    def test_obsolete_audit_fields_and_missing_audit_files_are_ignored(self) -> None:
        with tempfile.TemporaryDirectory(prefix="frontmind-v21-audit-") as temporary:
            root = Path(temporary) / "pack"
            root.mkdir()
            make_v21(root)
            pack_path = root / "reference_pack.json"
            pack = json.loads(pack_path.read_text(encoding="utf-8"))
            pack["approval"] = {"path": "approval/missing.json", "reviewer": "obsolete"}
            pack["files"] = [{"path": "missing.txt", "sha256": "0" * 64, "role": "obsolete"}]
            write_json(pack_path, pack)
            report = validate(DirectoryView(root))
            self.assertEqual(report["status"], "pass", report)

    def test_optional_writing_asset_failure_is_a_warning_not_a_pack_failure(self) -> None:
        with tempfile.TemporaryDirectory(prefix="frontmind-v22-writing-") as temporary:
            root = Path(temporary) / "pack"
            root.mkdir()
            make_v22(root)
            pack_path = root / "reference_pack.json"
            pack = json.loads(pack_path.read_text(encoding="utf-8"))
            pack["writing_assets"]["voice_path"] = "writing/missing_voice.json"
            write_json(pack_path, pack)
            report = validate(DirectoryView(root))
            self.assertEqual(report["status"], "pass", report)
            self.assertTrue(any("optional writing asset" in warning for warning in report["warnings"]))

    def test_missing_v22_core_registry_fails_because_content_cannot_be_read(self) -> None:
        with tempfile.TemporaryDirectory(prefix="frontmind-v22-missing-") as temporary:
            root = Path(temporary) / "pack"
            root.mkdir()
            make_v22(root)
            (root / "registries/claim_registry.json").unlink()
            report = validate(DirectoryView(root))
            self.assertEqual(report["status"], "fail")
            self.assertIn("required content file is absent", "\n".join(report["errors"]))

    def test_v21_without_any_readable_content_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="frontmind-v21-empty-") as temporary:
            root = Path(temporary) / "pack"
            root.mkdir()
            write_json(
                root / "reference_pack.json",
                {
                    "schema_version": "2.1.0",
                    "profile": "frontmind-content-reference-pack-v2.1",
                    "pack_id": "rp_empty_v21",
                    "brand": {"canonical_name": "匿名示例企业", "aliases": []},
                    "registries": {},
                },
            )
            report = validate(DirectoryView(root))
            self.assertEqual(report["status"], "fail")
            self.assertIn("no readable content asset", "\n".join(report["errors"]))

    def test_unsafe_zip_path_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="frontmind-v22-zip-slip-") as temporary:
            archive_path = Path(temporary) / "unsafe.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("../escape.txt", "no")
            with self.assertRaisesRegex(ValueError, "unsafe ZIP path"):
                ZipView(archive_path)

    def test_unknown_pack_identity_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="frontmind-v22-identity-") as temporary:
            root = Path(temporary) / "pack"
            root.mkdir()
            make_v22(root)
            pack_path = root / "reference_pack.json"
            pack = json.loads(pack_path.read_text(encoding="utf-8"))
            pack["schema_version"] = "1.0.0"
            pack["profile"] = "obsolete"
            write_json(pack_path, pack)
            report = validate(DirectoryView(root))
            self.assertEqual(report["status"], "fail")
            self.assertIn("unsupported Reference Pack identity", "\n".join(report["errors"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
