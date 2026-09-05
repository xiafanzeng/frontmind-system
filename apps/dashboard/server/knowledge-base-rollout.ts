import { createHash } from "node:crypto";

function configuredRolloutPercent() {
  // V4 is the only supported creation path. Keep the parser for the rollout
  // audit tooling, but never silently disable customer builds in production.
  const fallback = "100";
  const raw = (process.env.FRONTMIND_KB_V4_ROLLOUT_PERCENT || fallback).trim();
  if (!/^(?:100|[0-9]{1,2})(?:\.\d{1,2})?$/u.test(raw)) {
    throw new Error(
      "FRONTMIND_KB_V4_ROLLOUT_PERCENT must be between 0 and 100",
    );
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(
      "FRONTMIND_KB_V4_ROLLOUT_PERCENT must be between 0 and 100",
    );
  }
  return value;
}

function allowlistedUserIds() {
  const raw = (process.env.FRONTMIND_KB_V4_ALLOW_USER_IDS || "").trim();
  if (!raw) return new Set<number>();
  const ids = raw.split(",").map((value) => value.trim());
  if (ids.some((value) => !/^[1-9]\d*$/u.test(value))) {
    throw new Error(
      "FRONTMIND_KB_V4_ALLOW_USER_IDS must be comma-separated positive integers",
    );
  }
  return new Set(ids.map(Number));
}

export function knowledgeBaseV4RolloutDecision(userId: number) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("Knowledge-base rollout user is invalid");
  }
  const percent = configuredRolloutPercent();
  const allowlisted = allowlistedUserIds().has(userId);
  const bucket =
    createHash("sha256")
      .update(`frontmind.knowledge-base.v4.rollout:${userId}`, "utf8")
      .digest()
      .readUInt32BE(0) % 10_000;
  return {
    enabled: allowlisted || bucket < Math.round(percent * 100),
    allowlisted,
    bucket,
    percent,
  };
}
