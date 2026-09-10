import { toPublicDashboardPayload } from "./dashboard-service";
import type { DashboardPayload } from "../shared/dashboard";
import type { ServicePortal } from "../shared/service-portal";
import {
  assertServiceCapability,
  getServicePortal,
} from "./service-entitlement";

export const restrictedDashboardFields = [
  "metrics",
  "keywordTables",
  "questions",
  "monitoringAnswers",
  "citations",
  "contentAssets",
  "optimizationReport",
  "progressReports",
  "sections",
] as const satisfies readonly (keyof DashboardPayload)[];

/** Basic profile edits do not overwrite or require access to hidden modules. */
export async function assertDashboardUpdateCapability(input: {
  userId: number;
  existing: { payload: DashboardPayload };
  next: DashboardPayload;
  portal?: ServicePortal;
}) {
  if (
    !restrictedDashboardFields.some(
      (key) =>
        JSON.stringify(input.existing.payload[key]) !==
        JSON.stringify(input.next[key]),
    )
  )
    return;
  const portal = input.portal ?? (await getServicePortal(input.userId));
  if (portal.capabilities.contentAssets.allowed) return;
  await assertServiceCapability(input.userId, "contentAssets");
}

type Report = NonNullable<DashboardPayload["optimizationReport"]>;
function hasPrivateReportData(report: Report | null | undefined) {
  return (
    report?.questionReports?.some(
      (question) => question.afterEffect && !question.afterEffect.released,
    ) === true
  );
}

function mergeCustomerReport(
  next: Report | null,
  existing: Report | null,
): Report | null {
  if (!next) return hasPrivateReportData(existing) ? existing : null;
  const oldQuestions = new Map(
    (existing?.questionReports ?? []).map((row) => [row.id, row]),
  );
  const questions = (next.questionReports ?? []).map((row) => {
    const previous = oldQuestions.get(row.id);
    const { afterEffect: submittedEffect, ...publicFields } = row;
    const afterEffect = previous?.afterEffect?.released
      ? submittedEffect && { ...submittedEffect, released: true }
      : previous?.afterEffect;
    return { ...publicFields, ...(afterEffect ? { afterEffect } : {}) };
  });
  const nextIds = new Set(questions.map((row) => row.id));
  for (const row of existing?.questionReports ?? []) {
    if (!nextIds.has(row.id) && row.afterEffect && !row.afterEffect.released) {
      questions.push(row);
    }
  }
  return { ...next, questionReports: questions };
}

/** Merge only fields present in the customer's projection onto original data. */
export function mergeCustomerDashboardPayload(input: {
  existing: DashboardPayload;
  submitted: DashboardPayload;
  contentAssetsVisible: boolean;
}): DashboardPayload {
  const { existing, submitted } = input;
  if (!input.contentAssetsVisible) {
    return {
      ...existing,
      brandName: submitted.brandName,
      headline: submitted.headline,
      summary: submitted.summary,
    };
  }
  const priorReports = new Map(
    existing.progressReports.map((report) => [report.id, report]),
  );
  const progressReports = submitted.progressReports.map((version) => ({
    ...version,
    report: mergeCustomerReport(
      version.report,
      priorReports.get(version.id)?.report ?? null,
    )!,
  }));
  const nextIds = new Set(progressReports.map((version) => version.id));
  for (const version of existing.progressReports) {
    if (!nextIds.has(version.id) && hasPrivateReportData(version.report))
      progressReports.push(version);
  }
  return {
    ...submitted,
    // Monitoring observations are authored by their existing server pipelines.
    contentAssets: existing.contentAssets,
    monitoringAnswers: existing.monitoringAnswers,
    citations: existing.citations,
    optimizationReport: mergeCustomerReport(
      submitted.optimizationReport,
      existing.optimizationReport,
    ),
    progressReports,
  };
}

export function projectUserDashboardPayload(input: {
  payload: DashboardPayload;
  configured: boolean;
  contentAssetsAllowed: boolean;
}) {
  if (!input.configured) return null;
  const payload = toPublicDashboardPayload(input.payload);
  if (input.contentAssetsAllowed) return payload;
  return {
    ...payload,
    metrics: [],
    keywordTables: [],
    questions: [],
    monitoringAnswers: [],
    citations: [],
    contentAssets: [],
    optimizationReport: null,
    progressReports: [],
    sections: [],
  };
}
