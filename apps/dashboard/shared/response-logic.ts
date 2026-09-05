import { z } from "zod";

export const responseLogicAuthorizationSchema = z.enum([
  "公开可用",
  "已获授权",
  "仅内部参考",
  "待确认",
  "本次应答可用",
]);

export const responseLogicImageSchema = z.object({
  id: z.string().trim().min(1).max(191),
  name: z.string().trim().min(1).max(512),
  url: z.string().trim().max(4096),
  caption: z.string().max(2_000),
  source: z.string().max(4_000),
  section: z.string().max(512),
  authorization: responseLogicAuthorizationSchema,
});

/**
 * An uploaded source that has been accepted by the authenticated response-logic
 * route after its upstream file ownership was verified. Browser-only File/blob
 * values are deliberately not stored here.
 */
export const responseLogicAttachmentSchema = z.object({
  fileId: z
    .string()
    .max(255)
    .refine((value) => value.trim().length > 0, "fileId不能为空"),
  filename: z.string().trim().min(1).max(512),
  mimeType: z.string().trim().min(1).max(255),
  kind: z.enum(["image", "file"]),
  uploadedAt: z.string().datetime(),
  expiresAt: z.number().finite().optional(),
  expired: z.boolean().optional(),
});

export const responseLogicDraftSchema = z.object({
  concern: z.string().max(200_000),
  conclusion: z.string().max(500_000),
  facts: z.string().max(500_000),
  pending: z.string().max(300_000),
  boundaries: z.string().max(300_000),
  references: z.string().max(500_000),
  images: z.array(responseLogicImageSchema).max(200),
  attachments: z.array(responseLogicAttachmentSchema).max(200).default([]),
});

/**
 * The Pro response-logic task is machine-consumed. Keep this contract stricter
 * than the editable draft: a completed model response must contain exactly
 * these four customer-visible sections, in this order, before any part of it
 * may enter the draft.
 */
export const RESPONSE_LOGIC_MODEL_SECTIONS = [
  { heading: "用户真实关心", field: "concern" },
  { heading: "核心结论/执行口径", field: "conclusion" },
  { heading: "企业材料/官方依据", field: "facts" },
  { heading: "回答边界/禁止表达", field: "boundaries" },
] as const;

/**
 * Tasks that started before the four-section contract was deployed may still
 * complete with the former exact five-section shape. Accept only that exact
 * legacy shape, then discard its retired references section.
 */
const LEGACY_FIVE_RESPONSE_LOGIC_MODEL_SECTIONS = [
  { heading: "用户真实关心", field: "concern" },
  { heading: "核心结论/执行口径", field: "conclusion" },
  { heading: "企业材料/官方依据", field: "facts" },
  { heading: "回答边界/禁止表达", field: "boundaries" },
  { heading: "引用与核验规则", field: "references" },
] as const;

/**
 * The original seven-section contract is also accepted only as an exact
 * legacy shape. Its pending, references, and confirmation sections never
 * enter the current customer-visible draft.
 */
const LEGACY_SEVEN_RESPONSE_LOGIC_MODEL_SECTIONS = [
  { heading: "用户真实关心", field: "concern" },
  { heading: "核心结论/执行口径", field: "conclusion" },
  { heading: "企业材料/官方依据", field: "facts" },
  { heading: "待补充/待确认", field: "pending" },
  { heading: "回答边界/禁止表达", field: "boundaries" },
  { heading: "引用与核验规则", field: "references" },
  { heading: "本轮确认", field: "roundConfirmation" },
] as const;

export const responseLogicStructuredDraftSchema = z
  .object({
    concern: z.string().trim().min(1).max(200_000),
    conclusion: z.string().trim().min(1).max(500_000),
    facts: z.string().trim().min(1).max(500_000),
    boundaries: z.string().trim().min(1).max(300_000),
  })
  .strict();

const responseLogicTaskStatusBaseSchema = z.object({
  taskId: z.string().trim().min(1).max(255),
  operationRevision: z.number().int().positive(),
  model: z.string().trim().min(1).max(128),
});

