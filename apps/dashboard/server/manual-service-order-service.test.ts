import { describe, expect, it, vi } from "vitest";

import {
  createManualServiceOrderService,
  ManualServiceOrderError,
  type ManualServiceOrderRecord,
  type ManualServiceOrderRepository,
} from "./manual-service-order-service";
import { websitePurchaseRequestV2Schema } from "../shared/provisioning-v2";

const SECRET = "manual-order-test-secret-with-at-least-32-characters";
const NOW = new Date("2026-07-26T10:20:00.000Z");

function createRequest(question = "如何选择适合当前生产场景的解决方案？") {
  return {
    schemaVersion: 1 as const,
    project: {
      id: "project-manual-001",
      companyName: "示例科技有限公司",
    },
    service: {
      planCode: "basic" as const,
      serviceDays: 30 as const,
      purchasedQuestion: {
        id: "question-manual-001",
        category: "product_scenario" as const,
        question,
      },
    },
    contract: {
      templateVersion: "basic-2026.07-v2",
      profile: {
        legalName: "示例科技有限公司",
        creditCode: "91310000MA1K12345X",
        address: "上海市浦东新区示例路 1 号",
        signatoryName: "张三",
        signatoryTitle: "法定代表人",
        mobile: "13800138000",
        email: "legal@example.com",
        authorized: true as const,
      },
    },
  };
}

function paymentRequest() {
  return {
    schemaVersion: 1 as const,
    payment: {
      orderId: "20260726100000123456",
      tradeNo: "zpay-trade-manual-001",
      amountFen: 150_000,
      paidAt: "2026-07-26T10:10:00.987Z",
    },
  };
}

function accountRequest(
  account:
    | {
        mode: "create";
        username: string;
        displayName: string;
        password: string;
      }
    | { mode: "bind_existing"; purchaseIntent: string } = {
    mode: "create",
    username: "example.manual",
    displayName: "示例科技有限公司",
    password: "customer-selected-password",
  },
) {
  return { schemaVersion: 1 as const, account };
}

const PASSWORD_HASH = [
  "scrypt",
  "v1",
  "16384",
  "8",
  "1",
  Buffer.alloc(16, 1).toString("base64"),
  Buffer.alloc(64, 2).toString("base64"),
].join("$");

function memoryRepository(): ManualServiceOrderRepository & {
  rows: Map<string, ManualServiceOrderRecord>;
} {
  const rows = new Map<string, ManualServiceOrderRecord>();
  let queue = Promise.resolve();
  return {
    rows,
    async find(reference) {
      return rows.get(reference);
    },
    async findByCreateKey(keyHash) {
      return [...rows.values()].find(
        (row) => row.idempotencyKeyHash === keyHash,
      );
    },
    async insert(value) {
      const row = {
        externalContractId: null,
        signingUrl: null,
        signedPdfFileId: null,
        signedPdfFilename: null,
        signedPdfSha256: null,
        evidenceReportFileId: null,
        evidenceReportFilename: null,
        evidenceReportSha256: null,
        signedAt: null,
        signatoryId: null,
        signatureNote: null,
        contractAuthorizationMode: null,
        contractAuthorizationEventReference: null,
        contractAuthorizedAt: null,
        paymentIdempotencyKeyHash: null,
        paymentRequestHash: null,
        paymentOrderId: null,
        paymentTradeNo: null,
        paidAt: null,
        accountSetupIdempotencyKeyHash: null,
        accountSetupRequestHash: null,
        accountMode: null,
        requestedUsername: null,
        requestedDisplayName: null,
        requestedPasswordHash: null,
        provisioningReference: null,
        preparedByUserId: null,
        signedByUserId: null,
        activatedByUserId: null,
        rejectedByUserId: null,
        preparedAt: null,
        accountSetupAt: null,
        activatedAt: null,
        rejectedAt: null,
        lastError: null,
        ...value,
      } as ManualServiceOrderRecord;
      rows.set(row.id, row);
      return row;
    },
    async list() {
      return [...rows.values()];
    },
    async mutate(reference, mutation) {
      let result!: ManualServiceOrderRecord;
      const operation = queue.then(async () => {
        const current = rows.get(reference);
        if (!current) {
          throw new ManualServiceOrderError(
            "MANUAL_ORDER_NOT_FOUND",
            "not found",
            404,
          );
        }
        const patch = await mutation(current);
        result = patch
          ? ({ ...current, ...patch } as ManualServiceOrderRecord)
          : current;
        rows.set(reference, result);
      });
      queue = operation.then(
        () => undefined,
        () => undefined,
      );
      await operation;
      return result;
    },
  };
}

