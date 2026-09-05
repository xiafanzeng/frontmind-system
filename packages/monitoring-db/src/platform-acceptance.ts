import { createHash } from "node:crypto";
import type {
  PlatformAcceptanceCheckPlan,
  PlatformAcceptanceDimension,
} from "./platform-acceptance-types.js";

export type AcceptancePlatform = {
  id: string;
  providerCode: string;
  displayName: string;
  clientType: "web" | "mobile";
  pricingClass: "domestic" | "overseas" | null;
  providerMetadata: Record<string, unknown> | null;
  acceptanceFingerprint?: string | null;
};

export type AcceptancePrice = {
  pricingClass: "domestic" | "overseas";
  mode: "search" | "reasoning_search";
  screenshotEnabled: boolean;
  amountTenThousandths: bigint;
};

export function stableAcceptanceJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableAcceptanceJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${stableAcceptanceJson(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function acceptanceSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function platformAcceptanceFingerprint(
  platform: Pick<
    AcceptancePlatform,
    "providerCode" | "clientType" | "providerMetadata"
  >,
): string {
  return acceptanceSha256(
    stableAcceptanceJson({
      providerCode: platform.providerCode,
      clientType: platform.clientType,
      providerMetadata: platform.providerMetadata ?? null,
    }),
  );
}

function checkDimensions(input: {
  platform: AcceptancePlatform;
  domesticRegionCode: string | null;
  overseasRegionCode: string | null;
}): Array<{
  dimension: PlatformAcceptanceDimension;
  mode: "search" | "reasoning_search";
  screenshot: 0 | 1 | 2;
  regionCode: string | null;
}> {
  const common = [
    {
      dimension: "search_default" as const,
      mode: "search" as const,
      screenshot: 0 as const,
      regionCode: null,
    },
    {
      dimension: "reasoning_search" as const,
      mode: "reasoning_search" as const,
      screenshot: 0 as const,
      regionCode: null,
    },
    {
      dimension: "screenshot_mention" as const,
      mode: "search" as const,
      screenshot: 2 as const,
      regionCode: null,
    },
    {
      dimension: "screenshot_all" as const,
      mode: "search" as const,
      screenshot: 1 as const,
      regionCode: null,
    },
  ];
  if (input.platform.clientType === "mobile") {
    return [
      ...common,
      {
        dimension: "mobile_no_region",
        mode: "search",
        screenshot: 0,
        regionCode: null,
      },
    ];
  }
  return [
    ...common,
    {
      dimension: "region_default",
      mode: "search",
      screenshot: 0,
      regionCode: null,
    },
    ...(input.domesticRegionCode
      ? [
          {
            dimension: "region_domestic" as const,
            mode: "search" as const,
            screenshot: 0 as const,
            regionCode: input.domesticRegionCode,
          },
        ]
      : []),
    ...(input.overseasRegionCode
      ? [
          {
            dimension: "region_overseas" as const,
            mode: "search" as const,
            screenshot: 0 as const,
            regionCode: input.overseasRegionCode,
          },
        ]
      : []),
  ];
}

export function buildPlatformAcceptancePlan(input: {
  platforms: readonly AcceptancePlatform[];
  prices: readonly AcceptancePrice[];
  domesticRegionCode: string | null;
  overseasRegionCode: string | null;
}): PlatformAcceptanceCheckPlan[] {
  const prices = new Map(
    input.prices.map((price) => [
      `${price.pricingClass}:${price.mode}:${String(price.screenshotEnabled)}`,
      price.amountTenThousandths,
    ]),
  );
  return [...input.platforms]
    .sort((left, right) =>
      `${left.providerCode}:${left.clientType}`.localeCompare(
        `${right.providerCode}:${right.clientType}`,
      ),
    )
    .flatMap((platform) => {
      if (!platform.pricingClass) {
        throw new Error(
          `Platform ${platform.providerCode}:${platform.clientType} has no confirmed pricing class`,
        );
      }
      const platformFingerprint = platformAcceptanceFingerprint(platform);
      return checkDimensions({
        platform,
        domesticRegionCode: input.domesticRegionCode,
        overseasRegionCode: input.overseasRegionCode,
      }).map((check) => {
        const amount = prices.get(
          `${platform.pricingClass}:${check.mode}:${String(check.screenshot !== 0)}`,
        );
        if (amount === undefined) {
          throw new Error(
            `No active price exists for ${platform.pricingClass}/${check.mode}/${check.screenshot !== 0 ? "screenshot" : "no-screenshot"}`,
          );
        }
        return {
          platformId: platform.id,
          providerCode: platform.providerCode,
          displayName: platform.displayName,
          clientType: platform.clientType,
          platformFingerprint,
          dimension: check.dimension,
          mode: check.mode,
          screenshot: check.screenshot,
          regionCode: check.regionCode,
          unitAmountTenThousandths: amount,
        };
      });
    });
}

export function platformAcceptancePlanFingerprint(input: {
  ownerId: string;
  projectId: string;
  questionHash: string;
  checks: readonly PlatformAcceptanceCheckPlan[];
}): string {
  return acceptanceSha256(
    stableAcceptanceJson({
      ownerId: input.ownerId,
      projectId: input.projectId,
      questionHash: input.questionHash,
      checks: input.checks.map((check) => ({
        platformId: check.platformId,
        platformFingerprint: check.platformFingerprint,
        dimension: check.dimension,
        mode: check.mode,
        screenshot: check.screenshot,
        regionCode: check.regionCode,
        unitAmountTenThousandths: check.unitAmountTenThousandths.toString(),
      })),
    }),
  );
}

export function acceptanceCapabilityForDimension(
  dimension: PlatformAcceptanceDimension,
):
  | "base"
  | "reasoning"
  | "screenshot_mention"
  | "screenshot_all"
  | "region_default"
  | "region_domestic"
  | "region_overseas"
  | "mobile_no_region" {
  if (dimension === "search_default") return "base";
  if (dimension === "reasoning_search") return "reasoning";
  return dimension;
}