/**
 * The dedicated response-logic task endpoint never shares the ordinary chat
 * task envelope. Keeping this as a discriminated union makes a truncated or
 * cross-wired response fail before any model text can reach the editor.
 */
export const responseLogicTaskStatusEnvelopeSchema = z.discriminatedUnion(
  "status",
  [
    responseLogicTaskStatusBaseSchema
      .extend({ status: z.enum(["running", "result_pending"]) })
      .strict(),
    responseLogicTaskStatusBaseSchema
      .extend({
        status: z.literal("completed"),
        resultId: z.string().trim().min(1).max(512),
        source: z.enum(["structured_output", "assistant_markdown"]),
        structuredDraft: responseLogicStructuredDraftSchema,
      })
      .strict(),
  ],
);

export class ResponseLogicOutputContractError extends Error {
  readonly code = "RESPONSE_LOGIC_TASK_OUTPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ResponseLogicOutputContractError";
  }
}

/**
 * Parse the final assistant message without forgiving aliases, missing
 * sections, duplicate sections, reordered headings, prose outside the
 * contract, or empty section bodies. This intentionally rejects code fences
 * and any extra Markdown heading as well.
 */
function parseResponseLogicSections(
  normalized: string,
  sections: readonly { heading: string; field: string }[],
) {
  const allMarkdownHeadings = Array.from(
    normalized.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm),
  );
  const levelTwoHeadings = allMarkdownHeadings.filter(
    (match) => match[1] === "##",
  );
  if (
    allMarkdownHeadings.length !== sections.length ||
    levelTwoHeadings.length !== sections.length
  ) {
    throw new ResponseLogicOutputContractError(
      `模型输出必须且只能包含 ${sections.length} 个二级栏目`,
    );
  }

  const values: Record<string, string> = {};
  for (let index = 0; index < sections.length; index += 1) {
    const expected = sections[index];
    const headingMatch = levelTwoHeadings[index];
    const actualHeading = headingMatch?.[2]?.trim();
    if (actualHeading !== expected.heading) {
      throw new ResponseLogicOutputContractError(
        `第 ${index + 1} 个栏目必须是“${expected.heading}”`,
      );
    }
    if (headingMatch.index === undefined) {
      throw new ResponseLogicOutputContractError("模型输出栏目位置无效");
    }
    if (
      index === 0 &&
      normalized.slice(0, headingMatch.index).trim().length > 0
    ) {
      throw new ResponseLogicOutputContractError(
        "模型输出不能在第一个栏目之前添加说明",
      );
    }
    const contentStart = headingMatch.index + headingMatch[0].length;
    const contentEnd = levelTwoHeadings[index + 1]?.index ?? normalized.length;
    const content = normalized.slice(contentStart, contentEnd).trim();
    if (!content) {
      throw new ResponseLogicOutputContractError(
        `栏目“${expected.heading}”不能为空`,
      );
    }
    values[expected.field] = content;
  }

  return values;
}

const RESPONSE_LOGIC_PROVENANCE_LABEL =
  /(?:来源路径|来源文件|引用文档|知识库版本)[：:]\s*[^，,；;。\n）)]*/giu;
const RESPONSE_LOGIC_URL = /https?:\/\/[^\s，。；;、)）]+/giu;
const RESPONSE_LOGIC_INTERNAL_PATH =
  /(?:[A-Za-z0-9_.*-]+[\\/])+[A-Za-z0-9_.*-]+\.(?:md|markdown|zip|json|html?|pptx?|pdf|docx?|xlsx?|csv|txt|png|jpe?g|webp|gif)(?:\?[^\s，。；;、)）]+)?/giu;
const RESPONSE_LOGIC_KNOWLEDGE_FILENAME =
  /(^|[\s（(:：，、；;])([\p{L}\p{N}_.*-]+\.(?:md|markdown|zip|json|html?|pptx?)(?:\?[^\s，。；;、)）]+)?)/gimu;
const RESPONSE_LOGIC_UPLOAD_FILENAME =
  /(^|[\s（(:：，、；;])([\p{L}\p{N}_.*-]+\.(?:pdf|docx?|xlsx?|csv|txt|png|jpe?g|webp|gif)(?:\?[^\s，。；;、)）]+)?)/gimu;

