import { PaymentError } from "./errors.js";

export const ZPAY_SUBMIT_URL = "https://zpayz.cn/submit.php" as const;
export const ZPAY_QUERY_URL = "https://zpayz.cn/api.php" as const;
export const PAYMENT_ROUTER_MOUNT_PATH = "/api/monitoring/payments" as const;
export const ZPAY_NOTIFY_PATH =
  `${PAYMENT_ROUTER_MOUNT_PATH}/zpay/notify` as const;
export const ZPAY_RETURN_PATH =
  `${PAYMENT_ROUTER_MOUNT_PATH}/zpay/return` as const;

export type ZpayConfiguration = {
  pid: string;
  key: string;
  cid?: string;
  publicBaseUrl: string;
  notifyUrl: string;
  returnUrl: string;
};

export type BankTransferDisplay = {
  accountName: string;
  bankName: string;
  accountNumber: string;
  branchName?: string;
  transferNoteHint?: string;
};

export type SafePaymentMethodState = {
  configured: boolean;
  onlinePayment: {
    configured: boolean;
    provider: "zpay" | null;
    methods: Array<"alipay" | "wxpay">;
  };
  bankTransfer: {
    configured: boolean;
    details?: BankTransferDisplay;
  };
};

export type PaymentConfiguration = {
  zpay?: ZpayConfiguration;
  bankTransfer?: BankTransferDisplay;
  publicState: SafePaymentMethodState;
};

function normalizedOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isPublicHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "0.0.0.0" ||
    hostname === "::1"
  ) {
    return false;
  }
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
    return !hostname.includes(":");
  }
  const values = octets.map(Number);
  if (values.some((octet) => octet < 0 || octet > 255)) return false;
  return !(
    values[0] === 10 ||
    values[0] === 127 ||
    (values[0] === 169 && values[1] === 254) ||
    (values[0] === 172 && values[1]! >= 16 && values[1]! <= 31) ||
    (values[0] === 192 && values[1] === 168)
  );
}

