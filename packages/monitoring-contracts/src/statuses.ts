import { z } from "zod";

export const roleSchema = z.enum(["user", "admin"]);
export type Role = z.infer<typeof roleSchema>;

export const userStatusSchema = z.enum(["active", "disabled"]);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const monitorStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "deleted",
]);
export type MonitorStatus = z.infer<typeof monitorStatusSchema>;

export const scheduleTypeSchema = z.enum(["none", "daily", "weekly"]);
export type ScheduleType = z.infer<typeof scheduleTypeSchema>;

export const runTriggerSchema = z.enum(["manual", "scheduled", "catch_up"]);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

export const runStatusSchema = z.enum([
  "queued",
  "waiting_quota",
  "running",
  "completed",
  "partial_completed",
  "failed",
  "review_required",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const attemptStatusSchema = z.enum([
  "queued",
  "submitting",
  "submission_unknown",
  "accepted",
  "processing",
  "completed",
  "failed",
  "stopped",
  "error",
  "cancelled_before_submit",
  "review_required",
]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const providerModeSchema = z.enum(["search", "reasoning_search"]);
export type ProviderMode = z.infer<typeof providerModeSchema>;

export const screenshotPolicySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
]);
export type ScreenshotPolicy = z.infer<typeof screenshotPolicySchema>;

export const clientTypeSchema = z.enum(["web", "mobile"]);
export type ClientType = z.infer<typeof clientTypeSchema>;

export const sentimentSchema = z.enum([
  "positive",
  "neutral",
  "negative",
  "unknown",
]);
export type Sentiment = z.infer<typeof sentimentSchema>;

export const quotaEntryTypeSchema = z.enum([
  "grant",
  "adjust",
  "reserve",
  "consume",
  "release",
]);
export type QuotaEntryType = z.infer<typeof quotaEntryTypeSchema>;

export const jobStatusSchema = z.enum([
  "ready",
  "leased",
  "retry_wait",
  "succeeded",
  "dead",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobTypeSchema = z.enum([
  "submit_attempt",
  "stop_attempt",
  "poll_attempt",
  "fetch_result",
  "archive_media",
  "schedule_catch_up",
  "dispatch_occurrences",
  "reconcile_billing",
  "purge_soft_deleted",
  "sync_provider_catalog",
]);
export type JobType = z.infer<typeof jobTypeSchema>;

export const quotaSettlementSchema = z.enum([
  "reserved",
  "consumed",
  "released",
]);
export type QuotaSettlement = z.infer<typeof quotaSettlementSchema>;
