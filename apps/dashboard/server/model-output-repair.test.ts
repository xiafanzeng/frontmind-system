import { describe, expect, it, vi } from "vitest";

import {
  parseExactJson as parseExactJsonFromSharedCore,
  repairStructuredJsonCandidate as repairStructuredJsonCandidateFromSharedCore,
} from "../shared/model-output-repair";

import {
  DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS,
  MAX_MODEL_OUTPUT_REPAIR_CHARACTERS,
  ModelOutputRepairError,
  configuredModelOutputRepairMode,
  parseExactJson,
  parseUploadedJsonWithRepair,
  parseWithModelOutputRepair,
  repairStructuredJsonCandidate,
} from "./model-output-repair";

describe("compatibility-first model output repair", () => {
  it("keeps the server entry point as the exact shared browser-safe implementation", () => {
    expect(parseExactJson).toBe(parseExactJsonFromSharedCore);
    expect(repairStructuredJsonCandidate).toBe(
      repairStructuredJsonCandidateFromSharedCore,
    );
  });

  it("returns the exact parser result unchanged and never evaluates recovery", () => {
    const exactValue = {
      taskId: "task-unchanged",
      nested: { content: "保留原始内容" },
    };
    const exactParse = vi.fn(() => exactValue);
    const repairParse = vi.fn(() => ({
      value: { taskId: "wrong" },
      ruleCodes: [] as const,
    }));

    const parsed = parseWithModelOutputRepair({
      adapter: "brand_question_portfolio",
      raw: JSON.stringify(exactValue),
      exactParse,
      repairParse,
      mode: "active",
    });

    expect(parsed).toBe(exactValue);
    expect(parsed).toEqual(exactValue);
    expect(exactParse).toHaveBeenCalledOnce();
    expect(repairParse).not.toHaveBeenCalled();
  });

  it("keeps shadow mode non-authoritative and reports privacy-safe rule codes", () => {
    const originalError = new SyntaxError("raw secret must not be logged");
    const observations: unknown[] = [];

    expect(() =>
      parseWithModelOutputRepair({
        adapter: "upload_import",
        raw: "customer secret",
        exactParse: () => {
          throw originalError;
        },
        repairParse: () => ({
          value: { repaired: true },
          ruleCodes: ["known_fence_removed"],
        }),
        mode: "shadow",
        report: (observation) => observations.push(observation),
      }),
    ).toThrow(originalError);
    expect(observations).toEqual([
      {
        adapter: "upload_import",
        mode: "shadow",
        outcome: "candidate_accepted",
        ruleCodes: ["known_fence_removed"],
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain("customer secret");
    expect(JSON.stringify(observations)).not.toContain("raw secret");
  });

  it("isolates non-authoritative reporting failures in shadow and active modes", () => {
    const originalError = new SyntaxError("exact parser rejection");
    const input = {
      adapter: "upload_import" as const,
      raw: "repairable",
      exactParse: () => {
        throw originalError;
      },
      repairParse: () => ({
        value: { repaired: true },
        ruleCodes: ["known_fence_removed"] as const,
      }),
      report: () => {
        throw new Error("telemetry unavailable");
      },
    };

    expect(() =>
      parseWithModelOutputRepair({ ...input, mode: "shadow" }),
    ).toThrow(originalError);
    expect(parseWithModelOutputRepair({ ...input, mode: "active" })).toEqual({
      repaired: true,
    });
  });

  it("never treats a no-op candidate as a repair", () => {
    const originalError = new Error("exact rejection");
    const report = vi.fn();
    expect(() =>
      parseWithModelOutputRepair({
        adapter: "upload_import",
        raw: "{}",
        exactParse: () => {
          throw originalError;
        },
        repairParse: () => ({ value: {}, ruleCodes: [] }),
        mode: "active",
        report,
      }),
    ).toThrow(originalError);
    expect(report).not.toHaveBeenCalled();
  });

  it("never invokes recovery for an oversized failed response", () => {
    const originalError = new SyntaxError("exact parser rejection");
    const repairParse = vi.fn();
    expect(() =>
      parseWithModelOutputRepair({
        adapter: "upload_import",
        raw: "x".repeat(DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS + 1),
        exactParse: () => {
          throw originalError;
        },
        repairParse,
        mode: "active",
      }),
    ).toThrow(originalError);
    expect(repairParse).not.toHaveBeenCalled();
  });

  it("allows a caller to raise the bounded repair limit to two MiB", () => {
    const raw = `{"body":"${"x".repeat(
      DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS,
    )}",}`;
    expect(() => repairStructuredJsonCandidate(raw)).toThrow();
    expect(
      repairStructuredJsonCandidate(raw, {
        maxCharacters: MAX_MODEL_OUTPUT_REPAIR_CHARACTERS,
      }).value,
    ).toEqual({ body: "x".repeat(DEFAULT_MODEL_OUTPUT_REPAIR_MAX_CHARACTERS) });
    expect(() =>
      repairStructuredJsonCandidate("{}", {
        maxCharacters: MAX_MODEL_OUTPUT_REPAIR_CHARACTERS + 1,
      }),
    ).toThrowError(
      expect.objectContaining<ModelOutputRepairError>({
        code: "UNSAFE_POLICY",
      }),
    );
  });

  it("requires the adapter-specific active mode before accepting recovery", () => {
    expect(configuredModelOutputRepairMode("response_logic", {})).toBe(
      "shadow",
    );
    expect(
      configuredModelOutputRepairMode("response_logic", {
        FRONTMIND_RESPONSE_LOGIC_OUTPUT_REPAIR: "active",
      }),
    ).toBe("active");
    expect(
      configuredModelOutputRepairMode("response_logic", {
        FRONTMIND_RESPONSE_LOGIC_OUTPUT_REPAIR: "true",
      }),
    ).toBe("shadow");
  });

  it("normalizes only deterministic JSON transport defects and is idempotent", () => {
    const raw =
      '\uFEFF```json\n"{\\"schema_version\\":\\"1\\",\\"task_id\\":\\"task-' +
      "x".repeat(320) +
      '\\",\\"status\\":\\"finished\\",\\"body\\":\\"line 1\\nline 2\\",}"\n```';
    const policy = {
      fenceLanguages: ["", "json"],
      aliases: {
        schema_version: "schemaVersion",
        task_id: "taskId",
      },
      numericKeys: ["schemaVersion"],
      statusKeys: ["status"],
      statusAliases: { finished: "completed" },
      identityKeys: ["task_id", "taskId"],
    } as const;

    const first = repairStructuredJsonCandidate(raw, policy);
    const second = repairStructuredJsonCandidate(first.normalizedText, policy);

    expect(first.value).toEqual({
      schemaVersion: 1,
      taskId: `task-${"x".repeat(320)}`,
      status: "completed",
      body: "line 1\nline 2",
    });
    expect(first.ruleCodes).toEqual(
      expect.arrayContaining([
        "bom_removed",
        "known_fence_removed",
        "json_string_unwrapped",
        "trailing_comma_removed",
        "known_alias_normalized",
        "lossless_numeric_string_normalized",
        "known_status_alias_normalized",
      ]),
    );
    expect(second.normalizedText).toBe(first.normalizedText);
    expect(second.value).toEqual(first.value);
    expect(second.ruleCodes).toEqual([]);
    expect((first.value as { taskId: string }).taskId).toHaveLength(325);
  });

  it("escapes literal control characters inside strings without changing content", () => {
    const repaired = repairStructuredJsonCandidate(
      '{"body":"line 1\nline 2\tend"}',
    );
    expect(repaired.value).toEqual({ body: "line 1\nline 2\tend" });
    expect(repaired.ruleCodes).toContain("raw_control_character_escaped");
  });

  it("repairs only quotes that cannot close the current JSON string", () => {
    const repaired = repairStructuredJsonCandidate(
      '{"decision":"accept","reason":"问题明确以"硅基流动"为主语，知识库证据可以支持判定。","enterpriseAnchor":"硅基流动","evidenceRefs":["evidence/S001.md"]}',
    );

    expect(repaired.value).toEqual({
      decision: "accept",
      reason: '问题明确以"硅基流动"为主语，知识库证据可以支持判定。',
      enterpriseAnchor: "硅基流动",
      evidenceRefs: ["evidence/S001.md"],
    });
    expect(repaired.ruleCodes).toContain("unescaped_string_quote_escaped");
  });

  it("fails closed when quote repair would still leave ambiguous JSON", () => {
    expect(() =>
      repairStructuredJsonCandidate(
        '{"reason":"前文 "引号", "looksLikeAKey": 但仍是正文","decision":"accept"}',
      ),
    ).toThrow();
  });

  it("extracts only one complete balanced value and rejects ambiguity", () => {
    expect(
      repairStructuredJsonCandidate('result: {"ok":true} end').value,
    ).toEqual({ ok: true });
    expect(() =>
      repairStructuredJsonCandidate('{"first":1}\n{"second":2}'),
    ).toThrowError(
      expect.objectContaining<ModelOutputRepairError>({
        code: "MULTIPLE_CANDIDATES",
      }),
    );
  });

  it("bounds adversarial candidate scanning and nesting", () => {
    expect(() =>
      repairStructuredJsonCandidate("{}".repeat(50_000)),
    ).toThrowError(
      expect.objectContaining<ModelOutputRepairError>({
        code: "MULTIPLE_CANDIDATES",
      }),
    );
    expect(() =>
      repairStructuredJsonCandidate(`${"[".repeat(130)}0${"]".repeat(130)}`),
    ).toThrowError(
      expect.objectContaining<ModelOutputRepairError>({
        code: "INVALID_CANDIDATE",
      }),
    );
  });

  it("rejects duplicate keys and conflicting aliases", () => {
    expect(() => parseExactJson('{"id":"a","id":"b"}')).toThrowError(
      expect.objectContaining<ModelOutputRepairError>({
        code: "DUPLICATE_KEY",
      }),
    );
    expect(() =>
      repairStructuredJsonCandidate(
        '{"taskId":"canonical","task_id":"different"}',
        {
          aliases: { task_id: "taskId" },
          identityKeys: ["task_id", "taskId"],
        },
      ),
    ).toThrowError(
      expect.objectContaining<ModelOutputRepairError>({
        code: "CONFLICTING_ALIAS",
      }),
    );
  });

  it("does not coerce or truncate identity fields", () => {
    const longId = "0".repeat(400);
    const repaired = repairStructuredJsonCandidate(
      JSON.stringify({ task_id: longId, version: "2" }),
      {
        aliases: { task_id: "taskId" },
        numericKeys: ["version"],
        identityKeys: ["task_id", "taskId"],
      },
    );
    expect(repaired.value).toEqual({ taskId: longId, version: 2 });
    expect((repaired.value as { taskId: string }).taskId).toHaveLength(400);
    expect(() =>
      repairStructuredJsonCandidate('{"taskId":"123"}', {
        numericKeys: ["taskId"],
        identityKeys: ["taskId"],
      }),
    ).toThrowError(
      expect.objectContaining<ModelOutputRepairError>({
        code: "UNSAFE_POLICY",
      }),
    );
  });

  it("keeps upload recovery shadow-only by default and active only explicitly", () => {
    const raw = '```json\n{"schemaVersion":"1",}\n```';
    const observations: unknown[] = [];
    expect(() =>
      parseUploadedJsonWithRepair(raw, {
        report: (observation) => observations.push(observation),
      }),
    ).toThrow();
    expect(observations).toHaveLength(1);

    expect(
      parseUploadedJsonWithRepair(raw, {
        mode: "active",
        report: () => undefined,
      }),
    ).toEqual({ schemaVersion: 1 });
  });
});
