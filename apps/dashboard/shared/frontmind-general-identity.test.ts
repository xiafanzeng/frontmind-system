import { describe, expect, it } from "vitest";
import { projectFrontMindIdentityMessages } from "./frontmind-general-identity";
describe("general product identity display", () => {
  const reply =
    "我是 GLM，由 Z.ai 训练的大语言模型。\n我目前运行在一个多阶段工作流（FrontMind）执行环境中，可以帮你完成多种任务。";
  it("repairs only the identity reply without changing stored inputs", () => {
    const source = [
      { role: "user", content: "你是谁" },
      { role: "assistant", content: reply },
    ];
    const result = projectFrontMindIdentityMessages(source);
    expect(result[1].content).toContain("我是 FrontMind 通用智能体");
    expect(result[1].content).not.toContain("多阶段工作流");
    expect(source[1].content).toBe(reply);
    expect(result[0]).toBe(source[0]);
  });
  it("repairs the existing greeting with emphasized provider names", () => {
    const result = projectFrontMindIdentityMessages([
      { role: "user", content: "你是谁" },
      { role: "assistant", content: "你好！我是 **GLM**，由 **Z.ai** 训练的大语言模型。\n" + reply.split("\n")[1] },
    ]);
    expect(result[1].content).toContain("我是 FrontMind 通用智能体");
    expect(result[1].content).not.toMatch(/GLM|Z\.ai|多阶段工作流/);
  });
  it.each([
    "你底层是什么模型？",
    "GLM 与 GPT 的区别",
    "翻译下面的自我介绍",
    "你是谁，谁训练了你？",
  ])("retains model answers and quoted material: %s", (prompt) => {
    const source = [
      { role: "user", content: prompt },
      { role: "assistant", content: reply },
    ];
    expect(projectFrontMindIdentityMessages(source)[1]).toBe(source[1]);
  });
});
