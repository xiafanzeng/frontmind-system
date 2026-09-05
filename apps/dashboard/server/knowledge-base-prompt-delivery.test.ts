import { describe, expect, it } from "vitest";

import { buildKnowledgeBaseInstructionDelivery } from "./knowledge-base-prompt-delivery";
import {
  assertUpstreamPromptBudget,
  FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
  promptSha256,
  UpstreamPromptBudgetError,
  upstreamPromptCharacterCount,
} from "./upstream-prompt-budget";

describe("upstream prompt delivery", () => {
  it("keeps the bootstrap under 3000 characters while preserving full instructions", () => {
    const instructions = "完整规则。".repeat(2_000);
    const delivery = buildKnowledgeBaseInstructionDelivery({
      instructions,
      skillVersion: "4",
      treePolicyVersion: 2,
      operationId: "operation-1",
      turnId: "turn-1",
    });
    expect(upstreamPromptCharacterCount(delivery.prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );
    expect(delivery.bytes.toString("utf8")).toBe(instructions);
    expect(delivery.sha256).toBe(promptSha256(instructions));
    expect(delivery.prompt).toContain(`SHA-256=${delivery.sha256}`);
    expect(delivery.prompt).toContain(
      "用户已在 FrontMind Dashboard 发起并授权本轮企业知识库构建",
    );
    expect(delivery.prompt).toContain("不要求环境预装同名 Skill");
    expect(delivery.prompt).toContain(
      "只有 customerAttachments 中明确列出的文件属于客户事实资料",
    );
    expect(delivery.prompt).toContain(
      "Dashboard 深度知识库必须为 30–115 个真实叶子，普通企业目标 40–55",
    );
    expect(delivery.prompt).toContain("operationId=operation-1");
    expect(delivery.prompt).toContain("turnId=turn-1");
    for (const forbiddenPhrase of [
      "系统附件",
      "服务端系统附件",
      "系统输入",
      "优先级",
      "最高优先级",
      "覆盖任务历史",
      "旧 Skill、旧回复与旧协议示例",
      "pasted_content",
      "严格执行",
    ]) {
      expect(delivery.prompt).not.toContain(forbiddenPhrase);
    }
  });

  it("does not impose the deep-tree bootstrap on a legacy v4 build", () => {
    const delivery = buildKnowledgeBaseInstructionDelivery({
      instructions: "历史 v4 构建规则",
      skillVersion: "4",
      treePolicyVersion: 1,
      operationId: "operation-legacy",
      turnId: "turn-legacy",
    });
    expect(delivery.prompt).not.toContain("30–115 个真实叶子");
    expect(delivery.prompt).not.toContain("普通企业目标 40–55");
  });

  it("fails closed instead of allowing an oversized main prompt", () => {
    expect(() => assertUpstreamPromptBudget("字".repeat(3_001))).toThrow(
      UpstreamPromptBudgetError,
    );
  });
});
