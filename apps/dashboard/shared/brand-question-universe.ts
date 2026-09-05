import { z } from "zod";

export const BRAND_QUESTION_UNIVERSE_COLUMNS = [
  "序号",
  "问题",
  "核心词",
  "核心词分类",
  "问题细分",
] as const;

export const BRAND_QUESTION_UNIVERSE_CATEGORY_TARGETS = {
  行业排名词: 20,
  竞品对比词: 20,
  美誉舆情词: 20,
  产品场景词: 100,
} as const;

export const BRAND_QUESTION_UNIVERSE_SUBCATEGORIES = [
  "品牌认知",
  "品类发现",
  "产品能力",
  "竞品对比",
  "场景方案",
  "采购决策",
  "信任验证",
  "售后合作",
] as const;

const categorySchema = z.enum([
  "行业排名词",
  "竞品对比词",
  "美誉舆情词",
  "产品场景词",
]);
const subcategorySchema = z.enum(BRAND_QUESTION_UNIVERSE_SUBCATEGORIES);

export const brandQuestionUniverseRowSchema = z
  .object({
    序号: z.number().int().positive(),
    问题: z.string(),
    核心词: z.string(),
    核心词分类: categorySchema,
    问题细分: subcategorySchema,
  })
  .strict();

const researchCompetitorSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    url: z
      .string()
      .url()
      .max(2_048)
      .refine((value) => value.startsWith("https://")),
  })
  .strict();

export const brandQuestionUniversePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationToken: z.string().trim().min(16).max(128),
    research: z
      .object({ competitors: z.array(researchCompetitorSchema).min(2).max(20) })
      .strict(),
    rows: z.array(brandQuestionUniverseRowSchema).length(160),
  })
  .strict();

export type BrandQuestionUniverseRow = z.infer<
  typeof brandQuestionUniverseRowSchema
>;
export type BrandQuestionUniversePayload = z.infer<
  typeof brandQuestionUniversePayloadSchema
>;

export const brandQuestionUniverseStartInputSchema = z
  .object({
    knowledgeSnapshotId: z.string().uuid(),
    clientRequestId: z.string().uuid(),
    expectedDashboardRevision: z.number().int().nonnegative(),
  })
  .strict();

