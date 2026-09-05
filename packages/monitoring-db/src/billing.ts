export const MONEY_SCALE = 10_000n;
export const FEN_SCALE = 100n;
export const MONEY_CURRENCY = "CNY" as const;
export const OFFICIAL_PRICING_VERSION_ID = "moli-official-2026-08-28" as const;
export const OFFICIAL_PRICING_SOURCE_URL =
  "https://doc.molizhishu.com/docs/intro" as const;

export const pricingClasses = ["domestic", "overseas"] as const;
export type PricingClass = (typeof pricingClasses)[number];
export type BillableProviderMode = "search" | "reasoning_search";

export type AttemptPriceInput = {
  pricingClass: PricingClass;
  mode: BillableProviderMode;
  screenshot: 0 | 1 | 2;
};

export type AttemptQuote = AttemptPriceInput & {
  pricingVersionId: typeof OFFICIAL_PRICING_VERSION_ID;
  screenshotEnabled: boolean;
  amountTenThousandths: bigint;
};

const OFFICIAL_PRICES = {
  domestic: {
    search: { withoutScreenshot: 900n, withScreenshot: 1_800n },
    reasoning_search: {
      withoutScreenshot: 1_800n,
      withScreenshot: 2_700n,
    },
  },
  overseas: {
    search: { withoutScreenshot: 2_400n, withScreenshot: 3_200n },
    reasoning_search: {
      withoutScreenshot: 2_400n,
      withScreenshot: 3_200n,
    },
  },
} as const satisfies Record<
  PricingClass,
  Record<
    BillableProviderMode,
    { withoutScreenshot: bigint; withScreenshot: bigint }
  >
>;

/**
 * Prices are customer-facing immutable quotes in 1/10,000 CNY units. The
 * provider documentation says that enabling screenshots incurs the surcharge;
 * screenshot policy 2 is therefore quoted and reserved at the screenshot rate.
 */
export function quoteOfficialAttempt(input: AttemptPriceInput): AttemptQuote {
  const screenshotEnabled = input.screenshot !== 0;
  const prices = OFFICIAL_PRICES[input.pricingClass][input.mode];
  return {
    ...input,
    pricingVersionId: OFFICIAL_PRICING_VERSION_ID,
    screenshotEnabled,
    amountTenThousandths: screenshotEnabled
      ? prices.withScreenshot
      : prices.withoutScreenshot,
  };
}

export function quoteOfficialAttempts(inputs: readonly AttemptPriceInput[]): {
  attempts: AttemptQuote[];
  totalTenThousandths: bigint;
} {
  const attempts = inputs.map(quoteOfficialAttempt);
  return {
    attempts,
    totalTenThousandths: attempts.reduce(
      (total, quote) => total + quote.amountTenThousandths,
      0n,
    ),
  };
}

export function moneyToApiString(value: bigint): string {
  return value.toString(10);
}

export function moneyFromApiString(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError("Money amount must be a base-10 integer string");
  }
  return BigInt(value);
}

export function fenToTenThousandths(amountFen: bigint): bigint {
  return amountFen * FEN_SCALE;
}

export function tenThousandthsToFen(amountTenThousandths: bigint): bigint {
  if (amountTenThousandths % FEN_SCALE !== 0n) {
    throw new RangeError("Amount cannot be represented as whole fen");
  }
  return amountTenThousandths / FEN_SCALE;
}

export function formatCnyFromTenThousandths(
  amountTenThousandths: bigint,
): string {
  const negative = amountTenThousandths < 0n;
  const absolute = negative ? -amountTenThousandths : amountTenThousandths;
  const whole = absolute / MONEY_SCALE;
  const fraction = (absolute % MONEY_SCALE).toString().padStart(4, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export type ExplicitPlatformPricingClass = {
  providerCode: string;
  pricingClass: PricingClass;
};

const DOMESTIC_PROVIDER_CODES = new Set([
  "doubao",
  "doubao_mobile",
  "yuanbao",
  "yuanbao_mobile",
  "deepseek",
  "deepseek_mobile",
  "qianwen",
  "qianwen_mobile",
  "baiduai",
  "baiduai_mobile",
  "baidu_mobile",
  "kimi",
  "kimi_mobile",
]);

/** Seed helper only. Runtime pricing must use the persisted explicit class. */
export function officialPricingClassForKnownProvider(
  providerCode: string,
): PricingClass | null {
  const normalized = providerCode.trim().toLowerCase();
  if (normalized === "chatgpt" || normalized === "chatgpt_mobile")
    return "overseas";
  if (DOMESTIC_PROVIDER_CODES.has(normalized)) return "domestic";
  return null;
}

export const OFFICIAL_PRICING_ITEMS = pricingClasses.flatMap((pricingClass) =>
  (["search", "reasoning_search"] as const).flatMap((mode) =>
    ([false, true] as const).map((screenshotEnabled) => {
      const amountTenThousandths =
        OFFICIAL_PRICES[pricingClass][mode][
          screenshotEnabled ? "withScreenshot" : "withoutScreenshot"
        ];
      return {
        pricingClass,
        mode,
        screenshotEnabled,
        amountTenThousandths,
      };
    }),
  ),
);