/**
 * Remove implementation-only provenance from one customer-visible field while
 * preserving any factual statement that follows the source marker.
 */
export function normalizeResponseLogicPublicText(value: string) {
  const normalized = value
    .replace(RESPONSE_LOGIC_PROVENANCE_LABEL, "引自知识库文档")
    .replace(RESPONSE_LOGIC_URL, "知识库文档")
    .replace(RESPONSE_LOGIC_INTERNAL_PATH, "知识库文档")
    .replace(RESPONSE_LOGIC_KNOWLEDGE_FILENAME, "$1知识库文档")
    .replace(
      RESPONSE_LOGIC_UPLOAD_FILENAME,
      (_match, prefix: string, name: string) =>
        `${prefix}${/\.(?:png|jpe?g|webp|gif)(?:\?|$)/iu.test(name) ? "用户上传图片" : "用户上传资料"}`,
    )
    .replace(/知识库(?:版本)?\s*[：:]?\s*V\d+(?:\.\d+)*/giu, "知识库文档")
    .replace(/(?:引自知识库文档\s*){2,}/gu, "引自知识库文档")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized
    .split("\n")
    .filter(
      (line) =>
        !/^[ \t]*(?:[-+*]|\d+[.)、])?[ \t]*(?:引自知识库文档[，,；;、]?[ \t]*)+$/u.test(
          line,
        ),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeResponseLogicPublicProvenance<
  T extends {
    concern: string;
    conclusion: string;
    facts: string;
    boundaries: string;
    references?: string;
  },
>(value: T): T {
  return {
    ...value,
    concern: normalizeResponseLogicPublicText(value.concern),
    conclusion: normalizeResponseLogicPublicText(value.conclusion),
    facts:
      normalizeResponseLogicPublicText(value.facts) ||
      "相关企业事实引自知识库文档。",
    boundaries: normalizeResponseLogicPublicText(value.boundaries),
    ...(Object.prototype.hasOwnProperty.call(value, "references")
      ? { references: "" }
      : {}),
  } as T;
}

export function serializeResponseLogicStructuredDraft(
  value: ResponseLogicStructuredDraft,
) {
  return RESPONSE_LOGIC_MODEL_SECTIONS.map(
    ({ heading, field }) => `## ${heading}\n\n${value[field]}`,
  ).join("\n\n");
}

/**
 * The response-logic conversation keeps the provider's raw output internally,
 * but its customer-facing bubble uses the same four-section projection as the
 * draft. Partial/conversational messages still receive narrow provenance
 * cleanup and never expose the three retired legacy sections.
 */
export function projectResponseLogicAssistantMarkdown(markdown: string) {
  try {
    return serializeResponseLogicStructuredDraft(
      parseResponseLogicStructuredDraft(markdown),
    );
  } catch {
    const visibleLines: string[] = [];
    let skippingLegacySection = false;
    for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
      const heading = line.match(/^##[ \t]+(.+?)[ \t]*$/u)?.[1]?.trim();
      if (heading) {
        skippingLegacySection = [
          "待补充/待确认",
          "引用与核验规则",
          "本轮确认",
        ].includes(heading);
      }
      if (!skippingLegacySection) visibleLines.push(line);
    }
    return normalizeResponseLogicPublicText(visibleLines.join("\n"));
  }
}

export function parseResponseLogicStructuredDraft(
  markdown: string,
): ResponseLogicStructuredDraft {
  const normalized = markdown
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) {
    throw new ResponseLogicOutputContractError("模型没有返回应答逻辑内容");
  }

  let values: Record<string, string>;
  try {
    values = parseResponseLogicSections(
      normalized,
      RESPONSE_LOGIC_MODEL_SECTIONS,
    );
  } catch (currentContractError) {
    try {
      values = parseResponseLogicSections(
        normalized,
        LEGACY_FIVE_RESPONSE_LOGIC_MODEL_SECTIONS,
      );
    } catch {
      try {
        values = parseResponseLogicSections(
          normalized,
          LEGACY_SEVEN_RESPONSE_LOGIC_MODEL_SECTIONS,
        );
      } catch {
        throw currentContractError;
      }
    }
  }

  values = Object.fromEntries(
    RESPONSE_LOGIC_MODEL_SECTIONS.map((section) => [
      section.field,
      values[section.field],
    ]),
  );

  const parsed = responseLogicStructuredDraftSchema.safeParse(values);
  if (!parsed.success) {
    throw new ResponseLogicOutputContractError(
      "模型输出栏目内容超出允许范围或格式无效",
    );
  }
  return normalizeResponseLogicPublicProvenance(parsed.data);
}