const FORMULA_PREFIX = /^[=+\-@]/;
const MEANINGFUL_NORMALIZATION_SYMBOL = /^[+#&]$/u;
const QUESTION_INTENT_STRIP =
  /哪家专业|哪家靠谱|哪家好|哪个好|怎么选择|如何选择|怎么选|如何选|选哪家|选哪个|推荐哪几家|值得考虑|推荐|有哪些|哪几家|哪些|名单|名录|排行榜|排名|对比|比较|有何不同|什么区别|区别|差异|优缺点|怎么样|如何|靠谱吗|是否靠谱|吗|呢/gi;
const CORE_TERM_QUESTION =
  /怎么|如何|为什么|为何|是否|哪些|哪家|哪个好|怎么办|怎么解决|推荐|值得考虑|哪家专业|哪家靠谱|对比|比较|区别|差异|优缺点|排名|排行榜|榜单|名单|名录|吗$|呢$/i;
const FORBIDDEN_PROMISES = [
  "零风险",
  "百分百",
  "100%",
  "保证有效",
  "保证成功",
  "绝对安全",
  "稳赚不赔",
  "包治",
  "治愈",
  "包过",
  "必过",
] as const;
const PROMOTIONAL_ASSERTION =
  /行业领先|全国领先|全球领先|顶级|最专业|首选|必选|公认第一|官方指定|唯一指定|权威认证|值得信赖/u;
const SEARCH_PHRASE_INTENTS: Record<string, RegExp> = {
  行业排名词:
    /推荐|哪家好|哪家专业|哪家靠谱|值得考虑|怎么选|如何选|选哪家|选哪个|名单|名录|有哪些|哪几家|排名/u,
  竞品对比词:
    /对比|比较|区别|差异|哪家好|哪个好|怎么选|如何选|优缺点|相比|还是|(?:和|与|vs|v\.s\.).*(?:哪家|哪个|对比|比较)/iu,
  美誉舆情词:
    /口碑|评价|认可度|可信度|专业度|可靠|靠谱|怎么样|体验|定位|声誉|满意度|售后|响应|稳定|规范|透明|合理|行业地位/u,
  产品场景词:
    /服务|功能|产品|项目|地区|区域|内容|能力|范围|价格|报价|收费|流程|材料|周期|条件|教程|方法|资质|报告|接入|使用|复测|售后|测试|检测|审计|方案|客户|对象|时效|发票|合同|验真|加急/u,
};
const TERMINAL_PUNCTUATION = /[。！!；;：:,，、…]/u;
const DANGLING_ENDINGS = [
  "的",
  "与",
  "和",
  "在",
  "对",
  "为",
  "把",
  "被",
  "从",
  "到",
] as const;
const COMPETITOR_PAIR = /.{2,}(?:和|与|vs|v\.s\.).{2,}/iu;
const CATEGORY_ORDER = Object.keys(
  BRAND_QUESTION_UNIVERSE_CATEGORY_TARGETS,
) as Array<keyof typeof BRAND_QUESTION_UNIVERSE_CATEGORY_TARGETS>;
const ALLOWED_SUBCATEGORIES: Record<
  keyof typeof BRAND_QUESTION_UNIVERSE_CATEGORY_TARGETS,
  ReadonlySet<string>
> = {
  行业排名词: new Set([
    "品类发现",
    "产品能力",
    "场景方案",
    "采购决策",
    "信任验证",
    "售后合作",
  ]),
  竞品对比词: new Set([
    "竞品对比",
    "产品能力",
    "场景方案",
    "采购决策",
    "信任验证",
    "售后合作",
  ]),
  美誉舆情词: new Set(["品牌认知", "采购决策", "信任验证", "售后合作"]),
  产品场景词: new Set([
    "品牌认知",
    "产品能力",
    "场景方案",
    "采购决策",
    "信任验证",
    "售后合作",
  ]),
};

function visibleLength(value: string) {
  return [...value].filter((character) => !/\s/u.test(character)).length;
}

function normalizeQuestion(value: string) {
  return Array.from(value.normalize("NFKC").toLocaleLowerCase("zh-CN"))
    .filter(
      (character) =>
        !/\s/u.test(character) &&
        (MEANINGFUL_NORMALIZATION_SYMBOL.test(character) ||
          !/[\p{P}\p{S}\p{Z}]/u.test(character)),
    )
    .join("");
}

function answerSignature(value: string) {
  return normalizeQuestion(
    value.normalize("NFKC").replace(QUESTION_INTENT_STRIP, ""),
  );
}

function industryFamily(value: string) {
  for (const [label, pattern] of [
    ["哪家专业", /哪家专业/u],
    ["哪家靠谱", /哪家靠谱/u],
    ["哪家好", /哪家好/u],
    ["推荐", /推荐/u],
    ["值得考虑", /值得考虑/u],
  ] as const) {
    if (pattern.test(value)) {
      return { family: "recommendation" as const, pattern: label };
    }
  }
  if (/怎么选|如何选|选哪家|选哪个/u.test(value)) {
    return { family: "selection" as const, pattern: "selection" };
  }
  if (/名单|名录|有哪些|哪几家|哪些/u.test(value)) {
    return { family: "factual_list" as const, pattern: "factual_list" };
  }
  return null;
}

function surfaceFormErrors(question: string, category: string, core: string) {
  const errors: string[] = [];
  const questionMarks = [...question].filter(
    (character) => character === "？" || character === "?",
  ).length;
  if (questionMarks > 0) {
    if (
      questionMarks !== 1 ||
      (!question.endsWith("？") && !question.endsWith("?"))
    ) {
      errors.push("QUESTION_MARK");
    }
    return { surface: "full_question" as const, errors };
  }
  if (TERMINAL_PUNCTUATION.test(question)) errors.push("PHRASE_PUNCTUATION");
  if (DANGLING_ENDINGS.some((ending) => question.endsWith(ending))) {
    errors.push("PHRASE_DANGLING");
  }
  const intent = SEARCH_PHRASE_INTENTS[category];
  if (!intent?.test(question)) errors.push("PHRASE_INTENT");
  if (normalizeQuestion(question) === normalizeQuestion(core)) {
    errors.push("PHRASE_EQUALS_CORE");
  }
  const objectText = question.replace(QUESTION_INTENT_STRIP, "");
  if (visibleLength(normalizeQuestion(objectText)) < 4) {
    errors.push("PHRASE_OBJECT");
  }
  if (category === "竞品对比词" && !COMPETITOR_PAIR.test(question)) {
    errors.push("PHRASE_COMPETITOR_PAIR");
  }
  return { surface: "search_phrase" as const, errors };
}

export class BrandQuestionUniverseValidationError extends Error {
  readonly codes: string[];

  constructor(codes: string[]) {
    super(`BRAND_QUESTION_UNIVERSE_INVALID:${codes.slice(0, 20).join(",")}`);
    this.name = "BrandQuestionUniverseValidationError";
    this.codes = [...new Set(codes)].slice(0, 80);
  }
}

/** Strict host-side validation. Provider success never weakens this contract. */
export function assertBrandQuestionUniversePayload(
  value: unknown,
  expectedOperationToken: string,
) {
  const schemaResult = brandQuestionUniversePayloadSchema.safeParse(value);
  if (!schemaResult.success) {
    throw new BrandQuestionUniverseValidationError([
      "SCHEMA",
      ...schemaResult.error.issues.map(
        (issue) =>
          `SCHEMA_${
            issue.path
              .map((part) =>
                String(part).replace(/[^A-Za-z0-9_\u3400-\u9fff]/gu, "_"),
              )
              .join("_") || "ROOT"
          }`,
      ),
    ]);
  }
  const parsed = schemaResult.data;
  const errors: string[] = [];
  if (parsed.operationToken !== expectedOperationToken)
    errors.push("OPERATION_TOKEN");
  if (
    new Set(
      parsed.research.competitors.map((item) =>
        item.name.normalize("NFKC").trim().toLowerCase(),
      ),
    ).size < 2
  ) {
    errors.push("RESEARCH_COMPETITORS");
  }

  const exact = new Set<string>();
  const normalized = new Set<string>();
  const signatures = new Set<string>();
  const categories = new Map<string, number>();
  const subcategories = new Set<string>();
  const industry = new Map<string, number>();
  const recommendationPatterns = new Map<string, number>();
  const expectedCategories = CATEGORY_ORDER.flatMap((category) =>
    Array(BRAND_QUESTION_UNIVERSE_CATEGORY_TARGETS[category]).fill(category),
  );

  parsed.rows.forEach((row, index) => {
    const rowCode = `ROW_${index + 1}`;
    if (row.序号 !== index + 1) errors.push(`${rowCode}_SEQUENCE`);
    if (row.核心词分类 !== expectedCategories[index])
      errors.push(`${rowCode}_CATEGORY_ORDER`);
    categories.set(row.核心词分类, (categories.get(row.核心词分类) ?? 0) + 1);
    subcategories.add(row.问题细分);
    if (!ALLOWED_SUBCATEGORIES[row.核心词分类].has(row.问题细分)) {
      errors.push(`${rowCode}_SUBCATEGORY`);
    }

    const question = row.问题.trim();
    const core = row.核心词.trim();
    if (question !== row.问题 || core !== row.核心词) {
      errors.push(`${rowCode}_TRIM`);
    }
    if (visibleLength(question) < 8 || visibleLength(question) > 32)
      errors.push(`${rowCode}_QUESTION_LENGTH`);
    if (visibleLength(core) < 2 || visibleLength(core) > 24)
      errors.push(`${rowCode}_CORE_LENGTH`);
    if (FORMULA_PREFIX.test(question) || FORMULA_PREFIX.test(core))
      errors.push(`${rowCode}_FORMULA`);
    if (/[,，\r\n]/.test(question) || /[,，\r\n？?]/.test(core))
      errors.push(`${rowCode}_PUNCTUATION`);
    if (CORE_TERM_QUESTION.test(core)) errors.push(`${rowCode}_CORE_INTENT`);
    const surface = surfaceFormErrors(question, row.核心词分类, core);
    for (const code of surface.errors) errors.push(`${rowCode}_${code}`);
    if (FORBIDDEN_PROMISES.some((promise) => question.includes(promise))) {
      errors.push(`${rowCode}_FORBIDDEN_PROMISE`);
    }
    if (
      surface.surface === "search_phrase" &&
      PROMOTIONAL_ASSERTION.test(question)
    ) {
      errors.push(`${rowCode}_PROMOTIONAL_ASSERTION`);
    }

    if (exact.has(question)) errors.push(`${rowCode}_EXACT_DUPLICATE`);
    exact.add(question);
    const normalizedValue = normalizeQuestion(question);
    if (!normalizedValue || normalized.has(normalizedValue))
      errors.push(`${rowCode}_NORMALIZED_DUPLICATE`);
    normalized.add(normalizedValue);
    const signature = answerSignature(question);
    if (signature.length >= 4 && signatures.has(signature))
      errors.push(`${rowCode}_ANSWER_DUPLICATE`);
    if (signature.length >= 4) signatures.add(signature);

    if (row.核心词分类 === "行业排名词") {
      const classified = industryFamily(question);
      if (!classified) errors.push(`${rowCode}_INDUSTRY_FAMILY`);
      else {
        industry.set(
          classified.family,
          (industry.get(classified.family) ?? 0) + 1,
        );
        if (classified.family === "recommendation") {
          recommendationPatterns.set(
            classified.pattern,
            (recommendationPatterns.get(classified.pattern) ?? 0) + 1,
          );
        }
      }
    }
  });

  for (const [category, target] of Object.entries(
    BRAND_QUESTION_UNIVERSE_CATEGORY_TARGETS,
  )) {
    if ((categories.get(category) ?? 0) !== target)
      errors.push(`CATEGORY_${category}`);
  }
  for (const subcategory of BRAND_QUESTION_UNIVERSE_SUBCATEGORIES) {
    if (!subcategories.has(subcategory))
      errors.push(`SUBCATEGORY_${subcategory}`);
  }
  if ((industry.get("recommendation") ?? 0) !== 12)
    errors.push("INDUSTRY_RECOMMENDATION_12");
  if ((industry.get("selection") ?? 0) !== 4)
    errors.push("INDUSTRY_SELECTION_4");
  if ((industry.get("factual_list") ?? 0) !== 4)
    errors.push("INDUSTRY_FACTUAL_4");
  if (
    (industry.get("recommendation") ?? 0) === 12 &&
    recommendationPatterns.size < 3
  ) {
    errors.push("INDUSTRY_RECOMMENDATION_PATTERNS_3");
  }
  if (
    (industry.get("recommendation") ?? 0) === 12 &&
    Math.max(0, ...recommendationPatterns.values()) > 6
  ) {
    errors.push("INDUSTRY_RECOMMENDATION_PATTERN_MAX_6");
  }
  if (
    !parsed.rows[0]?.问题.includes("推荐") ||
    parsed.rows[0]?.问题.includes("有哪些")
  ) {
    errors.push("ROW_1_RECOMMENDATION");
  }
  if (errors.length) throw new BrandQuestionUniverseValidationError(errors);
  return parsed;
}

export const BRAND_QUESTION_UNIVERSE_WIRE_SCHEMA = {
  type: "object",
  properties: { payload: { type: "string" } },
  required: ["payload"],
  additionalProperties: false,
} as const;
