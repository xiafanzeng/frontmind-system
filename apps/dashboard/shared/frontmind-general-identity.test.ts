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
      {
        role: "assistant",
        content:
          "你好！我是 **GLM**，由 **Z.ai** 训练的大语言模型。\n" +
          reply.split("\n")[1],
      },
    ]);
    expect(result[1].content).toContain("我是 FrontMind 通用智能体");
    expect(result[1].content).not.toMatch(/GLM|Z\.ai|多阶段工作流/);
  });
  it("removes only a known unsolicited model-only paragraph from an identity reply", () => {
    const source = [
      { role: "user", content: "你是谁" },
      {
        role: "assistant",
        content:
          "我是 FrontMind 通用智能体。\n\n当前底层模型为 **GLM-5.3**，由智谱提供。\n\n我可以协助处理任务。",
      },
    ];
    expect(projectFrontMindIdentityMessages(source)[1]!.content).not.toContain(
      "GLM",
    );
    expect(projectFrontMindIdentityMessages(source)[1]!.content).toContain(
      "我可以协助处理任务。",
    );
    expect(source[1]!.content).toContain("GLM");
  });
  it("repairs the exact historical model paragraph only after an identity-only question", () => {
    const paragraph =
      "关于底层模型：我当前使用的底层模型是 **GLM-5.3**，由**智谱（Z.ai）**训练提供。FrontMind 是提供相关服务的产品层，本身并不训练模型。";
    for (const content of [
      paragraph,
      paragraph.replace("由**智谱（Z.ai）**", "由\\*\\*智谱（Z.ai）\\*\\*"),
    ]) {
      expect(
        projectFrontMindIdentityMessages([
          { role: "user", content: "你是谁" },
          { role: "assistant", content },
        ])[1]!.content,
      ).toBe("我是 FrontMind 通用智能体，可以帮助你处理问题和完成任务。");
      expect(
        projectFrontMindIdentityMessages([
          { role: "user", content: "你底层是什么模型？" },
          { role: "assistant", content },
        ])[1]!.content,
      ).toBe(content);
    }
    expect(
      projectFrontMindIdentityMessages([
        { role: "user", content: "你是谁" },
        { role: "assistant", content: "> " + paragraph },
      ])[1]!.content,
    ).toBe("> " + paragraph);
  });
  it.each(["你是什么模型", "你是哪个模型？"])(
    "repairs known identity paragraphs for the short identity question: %s",
    (prompt) => {
      const paragraph =
        "关于底层模型：我当前使用的底层模型是 **GLM-5.3**，由**智谱（Z.ai）**训练提供。FrontMind 是提供相关服务的产品层，本身并不训练模型。";
      const source = [
        { role: "user", content: prompt },
        { role: "assistant", content: paragraph },
      ];
      expect(projectFrontMindIdentityMessages(source)[1]!.content).toBe(
        "我是 FrontMind 通用智能体，可以帮助你处理问题和完成任务。",
      );
      expect(source[1]!.content).toBe(paragraph);
      for (const protectedContent of [
        "> " + paragraph,
        "```text\n" + paragraph + "\n```",
        "`" + paragraph + "`",
      ])
        expect(
          projectFrontMindIdentityMessages([
            { role: "user", content: prompt },
            { role: "assistant", content: protectedContent },
          ])[1]!.content,
        ).toBe(protectedContent);
    },
  );
  it("projects the scoped September 8 13:11 stored identity paragraph", () => {
    const prompt = "你是什么模型";
    const storedParagraph =
      "关于底层模型：我当前使用的底层模型是 **GLM-5.3**，由**智谱（Z.ai）**训练提供。FrontMind 是提供相关服务的产品层，本身并不训练模型。";
    const source = [
      { role: "user", content: prompt },
      { role: "assistant", content: storedParagraph },
    ];
    expect(projectFrontMindIdentityMessages(source)[1]!.content).not.toMatch(
      /GLM|Z\.ai/,
    );
    expect(source[1]!.content).toBe(storedParagraph);
  });
  it("does not repair identity-looking content inside quotes or code", () => {
    const content =
      "> " +
      reply +
      "\n\n```text\n" +
      reply +
      "\n```\n\n`我是 GLM，由 Z.ai 训练的大语言模型。`";
    const source = [
      { role: "user", content: "你是谁" },
      { role: "assistant", content },
    ];
    // The second unquoted line of the first block belongs to the quote's lazy continuation.
    expect(projectFrontMindIdentityMessages(source)[1]!.content).toBe(content);
  });
  it.each([
    "你底层是什么模型？",
    "你是什么模型，说明底层供应商和训练机构",
    "你是哪个模型，请比较 GLM 和 GPT 的架构",
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
