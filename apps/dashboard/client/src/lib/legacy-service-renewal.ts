/** Historical contract display helpers retained for archived records only. */
type AdminServicePlanCode = "basic" | "advanced" | "luxury";

type AdminServicePurchase = {
  id: string;
  planCode: AdminServicePlanCode;
  status: string;
  validFrom?: number | null;
  validUntil?: number | null;
};

function shanghaiServiceDateInput(value: number) {
  return new Date(value + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

export function resolveAdminServiceStartsAtEpoch(input: {
  dateInput: string;
  sourcePlanCode?: AdminServicePlanCode | null;
  targetPlanCode: AdminServicePlanCode;
  currentContractId?: string | null;
  purchases?: AdminServicePurchase[];
}) {
  const midnight = new Date(`${input.dateInput}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(midnight)) return null;
  const source = input.purchases?.find(
    (purchase) => purchase.id === input.currentContractId,
  );
  if (
    input.sourcePlanCode === "luxury" &&
    input.targetPlanCode === "luxury" &&
    source?.planCode === "luxury" &&
    Number.isFinite(source.validUntil) &&
    shanghaiServiceDateInput(source.validUntil!) === input.dateInput
  ) {
    return source.validUntil!;
  }
  if (
    source &&
    source.planCode === input.sourcePlanCode &&
    input.targetPlanCode === input.sourcePlanCode &&
    Number.isFinite(source.validFrom) &&
    shanghaiServiceDateInput(source.validFrom!) === input.dateInput
  ) {
    return source.validFrom!;
  }
  return midnight;
}

export function isAdminProgressiveLuxuryRenewal(input: {
  sourcePlanCode?: AdminServicePlanCode | null;
  targetPlanCode: AdminServicePlanCode;
  currentContractId?: string | null;
  targetStartsAt?: number | null;
  purchases?: AdminServicePurchase[];
}) {
  if (
    input.sourcePlanCode !== "luxury" ||
    input.targetPlanCode !== "luxury" ||
    !Number.isFinite(input.targetStartsAt)
  ) {
    return false;
  }
  const source = input.purchases?.find(
    (purchase) => purchase.id === input.currentContractId,
  );
  return Boolean(
    source?.planCode === "luxury" &&
      Number.isFinite(source.validUntil) &&
      input.targetStartsAt! >= source.validUntil!,
  );
}

export function resolveAdminTargetLuxuryPlanVersion(input: {
  sourcePlanCode?: AdminServicePlanCode | null;
  sourcePlanVersion?: number | null;
  sourceValidUntil?: number | null;
  targetStartsAt?: number | null;
}) {
  return input.sourcePlanCode === "luxury" &&
    (input.sourcePlanVersion ?? 1) < 2 &&
    Number.isFinite(input.sourceValidUntil) &&
    Number.isFinite(input.targetStartsAt) &&
    input.targetStartsAt! < input.sourceValidUntil!
    ? 1
    : 2;
}

export function isFutureDatedServiceCancellation(input: {
  status: string;
  startsAt: number | null;
  now?: number;
}) {
  return (
    input.status === "cancelled" &&
    Number.isFinite(input.startsAt) &&
    input.startsAt! > (input.now ?? Date.now())
  );
}

export function defaultAdminServiceCarryQuestionIds(input: {
  sourcePlanCode?: AdminServicePlanCode | null;
  targetPlanCode: AdminServicePlanCode;
  currentContractId?: string | null;
  targetStartsAt?: number | null;
  purchases?: AdminServicePurchase[];
  questions?: Array<{
    id: string;
    contractId?: string | null;
    status: string;
  }>;
}) {
  if (isAdminProgressiveLuxuryRenewal(input)) {
    return [];
  }
  const activeBasicIds =
    input.sourcePlanCode === "basic"
      ? (input.purchases ?? [])
          .filter(
            (purchase) =>
              purchase.planCode === "basic" &&
              (purchase.status === "active" || purchase.status === "scheduled"),
          )
          .map((purchase) => purchase.id)
      : [];
  const sourceContractIds = activeBasicIds.length
    ? activeBasicIds
    : input.currentContractId
      ? [input.currentContractId]
      : [];
  return (input.questions ?? [])
    .filter(
      (question) =>
        question.status === "selected" &&
        Boolean(
          question.contractId &&
            sourceContractIds.includes(question.contractId),
        ),
    )
    .map((question) => question.id);
}

