import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME,
  BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME,
  buildBrandQuestionPortfolioEvidenceArchive,
  buildBrandQuestionPortfolioPrompt,
  buildBrandQuestionPortfolioSkillArchive,
  parseBrandQuestionPortfolioStructuredValue,
  type BrandQuestionPortfolioContext,
} from "./brand-question-portfolio-runtime";
import {
  FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
  upstreamPromptCharacterCount,
} from "./upstream-prompt-budget";

const context: BrandQuestionPortfolioContext = {
  modelProfile: "frontmind-base",
  planCode: "advanced",
  quotaPeriodId: "period-1",
  quotaRevision: 2,
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
      model: context.modelProfile,
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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("pins the authoritative plan, quota period and credential profile", async () => {
    const prompt = await buildBrandQuestionPortfolioPrompt(context);
    expect(prompt).toContain(BRAND_QUESTION_SKILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain(BRAND_QUESTION_EVIDENCE_ATTACHMENT_FILENAME);
    expect(prompt).not.toContain("documentPath: README.md");
    expect(prompt).not.toContain("示例企业");
    expect(upstreamPromptCharacterCount(prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );

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
      "credential profile frozen by the application",
    );
    expect(await evidenceZip.file("knowledge.md")!.async("string")).toContain(
      "documentPath: README.md",
    );
    expect(
      JSON.parse(await evidenceZip.file("context.json")!.async("string")),
    ).toMatchObject({
      schemaVersion: 2,
      kind: "frontmind.brand-question-portfolio.input",
      planCode: "advanced",
      quotaPeriodId: "period-1",
      quotaRevision: 2,
      modelProfile: "frontmind-base",
      enterprise: context.enterprise,
      availableQuota: context.quota,
      candidateTargets: {
        industry: 3,
        competitor_comparison: 0,
        reputation: 0,
        product_scenario: 0,
      },
      knowledgeSnapshot: {
        id: "snapshot-1",
        version: 1,
        archiveHash: "a".repeat(64),
        sourceFileName: "company.zip",
      },
    });
  });

  it("keeps the outbound prompt bounded when every dynamic field is very large", async () => {
    const oversizedContext: BrandQuestionPortfolioContext = {
      ...context,
      quotaPeriodId: "期".repeat(50_000),
      enterprise: {
        identityHash: "b".repeat(64),
        canonicalName: "企业".repeat(100_000),
      },
      snapshot: {
        ...context.snapshot,
        sourceFileName: `${"知识库".repeat(100_000)}.zip`,
      },
    };

    const [prompt, evidenceArchive] = await Promise.all([
      buildBrandQuestionPortfolioPrompt(oversizedContext),
      buildBrandQuestionPortfolioEvidenceArchive(oversizedContext),
    ]);
    expect(upstreamPromptCharacterCount(prompt)).toBeLessThanOrEqual(
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
    );
    expect(prompt).not.toContain(oversizedContext.enterprise.canonicalName);

    const evidenceZip = await JSZip.loadAsync(evidenceArchive.bytes);
    const authoritativeInput = JSON.parse(
      await evidenceZip.file("context.json")!.async("string"),
    );
    expect(authoritativeInput.enterprise.canonicalName).toBe(
      oversizedContext.enterprise.canonicalName,
    );
    expect(authoritativeInput.quotaPeriodId).toBe(
      oversizedContext.quotaPeriodId,
    );
    expect(authoritativeInput.knowledgeSnapshot.sourceFileName).toBe(
      oversizedContext.snapshot.sourceFileName,
    );
  });

  it("parses only a v2 structured result bound to the current snapshot", () => {
    const parsed = parseBrandQuestionPortfolioStructuredValue(
      { payload: JSON.stringify(result()) },
      context,
    );
    expect(parsed.categories.industry[0]?.candidateId).toBe(
      "industrial-solution-category",
    );
  });

  it("rejects unknown fields and stale snapshot echoes without text repair", () => {
    const unknownSchema = { ...result(), unknownField: "must be rejected" };
    expect(() =>
      parseBrandQuestionPortfolioStructuredValue(
        { payload: JSON.stringify(unknownSchema) },
        context,
      ),
    ).toThrow();

    const stale = result();
    stale.knowledgeSnapshot.id = "snapshot-from-another-workspace";
    expect(() =>
      parseBrandQuestionPortfolioStructuredValue(
        { payload: JSON.stringify(stale) },
        context,
      ),
    ).toThrow("不匹配");
  });

  it("rejects prose, fences, raw output aliases and mismatched model profiles", () => {
    for (const value of [
      { payload: `result: ${JSON.stringify(result())}` },
      { payload: `\`\`\`json\n${JSON.stringify(result())}\n\`\`\`` },
      { output_text: JSON.stringify(result()) },
      { output_file: "result.json" },
    ]) {
      expect(() =>
        parseBrandQuestionPortfolioStructuredValue(value, context),
      ).toThrow();
    }

    const wrongModel = result();
    wrongModel.skill.model = "frontmind-pro";
    expect(() =>
      parseBrandQuestionPortfolioStructuredValue(
        { payload: JSON.stringify(wrongModel) },
        context,
      ),
    ).toThrow("不匹配");
  });
});
