#!/usr/bin/env python3
"""Deployment preflight tests for the v2.3 XTY-hosted HarnessGEO runtime."""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "frontmind_runtime_dependencies_v23", ROOT / "scripts/check_runtime_dependencies.py"
)
assert SPEC and SPEC.loader
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class FakeResponse:
    status = 200

    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class RuntimeDependenciesV23Tests(unittest.TestCase):
    def test_formal_environment_key_is_recognized_without_exposing_it(self) -> None:
        result = RUNTIME.resolve_harnessgeo_api_key(
            {RUNTIME.FORMAL_KEY_ENV: "fake-runtime-key"}
        )
        self.assertTrue(result["available"])
        self.assertEqual(result["source"], "environment")

    def test_provider_native_key_is_process_compatibility_only(self) -> None:
        result = RUNTIME.resolve_harnessgeo_api_key(
            {RUNTIME.COMPATIBILITY_KEY_ENV: "fake-xty-key"}
        )
        self.assertTrue(result["available"])
        self.assertEqual(result["source"], "xty_environment_compatibility")

    def test_keys_file_accepts_only_formal_harnessgeo_name(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            keys = Path(temporary) / "keys.env"
            keys.write_text(
                "export FRONTMIND_HARNESSGEO_API_KEY='fake-file-key'\n",
                encoding="utf-8",
            )
            result = RUNTIME.resolve_harnessgeo_api_key({RUNTIME.KEYS_FILE_ENV: str(keys)})
            self.assertTrue(result["available"])
            self.assertEqual(result["source"], "keys_file")
            keys.write_text("GOOGLE_API_KEY=obsolete\nXTY_API_KEY=not-accepted-here\n", encoding="utf-8")
            rejected = RUNTIME.resolve_harnessgeo_api_key({RUNTIME.KEYS_FILE_ENV: str(keys)})
            self.assertFalse(rejected["available"])

    def test_missing_key_fails_closed_before_http(self) -> None:
        called = False

        def opener(*_args: object, **_kwargs: object) -> FakeResponse:
            nonlocal called
            called = True
            return FakeResponse({})

        with patch.dict(os.environ, {
            RUNTIME.FORMAL_KEY_ENV: "", RUNTIME.COMPATIBILITY_KEY_ENV: "",
            RUNTIME.KEYS_FILE_ENV: "",
        }, clear=False):
            result = RUNTIME.probe_harnessgeo(opener)
        self.assertFalse(result["available"])
        self.assertIn(RUNTIME.FORMAL_KEY_ENV, str(result["error"]))
        self.assertFalse(called)

    def test_fixed_http_contract_is_live_probe_shape_and_secret_safe(self) -> None:
        observed: dict[str, object] = {}

        def opener(request: object, timeout: int) -> FakeResponse:
            observed["url"] = getattr(request, "full_url")
            observed["headers"] = dict(getattr(request, "headers"))
            observed["payload"] = json.loads(getattr(request, "data").decode("utf-8"))
            observed["timeout"] = timeout
            return FakeResponse({
                "model": "gpt-5.6-luna",
                "choices": [{"message": {"content": "OK"}}],
            })

        environment = {
            RUNTIME.FORMAL_KEY_ENV: "fake-runtime-key",
            "GOOGLE_API_KEY": "obsolete-google-key",
            "FRONTMIND_HARNESSGEO_PYTHON": "/missing/local/python",
            "FRONTMIND_HARNESSGEO_ROOT": "/missing/local/repository",
            "FRONTMIND_HARNESSGEO_MODEL": "caller-must-not-override",
            "FRONTMIND_HARNESSGEO_ENDPOINT": "https://caller.invalid/v1",
            "FRONTMIND_AUTOGEO_MODEL_PATH": "/must/not/be-used",
        }
        with patch.dict(os.environ, environment, clear=False):
            result = RUNTIME.probe_harnessgeo(opener)
        self.assertTrue(result["available"], result)
        self.assertEqual(result["adapter"], "xty_openai_chat_completions")
        self.assertEqual(result["endpoint"], "https://api.xty.app/v1/chat/completions")
        self.assertEqual(result["model"], "gpt-5.6-luna")
        self.assertEqual(observed["url"], result["endpoint"])
        self.assertEqual(observed["timeout"], 30)
        headers = observed["headers"]
        assert isinstance(headers, dict)
        self.assertEqual(headers["Authorization"], "Bearer fake-runtime-key")
        self.assertEqual(headers["Content-type"], "application/json")
        payload = observed["payload"]
        assert isinstance(payload, dict)
        self.assertEqual(payload["model"], "gpt-5.6-luna")
        self.assertEqual(payload["stream"], False)
        self.assertEqual([item["role"] for item in payload["messages"]], ["system", "user"])
        self.assertNotIn("fake-runtime-key", str(result))
        self.assertNotIn("obsolete-google-key", str(result))

    def test_empty_chat_completion_fails_contract(self) -> None:
        def opener(*_args: object, **_kwargs: object) -> FakeResponse:
            return FakeResponse({
                "model": "gpt-5.6-luna",
                "choices": [{"message": {"content": ""}}],
            })

        with patch.dict(os.environ, {RUNTIME.FORMAL_KEY_ENV: "fake-runtime-key"}, clear=False):
            result = RUNTIME.probe_harnessgeo(opener)
        self.assertFalse(result["available"])
        self.assertIn("empty", str(result["error"]))

    def test_response_model_cannot_silently_fallback(self) -> None:
        def opener(*_args: object, **_kwargs: object) -> FakeResponse:
            return FakeResponse({
                "model": "fallback-model",
                "choices": [{"message": {"content": "OK"}}],
            })

        with patch.dict(os.environ, {RUNTIME.FORMAL_KEY_ENV: "fake-runtime-key"}, clear=False):
            result = RUNTIME.probe_harnessgeo(opener)
        self.assertFalse(result["available"])
        self.assertIn("model", str(result["error"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