function parseZpayConfiguration(
  environment: NodeJS.ProcessEnv,
): ZpayConfiguration | undefined {
  const pid = normalizedOptional(environment.FRONTMIND_ZPAY_PID);
  const key = normalizedOptional(environment.FRONTMIND_ZPAY_KEY);
  const cid = normalizedOptional(environment.FRONTMIND_ZPAY_CID);
  const publicBaseUrl = normalizedOptional(
    environment.FRONTMIND_PUBLIC_BASE_URL,
  );
  if (!pid && !key && !cid && !publicBaseUrl) return undefined;
  if (!pid || !key || !publicBaseUrl) {
    throw new PaymentError(
      "在线支付配置不完整",
      "PAYMENT_CONFIGURATION_INVALID",
      503,
    );
  }
  if (!/^[A-Za-z0-9]{2,64}$/.test(pid) || key.length < 8) {
    throw new PaymentError(
      "在线支付配置无效",
      "PAYMENT_CONFIGURATION_INVALID",
      503,
    );
  }
  if (cid && !/^\d+(?:,\d+)*$/.test(cid)) {
    throw new PaymentError(
      "在线支付渠道配置无效",
      "PAYMENT_CONFIGURATION_INVALID",
      503,
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(publicBaseUrl);
  } catch {
    throw new PaymentError(
      "支付回调地址配置无效",
      "PAYMENT_CONFIGURATION_INVALID",
      503,
    );
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new PaymentError(
      "支付回调地址配置无效",
      "PAYMENT_CONFIGURATION_INVALID",
      503,
    );
  }
  if (
    environment.NODE_ENV === "production" &&
    (baseUrl.protocol !== "https:" || !isPublicHostname(baseUrl.hostname))
  ) {
    throw new PaymentError(
      "生产支付回调必须使用公网 HTTPS 地址",
      "PAYMENT_CONFIGURATION_INVALID",
      503,
    );
  }

  return {
    pid,
    key,
    ...(cid ? { cid } : {}),
    publicBaseUrl: baseUrl.toString(),
    notifyUrl: new URL(ZPAY_NOTIFY_PATH, baseUrl).toString(),
    returnUrl: new URL(ZPAY_RETURN_PATH, baseUrl).toString(),
  };
}

function parseBankTransferDisplay(
  environment: NodeJS.ProcessEnv,
): BankTransferDisplay | undefined {
  const accountName = normalizedOptional(
    environment.FRONTMIND_BANK_ACCOUNT_NAME,
  );
  const bankName = normalizedOptional(environment.FRONTMIND_BANK_NAME);
  const accountNumber = normalizedOptional(
    environment.FRONTMIND_BANK_ACCOUNT_NUMBER,
  );
  const branchName = normalizedOptional(environment.FRONTMIND_BANK_BRANCH_NAME);
  const transferNoteHint = normalizedOptional(
    environment.FRONTMIND_BANK_TRANSFER_NOTE_HINT,
  );
  if (
    !accountName &&
    !bankName &&
    !accountNumber &&
    !branchName &&
    !transferNoteHint
  ) {
    return undefined;
  }
  if (!accountName || !bankName || !accountNumber) {
    throw new PaymentError(
      "对公转账展示配置不完整",
      "PAYMENT_CONFIGURATION_INVALID",
      503,
    );
  }
  if (
    accountName.length > 200 ||
    bankName.length > 200 ||
    accountNumber.length > 64 ||
    !/^[0-9A-Za-z -]+$/.test(accountNumber) ||
    (branchName?.length ?? 0) > 200 ||
    (transferNoteHint?.length ?? 0) > 300
  ) {
    throw new PaymentError(
      "对公转账展示配置无效",
      "PAYMENT_CONFIGURATION_INVALID",
      503,
    );
  }
  return {
    accountName,
    bankName,
    accountNumber,
    ...(branchName ? { branchName } : {}),
    ...(transferNoteHint ? { transferNoteHint } : {}),
  };
}

/**
 * Payment configuration fails closed. Invalid or partial settings never throw
 * into application startup and are never reflected with secret details.
 */
export function resolvePaymentConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): PaymentConfiguration {
  let zpay: ZpayConfiguration | undefined;
  let bankTransfer: BankTransferDisplay | undefined;
  try {
    zpay = parseZpayConfiguration(environment);
  } catch {
    zpay = undefined;
  }
  try {
    bankTransfer = parseBankTransferDisplay(environment);
  } catch {
    bankTransfer = undefined;
  }
  const publicState: SafePaymentMethodState = {
    configured: Boolean(zpay || bankTransfer),
    onlinePayment: {
      configured: Boolean(zpay),
      provider: zpay ? "zpay" : null,
      methods: zpay ? ["alipay", "wxpay"] : [],
    },
    bankTransfer: {
      configured: Boolean(bankTransfer),
      ...(bankTransfer ? { details: { ...bankTransfer } } : {}),
    },
  };
  return {
    ...(zpay ? { zpay } : {}),
    ...(bankTransfer ? { bankTransfer } : {}),
    publicState,
  };
}

/**
 * Return this value only from an authenticated application endpoint. In
 * particular, bank account details are intentionally not mounted by the
 * provider callback router.
 */
export function paymentMethodStateForAuthenticatedUser(
  configuration: PaymentConfiguration,
): SafePaymentMethodState {
  return {
    configured: configuration.publicState.configured,
    onlinePayment: {
      ...configuration.publicState.onlinePayment,
      methods: [...configuration.publicState.onlinePayment.methods],
    },
    bankTransfer: {
      configured: configuration.publicState.bankTransfer.configured,
      ...(configuration.publicState.bankTransfer.details
        ? { details: { ...configuration.publicState.bankTransfer.details } }
        : {}),
    },
  };
}
