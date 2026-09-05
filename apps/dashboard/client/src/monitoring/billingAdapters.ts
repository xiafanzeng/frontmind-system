import type {
  BankTransferSubmissionView,
  BillingLedgerEntryView,
  BillingPaymentMethodView,
  BillingPricingView,
  BillingSummaryView,
  BillingTopupView,
  MediaPublishingBillingSummaryView,
} from "./pages/SettingsPage";
import type { AdminBankTransfer, AdminUser } from "./pages/AdminPage";

type BillingSummarySource = {
  availableTenThousandths: string;
  reservedTenThousandths: string;
  spentTenThousandths: string;
};

type PricingItemSource = {
  id: string;
  pricingClass: "domestic" | "overseas";
  mode: "search" | "reasoning_search";
  screenshotEnabled: boolean;
  amountTenThousandths: string;
};

type LedgerEntrySource = {
  id: string;
  type: "topup" | "admin_adjustment" | "reserve" | "consume" | "release";
  balanceDeltaTenThousandths: string;
  reservedDeltaTenThousandths: string;
  reason: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date | string;
};

type MediaPublishingLedgerEntrySource = {
  id: string;
  type:
    "topup" | "admin_adjustment" | "reserve" | "freeze" | "consume" | "release";
  balanceDeltaTenThousandths: string;
  reservedDeltaTenThousandths: string;
  frozenDeltaTenThousandths: string;
  reason: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date | string;
};

type PaymentMethodStateSource = {
  onlinePayment: {
    configured: boolean;
    methods: Array<"alipay" | "wxpay">;
  };
  bankTransfer: {
    configured: boolean;
    details?: {
      accountName: string;
      bankName: string;
      accountNumber: string;
      branchName?: string;
      transferNoteHint?: string;
    };
  };
};

type TopupOrderSource = {
  id: string;
  paymentMethod: "alipay" | "wxpay" | "bank_transfer";
  amountTenThousandths: string;
  state:
    | "pending"
    | "review_required"
    | "paid"
    | "credited"
    | "expired"
    | "cancelled"
    | "rejected";
};

type CheckoutSource = {
  action: string;
  httpMethod: "POST";
  fields: Record<string, string | undefined>;
};

type AdminBillingUserSource = {
  id: string;
  username: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  lastLoginAt: Date | string | null;
  balanceTenThousandths: string;
  reservedTenThousandths: string;
  spentTenThousandths: string;
  availableTenThousandths: string;
};

type AdminBankTransferSource = {
  username: string;
  order: TopupOrderSource;
  review: {
    id: string;
    orderId: string;
    status: "pending" | "approved" | "rejected";
    payerName: string;
    transferredAt: Date | string;
    remittanceReference: string;
    submittedAt: Date | string;
  };
};

const LEDGER_TYPES: Record<
  LedgerEntrySource["type"],
  BillingLedgerEntryView["type"]
> = {
  topup: "topup",
  admin_adjustment: "adjustment",
  reserve: "freeze",
  consume: "spend",
  release: "release",
};

const LEDGER_DESCRIPTIONS: Record<LedgerEntrySource["type"], string> = {
  topup: "充值到账",
  admin_adjustment: "管理员调整",
  reserve: "运行金额冻结",
  consume: "成功回答结算",
  release: "未结算金额释放",
};

const PRICING_CLASS_LABELS = {
  domestic: "国内平台",
  overseas: "海外平台",
} as const;

const OFFICIAL_PRICING_PRESENTATION = [
  {
    pricingClass: "domestic",
    mode: "standard",
    answerMode: "标准问答",
    derivedFrom: "search",
  },
  {
    pricingClass: "domestic",
    mode: "reasoning",
    answerMode: "深度思考",
    derivedFrom: "reasoning_search",
  },
  {
    pricingClass: "overseas",
    mode: "standard",
    answerMode: "标准问答",
    derivedFrom: "search",
  },
  {
    pricingClass: "overseas",
    mode: "reasoning",
    answerMode: "深度思考",
    derivedFrom: "reasoning_search",
  },
] as const;

export function mapBillingSummaryView(
  source: BillingSummarySource,
): BillingSummaryView {
  return {
    availableTenThousandths: source.availableTenThousandths,
    reservedTenThousandths: source.reservedTenThousandths,
    totalSpentTenThousandths: source.spentTenThousandths,
  };
}

