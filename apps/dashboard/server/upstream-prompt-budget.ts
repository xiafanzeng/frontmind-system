import { createHash } from "node:crypto";

export const FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS = 3_000;

export class UpstreamPromptBudgetError extends Error {
  constructor(
    public readonly promptCharacters: number,
    public readonly limit = FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
  ) {
    super(`UPSTREAM_PROMPT_EXCEEDS_${limit}_CHARACTERS`);
    this.name = "UpstreamPromptBudgetError";
  }
}

export function upstreamPromptCharacterCount(value: string) {
  return Array.from(String(value || "")).length;
}

export function assertUpstreamPromptBudget(value: string) {
  const promptCharacters = upstreamPromptCharacterCount(value);
  if (promptCharacters > FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS) {
    throw new UpstreamPromptBudgetError(promptCharacters);
  }
  return value;
}

export function promptSha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
