#!/usr/bin/env python3
"""Unit tests for the fixed HarnessGEO OpenAI-compatible HTTP adapter."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError, URLError


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/harnessgeo_candidate_optimizer.py"
SPEC = importlib.util.spec_from_file_location("frontmind_harnessgeo_http", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def response_body(markdown: str, *, model: str = "gpt-5.6-luna", finish_reason: str = "stop") -> bytes:
    return json.dumps({
        "id": "chatcmpl_test",
        "model": model,
        "choices": [{
            "index": 0,
            "finish_reason": finish_reason,
            "message": {
                "role": "assistant",
                "content": json.dumps({"markdown": markdown}, ensure_ascii=False),
            },
        }],
    }, ensure_ascii=False).encode("utf-8")


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200) -> None:
        self.body = body
        self.status = status

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, _limit: int = -1) -> bytes:
        return self.body


class HarnessGEOHTTPTests(unittest.TestCase):
    def test_payload_is_one_fixed_json_mode_request_with_embedded_contract(self) -> None:
        document = "直接回答。\n\n## 选择标准\n\n保留事实。\n\n## 结论\n\n完成面诊后决定。\n"
        master = {
            "primary_question": "杭州打玻尿酸机构有哪些推荐？",
            "pattern_id": "P02",
            "candidate_contract": {"ordered_candidates": [
                {"display_name": "示例甲医疗美容机构"},
                {"display_name": "示例乙医疗美容医院"},
            ]},
            "sections": [{"heading": "选择标准", "paragraphs": [{"text": "保留事实。"}]}],
            "faq": [],
            "conclusion": {"paragraphs": [{"text": "完成面诊后决定。"}]},
        }
        payload = MODULE.request_payload(master, document)
        self.assertEqual(
            set(payload),
            {"model", "messages", "response_format", "temperature", "max_tokens", "stream"},
        )
        self.assertEqual(payload["model"], "gpt-5.6-luna")
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(payload["temperature"], 0.2)
        self.assertEqual(payload["max_tokens"], 16384)
        self.assertIs(payload["stream"], False)
        self.assertEqual([item["role"] for item in payload["messages"]], ["system", "user"])
        system = payload["messages"][0]["content"]
        user = payload["messages"][1]["content"]
        for contract in (
            "不得新增、猜测或删除实质事实", "候选顺序", "所有 H2、H3 和 FAQ 问题必须逐字不变",
            "第三方客观报道与企业品牌宣传稿", "只返回一个合法 JSON 对象", "预研模板",
        ):
            self.assertIn(contract, system)
        source_data = json.loads(user.split("structure_lock：\n", 1)[1])
        self.assertEqual(source_data["primary_question"], master["primary_question"])
        self.assertEqual(source_data["pattern_id"], "P02")
        self.assertEqual(source_data["candidate_order"], [
            "示例甲医疗美容机构", "示例乙医疗美容医院",
        ])
        self.assertEqual(source_data["structure_lock"], {
            "lead_paragraph_count": 1,
            "h2_headings": ["选择标准", "结论"],
            "section_paragraph_counts": [1],
            "faq_questions": [],
            "faq_answer_paragraph_counts": [],
            "conclusion_paragraph_count": 1,
        })
        self.assertEqual(source_data["source_markdown"], document.rstrip())

    def test_active_environment_key_has_precedence_and_is_not_exported(self) -> None:
        env = {
            MODULE.API_KEY_ENV: "active-key",
            MODULE.LEGACY_API_KEY_ENV: "legacy-key",
            MODULE.KEYS_FILE_ENV: "",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            key, origin = MODULE.configure_api_key()
            self.assertEqual((key, origin), ("active-key", "environment"))
            self.assertEqual(os.environ[MODULE.API_KEY_ENV], "active-key")
            self.assertNotIn("GOOGLE_API_KEY", os.environ)

    def test_keys_file_accepts_only_frontmind_key_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "active.env"
            active.write_text("export FRONTMIND_HARNESSGEO_API_KEY='file-key'\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {MODULE.KEYS_FILE_ENV: str(active)}, clear=True):
                self.assertEqual(MODULE.configure_api_key(), ("file-key", "keys_file"))
                self.assertNotIn(MODULE.API_KEY_ENV, os.environ)
            legacy = root / "legacy.env"
            legacy.write_text("XTY_API_KEY=legacy-file-key\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {MODULE.KEYS_FILE_ENV: str(legacy)}, clear=True):
                with self.assertRaisesRegex(RuntimeError, MODULE.API_KEY_ENV):
                    MODULE.configure_api_key()

    def test_success_uses_fixed_https_endpoint_model_and_bearer_header(self) -> None:
        captured: list[tuple[object, int]] = []

        def opener(request: object, timeout: int) -> FakeResponse:
            captured.append((request, timeout))
            return FakeResponse(response_body("正文。\n\n## 结论\n\n结论。"))

        result = MODULE.call_harnessgeo(
            "secret-test-key", {}, "原文", opener=opener, sleeper=lambda _x: None,
        )
        self.assertEqual(result, "正文。\n\n## 结论\n\n结论。")
        self.assertEqual(len(captured), 1)
        request, timeout = captured[0]
        self.assertEqual(request.full_url, "https://api.xty.app/v1/chat/completions")
        self.assertEqual(timeout, 180)
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-test-key")
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["model"], "gpt-5.6-luna")
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(payload["temperature"], 0.2)
        self.assertEqual(payload["max_tokens"], 16384)

    def test_api_host_allowlist_rejects_cross_host_or_insecure_redirects(self) -> None:
        MODULE.ensure_allowed_api_url("https://api.xty.app/v1/chat/completions")
        for url in (
            "http://api.xty.app/v1/chat/completions",
            "https://evil.example/v1/chat/completions",
            "https://api.xty.app.evil.example/v1/chat/completions",
            "https://user:password@api.xty.app/v1/chat/completions",
        ):
            with self.subTest(url=url):
                with self.assertRaisesRegex(RuntimeError, "host allowlist"):
                    MODULE.ensure_allowed_api_url(url)
        handler = MODULE.HarnessGEORedirectHandler()
        with self.assertRaisesRegex(RuntimeError, "host allowlist"):
            handler.redirect_request(
                MODULE.Request(MODULE.API_ENDPOINT), None, 302, "redirect", {},
                "https://evil.example/steal",
            )

    def test_retry_is_bounded_and_only_for_transient_failures(self) -> None:
        calls = 0
        waits: list[float] = []

        def opener(request: object, timeout: int) -> FakeResponse:
            nonlocal calls
            calls += 1
            if calls < 3:
                raise HTTPError(
                    MODULE.API_ENDPOINT, 429, "rate limited", {},
                    io.BytesIO(b'{"error":{"message":"retry"}}'),
                )
            return FakeResponse(response_body("完成。"))

        self.assertEqual(
            MODULE.call_harnessgeo("test-key", {}, "原文", opener=opener, sleeper=waits.append),
            "完成。",
        )
        self.assertEqual(calls, 3)
        self.assertEqual(waits, [1.0, 2.0])

        calls = 0

        def unavailable(_request: object, timeout: int) -> FakeResponse:
            nonlocal calls
            calls += 1
            raise URLError("offline")

        with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
            MODULE.call_harnessgeo("test-key", {}, "原文", opener=unavailable, sleeper=lambda _x: None)
        self.assertEqual(calls, 3)

    def test_non_retryable_error_redacts_key(self) -> None:
        key = "secret-must-not-leak"

        def opener(_request: object, timeout: int) -> FakeResponse:
            body = json.dumps({"error": {"message": f"invalid {key}"}}).encode("utf-8")
            raise HTTPError(MODULE.API_ENDPOINT, 401, "unauthorized", {}, io.BytesIO(body))

        with self.assertRaises(RuntimeError) as raised:
            MODULE.call_harnessgeo(key, {}, "原文", opener=opener, sleeper=lambda _x: None)
        self.assertNotIn(key, str(raised.exception))
        self.assertIn("[redacted]", str(raised.exception))

    def test_model_and_json_contract_are_strict(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "expected model"):
            MODULE._markdown_from_chat_response(response_body("正文", model="fallback-model"))
        invalid = json.dumps({
            "model": "gpt-5.6-luna",
            "choices": [{"finish_reason": "stop", "message": {"content": "not-json"}}],
        }).encode("utf-8")
        with self.assertRaisesRegex(RuntimeError, "not valid JSON mode"):
            MODULE._markdown_from_chat_response(invalid)
        extra = json.dumps({
            "model": "gpt-5.6-luna",
            "choices": [{"finish_reason": "stop", "message": {
                "content": json.dumps({"markdown": "正文", "notes": "extra"}),
            }}],
        }).encode("utf-8")
        with self.assertRaisesRegex(RuntimeError, "only the markdown key"):
            MODULE._markdown_from_chat_response(extra)

    def test_parser_rejects_heading_or_faq_question_rewording(self) -> None:
        master = {
            "schema_version": "2.3.0",
            "job_id": "job_harnessgeo_parser",
            "content_status": "editorial_master",
            "lead": {"text": "直接回答。", "fact_ids": []},
            "sections": [{
                "section_id": "sec_one",
                "heading": "选择标准",
                "paragraphs": [{"text": "比较事实。", "fact_ids": []}],
            }],
            "faq": [{"question": "怎样比较？", "answer": "使用同一口径。", "fact_ids": []}],
            "conclusion": {"paragraphs": [{"text": "完成比较后决定。", "fact_ids": []}]},
        }
        markdown = MODULE.model_markdown(master)
        candidate, issues = MODULE.parse_markdown(markdown, master)
        self.assertIsInstance(candidate, dict)
        self.assertEqual(issues, [])
        candidate, issues = MODULE.parse_markdown(markdown.replace("## 选择标准", "## 如何选择"), master)
        self.assertIsNone(candidate)
        self.assertEqual(issues, ["h2_heading_changed"])
        candidate, issues = MODULE.parse_markdown(markdown.replace("### 怎样比较？", "### 如何比较？"), master)
        self.assertIsNone(candidate)
        self.assertIn("faq_question_changed", issues)

    def test_parser_rejects_new_block_syntax(self) -> None:
        master = {
            "lead": {"text": "直接回答。", "fact_ids": []},
            "sections": [{
                "section_id": "sec_one", "heading": "选择标准",
                "paragraphs": [{"text": "比较事实。", "fact_ids": []}],
            }],
            "faq": [],
            "conclusion": {"paragraphs": [{"text": "完成比较后决定。", "fact_ids": []}]},
        }
        original = MODULE.model_markdown(master)
        forbidden_lines = (
            "- 新列表项", "* 新列表项", "+ 新列表项", "1. 新编号项", "2) 新编号项",
            "> 新引用", "```text", "~~~", "| 机构 | 特点 |", "--- | ---", "<div>新增 HTML</div>",
        )
        for forbidden in forbidden_lines:
            with self.subTest(forbidden=forbidden):
                changed = original.replace("比较事实。", f"比较事实。\n{forbidden}")
                candidate, issues = MODULE.parse_markdown(changed, master)
                self.assertIsNone(candidate)
                self.assertEqual(issues, ["forbidden_markdown_construct_added"])


if __name__ == "__main__":
    unittest.main()