/**
 * Parse only the currently dispatched four-section contract. Server-side
 * status recovery must not accept a legacy five/seven-section assistant turn:
 * those compatibility shapes are reserved for explicitly loaded historical
 * content and must never satisfy a newly completed provider operation.
 */
export function parseCurrentResponseLogicStructuredDraft(
  markdown: string,
): ResponseLogicStructuredDraft {
  const normalized = markdown
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) {
    throw new ResponseLogicOutputContractError("模型没有返回应答逻辑内容");
  }
  const parsedSections = parseResponseLogicSections(
    normalized,
    RESPONSE_LOGIC_MODEL_SECTIONS,
  );
  const values = Object.fromEntries(
    RESPONSE_LOGIC_MODEL_SECTIONS.map((section) => [
      section.field,
      parsedSections[section.field],
    ]),
  );
  const parsed = responseLogicStructuredDraftSchema.safeParse(values);
  if (!parsed.success) {
    throw new ResponseLogicOutputContractError(
      "模型输出栏目内容超出允许范围或格式无效",
    );
  }
  return normalizeResponseLogicPublicProvenance(parsed.data);
}

export const confirmedResponseLogicSchema = responseLogicDraftSchema.extend({
  version: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});

export const responseLogicQuestionSchema = z.object({
  questionId: z.string().trim().min(1).max(191),
  groupId: z.string().trim().min(1).max(128),
  groupTitle: z.string().trim().min(1).max(255),
  question: z.string().trim().min(1).max(2_000),
  intent: z.string().max(8_000),
  summary: z.string().max(8_000),
});

export const saveResponseLogicSchema = responseLogicQuestionSchema.extend({
  /**
   * Optimistic record revision. A missing value is the first-write revision,
   * so older clients cannot silently overwrite an existing or just-cleared
   * response logic record.
   */
  expectedRevision: z.number().int().nonnegative().default(0),
  /** Atomic guard used when persisting one validated provider task result. */
  expectedTaskId: z.string().trim().min(1).max(255).optional(),
  /** Exact response-logic operation that produced the validated result. */
  expectedOperationRevision: z.number().int().positive().optional(),
  conversationId: z.string().trim().min(1).max(191).optional(),
  draft: responseLogicDraftSchema,
  publish: z.boolean().default(false),
});

export type ResponseLogicAuthorization = z.infer<
  typeof responseLogicAuthorizationSchema
>;
export type ResponseLogicImage = z.infer<typeof responseLogicImageSchema>;
export type ResponseLogicAttachment = z.infer<
  typeof responseLogicAttachmentSchema
>;
export type ResponseLogicDraft = z.infer<typeof responseLogicDraftSchema>;
export type ResponseLogicStructuredDraft = z.infer<
  typeof responseLogicStructuredDraftSchema
>;
export type ResponseLogicTaskStatusEnvelope = z.infer<
  typeof responseLogicTaskStatusEnvelopeSchema
>;
export type ConfirmedResponseLogic = z.infer<
  typeof confirmedResponseLogicSchema
>;
export type ResponseLogicQuestion = z.infer<typeof responseLogicQuestionSchema>;
export type SaveResponseLogicInput = z.infer<typeof saveResponseLogicSchema>;

export type ResponseLogicRecordDto = ResponseLogicQuestion & {
  id: string;
  conversationId?: string;
  lastTaskId?: string;
  draft: ResponseLogicDraft;
  confirmed?: ConfirmedResponseLogic;
  /** Optimistic record revision. Increments on every draft/task/publish write. */
  revision: number;
  /** Published confirmation version. Increments only when a formal version is published. */
  version: number;
  createdAt: number;
  updatedAt: number;
};
