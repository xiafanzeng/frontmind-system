#!/usr/bin/env python3
"""Check the complete v2.3 production runtime before starting a job."""

from __future__ import annotations

import importlib
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from pathlib import Path
from typing import Any, Callable, Mapping


CORE = {
    "openpyxl (monitoring and citation workbooks)": "openpyxl",
    "Pillow (visual production and DOCX images)": "PIL",
    "python-docx (high-fidelity DOCX)": "docx",
    "pypdf (complete PDF research)": "pypdf",
}
OPTIONAL = {"CairoSVG (SVG conversion when required)": "cairosvg"}
KEYS_FILE_ENV = "FRONTMIND_HARNESSGEO_KEYS_FILE"
FORMAL_KEY_ENV = "FRONTMIND_HARNESSGEO_API_KEY"
COMPATIBILITY_KEY_ENV = "XTY_API_KEY"
HARNESSGEO_ENDPOINT = "https://api.xty.app/v1/chat/completions"
HARNESSGEO_MODEL = "gpt-5.6-luna"


def probe(module: str) -> dict[str, object]:
    try:
        imported = importlib.import_module(module)
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {str(exc)[:240]}"}
    return {"available": True, "error": None, "module": getattr(imported, "__name__", module)}


def key_from_file(path: Path) -> str | None:
    if path.is_symlink() or not path.is_file():
        return None
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        name, separator, value = line.partition("=")
        if separator and name.strip() == FORMAL_KEY_ENV:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            return value.strip() or None
    return None


def resolve_harnessgeo_api_key(environment: Mapping[str, str]) -> dict[str, object]:
    if environment.get(FORMAL_KEY_ENV, "").strip():
        return {
            "available": True, "source": "environment", "key": environment[FORMAL_KEY_ENV].strip(),
            "error": None,
        }
    if environment.get(COMPATIBILITY_KEY_ENV, "").strip():
        return {
            "available": True, "source": "xty_environment_compatibility",
            "key": environment[COMPATIBILITY_KEY_ENV].strip(), "error": None,
        }
    configured = environment.get(KEYS_FILE_ENV, "").strip()
    if not configured:
        return {
            "available": False, "source": None, "key": None,
            "error": f"{FORMAL_KEY_ENV} or {KEYS_FILE_ENV} is required",
        }
    path = Path(configured).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).absolute()
    key = key_from_file(path)
    if not key:
        return {
            "available": False, "source": "keys_file", "key": None,
            "error": f"{KEYS_FILE_ENV} is unreadable or has no {FORMAL_KEY_ENV}",
        }
    return {"available": True, "source": "keys_file", "key": key, "error": None}


def harnessgeo_probe_payload() -> dict[str, object]:
    """Small live request that validates the exact production HTTP contract."""
    return {
        "model": HARNESSGEO_MODEL,
        "messages": [
            {
                "role": "system",
                "content": "You are a HarnessGEO deployment probe. Reply with exactly OK and nothing else.",
            },
            {"role": "user", "content": "Check the HTTPS chat-completions connection."},
        ],
        "stream": False,
    }


def probe_harnessgeo(
    opener: Callable[..., Any] = urlopen,
) -> dict[str, object]:
    """Make a minimal live request to the fixed XTY-hosted HarnessGEO API."""
    key_result = resolve_harnessgeo_api_key(os.environ)
    if not key_result["available"]:
        return {
            "available": False, "error": key_result["error"], "key_source": key_result["source"],
            "endpoint": HARNESSGEO_ENDPOINT, "model": HARNESSGEO_MODEL,
        }
    request = Request(
        HARNESSGEO_ENDPOINT,
        data=json.dumps(harnessgeo_probe_payload(), ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key_result['key']}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "FrontMind-HarnessGEO/2.3",
        },
        method="POST",
    )
    try:
        with opener(request, timeout=30) as response:
            status = int(getattr(response, "status", 200))
            raw = response.read()
    except HTTPError as exc:
        return {
            "available": False, "error": f"HTTP {exc.code}", "key_source": key_result["source"],
            "endpoint": HARNESSGEO_ENDPOINT, "model": HARNESSGEO_MODEL,
        }
    except (URLError, OSError, TimeoutError) as exc:
        return {
            "available": False, "error": f"{type(exc).__name__}: {str(exc)[:240]}",
            "key_source": key_result["source"], "endpoint": HARNESSGEO_ENDPOINT,
            "model": HARNESSGEO_MODEL,
        }
    try:
        payload = json.loads(raw.decode("utf-8"))
        content = payload["choices"][0]["message"]["content"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
        return {
            "available": False, "error": f"invalid chat-completions response: {type(exc).__name__}",
            "key_source": key_result["source"], "endpoint": HARNESSGEO_ENDPOINT,
            "model": HARNESSGEO_MODEL, "http_status": status,
        }
    response_model = payload.get("model") if isinstance(payload, dict) else None
    if response_model != HARNESSGEO_MODEL:
        return {
            "available": False, "error": "chat-completions response model does not match fixed model",
            "key_source": key_result["source"], "endpoint": HARNESSGEO_ENDPOINT,
            "model": HARNESSGEO_MODEL, "http_status": status,
        }
    if not isinstance(content, str) or not content.strip():
        return {
            "available": False, "error": "chat-completions response content is empty",
            "key_source": key_result["source"], "endpoint": HARNESSGEO_ENDPOINT,
            "model": HARNESSGEO_MODEL, "http_status": status,
        }
    return {
        "available": True, "adapter": "xty_openai_chat_completions", "error": None,
        "key_source": key_result["source"], "endpoint": HARNESSGEO_ENDPOINT,
        "model": HARNESSGEO_MODEL, "http_status": status,
    }


def main() -> int:
    core = {name: probe(module) for name, module in CORE.items()}
    harnessgeo = probe_harnessgeo()
    required_missing = [name for name, result in core.items() if not result["available"]]
    if not harnessgeo["available"]:
        required_missing.append("HarnessGEO deployment adapter")
    if sys.version_info < (3, 10):
        required_missing.append("Python>=3.10")
    payload = {
        "python": sys.version.split()[0], "python_supported": sys.version_info >= (3, 10),
        "core": core, "harnessgeo": harnessgeo,
        "optional": {name: probe(module) for name, module in OPTIONAL.items()},
        "status": "pass" if not required_missing else "fail", "required_missing": required_missing,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if not required_missing else 1


if __name__ == "__main__":
    raise SystemExit(main())
