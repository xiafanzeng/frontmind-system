import type { MonitorInput, ProviderMode, ScreenshotPolicy } from "./domain";

export type RunCostQuoteInput = {
  items: Array<{
    platformId: string;
    mode: ProviderMode;
    screenshot: ScreenshotPolicy;
    regionCode: string | null;
    quantity: number;
  }>;
};

export type RunCostQuoteView = {
  totalAmountTenThousandths: string;
};

export type QuoteRunCost = (
  input: RunCostQuoteInput,
) => Promise<RunCostQuoteView>;

export type QuoteMonitorRunCost = (
  monitorId: string,
) => Promise<RunCostQuoteView>;

export type ScreenshotPolicySummary = ScreenshotPolicy | "mixed" | undefined;

export function summarizeScreenshotPolicies(
  platforms: readonly Pick<MonitorInput["platforms"][number], "screenshot">[],
): ScreenshotPolicySummary {
  const values = new Set(platforms.map((platform) => platform.screenshot));
  if (values.size === 0) return undefined;
  if (values.size > 1) return "mixed";
  return values.values().next().value;
}

export function buildRunCostQuoteInput(
  configuration: Pick<MonitorInput, "questions" | "platforms" | "repetitions">,
): RunCostQuoteInput {
  const quantity = configuration.questions.length * configuration.repetitions;
  return {
    items: configuration.platforms.map((platform) => ({
      platformId: platform.platformId,
      mode: platform.mode,
      screenshot: platform.screenshot,
      regionCode: platform.clientType === "mobile" ? null : platform.regionCode,
      quantity,
    })),
  };
}
