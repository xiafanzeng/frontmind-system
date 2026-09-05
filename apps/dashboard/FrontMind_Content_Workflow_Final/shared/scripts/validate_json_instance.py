#!/usr/bin/env python3
"""Validate a JSON instance against FrontMind's active JSON Schema subset.

This module intentionally uses only the Python standard library.  It implements
the Draft 2020-12 keywords used by this workflow rather than pretending to be a
complete JSON Schema implementation.  Local ``$ref`` values are resolved from
disk inside the directory that contains the entry schema; network and absolute
references are rejected.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlsplit


MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_EVALUATION_DEPTH = 512
_SCHEMA_NOT_SUPPLIED = object()
TYPE_NAMES = {"null", "boolean", "object", "array", "number", "integer", "string"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATE_TIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$"
)
URI_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*$")
BAD_PERCENT_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class ValidationRuntimeError(Exception):
    """Base class for schema loading, definition, and reference failures."""


class JsonLoadError(ValidationRuntimeError):
    """A schema or instance is not strict JSON."""


class SchemaDefinitionError(ValidationRuntimeError):
    """A supported keyword has an invalid schema value."""


class ReferenceResolutionError(ValidationRuntimeError):
    """A local $ref cannot be resolved safely."""


@dataclass(frozen=True)
class ValidationError:
    """One machine-readable instance validation failure."""

    keyword: str
    message: str
    instance_path: str
    json_path: str
    schema_path: str
    schema_uri: str
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        if not value["details"]:
            value.pop("details")
        return value


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is forbidden: {value}")


def _reject_duplicate_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate object key: {key!r}")
        result[key] = value
    return result


def load_json(path: Path) -> Any:
    """Load strict UTF-8 JSON with duplicate-key and NaN/Infinity rejection."""

    resolved = path.resolve()
    try:
        size = resolved.stat().st_size
    except OSError as exc:
        raise JsonLoadError(f"cannot read {resolved}: {exc}") from exc
    if size > MAX_JSON_BYTES:
        raise JsonLoadError(f"JSON file exceeds {MAX_JSON_BYTES} bytes: {resolved}")
    try:
        text = resolved.read_text(encoding="utf-8")
        return json.loads(
            text,
            object_pairs_hook=_reject_duplicate_object,
            parse_constant=_reject_constant,
        )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise JsonLoadError(f"invalid JSON in {resolved}: {exc}") from exc


def _escape_pointer(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def _join_pointer(pointer: str, token: str | int) -> str:
    return f"{pointer}/{_escape_pointer(str(token))}"


def _json_path(tokens: Iterable[str | int]) -> str:
    rendered = "$"
    for token in tokens:
        if isinstance(token, int):
            rendered += f"[{token}]"
        elif re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token):
            rendered += f".{token}"
        else:
            rendered += "[" + json.dumps(token, ensure_ascii=False) + "]"
    return rendered


def _json_equal(left: Any, right: Any) -> bool:
    """JSON equality without Python's True == 1 type collapse."""

    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if _is_number(left) or _is_number(right):
        return _is_number(left) and _is_number(right) and left == right
    if isinstance(left, str) or isinstance(right, str):
        return isinstance(left, str) and isinstance(right, str) and left == right
    if isinstance(left, list) or isinstance(right, list):
        return (
            isinstance(left, list)
            and isinstance(right, list)
            and len(left) == len(right)
            and all(_json_equal(a, b) for a, b in zip(left, right))
        )
    if isinstance(left, dict) or isinstance(right, dict):
        return (
            isinstance(left, dict)
            and isinstance(right, dict)
            and left.keys() == right.keys()
            and all(_json_equal(left[key], right[key]) for key in left)
        )
    return type(left) is type(right) and left == right


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_integer(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value) and value.is_integer()


def _matches_type(instance: Any, expected: str) -> bool:
    return {
        "null": instance is None,
        "boolean": isinstance(instance, bool),
        "object": isinstance(instance, dict),
        "array": isinstance(instance, list),
        "number": _is_number(instance),
        "integer": _is_integer(instance),
        "string": isinstance(instance, str),
    }[expected]


