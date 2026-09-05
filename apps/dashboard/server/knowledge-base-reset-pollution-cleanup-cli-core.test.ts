import { describe, expect, it } from "vitest";

import {
  parseResetPollutionCleanupCliArgs,
  serializeResetPollutionCleanupCliResult,
} from "./knowledge-base-reset-pollution-cleanup-cli-core";

const common = [
  "--user-id=7",
  "--conversation-id=conversation-1439",
  "--build-id=build-1439",
  "--reset-request-id=reset-approved",
  "--expected-reset-revision=3",
];

describe("reset-pollution cleanup CLI core", () => {
  it("requires every exact CAS coordinate and the apply state hash", () => {
    expect(
      parseResetPollutionCleanupCliArgs(["reset-pollution-preview", ...common]),
    ).toEqual({
      mode: "reset-pollution-preview",
      userId: 7,
      conversationId: "conversation-1439",
      buildId: "build-1439",
      resetRequestId: "reset-approved",
      expectedResetRevision: 3,
    });
    expect(
      parseResetPollutionCleanupCliArgs([
        "reset-pollution-apply",
        ...common,
        `--expected-state-sha256=${"a".repeat(64)}`,
      ]),
    ).toMatchObject({
      mode: "reset-pollution-apply",
      expectedStateSha256: "a".repeat(64),
    });
    for (const invalid of [
      ["reset-pollution-apply", ...common],
      ["reset-pollution-preview", ...common, "--unexpected=true"],
      ["reset-pollution-preview", ...common, "--user-id=8"],
    ]) {
      expect(() => parseResetPollutionCleanupCliArgs(invalid)).toThrow(
        /^KB_RESET_POLLUTION_CLI_/u,
      );
    }
  });

  it("serializes no customer coordinates or content on failure", () => {
    const output = serializeResetPollutionCleanupCliResult({
      success: false,
      mode: "reset-pollution-apply",
      code: "mysql://secret/customer.pdf build-1439",
    });
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1,
      success: false,
      mode: "reset-pollution-apply",
      status: "rejected",
      code: "KB_RESET_POLLUTION_CLI_FAILED",
    });
    expect(output).not.toContain("secret");
    expect(output).not.toContain("customer.pdf");
    expect(output).not.toContain("build-1439");
  });
});