export function mapMediaPublishingBillingSummaryView(source: {
  availableTenThousandths: string;
  reservedTenThousandths: string;
  frozenTenThousandths: string;
  spentTenThousandths: string;
}): MediaPublishingBillingSummaryView {
  return {
    availableTenThousandths: source.availableTenThousandths,
    reservedTenThousandths: source.reservedTenThousandths,
    frozenTenThousandths: source.frozenTenThousandths,
    totalSpentTenThousandths: source.spentTenThousandths,
  };
}

export function mapBillingPricingViews(
  items: PricingItemSource[],
): BillingPricingView[] {
  const grouped = new Map<
    string,
    {
      pricingClass: PricingItemSource["pricingClass"];
      mode: PricingItemSource["mode"];
      withoutScreenshot?: PricingItemSource;
      withScreenshot?: PricingItemSource;
    }
  >();
  for (const item of items) {
    const key = `${item.pricingClass}:${item.mode}`;
    const group = grouped.get(key) || {
      pricingClass: item.pricingClass,
      mode: item.mode,
    };
    if (item.screenshotEnabled) group.withScreenshot = item;
    else group.withoutScreenshot = item;
    grouped.set(key, group);
  }
  return OFFICIAL_PRICING_PRESENTATION.map((presentation) => {
    const id = `${presentation.pricingClass}:${presentation.mode}`;
    const sourceKey = `${presentation.pricingClass}:${presentation.derivedFrom}`;
    const source = grouped.get(sourceKey);
    return {
      id,
      platformType: PRICING_CLASS_LABELS[presentation.pricingClass],
      answerMode: presentation.answerMode,
      withoutScreenshotTenThousandths:
        source?.withoutScreenshot?.amountTenThousandths,
      withScreenshotTenThousandths:
        source?.withScreenshot?.amountTenThousandths,
      available: Boolean(source?.withoutScreenshot && source.withScreenshot),
    };
  });
}

export function mapBillingLedgerViews(
  entries: LedgerEntrySource[],
): BillingLedgerEntryView[] {
  return entries.map((entry) => {
    let displayedDelta = entry.balanceDeltaTenThousandths;
    if (entry.type === "reserve" || entry.type === "release") {
      let reservedMagnitude = "0";
      try {
        const reserved = BigInt(entry.reservedDeltaTenThousandths);
        reservedMagnitude = (reserved < 0n ? -reserved : reserved).toString();
      } catch {
        reservedMagnitude = "0";
      }
      displayedDelta =
        entry.type === "reserve" && reservedMagnitude !== "0"
          ? `-${reservedMagnitude}`
          : reservedMagnitude;
    }
    return {
      id: entry.id,
      type: LEDGER_TYPES[entry.type],
      balanceDeltaTenThousandths: displayedDelta,
      status: "completed",
      description: LEDGER_DESCRIPTIONS[entry.type],
      ...(entry.referenceId &&
      ["run", "attempt", "topup", "topup_order"].includes(
        entry.referenceType || "",
      )
        ? { relatedRun: entry.referenceId }
        : {}),
      createdAt:
        entry.createdAt instanceof Date
          ? entry.createdAt.toISOString()
          : entry.createdAt,
    };
  });
}

export function mapMediaPublishingLedgerViews(
  entries: MediaPublishingLedgerEntrySource[],
): BillingLedgerEntryView[] {
  return entries.map((entry) => {
    const type: BillingLedgerEntryView["type"] =
      entry.type === "consume"
        ? "spend"
        : entry.type === "release"
          ? "release"
          : entry.type === "topup"
            ? "topup"
            : entry.type === "admin_adjustment"
              ? "adjustment"
              : "freeze";
    let displayedDelta = entry.balanceDeltaTenThousandths;
    if (["reserve", "freeze", "release"].includes(entry.type)) {
      const source =
        entry.type === "freeze"
          ? entry.frozenDeltaTenThousandths
          : entry.reservedDeltaTenThousandths;
      try {
        const atomic = BigInt(source);
        const magnitude = (atomic < 0n ? -atomic : atomic).toString();
        displayedDelta =
          entry.type === "release"
            ? magnitude
            : magnitude === "0"
              ? "0"
              : `-${magnitude}`;
      } catch {
        displayedDelta = "0";
      }
    }
    return {
      id: entry.id,
      type,
      balanceDeltaTenThousandths: displayedDelta,
      status: "completed",
      description:
        entry.type === "reserve"
          ? "发布金额预占"
          : entry.type === "freeze"
            ? "待对账金额冻结"
            : entry.type === "consume"
              ? "媒体发布结算"
              : entry.type === "release"
                ? "预占释放"
                : entry.type === "topup"
                  ? "媒体钱包充值到账"
                  : "管理员调整",
      ...(entry.referenceId ? { relatedRun: entry.referenceId } : {}),
      walletScope: "media_publishing",
      createdAt:
        entry.createdAt instanceof Date
          ? entry.createdAt.toISOString()
          : entry.createdAt,
    };
  });
}

