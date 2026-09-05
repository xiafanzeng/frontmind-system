import { afterEach, describe, expect, it } from "vitest";

import { knowledgeBaseV4RolloutDecision } from "./knowledge-base-rollout";

const previous = {
  nodeEnv: process.env.NODE_ENV,
  percent: process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT,
  allowlist: process.env.FRONTMIND_KB_V4_ALLOW_USER_IDS,
};

afterEach(() => {
  if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous.nodeEnv;
  if (previous.percent === undefined) {
    delete process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT;
  } else {
    process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT = previous.percent;
  }
  if (previous.allowlist === undefined) {
    delete process.env.FRONTMIND_KB_V4_ALLOW_USER_IDS;
  } else {
    process.env.FRONTMIND_KB_V4_ALLOW_USER_IDS = previous.allowlist;
  }
});

describe("knowledge-base v4 rollout", () => {
  it("defaults production new-build access to fully enabled", () => {
    process.env.NODE_ENV = "production";
    delete process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT;
    delete process.env.FRONTMIND_KB_V4_ALLOW_USER_IDS;
    expect(knowledgeBaseV4RolloutDecision(42)).toMatchObject({
      enabled: true,
      percent: 100,
    });
  });

  it("uses a stable account bucket for percentage rollout", () => {
    process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT = "10";
    const first = knowledgeBaseV4RolloutDecision(42);
    const second = knowledgeBaseV4RolloutDecision(42);
    expect(second).toEqual(first);
    expect(first.enabled).toBe(first.bucket < 1_000);
  });

  it("lets the internal allowlist bypass a zero-percent cohort", () => {
    process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT = "0";
    process.env.FRONTMIND_KB_V4_ALLOW_USER_IDS = "7,42";
    expect(knowledgeBaseV4RolloutDecision(42)).toMatchObject({
      enabled: true,
      allowlisted: true,
    });
    expect(knowledgeBaseV4RolloutDecision(8).enabled).toBe(false);
  });

  it("rejects malformed rollout configuration", () => {
    process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT = "101";
    expect(() => knowledgeBaseV4RolloutDecision(42)).toThrow(
      "FRONTMIND_KB_V4_ROLLOUT_PERCENT",
    );
  });
});
