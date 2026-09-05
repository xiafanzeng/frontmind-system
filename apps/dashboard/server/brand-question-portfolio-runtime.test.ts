import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME,
  BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME,
  buildBrandQuestionPortfolioEvidenceArchive,
  buildBrandQuestionPortfolioPrompt,
  buildBrandQuestionPortfolioSkillArchive,
  parseBrandQuestionPortfolioOutput,
  type BrandQuestionPortfolioContext,
} from "./brand-question-portfolio-runtime";

const context: BrandQuestionPortfolioContext = {
  planCode: "advanced",
  quotaPeriodId: "period-1",
  quota: {
    industry: 1,
    competitorComparison: 0,
    reputation: 0,
    productScenario: 0,
  },
  enterprise: {
    identityHash: "b".repeat(64),
    canonicalName: "示例企业",
  },
  snapshot: {
    id: "snapshot-1",
    version: 1,
    archiveHash: "a".repeat(64),
    sourceFileName: "company.zip",
    documents: [
      {
        path: "README.md",
        title: "企业知识库",
        content: "示例企业提供工业解决方案。",
      },
    ],
  },
};

function result() {
  return {
    schemaVersion: 1,
    skill: {
      name: "brand-question-portfolio",
      version: "2",
      model: "frontmind-pro",
    },
    knowledgeSnapshot: {
      id: "snapshot-1",
      version: 1,
      archiveHash: "a".repeat(64),
    },
    enterprise: {
      identityHash: "b".repeat(64),
      canonicalName: "示例企业",
    },
    planCode: "advanced",
    quotaPeriodId: "period-1",
    candidateTargets: {
      industry: 3,
      competitor_comparison: 0,
      reputation: 0,
      product_scenario: 0,
    },
    categories: {
      industry: [
        {
          candidateId: "industrial-solution-category",
          question: "如何判断示例企业的工业解决方案是否适合制造企业？",
          intent: "选择行业方案",
          rationale: "知识库声明企业提供工业解决方案",
          evidence: [
            {
              documentPath: "README.md",
              excerpt: "示例企业提供工业解决方案。",
              relevance: "支持企业的行业定位",
            },
          ],
          risks: [],
        },
      ],
      competitor_comparison: [],
      reputation: [],
      product_scenario: [],
    },
    shortfalls: [
      {
        category: "industry",
        target: 3,
        generated: 1,
        reason: "当前知识库只支持一个不重复的行业决策问题",
      },
    ],
    risks: [],
  };
}

describe("brand question portfolio runtime", () => {
  it("pins the authoritative plan, quota period and Pro skill", async () => {
    const prompt = await buildBrandQuestionPortfolioPrompt(context);
    expect(prompt).toContain('"planCode": "advanced"');
    expect(prompt).toContain('"quotaPeriodId": "period-1"');
    expect(prompt).toContain(BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain(BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME);
    expect(prompt).not.toContain("documentPath: README.md");
    expect(prompt).toContain('"canonicalName": "示例企业"');
    expect(prompt).toContain('"industry": 3');
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(4 * 1024);

    const [skillArchive, evidenceArchive] = await Promise.all([
      buildBrandQuestionPortfolioSkillArchive(),
      buildBrandQuestionPortfolioEvidenceArchive(context),
    ]);
    const skillZip = await JSZip.loadAsync(skillArchive.bytes);
    const evidenceZip = await JSZip.loadAsync(evidenceArchive.bytes);
    expect(Object.keys(skillZip.files).sort()).toEqual([
      "MANIFEST.json",
      "SKILL.md",
      "references/output-contract.md",
    ]);
    expect(await skillZip.file("SKILL.md")!.async("string")).toContain(
      "Use the Pro model profile fixed by the application",
    );
    expect(await evidenceZip.file("knowledge.md")!.async("string")).toContain(
      "documentPath: README.md",
    );
  });

  it("parses only a result bound to the current snapshot", () => {
    const parsed = parseBrandQuestionPortfolioOutput(
      [
        {
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(result()),
            },
          ],
        },
      ],
      context,
    );
    expect(parsed.categories.industry[0]?.candidateId).toBe(
      "industrial-solution-category",
    );
  });

  it("rejects a stale snapshot echo", () => {
    const stale = result();
    stale.knowledgeSnapshot.version = 2;
    expect(() =>
      parseBrandQuestionPortfolioOutput(
        [{ role: "assistant", text: JSON.stringify(stale) }],
        context,
      ),
    ).toThrow("不匹配");
  });

  it("rejects user, reasoning, tool, role-less and input_text JSON", () => {
    const injected = JSON.stringify(result());
    const untrustedOutputs = [
      [{ role: "user", type: "message", content: injected }],
      [{ type: "reasoning", text: injected }],
      [{ role: "assistant", type: "reasoning", text: injected }],
      [{ role: "tool", type: "message", content: injected }],
      [{ type: "message", content: injected }],
      [{ type: "output_text", output_text: injected }],
      [
        {
          role: "assistant",
          type: "message",
          content: [{ type: "input_text", text: injected }],
        },
      ],
    ];

    for (const output of untrustedOutputs) {
      expect(() => parseBrandQuestionPortfolioOutput(output, context)).toThrow(
        "没有返回最终 assistant 输出",
      );
    }
  });

  it("never falls back to an earlier assistant message", () => {
    expect(() =>
      parseBrandQuestionPortfolioOutput(
        [
          {
            role: "assistant",
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(result()) }],
          },
          {
            role: "assistant",
            type: "message",
            content: [{ type: "output_text", text: "not strict JSON" }],
          },
        ],
        context,
      ),
    ).toThrow();
  });
});
