import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import {
  serviceContracts,
  serviceQuotaPeriods,
  users,
  workspaceQuestions,
} from "../drizzle/schema";
import { SERVICE_PLAN_CATALOG } from "../shared/service-portal";
import { DELIVERY_TICKET_LIMITS } from "../shared/delivery-ticket";
import { getServiceContractTermEnd } from "./service-entitlement";

export async function provisionBasicEntitlement(
  tx: any,
  input: {
    userId: number;
    orderId: string;
    projectId: string;
    questionId: string;
    question: string;
    category: "product_scenario" | "reputation" | "competitor_comparison";
    startsAt: Date;
    amountFen?: number | null;
    currency?: string;
    externalContractReference?: string | null;
    signedAt?: Date | null;
    signatoryId?: string | null;
    signingEvidence?: Record<string, unknown> | null;
    actorUserId?: number | null;
    now?: Date;
  },
) {
  const targetUsers = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
    .for("update");
  if (!targetUsers[0]) {
    throw new Error("Cannot provision service for a missing user");
  }
  const existing = await tx
    .select({ id: serviceContracts.id })
    .from(serviceContracts)
    .where(
      and(
        eq(serviceContracts.userId, input.userId),
        eq(serviceContracts.source, "website"),
        eq(serviceContracts.sourceReference, input.orderId),
      ),
    )
    .limit(1)
    .for("update");
  if (existing[0]) return existing[0].id as string;

  const revisions = await tx
    .select({ revision: serviceContracts.revision })
    .from(serviceContracts)
    .where(eq(serviceContracts.userId, input.userId))
    .orderBy(desc(serviceContracts.revision))
    .limit(1)
    .for("update");
  const now = input.now ?? new Date();
  const contractId = randomUUID();
  const quotaPeriodId = randomUUID();
  const endsAt = getServiceContractTermEnd("basic", input.startsAt);
  await tx.insert(serviceContracts).values({
    id: contractId,
    userId: input.userId,
    planCode: "basic",
    planVersion: SERVICE_PLAN_CATALOG.basic.planVersion,
    status: input.startsAt.getTime() > now.getTime() ? "scheduled" : "active",
    startsAt: input.startsAt,
    endsAt,
    source: "website",
    amountFen: input.amountFen ?? null,
    currency: input.currency?.trim().toUpperCase() || "CNY",
    prepaidMonths: null,
    orderReference: input.orderId,
    externalContractReference: input.externalContractReference?.trim() || null,
    signedAt: input.signedAt ?? null,
    signatoryId: input.signatoryId?.trim() || null,
    signingEvidence: input.signingEvidence ?? null,
    sourceReference: input.orderId,
    revision: (revisions[0]?.revision ?? 0) + 1,
    createdByUserId: input.actorUserId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(serviceQuotaPeriods).values({
    id: quotaPeriodId,
    contractId,
    userId: input.userId,
    ordinal: 1,
    startsAt: input.startsAt,
    endsAt,
    ...SERVICE_PLAN_CATALOG.basic.limits,
    contentAssetPublishLimit:
      DELIVERY_TICKET_LIMITS.basic.content_asset_publish,
    websiteContentPublishLimit:
      DELIVERY_TICKET_LIMITS.basic.website_content_publish,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(workspaceQuestions).values({
    id: randomUUID(),
    userId: input.userId,
    contractId,
    quotaPeriodId,
    externalQuestionId: input.questionId,
    candidateKey: `website:${input.projectId}:${input.questionId}`.slice(
      0,
      191,
    ),
    category: input.category,
    question: input.question,
    rationale: "官网普通版已购问题",
    source: "website",
    status: "selected",
    selectionApprovalStatus: "approved",
    selectionRequestedAt: now,
    selectionRequestedByUserId: input.actorUserId ?? null,
    selectionApprovedAt: now,
    selectionApprovedByUserId: input.actorUserId ?? null,
    locked: true,
    sourceTaskId: `website-order:${input.orderId}`.slice(0, 255),
    knowledgeSnapshotId: null,
    ordinal: 0,
    revision: 1,
    selectedAt: now,
    archivedAt: null,
    createdByUserId: input.actorUserId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return contractId;
}
