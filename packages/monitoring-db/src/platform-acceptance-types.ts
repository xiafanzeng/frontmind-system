import type {
  platformAcceptanceDimensions,
  platformAcceptanceStatuses,
} from "@frontmind/monitoring-contracts";

export type PlatformAcceptanceStatus =
  (typeof platformAcceptanceStatuses)[number];
export type PlatformAcceptanceDimension =
  (typeof platformAcceptanceDimensions)[number];

export type PlatformAcceptanceCheckPlan = {
  platformId: string;
  providerCode: string;
  displayName: string;
  clientType: "web" | "mobile";
  platformFingerprint: string;
  dimension: PlatformAcceptanceDimension;
  mode: "search" | "reasoning_search";
  screenshot: 0 | 1 | 2;
  regionCode: string | null;
  unitAmountTenThousandths: bigint;
};
