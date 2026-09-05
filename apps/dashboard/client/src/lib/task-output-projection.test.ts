import { describe, expect, it } from "vitest";
import type { OutputMessage } from "@/lib/frontmind-api";
import {
  outputForKnowledgePresentation,
  projectTaskOutputMessages,
} from "./task-output-projection";

function assistantOutput(id: string, text: string): OutputMessage {
  return {
    id,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function presentation(revision: number, leafId: string | null) {
  return `<!-- FRONTMIND_KB_PRESENTATION ${JSON.stringify({
    kind: "frontmind.knowledge-base.presentation",
    schemaVersion: 1,
    revision,
    leafId,
    imageState: leafId === null ? "not_applicable" : "no_eligible_asset",
    assetIds: [],
    imageCount: 0,
  })} -->`;
}

describe("task output projection", () => {
  it("renders a validated output_message after the first confirmation advances revision 0 to 1", () => {
    const text = [
      "1.1 已确认。",
      "",
      "## 1.2 使命、愿景与企业主张",
      "",
      "硅基流动以加速 AGI 普惠人类为使命。",
      "",
      '<!-- FRONTMIND_KB_PROGRESS {"kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":0,"transition":{"leafId":"1.1","from":"current","to":"confirmed","reason":"用户明确确认"}} -->',
      '<!-- FRONTMIND_KB_PRESENTATION {"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":1,"leafId":"1.2","imageState":"no_eligible_asset","assetIds":[],"imageCount":0} -->',
    ].join("\n");
    const output = [
      {
        id: "confirmed-node-output",
        type: "output_message",
        role: "assistant" as const,
        content: [{ type: "output_text", text }],
      },
    ];

    const messages = projectTaskOutputMessages({
      output,
      baselineOutputLength: 1,
      historicalOutputIds: ["confirmed-node-output"],
      responseStartedAt: 1,
      knowledgeBase: true,
      knowledgeBasePresentation: { revision: 1, leafId: "1.2" },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("1.1 已确认");
    expect(messages[0]?.content).toContain("1.2 使命、愿景与企业主张");
    expect(messages[0]?.content).not.toContain("FRONTMIND_KB_");
  });

  it("uses the latest same-ID replacement when the output length is unchanged", () => {
    const latest = assistantOutput(
      "reused-output",
      [
        "Manus 正在采集更新后的资料。",
        "![外部图片](https://cdn.example.com/image.png)",
        "## References",
        "- https://example.com/source",
        presentation(2, "1.3"),
      ].join("\n\n"),
    );

    const messages = projectTaskOutputMessages({
      output: [latest],
      baselineOutputLength: 1,
      historicalOutputIds: ["reused-output"],
      responseStartedAt: 1,
      modelName: "frontmind-pro",
      knowledgeBase: true,
      knowledgeBasePresentation: { revision: 2, leafId: "1.3" },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("FrontMind 正在采集更新后的资料");
    expect(messages[0]?.content).not.toContain("Manus");
    expect(messages[0]?.content).not.toContain("References");
    expect(messages[0]?.content).not.toContain("cdn.example.com");
  });

  it("selects only the latest assistant item and strips raw provider images", () => {
    const old = assistantOutput(
      "reused-output",
      `旧回复\n${presentation(1, "1.2")}`,
    );
    const current = assistantOutput(
      "reused-output",
      `新回复\n${presentation(2, "1.3")}`,
    );
    const image: OutputMessage = {
      id: "leaf-image",
      type: "output_image",
      image_url: "/api/knowledge-base/assets/leaf-image",
    };
    const duplicateImage: OutputMessage = {
      ...image,
      id: "leaf-image-copy",
    };

    expect(
      outputForKnowledgePresentation(
        [old, current, image, duplicateImage],
        [],
        {
          revision: 2,
          leafId: "1.3",
        },
      ),
    ).toEqual([current]);
  });

  it("keeps the newest content when a cumulative response repeats an ID", () => {
    const old = assistantOutput(
      "reused-output",
      `旧回复\n${presentation(1, "1.2")}`,
    );
    const current = assistantOutput(
      "reused-output",
      `新回复\n${presentation(2, "1.3")}`,
    );

    const messages = projectTaskOutputMessages({
      output: [old, current],
      baselineOutputLength: 0,
      responseStartedAt: 1,
      knowledgeBase: true,
      knowledgeBasePresentation: { revision: 2, leafId: "1.3" },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("新回复");
  });

  it("does not render running knowledge output before its envelope is complete", () => {
    const output: OutputMessage[] = [
      {
        id: "search-call",
        type: "web_search_call",
        status: "completed",
      },
      assistantOutput(
        "running-copy",
        [
          "已完成第一轮资料采集。",
          '<!-- FRONTMIND_KB_PROGRESS {"revision":1',
        ].join("\n"),
      ),
    ];

    const messages = projectTaskOutputMessages({
      output,
      baselineOutputLength: 0,
      responseStartedAt: 1,
      knowledgeBase: true,
    });

    expect(messages).toEqual([]);
  });

  it("renders a genuinely new running collection status", () => {
    const historical = assistantOutput("old-node", "1.2 企业主体\n旧正文");
    const running = assistantOutput(
      "collection-status",
      "FrontMind 正在按业务分支进行资料采集。",
    );

    const messages = projectTaskOutputMessages({
      output: [historical, running],
      baselineOutputLength: 1,
      historicalOutputIds: ["old-node"],
      responseStartedAt: 2,
      knowledgeBase: true,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("FrontMind 正在按业务分支进行资料采集。");
  });

  it("does not replay a reused historical output ID as running text", () => {
    const historical = assistantOutput(
      "reused-output",
      "FrontMind 正在处理上一节点。",
    );

    expect(
      projectTaskOutputMessages({
        output: [historical],
        baselineOutputLength: 1,
        historicalOutputIds: ["reused-output"],
        responseStartedAt: 2,
        knowledgeBase: true,
      }),
    ).toEqual([]);
  });

  it("suppresses a stale previous node until the authoritative next node arrives", () => {
    const stale = assistantOutput(
      "reused-output",
      `1.3 使命、愿景与价值观\n旧正文\n${presentation(1, "1.3")}`,
    );
    const partialCurrent = assistantOutput(
      "reused-output",
      "1.3「使命、愿景与价值观」已确认。\n\n1.4 Token 供应平台业务边界",
    );

    expect(
      projectTaskOutputMessages({
        output: [stale, partialCurrent],
        baselineOutputLength: 1,
        historicalOutputIds: ["reused-output"],
        responseStartedAt: 2,
        knowledgeBase: true,
        knowledgeBasePresentation: { revision: 2, leafId: "1.4" },
      }),
    ).toEqual([]);

    const completedCurrent = assistantOutput(
      "reused-output",
      [
        "1.3「使命、愿景与价值观」已确认。",
        "1.4 Token 供应平台业务边界",
        "新正文",
        presentation(2, "1.4"),
      ].join("\n\n"),
    );
    const messages = projectTaskOutputMessages({
      output: [stale, completedCurrent],
      baselineOutputLength: 1,
      historicalOutputIds: ["reused-output"],
      responseStartedAt: 2,
      knowledgeBase: true,
      knowledgeBasePresentation: { revision: 2, leafId: "1.4" },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("1.4 Token 供应平台业务边界");
    expect(messages[0]?.content).not.toContain("旧正文");
  });
});