function serviceHarness() {
  const repository = memoryRepository();
  let provisioned = false;
  const submitPurchase = vi.fn(async (input: any) => {
    const request = websitePurchaseRequestV2Schema.parse(input.request);
    return {
      schemaVersion: 2 as const,
      purchase: {
        reference: "provision-manual-001",
        projectId: request.project.id,
        orderId: request.order.id,
        status: "pending_confirmation" as const,
        updatedAt: "2026-07-26T10:11:00.000Z",
      },
      account:
        request.account.mode === "create"
          ? {
              username: request.account.username,
              displayName: request.account.displayName,
            }
          : {
              username: "existing.user",
              displayName: "示例科技有限公司",
            },
    };
  });
  const purchaseResponse = () => ({
    schemaVersion: 2 as const,
    purchase: {
      reference: "provision-manual-001",
      projectId: "project-manual-001",
      orderId: "20260726100000123456",
      status: provisioned
        ? ("provisioned" as const)
        : ("pending_confirmation" as const),
      updatedAt: provisioned
        ? "2026-07-26T10:20:00.000Z"
        : "2026-07-26T10:11:00.000Z",
    },
    account: {
      username: "example.manual",
      displayName: "示例科技有限公司",
      ...(provisioned
        ? {
            workspaceUrl: "https://agent.example/",
          }
        : {}),
    },
  });
  const readPurchase = vi.fn(async () => purchaseResponse());
  const decidePurchase = vi.fn(async (input: any) => {
    if (input.decision === "confirm") provisioned = true;
    return input.decision === "confirm"
      ? purchaseResponse()
      : {
          schemaVersion: 2 as const,
          purchase: {
            reference: "provision-manual-001",
            projectId: "project-manual-001",
            orderId: "20260726100000123456",
            status: "failed" as const,
            updatedAt: NOW.toISOString(),
            retryable: false,
            errorCode: "PURCHASE_CONFIRMATION_FAILED",
            message: input.note,
          },
          account: {
            username: "example.manual",
            displayName: "示例科技有限公司",
          },
        };
  });
  const hashCustomerPassword = vi.fn(async () => PASSWORD_HASH);
  const setupPurchasePassword = vi.fn(async () => ({
    success: true as const,
    username: "example.manual",
    workspaceUrl: "https://agent.example/",
  }));
  const service = createManualServiceOrderService({
    repository,
    secret: SECRET,
    now: () => new Date(NOW),
    submitPurchase: submitPurchase as any,
    readPurchase: readPurchase as any,
    decidePurchase: decidePurchase as any,
    hashCustomerPassword,
    setupPurchasePassword,
  });
  return {
    repository,
    service,
    submitPurchase,
    readPurchase,
    decidePurchase,
    hashCustomerPassword,
    setupPurchasePassword,
  };
}

async function createAndSign(harness: ReturnType<typeof serviceHarness>) {
  const created = await harness.service.create({
    idempotencyKey: "manual-create-idempotency-001",
    request: createRequest(),
  });
  const reference = created.order.reference;
  await harness.service.prepare({
    reference,
    contractId: "esign-contract-manual-001",
    signingUrl: "https://sign.example.com/flows/manual-001",
    actorUserId: 1,
  });
  await harness.service.confirmSigned({
    reference,
    signedPdf: {
      fileId: "signed-pdf-file-001",
      filename: "signed-contract.pdf",
      sha256: "a".repeat(64),
    },
    evidenceReport: {
      fileId: "evidence-report-file-001",
      filename: "signing-report.pdf",
      sha256: "b".repeat(64),
    },
    signedAt: Date.parse("2026-07-26T10:05:00.789Z"),
    signatoryId: "enterprise-signatory-001",
    note: "已核对电子签平台签署原件与签署报告",
    actorUserId: 1,
  });
  return reference;
}

