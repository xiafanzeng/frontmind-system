import { describe, expect, it, vi } from "vitest";

import {
  KNOWLEDGE_BASE_ROLLOUT_AUDIT_SUCCESS,
  knowledgeBaseRolloutFailureLine,
  parseKnowledgeBaseRolloutAuditArguments,
  runKnowledgeBaseRolloutAudit,
} from "./audit-knowledge-base-rollout";

describe("knowledge-base rollout audit CLI", () => {
  it("requires an explicit timestamp and the exact configured rollout percent", () => {
    expect(
      parseKnowledgeBaseRolloutAuditArguments(
        ["--since=2026-08-01T00:00:00Z", "--expected-percent", "10"],
        { FRONTMIND_KB_V4_ROLLOUT_PERCENT: "10.00" },
      ),
    ).toMatchObject({
      since: new Date("2026-08-01T00:00:00Z"),
      expectedPercent: 10,
      minimumBuilds: 1,
      minimumOperations: 1,
    });
    expect(
      parseKnowledgeBaseRolloutAuditArguments(
        [
          "--since=2026-08-01T00:00:00Z",
          "--expected-percent=50",
          "--min-builds=12",
          "--min-operations=36",
        ],
        { FRONTMIND_KB_V4_ROLLOUT_PERCENT: "50" },
      ),
    ).toMatchObject({ minimumBuilds: 12, minimumOperations: 36 });
    expect(() =>
      parseKnowledgeBaseRolloutAuditArguments(
        ["--since=2026-08-01T00:00:00Z", "--expected-percent=50"],
        { FRONTMIND_KB_V4_ROLLOUT_PERCENT: "10" },
      ),
    ).toThrow("KB_ROLLOUT_PERCENT_MISMATCH");
    expect(() =>
      parseKnowledgeBaseRolloutAuditArguments(
        ["--since=yesterday", "--expected-percent=10"],
        { FRONTMIND_KB_V4_ROLLOUT_PERCENT: "10" },
      ),
    ).toThrow("KB_ROLLOUT_SINCE_INVALID");
  });

  it("prints exactly one success line and no diagnostics on success", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const exitCode = await runKnowledgeBaseRolloutAudit({
      argv: ["--since=2026-08-01T00:00:00Z", "--expected-percent=10"],
      env: { FRONTMIND_KB_V4_ROLLOUT_PERCENT: "10" },
      audit: vi.fn(async () => {
        console.warn("driver diagnostic with sk-secret");
        return { scanned: 3, operations: 4, violations: [] };
      }),
      stdout,
      stderr,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith(KNOWLEDGE_BASE_ROLLOUT_AUDIT_SUCCESS);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("fails non-zero using codes only, never exception text, body or keys", async () => {
    const secret = "sk-do-not-print-this";
    const customerBody = "customer private Markdown";
    const stdout = vi.fn();
    const stderr = vi.fn();
    const exitCode = await runKnowledgeBaseRolloutAudit({
      argv: ["--since=2026-08-01T00:00:00Z", "--expected-percent=50"],
      env: { FRONTMIND_KB_V4_ROLLOUT_PERCENT: "50", API_KEY: secret },
      audit: vi.fn(async () => ({
        scanned: 1,
        operations: 1,
        violations: [
          {
            code: "PUBLISHED_DOWNLOAD_FAILED",
            buildId: customerBody,
            generation: 1,
          },
        ],
      })),
      stdout,
      stderr,
    });
    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      "KB_ROLLOUT_AUDIT_FAILED count=1 codes=PUBLISHED_DOWNLOAD_FAILED",
    );
    const serialized = JSON.stringify(stderr.mock.calls);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(customerBody);

    const errorStderr = vi.fn();
    expect(
      await runKnowledgeBaseRolloutAudit({
        argv: ["--since=2026-08-01T00:00:00Z", "--expected-percent=50"],
        env: { FRONTMIND_KB_V4_ROLLOUT_PERCENT: "50" },
        audit: vi.fn(async () => {
          throw new Error(`${secret}:${customerBody}`);
        }),
        stdout,
        stderr: errorStderr,
      }),
    ).toBe(1);
    expect(errorStderr).toHaveBeenCalledWith("KB_ROLLOUT_AUDIT_ERROR");
    expect(JSON.stringify(errorStderr.mock.calls)).not.toContain(secret);
  });

  it("cannot approve a non-zero rollout without real build and operation samples", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    expect(
      await runKnowledgeBaseRolloutAudit({
        argv: ["--since=2026-08-01T00:00:00Z", "--expected-percent=10"],
        env: { FRONTMIND_KB_V4_ROLLOUT_PERCENT: "10" },
        audit: vi.fn(async () => ({
          scanned: 0,
          operations: 0,
          violations: [],
        })),
        stdout,
        stderr,
      }),
    ).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "KB_ROLLOUT_AUDIT_FAILED count=2 codes=INSUFFICIENT_BUILD_SAMPLE,INSUFFICIENT_OPERATION_SAMPLE",
    );
    expect(stdout).not.toHaveBeenCalled();
  });

  it("sorts and deduplicates only stable violation codes", () => {
    expect(
      knowledgeBaseRolloutFailureLine([
        { code: "Z_CODE" },
        { code: "A_CODE" },
        { code: "Z_CODE" },
      ]),
    ).toBe("KB_ROLLOUT_AUDIT_FAILED count=3 codes=A_CODE,Z_CODE");
    expect(
      knowledgeBaseRolloutFailureLine([
        { code: "unsafe\ncustomer body sk-secret" },
      ]),
    ).toBe("KB_ROLLOUT_AUDIT_FAILED count=1 codes=UNKNOWN_VIOLATION");
  });
});