def _valid_date(value: str) -> bool:
    if not DATE_RE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _valid_date_time(value: str) -> bool:
    if not DATE_TIME_RE.fullmatch(value):
        return False
    normalized = value.replace("t", "T").replace("z", "Z")
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def _valid_uri(value: str) -> bool:
    if not value or any(ord(char) < 0x20 or char.isspace() for char in value):
        return False
    if "\\" in value or BAD_PERCENT_RE.search(value):
        return False
    try:
        value.encode("ascii")
        parsed = urlsplit(value)
        if not parsed.scheme or not URI_SCHEME_RE.fullmatch(parsed.scheme):
            return False
        if parsed.scheme.lower() in {"http", "https"}:
            if not parsed.netloc or parsed.hostname is None:
                return False
            _ = parsed.port
    except (UnicodeEncodeError, ValueError):
        return False
    return True


FORMAT_CHECKERS = {
    "date": _valid_date,
    "date-time": _valid_date_time,
    "uri": _valid_uri,
}


class JsonSchemaValidator:
    """Validate instances using the exact Draft 2020-12 subset used here."""

    def __init__(self, schema_path: Path, schema: Any = _SCHEMA_NOT_SUPPLIED):
        self.entry_path = schema_path.resolve()
        self.reference_root = self.entry_path.parent.resolve()
        self.documents: dict[Path, Any] = {
            self.entry_path: load_json(self.entry_path) if schema is _SCHEMA_NOT_SUPPLIED else schema
        }
        if not isinstance(self.documents[self.entry_path], (dict, bool)):
            raise SchemaDefinitionError("schema root must be an object or boolean")

    def validate(self, instance: Any) -> list[ValidationError]:
        errors: list[ValidationError] = []
        self._validate(
            instance=instance,
            schema=self.documents[self.entry_path],
            instance_pointer="",
            instance_tokens=(),
            schema_document=self.entry_path,
            schema_pointer="",
            evaluation_stack=set(),
            errors=errors,
        )
        return errors

    def validate_path(self, instance_path: Path) -> list[ValidationError]:
        return self.validate(load_json(instance_path))

    def _error(
        self,
        errors: list[ValidationError],
        *,
        keyword: str,
        message: str,
        instance_pointer: str,
        instance_tokens: tuple[str | int, ...],
        schema_document: Path,
        schema_pointer: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        errors.append(
            ValidationError(
                keyword=keyword,
                message=message,
                instance_path=instance_pointer or "#",
                json_path=_json_path(instance_tokens),
                schema_path=(schema_pointer or "#"),
                schema_uri=f"{schema_document.as_uri()}#{schema_pointer}",
                details=details or {},
            )
        )

    def _resolve_pointer(self, document: Any, fragment: str, ref: str) -> tuple[Any, str]:
        decoded = unquote(fragment)
        if decoded in ("", "#"):
            return document, ""
        if not decoded.startswith("/"):
            raise ReferenceResolutionError(f"only JSON Pointer fragments are supported in $ref: {ref!r}")
        current = document
        canonical = ""
        for raw_token in decoded[1:].split("/"):
            token = raw_token.replace("~1", "/").replace("~0", "~")
            canonical = _join_pointer(canonical, token)
            if isinstance(current, dict) and token in current:
                current = current[token]
            elif isinstance(current, list) and token.isdigit() and int(token) < len(current):
                current = current[int(token)]
            else:
                raise ReferenceResolutionError(f"missing JSON Pointer {decoded!r} in $ref {ref!r}")
        if not isinstance(current, (dict, bool)):
            raise ReferenceResolutionError(f"$ref target is not a schema object or boolean: {ref!r}")
        return current, canonical

    def _resolve_ref(self, ref: str, current_document: Path) -> tuple[Any, Path, str]:
        if not isinstance(ref, str) or not ref:
            raise SchemaDefinitionError("$ref must be a non-empty string")
        file_part, separator, fragment = ref.partition("#")
        if file_part:
            parsed = urlsplit(file_part)
            if parsed.scheme or parsed.netloc or parsed.query:
                raise ReferenceResolutionError(f"network, URI, and query $ref values are forbidden: {ref!r}")
            decoded_path = unquote(parsed.path)
            candidate = Path(decoded_path)
            if candidate.is_absolute() or "\\" in decoded_path or "\x00" in decoded_path:
                raise ReferenceResolutionError(f"absolute or malformed $ref path is forbidden: {ref!r}")
            target = (current_document.parent / candidate).resolve()
            if not target.is_relative_to(self.reference_root):
                raise ReferenceResolutionError(f"$ref escapes schema directory: {ref!r}")
        else:
            target = current_document

        if target not in self.documents:
            document = load_json(target)
            if not isinstance(document, (dict, bool)):
                raise ReferenceResolutionError(f"referenced schema root must be an object or boolean: {target}")
            self.documents[target] = document
        target_schema, pointer = self._resolve_pointer(self.documents[target], fragment if separator else "", ref)
        return target_schema, target, pointer

    def _branch_errors(
        self,
        instance: Any,
        schema: Any,
        *,
        instance_pointer: str,
        instance_tokens: tuple[str | int, ...],
        schema_document: Path,
        schema_pointer: str,
        evaluation_stack: set[tuple[Path, str, str]],
    ) -> list[ValidationError]:
        branch: list[ValidationError] = []
        self._validate(
            instance=instance,
            schema=schema,
            instance_pointer=instance_pointer,
            instance_tokens=instance_tokens,
            schema_document=schema_document,
            schema_pointer=schema_pointer,
            evaluation_stack=set(evaluation_stack),
            errors=branch,
        )
        return branch

    def _validate(
        self,
        *,
        instance: Any,
        schema: Any,
        instance_pointer: str,
        instance_tokens: tuple[str | int, ...],
        schema_document: Path,
        schema_pointer: str,
        evaluation_stack: set[tuple[Path, str, str]],
        errors: list[ValidationError],
    ) -> None:
        if schema is True:
            return
        if schema is False:
            self._error(
                errors,
                keyword="false_schema",
                message="instance is rejected by a false schema",
                instance_pointer=instance_pointer,
                instance_tokens=instance_tokens,
                schema_document=schema_document,
                schema_pointer=schema_pointer,
            )
            return
        if not isinstance(schema, dict):
            raise SchemaDefinitionError(f"schema at {schema_document}#{schema_pointer} is not an object or boolean")

        evaluation_key = (schema_document, schema_pointer, instance_pointer)
        if evaluation_key in evaluation_stack:
            return
        if len(evaluation_stack) >= MAX_EVALUATION_DEPTH:
            raise ReferenceResolutionError(f"schema evaluation exceeds {MAX_EVALUATION_DEPTH} nested locations")
        evaluation_stack.add(evaluation_key)
        try:
            self._validate_active(
                instance=instance,
                schema=schema,
                instance_pointer=instance_pointer,
                instance_tokens=instance_tokens,
                schema_document=schema_document,
                schema_pointer=schema_pointer,
                evaluation_stack=evaluation_stack,
                errors=errors,
            )
        finally:
            evaluation_stack.remove(evaluation_key)

    def _validate_active(
        self,
        *,
        instance: Any,
        schema: dict[str, Any],
        instance_pointer: str,
        instance_tokens: tuple[str | int, ...],
        schema_document: Path,
        schema_pointer: str,
        evaluation_stack: set[tuple[Path, str, str]],
        errors: list[ValidationError],
    ) -> None:
        context = {
            "instance_pointer": instance_pointer,
            "instance_tokens": instance_tokens,
            "schema_document": schema_document,
        }

        if "$ref" in schema:
            target_schema, target_document, target_pointer = self._resolve_ref(schema["$ref"], schema_document)
            self._validate(
                instance=instance,
                schema=target_schema,
                schema_document=target_document,
                schema_pointer=target_pointer,
                evaluation_stack=evaluation_stack,
                errors=errors,
                **{key: context[key] for key in ("instance_pointer", "instance_tokens")},
            )

        if "type" in schema:
            expected_raw = schema["type"]
            if isinstance(expected_raw, str):
                expected = [expected_raw]
            elif isinstance(expected_raw, list) and expected_raw and all(isinstance(item, str) for item in expected_raw):
                expected = expected_raw
            else:
                raise SchemaDefinitionError(f"type must be a string or non-empty string array at {schema_document}#{schema_pointer}")
            unknown = sorted(set(expected) - TYPE_NAMES)
            if unknown:
                raise SchemaDefinitionError(f"unsupported type names at {schema_document}#{schema_pointer}: {unknown}")
            if not any(_matches_type(instance, item) for item in expected):
                self._error(
                    errors,
                    keyword="type",
                    message=f"expected type {' or '.join(expected)}, found {type(instance).__name__}",
                    schema_pointer=_join_pointer(schema_pointer, "type"),
                    details={"expected": expected},
                    **context,
                )

        if "const" in schema and not _json_equal(instance, schema["const"]):
            self._error(
                errors,
                keyword="const",
                message=f"value must equal {schema['const']!r}",
                schema_pointer=_join_pointer(schema_pointer, "const"),
                details={"expected": schema["const"]},
                **context,
            )

        if "enum" in schema:
            choices = schema["enum"]
            if not isinstance(choices, list) or not choices:
                raise SchemaDefinitionError(f"enum must be a non-empty array at {schema_document}#{schema_pointer}")
            if not any(_json_equal(instance, candidate) for candidate in choices):
                self._error(
                    errors,
                    keyword="enum",
                    message="value is not one of the allowed enum values",
                    schema_pointer=_join_pointer(schema_pointer, "enum"),
                    details={"allowed": choices},
                    **context,
                )

        if isinstance(instance, dict):
            required = schema.get("required")
            if required is not None:
                if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
                    raise SchemaDefinitionError(f"required must be a string array at {schema_document}#{schema_pointer}")
                for key in required:
                    if key not in instance:
                        self._error(
                            errors,
                            keyword="required",
                            message=f"required property {key!r} is missing",
                            instance_pointer=_join_pointer(instance_pointer, key),
                            instance_tokens=instance_tokens + (key,),
                            schema_document=schema_document,
                            schema_pointer=_join_pointer(schema_pointer, "required"),
                            details={"missing": key},
                        )

            properties = schema.get("properties", {})
            if not isinstance(properties, dict):
                raise SchemaDefinitionError(f"properties must be an object at {schema_document}#{schema_pointer}")
            for key, child_schema in properties.items():
                if key in instance:
                    self._validate(
                        instance=instance[key],
                        schema=child_schema,
                        instance_pointer=_join_pointer(instance_pointer, key),
                        instance_tokens=instance_tokens + (key,),
                        schema_document=schema_document,
                        schema_pointer=_join_pointer(_join_pointer(schema_pointer, "properties"), key),
                        evaluation_stack=evaluation_stack,
                        errors=errors,
                    )

            if "additionalProperties" in schema:
                additional = schema["additionalProperties"]
                if not isinstance(additional, (dict, bool)):
                    raise SchemaDefinitionError(
                        f"additionalProperties must be an object or boolean at {schema_document}#{schema_pointer}"
                    )
                for key in sorted(instance.keys() - properties.keys()):
                    if additional is False:
                        self._error(
                            errors,
                            keyword="additionalProperties",
                            message=f"additional property {key!r} is not allowed",
                            instance_pointer=_join_pointer(instance_pointer, key),
                            instance_tokens=instance_tokens + (key,),
                            schema_document=schema_document,
                            schema_pointer=_join_pointer(schema_pointer, "additionalProperties"),
                            details={"property": key},
                        )
                    elif additional is not True:
                        self._validate(
                            instance=instance[key],
                            schema=additional,
                            instance_pointer=_join_pointer(instance_pointer, key),
                            instance_tokens=instance_tokens + (key,),
                            schema_document=schema_document,
                            schema_pointer=_join_pointer(schema_pointer, "additionalProperties"),
                            evaluation_stack=evaluation_stack,
                            errors=errors,
                        )

        if isinstance(instance, list):
            if "minItems" in schema:
                minimum = schema["minItems"]
                if not isinstance(minimum, int) or isinstance(minimum, bool) or minimum < 0:
                    raise SchemaDefinitionError(f"minItems must be a non-negative integer at {schema_document}#{schema_pointer}")
                if len(instance) < minimum:
                    self._error(
                        errors,
                        keyword="minItems",
                        message=f"array has {len(instance)} items; minimum is {minimum}",
                        schema_pointer=_join_pointer(schema_pointer, "minItems"),
                        details={"actual": len(instance), "minimum": minimum},
                        **context,
                    )
            if "maxItems" in schema:
                maximum = schema["maxItems"]
                if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 0:
                    raise SchemaDefinitionError(f"maxItems must be a non-negative integer at {schema_document}#{schema_pointer}")
                if len(instance) > maximum:
                    self._error(
                        errors,
                        keyword="maxItems",
                        message=f"array has {len(instance)} items; maximum is {maximum}",
                        schema_pointer=_join_pointer(schema_pointer, "maxItems"),
                        details={"actual": len(instance), "maximum": maximum},
                        **context,
                    )
            if schema.get("uniqueItems") is True:
                for index, item in enumerate(instance):
                    duplicate_of = next((prior for prior in range(index) if _json_equal(item, instance[prior])), None)
                    if duplicate_of is not None:
                        self._error(
                            errors,
                            keyword="uniqueItems",
                            message=f"array item duplicates item at index {duplicate_of}",
                            instance_pointer=_join_pointer(instance_pointer, index),
                            instance_tokens=instance_tokens + (index,),
                            schema_document=schema_document,
                            schema_pointer=_join_pointer(schema_pointer, "uniqueItems"),
                            details={"duplicate_of": duplicate_of},
                        )
            elif "uniqueItems" in schema and schema["uniqueItems"] is not False:
                raise SchemaDefinitionError(f"uniqueItems must be boolean at {schema_document}#{schema_pointer}")
            prefix_count = 0
            if "prefixItems" in schema:
                prefix_items = schema["prefixItems"]
                if not isinstance(prefix_items, list) or not all(isinstance(item, (dict, bool)) for item in prefix_items):
                    raise SchemaDefinitionError(f"prefixItems must be a schema array at {schema_document}#{schema_pointer}")
                prefix_count = len(prefix_items)
                for index, item_schema in enumerate(prefix_items[: len(instance)]):
                    self._validate(
                        instance=instance[index],
                        schema=item_schema,
                        instance_pointer=_join_pointer(instance_pointer, index),
                        instance_tokens=instance_tokens + (index,),
                        schema_document=schema_document,
                        schema_pointer=_join_pointer(_join_pointer(schema_pointer, "prefixItems"), index),
                        evaluation_stack=evaluation_stack,
                        errors=errors,
                    )
            if "items" in schema:
                item_schema = schema["items"]
                if not isinstance(item_schema, (dict, bool)):
                    raise SchemaDefinitionError(f"items must be an object or boolean at {schema_document}#{schema_pointer}")
                for index, item in enumerate(instance[prefix_count:], prefix_count):
                    self._validate(
                        instance=item,
                        schema=item_schema,
                        instance_pointer=_join_pointer(instance_pointer, index),
                        instance_tokens=instance_tokens + (index,),
                        schema_document=schema_document,
                        schema_pointer=_join_pointer(schema_pointer, "items"),
                        evaluation_stack=evaluation_stack,
                        errors=errors,
                    )
            if "contains" in schema:
                contains_schema = schema["contains"]
                if not isinstance(contains_schema, (dict, bool)):
                    raise SchemaDefinitionError(f"contains must be an object or boolean at {schema_document}#{schema_pointer}")
                matches = 0
                for index, item in enumerate(instance):
                    branch = self._branch_errors(
                        item,
                        contains_schema,
                        instance_pointer=_join_pointer(instance_pointer, index),
                        instance_tokens=instance_tokens + (index,),
                        schema_document=schema_document,
                        schema_pointer=_join_pointer(schema_pointer, "contains"),
                        evaluation_stack=evaluation_stack,
                    )
                    if not branch:
                        matches += 1
                minimum = schema.get("minContains", 1)
                maximum = schema.get("maxContains")
                if not isinstance(minimum, int) or isinstance(minimum, bool) or minimum < 0:
                    raise SchemaDefinitionError(f"minContains must be a non-negative integer at {schema_document}#{schema_pointer}")
                if maximum is not None and (
                    not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 0
                ):
                    raise SchemaDefinitionError(f"maxContains must be a non-negative integer at {schema_document}#{schema_pointer}")
                if matches < minimum or (maximum is not None and matches > maximum):
                    self._error(
                        errors,
                        keyword="contains",
                        message=f"array has {matches} matching items; required {minimum}"
                        + (f"..{maximum}" if maximum is not None else "+"),
                        schema_pointer=_join_pointer(schema_pointer, "contains"),
                        details={"matches": matches, "minimum": minimum, "maximum": maximum},
                        **context,
                    )

        if isinstance(instance, str):
            for keyword, compare, label in (
                ("minLength", lambda actual, limit: actual < limit, "minimum"),
                ("maxLength", lambda actual, limit: actual > limit, "maximum"),
            ):
                if keyword in schema:
                    limit = schema[keyword]
                    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 0:
                        raise SchemaDefinitionError(f"{keyword} must be a non-negative integer at {schema_document}#{schema_pointer}")
                    if compare(len(instance), limit):
                        self._error(
                            errors,
                            keyword=keyword,
                            message=f"string has {len(instance)} Unicode characters; {label} is {limit}",
                            schema_pointer=_join_pointer(schema_pointer, keyword),
                            details={"actual": len(instance), label: limit},
                            **context,
                        )
            if "pattern" in schema:
                pattern = schema["pattern"]
                if not isinstance(pattern, str):
                    raise SchemaDefinitionError(f"pattern must be a string at {schema_document}#{schema_pointer}")
                try:
                    matched = re.search(pattern, instance) is not None
                except re.error as exc:
                    raise SchemaDefinitionError(f"invalid pattern at {schema_document}#{schema_pointer}: {exc}") from exc
                if not matched:
                    self._error(
                        errors,
                        keyword="pattern",
                        message=f"string does not match pattern {pattern!r}",
                        schema_pointer=_join_pointer(schema_pointer, "pattern"),
                        details={"pattern": pattern},
                        **context,
                    )
            if "format" in schema:
                format_name = schema["format"]
                if not isinstance(format_name, str):
                    raise SchemaDefinitionError(f"format must be a string at {schema_document}#{schema_pointer}")
                checker = FORMAT_CHECKERS.get(format_name)
                if checker is not None and not checker(instance):
                    self._error(
                        errors,
                        keyword="format",
                        message=f"string is not a valid {format_name}",
                        schema_pointer=_join_pointer(schema_pointer, "format"),
                        details={"format": format_name},
                        **context,
                    )

        if _is_number(instance):
            for keyword, compare, label in (
                ("minimum", lambda actual, limit: actual < limit, "minimum"),
                ("maximum", lambda actual, limit: actual > limit, "maximum"),
            ):
                if keyword in schema:
                    limit = schema[keyword]
                    if not _is_number(limit):
                        raise SchemaDefinitionError(f"{keyword} must be a finite number at {schema_document}#{schema_pointer}")
                    if compare(instance, limit):
                        self._error(
                            errors,
                            keyword=keyword,
                            message=f"number {instance!r} violates {label} {limit!r}",
                            schema_pointer=_join_pointer(schema_pointer, keyword),
                            details={"actual": instance, label: limit},
                            **context,
                        )

        for keyword in ("allOf", "anyOf", "oneOf"):
            if keyword not in schema:
                continue
            branches = schema[keyword]
            if not isinstance(branches, list) or not branches:
                raise SchemaDefinitionError(f"{keyword} must be a non-empty schema array at {schema_document}#{schema_pointer}")
            branch_results = [
                self._branch_errors(
                    instance,
                    branch_schema,
                    instance_pointer=instance_pointer,
                    instance_tokens=instance_tokens,
                    schema_document=schema_document,
                    schema_pointer=_join_pointer(_join_pointer(schema_pointer, keyword), index),
                    evaluation_stack=evaluation_stack,
                )
                for index, branch_schema in enumerate(branches)
            ]
            matches = [index for index, result in enumerate(branch_results) if not result]
            if keyword == "allOf":
                for branch in branch_results:
                    errors.extend(branch)
            elif keyword == "anyOf" and not matches:
                self._error(
                    errors,
                    keyword="anyOf",
                    message="instance does not satisfy any branch",
                    schema_pointer=_join_pointer(schema_pointer, "anyOf"),
                    details={"branch_error_counts": [len(result) for result in branch_results]},
                    **context,
                )
            elif keyword == "oneOf" and len(matches) != 1:
                self._error(
                    errors,
                    keyword="oneOf",
                    message=f"instance must satisfy exactly one branch; matched {len(matches)}",
                    schema_pointer=_join_pointer(schema_pointer, "oneOf"),
                    details={
                        "matched_branches": matches,
                        "branch_error_counts": [len(result) for result in branch_results],
                    },
                    **context,
                )

        if "not" in schema:
            negated = schema["not"]
            if not isinstance(negated, (dict, bool)):
                raise SchemaDefinitionError(f"not must be an object or boolean at {schema_document}#{schema_pointer}")
            negated_errors = self._branch_errors(
                instance,
                negated,
                instance_pointer=instance_pointer,
                instance_tokens=instance_tokens,
                schema_document=schema_document,
                schema_pointer=_join_pointer(schema_pointer, "not"),
                evaluation_stack=evaluation_stack,
            )
            if not negated_errors:
                self._error(
                    errors,
                    keyword="not",
                    message="instance must not satisfy the negated schema",
                    schema_pointer=_join_pointer(schema_pointer, "not"),
                    **context,
                )

        if "if" in schema:
            condition_schema = schema["if"]
            condition_errors = self._branch_errors(
                instance,
                condition_schema,
                instance_pointer=instance_pointer,
                instance_tokens=instance_tokens,
                schema_document=schema_document,
                schema_pointer=_join_pointer(schema_pointer, "if"),
                evaluation_stack=evaluation_stack,
            )
            selected = "then" if not condition_errors else "else"
            if selected in schema:
                self._validate(
                    instance=instance,
                    schema=schema[selected],
                    instance_pointer=instance_pointer,
                    instance_tokens=instance_tokens,
                    schema_document=schema_document,
                    schema_pointer=_join_pointer(schema_pointer, selected),
                    evaluation_stack=evaluation_stack,
                    errors=errors,
                )


def validate_instance(instance: Any, schema: Any, schema_path: Path | str) -> list[ValidationError]:
    """Validate an already-loaded instance without creating a temporary file.

    ``schema_path`` supplies the filesystem base for safe relative ``$ref``
    resolution.  This is the preferred API for validators that read instances
    directly from a ZIP archive.
    """

    return JsonSchemaValidator(Path(schema_path), schema=schema).validate(instance)


def validate_files(schema_path: Path, instance_path: Path) -> dict[str, Any]:
    validator = JsonSchemaValidator(schema_path)
    errors = validator.validate_path(instance_path)
    return {
        "schema_version": "1.0.0",
        "status": "pass" if not errors else "fail",
        "valid": not errors,
        "schema": str(schema_path.resolve()),
        "instance": str(instance_path.resolve()),
        "error_count": len(errors),
        "errors": [error.to_dict() for error in errors],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate JSON using FrontMind's stdlib-only Draft 2020-12 subset."
    )
    parser.add_argument("schema", type=Path, help="entry JSON Schema file")
    parser.add_argument("instance", type=Path, help="JSON instance file")
    parser.add_argument("--report", type=Path, help="also write the JSON validation report to this path")
    args = parser.parse_args()

    try:
        report = validate_files(args.schema, args.instance)
        exit_code = 0 if report["valid"] else 1
    except ValidationRuntimeError as exc:
        report = {
            "schema_version": "1.0.0",
            "status": "error",
            "valid": False,
            "schema": str(args.schema.resolve()),
            "instance": str(args.instance.resolve()),
            "error_count": 1,
            "errors": [
                {
                    "keyword": "runtime",
                    "message": str(exc),
                    "instance_path": "#",
                    "json_path": "$",
                    "schema_path": "#",
                    "schema_uri": args.schema.resolve().as_uri() + "#",
                }
            ],
        }
        exit_code = 2

    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.report:
        try:
            args.report.write_text(rendered + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"cannot write report {args.report}: {exc}", file=sys.stderr)
            return 2
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
