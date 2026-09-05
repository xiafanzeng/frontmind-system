import type { ResponseLogicRecordDto } from "../shared/response-logic";
import {
  historicalQuestionResultsSchema,
  type HistoricalQuestionResults,
} from "../shared/historical-results";
import type { ServicePortal } from "../shared/service-portal";
import { toPublicServicePortalQuestion } from "../shared/service-portal";
import {
  listMonitoringCitations,
  listMonitoringSamples,
  resolveQuestionLineageIds,
} from "./monitoring-service";
import { listResponseLogicEntriesByQuestionIds } from "./response-logic-service";
import {
  getServicePortal,
  ServiceEntitlementError,
} from "./service-entitlement";

type MonitoringSamplesResult = Awaited<
  ReturnType<typeof listMonitoringSamples>
>;
type MonitoringCitationsResult = Awaited<
  ReturnType<typeof listMonitoringCitations>
>;

export type HistoricalResultsDependencies = {
  loadPortal: (userId: number) => Promise<ServicePortal>;
  resolveLineage: (userId: number, questionId: string) => Promise<string[]>;
  loadResponseLogic: (
    userId: number,
    questionIds: string[],
  ) => Promise<ResponseLogicRecordDto[]>;
  loadMonitoringSamples: (
    userId: number,
    questionId: string,
  ) => Promise<MonitoringSamplesResult>;
  loadMonitoringCitations: (
    userId: number,
    questionId: string,
  ) => Promise<MonitoringCitationsResult>;
};

const DEFAULT_DEPENDENCIES: HistoricalResultsDependencies = {
  loadPortal: (userId) => getServicePortal(userId),
  resolveLineage: resolveQuestionLineageIds,
  loadResponseLogic: listResponseLogicEntriesByQuestionIds,
  loadMonitoringSamples: (userId, questionId) =>
    listMonitoringSamples({
      userId,
      filters: {
        questionId,
        query: "",
        page: 1,
        pageSize: 100,
        sortOrder: "desc",
      },
    }),
  loadMonitoringCitations: (userId, questionId) =>
    listMonitoringCitations({
      userId,
      filters: {
        questionId,
        query: "",
        page: 1,
        pageSize: 100,
        sortBy: "collectedAt",
        sortOrder: "desc",
      },
    }),
};

function questionIdentityIds(
  question: ServicePortal["historicalQuestions"][number],
) {
  return [
    question.id,
    question.externalQuestionId,
    question.sourceQuestionId,
  ].filter((value): value is string => Boolean(value));
}

/**
 * Historical access is granted by the server portal, never by a client flag.
 * The result intentionally has no task/conversation identifiers and no write
 * operation. Active-question editors remain on their existing, separately
 * guarded routes.
 */
export async function getHistoricalQuestionResults(
  input: {
    userId: number;
    questionId: string;
  },
  dependencies: HistoricalResultsDependencies = DEFAULT_DEPENDENCIES,
): Promise<HistoricalQuestionResults> {
  const portal = await dependencies.loadPortal(input.userId);
  const question = portal.historicalQuestions.find((candidate) =>
    questionIdentityIds(candidate).includes(input.questionId),
  );
  if (!question) {
    throw new ServiceEntitlementError(
      "QUESTION_NOT_FOUND",
      "该问题不属于当前账号的只读历史成果。",
      404,
    );
  }

  const resolvedLineage = await dependencies.resolveLineage(
    input.userId,
    question.id,
  );
  const lineageQuestionIds = [
    ...new Set([...questionIdentityIds(question), ...resolvedLineage]),
  ];
  const [records, samples, citations] = await Promise.all([
    dependencies.loadResponseLogic(input.userId, lineageQuestionIds),
    dependencies.loadMonitoringSamples(input.userId, question.id),
    dependencies.loadMonitoringCitations(input.userId, question.id),
  ]);

  return historicalQuestionResultsSchema.parse({
    readOnly: true,
    question: toPublicServicePortalQuestion(question),
    lineageQuestionIds,
    responseLogic: records
      .map((record) => ({
        recordId: record.id,
        questionId: record.questionId,
        status: record.confirmed ? "confirmed" : "draft",
        version: record.confirmed?.version ?? record.version,
        updatedAt: record.updatedAt,
        content: record.confirmed ?? record.draft,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt),
    monitoring: {
      samples: samples.items,
      sampleTotal: samples.total,
      citations: citations.items,
      citationTotal: citations.total,
    },
  });
}
