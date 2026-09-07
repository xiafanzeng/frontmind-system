/** Official Managed GLM-5.3 pricing. Never use floating point for account charges.
 * Source: https://bigmodel.cn/pricing; Managed Agents uses same-model inference prices.
 * Managed input and cache-read counters are independent (unlike Chat prompt_tokens).
 */
export const ZHIPU_PRICING_VERSION = "zhipu-glm-5.3-2026-09-07";
export const ZHIPU_PRICING_SOURCE = "https://bigmodel.cn/pricing";
export const NANOS_PER_CNY = 1_000_000_000n;
export const NANOS_PER_WALLET_UNIT = 100_000n;
export type NativeTokens = {
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadInputTokens: bigint;
  cacheCreationInputTokens: bigint;
};
function count(value: unknown): bigint | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : null;
}
export function nativeTokens(value: unknown): NativeTokens | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  const cacheReadInputTokens = count(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = count(
    usage.cache_creation_input_tokens ?? 0,
  );
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadInputTokens === null ||
    cacheCreationInputTokens === null
  )
    return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  };
}
export function zhipuCostNanos(
  model: string,
  tokens: NativeTokens | null,
): bigint | null {
  if (model !== "glm-5.3" || !tokens || tokens.cacheCreationInputTokens !== 0n)
    return null;
  return (
    tokens.inputTokens * 8_000n +
    tokens.outputTokens * 28_000n +
    tokens.cacheReadInputTokens * 2_000n
  );
}
/** Carry sub-wallet-unit costs across events; never round each request up. */
export function applyCostRemainder(
  costNanos: bigint,
  previousRemainder: bigint,
) {
  if (
    costNanos < 0n ||
    previousRemainder < 0n ||
    previousRemainder >= NANOS_PER_WALLET_UNIT
  )
    throw new Error("INVALID_AI_COST");
  const total = costNanos + previousRemainder;
  return {
    charge: total / NANOS_PER_WALLET_UNIT,
    remainder: total % NANOS_PER_WALLET_UNIT,
  };
}
export function formatCostCny(nanos: bigint, decimals = 6): string {
  const divisor = 10n ** BigInt(9 - decimals);
  const rounded = (nanos + divisor / 2n) / divisor;
  const scale = 10n ** BigInt(decimals);
  return `${rounded / scale}.${(rounded % scale).toString().padStart(decimals, "0")}`;
}
export function projectNativeCost(model: string, usage: unknown) {
  const cost = zhipuCostNanos(model, nativeTokens(usage));
  return {
    costCny: cost === null ? null : formatCostCny(cost),
    costStatus: cost === null ? ("unknown" as const) : ("complete" as const),
    pricingSourceUrl: ZHIPU_PRICING_SOURCE,
  };
}