export function mapBillingPaymentMethodViews(
  state: PaymentMethodStateSource,
): BillingPaymentMethodView[] {
  const onlineMethods = new Set(state.onlinePayment.methods);
  return [
    {
      id: "alipay",
      configured: state.onlinePayment.configured && onlineMethods.has("alipay"),
      unavailableReason: "支付宝通道暂未配置",
    },
    {
      id: "wxpay",
      configured: state.onlinePayment.configured && onlineMethods.has("wxpay"),
      unavailableReason: "微信支付通道暂未配置",
    },
    {
      id: "bank_transfer",
      configured: state.bankTransfer.configured,
      unavailableReason: "企业转账账户暂未配置",
    },
  ];
}

export function bankTransferInstructions(state: PaymentMethodStateSource) {
  const details = state.bankTransfer.details;
  if (!state.bankTransfer.configured || !details) return undefined;
  return [
    `收款户名：${details.accountName}`,
    `开户银行：${details.bankName}`,
    ...(details.branchName ? [`开户支行：${details.branchName}`] : []),
    `银行账号：${details.accountNumber}`,
    ...(details.transferNoteHint
      ? [`转账附言：${details.transferNoteHint}`]
      : []),
  ].join("\n");
}

function topupStatus(
  state: TopupOrderSource["state"],
): BillingTopupView["status"] {
  if (state === "paid" || state === "credited") return "paid";
  if (state === "review_required") return "under_review";
  if (state === "pending") return "pending_payment";
  if (state === "expired") return "expired";
  if (state === "cancelled") return "cancelled";
  return "rejected";
}

export function mapBillingTopupView(
  source: { order: TopupOrderSource; checkout?: CheckoutSource | null },
  paymentMethods?: PaymentMethodStateSource,
): BillingTopupView {
  const checkout = source.checkout
    ? {
        action: source.checkout.action,
        httpMethod: source.checkout.httpMethod,
        fields: Object.fromEntries(
          Object.entries(source.checkout.fields).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      }
    : undefined;
  return {
    id: source.order.id,
    amountTenThousandths: source.order.amountTenThousandths,
    method: source.order.paymentMethod,
    status: topupStatus(source.order.state),
    ...(checkout ? { checkout } : {}),
    ...(source.order.paymentMethod === "bank_transfer" && paymentMethods
      ? { bankInstructions: bankTransferInstructions(paymentMethods) }
      : {}),
  };
}

export function mapAdminBillingUser(source: AdminBillingUserSource): AdminUser {
  return {
    id: source.id,
    username: source.username,
    active: source.status === "active",
    role: source.role,
    granted: 0,
    reserved: 0,
    consumed: 0,
    balanceTenThousandths: source.availableTenThousandths,
    reservedTenThousandths: source.reservedTenThousandths,
    totalSpentTenThousandths: source.spentTenThousandths,
    ...(source.lastLoginAt
      ? {
          lastSeenAt:
            source.lastLoginAt instanceof Date
              ? source.lastLoginAt.toISOString()
              : source.lastLoginAt,
        }
      : {}),
  };
}

export function mapAdminBankTransfer(
  source: AdminBankTransferSource,
): AdminBankTransfer {
  return {
    id: source.review.id,
    orderId: source.review.orderId,
    username: source.username,
    amountTenThousandths: source.order.amountTenThousandths,
    payerName: source.review.payerName,
    transferredAt:
      source.review.transferredAt instanceof Date
        ? source.review.transferredAt.toISOString()
        : source.review.transferredAt,
    remittanceReference: source.review.remittanceReference,
    status: source.review.status,
    submittedAt:
      source.review.submittedAt instanceof Date
        ? source.review.submittedAt.toISOString()
        : source.review.submittedAt,
  };
}

export function bankTransferInputForApi(input: BankTransferSubmissionView) {
  return {
    payerName: input.payerName,
    transferredAt: new Date(input.transferredAt),
    remittanceReference: input.remittanceReference,
  };
}