describe("manual service order workflow", () => {
  it("accepts an external WeChat contract confirmation without forging signing evidence", async () => {
    const harness = serviceHarness();
    const created = await harness.service.create({
      idempotencyKey: "manual-create-idempotency-001",
      request: createRequest(),
    });
    expect(created.order).not.toHaveProperty("amountFen");
    expect(
      harness.repository.rows.get(created.order.reference)?.amountFen,
    ).toBeNull();
    const request = {
      schemaVersion: 1 as const,
      authorization: {
        mode: "external_wechat" as const,
        eventReference: "wechat-contract-event-001",
        authorizedAt: "2026-07-26T10:05:00.987Z",
      },
    };

    const authorized = await harness.service.authorizeExternal({
      reference: created.order.reference,
      request,
    });
    const replay = await harness.service.authorizeExternal({
      reference: created.order.reference,
      request: {
        ...request,
        authorization: {
          ...request.authorization,
          authorizedAt: "2026-07-26T10:06:00.000Z",
        },
      },
    });
    expect(replay).toEqual(authorized);
    expect(authorized.order).toMatchObject({
      status: "payment_required",
      contractAuthorizationMode: "external_wechat",
      contractAuthorizedAt: "2026-07-26T10:05:00.000Z",
    });
    expect(authorized.order).not.toHaveProperty("contractId");
    expect(authorized.order).not.toHaveProperty("signingUrl");
    expect(harness.repository.rows.get(created.order.reference)).toMatchObject({
      externalContractId: null,
      signedAt: null,
      signatoryId: null,
      signedPdfFileId: null,
      evidenceReportFileId: null,
      signatureNote: null,
      signedByUserId: null,
      contractAuthorizationEventReference: "wechat-contract-event-001",
    });

    await harness.service.recordPayment({
      reference: created.order.reference,
      idempotencyKey: "manual-payment-idempotency-001",
      request: paymentRequest(),
    });
    const active = await harness.service.setupAccount({
      reference: created.order.reference,
      idempotencyKey: "manual-account-idempotency-001",
      request: accountRequest(),
    });
    expect(active.order.status).toBe("active");
    expect(harness.submitPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          contract: expect.objectContaining({
            evidence: {
              type: "external_wechat_confirmation",
              eventReference: "wechat-contract-event-001",
              authorizedAt: "2026-07-26T10:05:00.000Z",
            },
          }),
        }),
      }),
    );
    const submittedContract =
      harness.submitPurchase.mock.calls[0]?.[0]?.request.contract;
    expect(submittedContract).not.toHaveProperty("id");
    expect(submittedContract).not.toHaveProperty("contractId");
    expect(harness.decidePurchase).toHaveBeenCalledWith(
      expect.not.objectContaining({
        signedAt: expect.anything(),
        signatoryId: expect.anything(),
      }),
    );
  });

  it("advances signing before payment and keeps every action idempotent", async () => {
    const harness = serviceHarness();
    const first = await harness.service.create({
      idempotencyKey: "manual-create-idempotency-001",
      request: createRequest(),
    });
    const replay = await harness.service.create({
      idempotencyKey: "manual-create-idempotency-001",
      request: createRequest(),
    });
    expect(replay.order.reference).toBe(first.order.reference);
    expect(first.order.status).toBe("pending_admin");

    const prepared = await harness.service.prepare({
      reference: first.order.reference,
      contractId: "esign-contract-manual-001",
      signingUrl: "https://sign.example.com/flows/manual-001",
      actorUserId: 1,
    });
    const preparedReplay = await harness.service.prepare({
      reference: first.order.reference,
      contractId: "esign-contract-manual-001",
      signingUrl: "https://sign.example.com/flows/manual-001",
      actorUserId: 1,
    });
    expect(preparedReplay).toEqual(prepared);
    expect(prepared.order).toMatchObject({
      status: "signature_required",
      contractId: "esign-contract-manual-001",
      signingUrl: "https://sign.example.com/flows/manual-001",
    });

    const signedInput = {
      reference: first.order.reference,
      signedPdf: {
        fileId: "signed-pdf-file-001",
        filename: "signed-contract.pdf",
        sha256: "a".repeat(64),
      },
      signedAt: Date.parse("2026-07-26T10:05:00.789Z"),
      signatoryId: "enterprise-signatory-001",
      note: "已核对电子签平台签署原件与签署报告",
      actorUserId: 1,
    };
    const signed = await harness.service.confirmSigned(signedInput);
    const signedReplay = await harness.service.confirmSigned(signedInput);
    expect(signedReplay).toEqual(signed);
    expect(signed.order.status).toBe("payment_required");

    const [paid, paidReplay] = await Promise.all([
      harness.service.recordPayment({
        reference: first.order.reference,
        idempotencyKey: "manual-payment-idempotency-001",
        request: paymentRequest(),
      }),
      harness.service.recordPayment({
        reference: first.order.reference,
        idempotencyKey: "manual-payment-idempotency-001",
        request: paymentRequest(),
      }),
    ]);
    expect(paid.order.status).toBe("account_setup_required");
    expect(paidReplay.order.status).toBe("account_setup_required");
    expect(harness.submitPurchase).not.toHaveBeenCalled();

    const credentials = accountRequest();
    const [accountReady, accountReplay] = await Promise.all([
      harness.service.setupAccount({
        reference: first.order.reference,
        idempotencyKey: "manual-account-idempotency-001",
        request: credentials,
      }),
      harness.service.setupAccount({
        reference: first.order.reference,
        idempotencyKey: "manual-account-idempotency-001",
        request: credentials,
      }),
    ]);
    expect(accountReady.order.status).toBe("active");
    expect(accountReplay.order.status).toBe("active");
    expect(harness.submitPurchase).toHaveBeenCalledTimes(1);
    expect(harness.submitPurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^manual-account:[a-f0-9]{64}:purchase-v2$/,
        ),
        manualOrderReference: first.order.reference,
        request: expect.objectContaining({
          order: expect.objectContaining({
            paidAt: "2026-07-26T10:10:00.000Z",
          }),
          account: {
            mode: "create",
            username: "example.manual",
            displayName: "示例科技有限公司",
          },
        }),
      }),
    );
    expect(JSON.stringify(harness.submitPurchase.mock.calls)).not.toContain(
      credentials.account.mode === "create"
        ? credentials.account.password
        : "unreachable",
    );
    expect(harness.decidePurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: "provision-manual-001",
        manualOrderReference: first.order.reference,
        actorUserId: 1,
        decision: "confirm",
        manualPasswordHash: PASSWORD_HASH,
      }),
    );

    // The former administrator action remains an idempotent recovery path,
    // but the customer account submission has already activated the order.
    const [active, activeReplay] = await Promise.all([
      harness.service.activate({
        reference: first.order.reference,
        actorUserId: 1,
      }),
      harness.service.activate({
        reference: first.order.reference,
        actorUserId: 1,
      }),
    ]);
    expect(active.order.status).toBe("active");
    expect(active.account?.accountSetupUrl).toBeUndefined();
    expect(active.account?.workspaceUrl).toBe("https://agent.example/");
    expect(activeReplay.order.status).toBe("active");
    expect(harness.decidePurchase).toHaveBeenCalledTimes(1);
    expect(
      harness.repository.rows.get(first.order.reference)?.requestedPasswordHash,
    ).toBeNull();
  });

  it.each(["electronic_signature", "external_wechat"] as const)(
    "requires payment to be strictly later than %s evidence",
    async (mode) => {
      const harness = serviceHarness();
      let reference: string;
      if (mode === "electronic_signature") {
        reference = await createAndSign(harness);
      } else {
        const created = await harness.service.create({
          idempotencyKey: "manual-create-idempotency-001",
          request: createRequest(),
        });
        reference = created.order.reference;
        await harness.service.authorizeExternal({
          reference,
          request: {
            schemaVersion: 1,
            authorization: {
              mode: "external_wechat",
              eventReference: "wechat-contract-event-001",
              authorizedAt: "2026-07-26T10:05:00.000Z",
            },
          },
        });
      }
      const simultaneousPayment = paymentRequest();
      simultaneousPayment.payment.paidAt = "2026-07-26T10:05:00.000Z";
      await expect(
        harness.service.recordPayment({
          reference,
          idempotencyKey: "manual-payment-idempotency-001",
          request: simultaneousPayment,
        }),
      ).rejects.toMatchObject({ code: "MANUAL_ORDER_SCOPE_MISMATCH" });
      expect(harness.repository.rows.get(reference)?.amountFen).toBeNull();
    },
  );

  it("persists the account request before automatic activation and safely resumes after an outage", async () => {
    const harness = serviceHarness();
    const reference = await createAndSign(harness);
    await harness.service.recordPayment({
      reference,
      idempotencyKey: "manual-payment-idempotency-001",
      request: paymentRequest(),
    });
    harness.decidePurchase.mockRejectedValueOnce(
      new Error("temporary provisioning outage"),
    );

    await expect(
      harness.service.setupAccount({
        reference,
        idempotencyKey: "manual-account-idempotency-001",
        request: accountRequest(),
      }),
    ).rejects.toThrow("temporary provisioning outage");
    expect(harness.repository.rows.get(reference)).toMatchObject({
      status: "activation_required",
      requestedPasswordHash: PASSWORD_HASH,
    });

    const resumed = await harness.service.setupAccount({
      reference,
      idempotencyKey: "manual-account-idempotency-001",
      request: accountRequest(),
    });
    expect(resumed.order.status).toBe("active");
    expect(harness.submitPurchase).toHaveBeenCalledTimes(1);
    expect(harness.decidePurchase).toHaveBeenCalledTimes(2);

    await expect(
      harness.service.setupAccount({
        reference,
        idempotencyKey: "manual-account-idempotency-001",
        request: accountRequest({
          mode: "create",
          username: "example.manual",
          displayName: "示例科技有限公司",
          password: "a-different-customer-password",
        }),
      }),
    ).rejects.toMatchObject({ code: "MANUAL_ORDER_STATE_CONFLICT" });
  });

  it("refuses automatic activation without the system administrator who verified signing", async () => {
    const harness = serviceHarness();
    const reference = await createAndSign(harness);
    await harness.service.recordPayment({
      reference,
      idempotencyKey: "manual-payment-idempotency-001",
      request: paymentRequest(),
    });
    Object.assign(harness.repository.rows.get(reference)!, {
      signedByUserId: null,
    });

    await expect(
      harness.service.setupAccount({
        reference,
        idempotencyKey: "manual-account-idempotency-001",
        request: accountRequest(),
      }),
    ).rejects.toMatchObject({ code: "MANUAL_ORDER_STATE_CONFLICT" });
    expect(harness.repository.rows.get(reference)?.status).toBe(
      "activation_required",
    );
    expect(harness.decidePurchase).not.toHaveBeenCalled();
  });

  it("rejects every out-of-order transition and accepts the verified negotiated amount", async () => {
    const harness = serviceHarness();
    const created = await harness.service.create({
      idempotencyKey: "manual-create-idempotency-001",
      request: createRequest(),
    });
    const reference = created.order.reference;

    await expect(
      harness.service.confirmSigned({
        reference,
        signedPdf: {
          fileId: "signed-pdf-file-001",
          filename: "signed-contract.pdf",
          sha256: "a".repeat(64),
        },
        signedAt: Date.parse("2026-07-26T10:05:00.000Z"),
        signatoryId: "enterprise-signatory-001",
        note: "已核对完整签署证据与签署主体",
        actorUserId: 1,
      }),
    ).rejects.toMatchObject({ code: "MANUAL_ORDER_STATE_CONFLICT" });
    await expect(
      harness.service.recordPayment({
        reference,
        idempotencyKey: "manual-payment-idempotency-001",
        request: paymentRequest(),
      }),
    ).rejects.toMatchObject({ code: "MANUAL_ORDER_STATE_CONFLICT" });
    await expect(
      harness.service.activate({ reference, actorUserId: 1 }),
    ).rejects.toMatchObject({ code: "MANUAL_ORDER_STATE_CONFLICT" });
    await expect(
      harness.service.setupAccount({
        reference,
        idempotencyKey: "manual-account-idempotency-001",
        request: accountRequest(),
      }),
    ).rejects.toMatchObject({ code: "MANUAL_ORDER_STATE_CONFLICT" });

    await createAndSign(harness);
    const negotiatedPayment = paymentRequest();
    negotiatedPayment.payment.amountFen = 200_000;
    await harness.service.recordPayment({
      reference,
      idempotencyKey: "manual-payment-idempotency-001",
      request: negotiatedPayment,
    });
    expect(harness.submitPurchase).not.toHaveBeenCalled();
    expect(harness.repository.rows.get(reference)?.amountFen).toBe(200_000);
    await expect(
      harness.service.activate({ reference, actorUserId: 1 }),
    ).rejects.toMatchObject({ code: "MANUAL_ORDER_STATE_CONFLICT" });
  });

  it("never persists a bind-existing purchase intent in the manual order", async () => {
    const harness = serviceHarness();
    const reference = await createAndSign(harness);
    const purchaseIntent = "opaque-existing-account-purchase-intent";
    await harness.service.recordPayment({
      reference,
      idempotencyKey: "manual-payment-idempotency-001",
      request: paymentRequest(),
    });
    const active = await harness.service.setupAccount({
      reference,
      idempotencyKey: "manual-account-idempotency-001",
      request: accountRequest({
        mode: "bind_existing",
        purchaseIntent,
      }),
    });
    expect(active.order.status).toBe("active");
    expect(harness.submitPurchase.mock.calls[0]?.[0].request.account).toEqual({
      mode: "bind_existing",
      purchaseIntent,
    });
    expect(JSON.stringify(await harness.service.list())).not.toContain(
      purchaseIntent,
    );
    expect(JSON.stringify([...harness.repository.rows.values()])).not.toContain(
      purchaseIntent,
    );
    expect(
      harness.repository.rows.get(reference)?.requestedPasswordHash,
    ).toBeNull();
    expect(harness.decidePurchase).toHaveBeenCalledWith(
      expect.not.objectContaining({ manualPasswordHash: expect.anything() }),
    );
  });

  it("recovers a pre-migration activation order only with its already reserved username", async () => {
    const harness = serviceHarness();
    const reference = await createAndSign(harness);
    await harness.service.recordPayment({
      reference,
      idempotencyKey: "manual-payment-idempotency-001",
      request: paymentRequest(),
    });
    Object.assign(harness.repository.rows.get(reference)!, {
      status: "activation_required",
      accountMode: "create",
      requestedUsername: "example.manual",
      requestedDisplayName: "示例科技有限公司",
      provisioningReference: "provision-manual-001",
    });

    await expect(
      harness.service.setupAccount({
        reference,
        idempotencyKey: "manual-account-idempotency-wrong",
        request: accountRequest({
          mode: "create",
          username: "different.user",
          displayName: "示例科技有限公司",
          password: "customer-selected-password",
        }),
      }),
    ).rejects.toMatchObject({ code: "MANUAL_ORDER_STATE_CONFLICT" });

    const recovered = await harness.service.setupAccount({
      reference,
      idempotencyKey: "manual-account-idempotency-001",
      request: accountRequest(),
    });
    expect(recovered.order.status).toBe("active");
    expect(harness.submitPurchase).not.toHaveBeenCalled();
    expect(
      harness.repository.rows.get(reference)?.requestedPasswordHash,
    ).toBeNull();
  });

  it("rejects an idempotency key reused for a different create request", async () => {
    const harness = serviceHarness();
    await harness.service.create({
      idempotencyKey: "manual-create-idempotency-001",
      request: createRequest(),
    });
    await expect(
      harness.service.create({
        idempotencyKey: "manual-create-idempotency-001",
        request: createRequest("另一个不可混用的购买问题是什么？"),
      }),
    ).rejects.toMatchObject({
      code: "MANUAL_ORDER_IDEMPOTENCY_CONFLICT",
    });
  });

  it("makes rejection terminal and idempotent before activation", async () => {
    const harness = serviceHarness();
    const created = await harness.service.create({
      idempotencyKey: "manual-create-idempotency-001",
      request: createRequest(),
    });
    const rejected = await harness.service.reject({
      reference: created.order.reference,
      actorUserId: 1,
      note: "签约主体资料无法通过人工复核",
    });
    const replay = await harness.service.reject({
      reference: created.order.reference,
      actorUserId: 1,
      note: "重复拒绝不会改变结果",
    });
    expect(rejected.order.status).toBe("rejected");
    expect(replay.order.status).toBe("rejected");
    await expect(
      harness.service.prepare({
        reference: created.order.reference,
        contractId: "esign-contract-manual-001",
        signingUrl: "https://sign.example.com/flows/manual-001",
        actorUserId: 1,
      }),
    ).rejects.toMatchObject({ code: "MANUAL_ORDER_STATE_CONFLICT" });
  });

  it("uses the owning manual-order reference when rejecting its provisioning ledger", async () => {
    const harness = serviceHarness();
    const reference = await createAndSign(harness);
    await harness.service.recordPayment({
      reference,
      idempotencyKey: "manual-payment-idempotency-001",
      request: paymentRequest(),
    });
    harness.decidePurchase.mockRejectedValueOnce(
      new Error("temporary provisioning outage"),
    );
    await expect(
      harness.service.setupAccount({
        reference,
        idempotencyKey: "manual-account-idempotency-001",
        request: accountRequest(),
      }),
    ).rejects.toThrow("temporary provisioning outage");
    expect(harness.repository.rows.get(reference)?.status).toBe(
      "activation_required",
    );

    const rejected = await harness.service.reject({
      reference,
      actorUserId: 1,
      note: "签约后人工复核未通过",
    });

    expect(rejected.order.status).toBe("rejected");
    expect(harness.decidePurchase).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: "provision-manual-001",
        manualOrderReference: reference,
        decision: "reject",
      }),
    );
  });
});
