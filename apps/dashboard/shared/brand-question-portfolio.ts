import { z } from "zod";

export const brandQuestionCategorySchema = z.enum([
  "industry",
  "competitor_comparison",
  "reputation",
  "product_scenario",
]);

export type BrandQuestionCategory = z.infer<
  typeof brandQuestionCategorySchema
>;

const evidenceSchema = z
  .object({
    documentPath: z.string().trim().min(1).max(1024),
    excerpt: z.string().trim().min(1).max(500),
    relevance: z.string().trim().min(1).max(1000),
  })
  .strict();

export const brandQuestionCandidateSchema = z
  .object({
    candidateId: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    question: z.string().trim().min(4).max(500),
    intent: z.string().trim().min(1).max(1000),
    rationale: z.string().trim().min(1).max(2000),
    evidence: z.array(evidenceSchema).min(1).max(8),
    risks: z.array(z.string().trim().min(1).max(500)).max(12),
  })
  .strict();

const categoryCandidatesSchema = z.array(brandQuestionCandidateSchema).max(200);
const candidateTargetsSchema = z
  .object({
    industry: z.number().int().nonnegative().max(200),
    competitor_comparison: z.number().int().nonnegative().max(200),
    reputation: z.number().int().nonnegative().max(200),
    product_scenario: z.number().int().nonnegative().max(200),
  })
  .strict();

export const brandQuestionPortfolioSchema = z
  .object({
    schemaVersion: z.literal(1),
    skill: z
      .object({
        name: z.literal("brand-question-portfolio"),
        version: z.literal("2"),
        model: z.literal("frontmind-pro"),
      })
      .strict(),
    knowledgeSnapshot: z
      .object({
        id: z.string().trim().min(1).max(64),
        version: z.number().int().positive(),
        archiveHash: z.string().trim().regex(/^[a-f0-9]{64}$/i),
      })
      .strict(),
    enterprise: z
      .object({
        identityHash: z.string().trim().regex(/^[a-f0-9]{64}$/i),
        canonicalName: z.string().trim().min(1).max(200),
      })
      .strict(),
    planCode: z.enum(["advanced", "luxury"]),
    quotaPeriodId: z.string().trim().min(1).max(64),
    candidateTargets: candidateTargetsSchema,
    categories: z
      .object({
        industry: categoryCandidatesSchema,
        competitor_comparison: categoryCandidatesSchema,
        reputation: categoryCandidatesSchema,
        product_scenario: categoryCandidatesSchema,
      })
      .strict(),
    shortfalls: z
      .array(
        z
          .object({
            category: brandQuestionCategorySchema,
            target: z.number().int().positive().max(200),
            generated: z.number().int().nonnegative().max(200),
            reason: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(4),
    risks: z.array(z.string().trim().min(1).max(500)).max(30),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [category, candidates] of Object.entries(value.categories)) {
      const categoryKey = category as BrandQuestionCategory;
      const target = value.candidateTargets[categoryKey];
      if (candidates.length > target) {
        context.addIssue({
          code: "custom",
          path: ["categories", category],
          message: "candidate count exceeds the server-authoritative target",
        });
      }
      const shortfall = value.shortfalls.find(
        (item) => item.category === categoryKey,
      );
      if (candidates.length < target) {
        if (
          !shortfall ||
          shortfall.target !== target ||
          shortfall.generated !== candidates.length
        ) {
          context.addIssue({
            code: "custom",
            path: ["shortfalls", category],
            message:
              "a category below target requires an exact structured shortfall",
          });
        }
      } else if (shortfall) {
        context.addIssue({
          code: "custom",
          path: ["shortfalls", category],
          message: "a category at target must not include a shortfall",
        });
      }
      for (const candidate of candidates) {
        if (seen.has(candidate.candidateId)) {
          context.addIssue({
            code: "custom",
            path: ["categories", category, candidate.candidateId],
            message: "candidateId must be unique across the portfolio",
          });
        }
        seen.add(candidate.candidateId);
      }
    }
  });

export type BrandQuestionCandidate = z.infer<
  typeof brandQuestionCandidateSchema
>;
export type BrandQuestionPortfolio = z.infer<
  typeof brandQuestionPortfolioSchema
>;

export function portfolioCandidates(
  portfolio: BrandQuestionPortfolio,
): Array<BrandQuestionCandidate & { category: BrandQuestionCategory }> {
  return brandQuestionCategorySchema.options.flatMap((category) =>
    portfolio.categories[category].map((candidate) => ({
      ...candidate,
      category,
    })),
  );
}

export function assertBrandQuestionPortfolioContext(
  portfolio: BrandQuestionPortfolio,
  expected: {
    snapshotId: string;
    snapshotVersion: number;
    archiveHash: string;
    planCode: "advanced" | "luxury";
    quotaPeriodId: string;
    enterprise: { identityHash: string; canonicalName: string };
    candidateTargets: Record<BrandQuestionCategory, number>;
    documents: Iterable<{ path: string; content: string }>;
  },
) {
  if (
    portfolio.knowledgeSnapshot.id !== expected.snapshotId ||
    portfolio.knowledgeSnapshot.version !== expected.snapshotVersion ||
    portfolio.knowledgeSnapshot.archiveHash.toLowerCase() !==
      expected.archiveHash.toLowerCase() ||
    portfolio.planCode !== expected.planCode ||
    portfolio.quotaPeriodId !== expected.quotaPeriodId ||
    portfolio.enterprise.identityHash.toLowerCase() !==
      expected.enterprise.identityHash.toLowerCase() ||
    portfolio.enterprise.canonicalName !== expected.enterprise.canonicalName
  ) {
    throw new Error("品牌全域词库结果与当前知识库或服务周期不匹配");
  }
  for (const category of brandQuestionCategorySchema.options) {
    if (
      portfolio.candidateTargets[category] !==
      expected.candidateTargets[category]
    ) {
      throw new Error("品牌全域词库候选数量与当前服务额度不匹配");
    }
  }
  const documentContents = new Map(
    [...expected.documents].map((document) => [
      document.path,
      document.content,
    ]),
  );
  const normalizedEnterprise = expected.enterprise.canonicalName
    .normalize("NFKC")
    .toLowerCase();
  const normalizeEvidence = (value: string) =>
    value.normalize("NFKC").replace(/\s+/g, " ").trim();
  for (const candidate of portfolioCandidates(portfolio)) {
    if (
      !candidate.question
        .normalize("NFKC")
        .toLowerCase()
        .includes(normalizedEnterprise)
    ) {
      throw new Error("候选问题未明确指向当前企业");
    }
    for (const evidence of candidate.evidence) {
      const documentContent = documentContents.get(evidence.documentPath);
      if (documentContent === undefined) {
        throw new Error(
          `候选问题引用了当前知识库中不存在的路径：${evidence.documentPath}`,
        );
      }
      if (
        !normalizeEvidence(documentContent).includes(
          normalizeEvidence(evidence.excerpt),
        )
      ) {
        throw new Error(
          `候选问题的证据摘录不在原始文档中：${evidence.documentPath}`,
        );
      }
    }
  }
  return portfolio;
}
