import { z } from "zod";

export const responseLogicAuthorizationSchema = z.enum([
  "公开可用",
  "已获授权",
  "仅内部参考",
  "待确认",
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
 * these seven customer-visible sections, in this order, before any part of it
 * may enter the draft.
 */
export const RESPONSE_LOGIC_MODEL_SECTIONS = [
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
    pending: z.string().trim().min(1).max(300_000),
    boundaries: z.string().trim().min(1).max(300_000),
    references: z.string().trim().min(1).max(500_000),
    roundConfirmation: z.string().trim().min(1).max(100_000),
  })
  .strict();

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

  const allMarkdownHeadings = Array.from(
    normalized.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gm),
  );
  const levelTwoHeadings = allMarkdownHeadings.filter(
    (match) => match[1] === "##",
  );
  if (
    allMarkdownHeadings.length !== RESPONSE_LOGIC_MODEL_SECTIONS.length ||
    levelTwoHeadings.length !== RESPONSE_LOGIC_MODEL_SECTIONS.length
  ) {
    throw new ResponseLogicOutputContractError(
      `模型输出必须且只能包含 ${RESPONSE_LOGIC_MODEL_SECTIONS.length} 个二级栏目`,
    );
  }

  const values: Record<string, string> = {};
  for (
    let index = 0;
    index < RESPONSE_LOGIC_MODEL_SECTIONS.length;
    index += 1
  ) {
    const expected = RESPONSE_LOGIC_MODEL_SECTIONS[index];
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

  const parsed = responseLogicStructuredDraftSchema.safeParse(values);
  if (!parsed.success) {
    throw new ResponseLogicOutputContractError(
      "模型输出栏目内容超出允许范围或格式无效",
    );
  }
  return parsed.data;
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
