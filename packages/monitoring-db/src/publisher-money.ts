const PRICE_PATTERN = /^(?:0|[1-9]\d*)(?:\.(\d{1,4}))?$/u;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

/** Parse a provider decimal CNY price exactly into integer 1/10,000 CNY. */
export function publisherPriceToTenThousandths(value: string): bigint {
  const normalized = value.trim();
  const match = PRICE_PATTERN.exec(normalized);
  if (!match) {
    throw new TypeError(
      "Publisher price must be a non-negative decimal with at most four places",
    );
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  const amount = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  if (amount > MAX_SIGNED_BIGINT) {
    throw new RangeError("Publisher price exceeds the database money range");
  }
  return amount;
}

export function publisherMoneyFromApiString(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError("Money amount must be a base-10 integer string");
  }
  const amount = BigInt(value);
  if (amount < -MAX_SIGNED_BIGINT || amount > MAX_SIGNED_BIGINT) {
    throw new RangeError("Money amount exceeds the database range");
  }
  return amount;
}

export function publisherMoneyToApiString(value: bigint): string {
  return value.toString(10);
}

export function formatPublisherCny(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10_000n;
  const fraction = (absolute % 10_000n).toString().padStart(4, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export type PublisherWalletState = {
  balanceTenThousandths: bigint;
  reservedTenThousandths: bigint;
  frozenTenThousandths: bigint;
  spentTenThousandths: bigint;
};

export function publisherAvailableMoney(wallet: PublisherWalletState): bigint {
  return (
    wallet.balanceTenThousandths -
    wallet.reservedTenThousandths -
    wallet.frozenTenThousandths
  );
}

export function assertValidPublisherWallet(wallet: PublisherWalletState): void {
  if (
    wallet.reservedTenThousandths < 0n ||
    wallet.frozenTenThousandths < 0n ||
    wallet.spentTenThousandths < 0n
  ) {
    throw new RangeError("Publisher wallet counters cannot be negative");
  }
}

export function reservePublisherMoney(
  wallet: PublisherWalletState,
  amount: bigint,
): PublisherWalletState {
  assertValidPublisherWallet(wallet);
  if (amount <= 0n) throw new RangeError("Reservation must be positive");
  if (publisherAvailableMoney(wallet) < amount) {
    throw new RangeError("Publisher wallet has insufficient available funds");
  }
  return {
    ...wallet,
    reservedTenThousandths: wallet.reservedTenThousandths + amount,
  };
}

export function transitionPublisherFunds(
  wallet: PublisherWalletState,
  amount: bigint,
  from: "reserved" | "frozen",
  to: "frozen" | "consumed" | "released",
): PublisherWalletState {
  assertValidPublisherWallet(wallet);
  if (amount <= 0n) throw new RangeError("Settlement amount must be positive");
  if (from === "frozen" && to === "frozen") return wallet;
  if (from === "reserved" && wallet.reservedTenThousandths < amount) {
    throw new RangeError("Publisher wallet reserved funds are insufficient");
  }
  if (from === "frozen" && wallet.frozenTenThousandths < amount) {
    throw new RangeError("Publisher wallet frozen funds are insufficient");
  }
  const next: PublisherWalletState = {
    balanceTenThousandths:
      to === "consumed"
        ? wallet.balanceTenThousandths - amount
        : wallet.balanceTenThousandths,
    reservedTenThousandths:
      wallet.reservedTenThousandths - (from === "reserved" ? amount : 0n),
    frozenTenThousandths:
      wallet.frozenTenThousandths -
      (from === "frozen" ? amount : 0n) +
      (to === "frozen" ? amount : 0n),
    spentTenThousandths:
      wallet.spentTenThousandths + (to === "consumed" ? amount : 0n),
  };
  assertValidPublisherWallet(next);
  return next;
}
