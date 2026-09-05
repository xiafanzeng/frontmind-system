import { z } from "zod";

const nullableScalar = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .optional();
const nullableNumeric = z.union([z.string(), z.number(), z.null()]).optional();
const nullableText = z.union([z.string(), z.number(), z.null()]).optional();

export const kolPaginationSchema = z
  .object({
    current_page: z.coerce.number().int().nonnegative(),
    last_page: z.coerce.number().int().nonnegative(),
    per_page: z.coerce.number().int().positive().max(10_000),
    total: z.coerce.number().int().nonnegative(),
  })
  .passthrough();

export const kolAuthenticationResponseSchema = z
  .object({
    success: z.literal(true),
    status: z.coerce.number().int(),
    data: z
      .object({ token: z.string().trim().min(1).max(16_384) })
      .passthrough(),
  })
  .passthrough();

export const kolResourceSchema = z
  .object({
    id: z.coerce.number().int().positive(),
    name: z.string().trim().min(1).max(500),
    platform: nullableText,
    taxonomy: nullableText,
    media: nullableText,
    area: nullableText,
    case_url: nullableText,
    title_limit: nullableNumeric,
    price: nullableNumeric,
    pc_weight: nullableNumeric,
    m_weight: nullableNumeric,
    success_radio: nullableNumeric,
    include_radio: nullableNumeric,
    publish_time: nullableText,
    include_type: nullableText,
    url_type: nullableText,
    in_url: nullableText,
    in_level: nullableText,
    // Tolerated legacy aliases; documented fields above always win.
    entry_type: nullableText,
    link_type: nullableText,
    logo: nullableText,
    icon: nullableText,
    remark: nullableText,
    description: nullableText,
    is_zimeiti: z.union([
      z.literal(1),
      z.literal(2),
      z.literal("1"),
      z.literal("2"),
    ]),
    is_recommend: nullableScalar,
    auth: nullableScalar,
    festival: nullableScalar,
    fans_num: nullableNumeric,
    likes_num: nullableNumeric,
    like_num: nullableNumeric,
    publish_count: nullableNumeric,
  })
  .passthrough();

export const kolResourcePageSchema = z
  .object({
    success: z.literal(true),
    status: z.coerce.number().int(),
    pagination: kolPaginationSchema,
    data: z.array(kolResourceSchema).max(10_000),
  })
  .passthrough();

export const kolCreateOrderResponseSchema = z
  .object({
    success: z.literal(true),
    status: z.coerce.number().int(),
    message: z.string().max(2_000).optional(),
    response_data: z
      .array(
        z
          .object({
            order_id: z
              .union([z.string(), z.number()])
              .transform(String)
              .pipe(z.string().trim().min(1).max(128)),
            paid_at: z.union([z.string(), z.number(), z.null()]).optional(),
            resource_id: z.coerce.number().int().positive(),
            resource_name: z.string().trim().min(1).max(500),
          })
          .passthrough(),
      )
      .max(20),
  })
  .passthrough();

export const kolOrderSchema = z
  .object({
    id: z.coerce.number().int().positive(),
    resource_id: z.coerce.number().int().positive(),
    order_id: z
      .union([z.string(), z.number()])
      .transform(String)
      .pipe(z.string().trim().min(1).max(128)),
    title: z.string().max(1_000).default(""),
    status: z.coerce.number().int(),
    response_message: nullableText,
    price: nullableNumeric,
    resource_name: nullableText,
    manuscript_id: nullableText,
    created_at: nullableNumeric,
    updated_at: nullableNumeric,
  })
  .passthrough();

export const kolOrderPageSchema = z
  .object({
    success: z.literal(true),
    status: z.coerce.number().int(),
    pagination: kolPaginationSchema.optional(),
    data: z.union([
      z.array(kolOrderSchema).max(10_000),
      kolOrderSchema,
      z.null(),
    ]),
  })
  .passthrough();

export const kolErrorEnvelopeSchema = z
  .object({
    success: z.boolean().optional(),
    status: z.coerce.number().int().optional(),
    message: z.string().max(2_000).optional(),
  })
  .passthrough();

export type KolRawResource = z.infer<typeof kolResourceSchema>;
export type KolRawOrder = z.infer<typeof kolOrderSchema>;
