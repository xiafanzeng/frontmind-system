import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertProvisioningConfigured,
  createProvisioningRouter,
  isValidProvisioningServiceToken,
} from "./provisioning-router";
import type {
  ProvisionWebsiteUserInput,
  ProvisionedWebsiteUser,
  WebsiteProvisionRequest,
} from "./provisioning-service";

const SERVICE_TOKEN = "4q9zY3PjF9yebW7s7NXVk5dWks6UN3A4r0mgPS6g6nE";
const originalServiceToken = process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN;
const servers: Server[] = [];

afterEach(async () => {
  if (originalServiceToken === undefined) {
    delete process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN;
  } else {
    process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN = originalServiceToken;
  }
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

function requestBody(): WebsiteProvisionRequest {
  return {
    schemaVersion: 1,
    project: {
      id: "project-acceptance-001",
      companyName: "验收企业",
    },
    order: {
      id: "order-zpay-000001",
      tradeNo: "zpay-trade-000001",
      status: "paid",
      amountFen: 150_000,
      paidAt: "2026-07-24T08:00:00.000Z",
      serviceCategory: "product_scenario",
      questionId: "question-acceptance-001",
      question: "验收企业有哪些核心服务？",
    },
    contract: {
      id: "contract-acceptance-000001",
      status: "signed",
      projectId: "project-acceptance-001",
      orderId: "order-zpay-000001",
      questionId: "question-acceptance-001",
      templateVersion: "geo-monthly-v1",
      documentSha256:
        "13d24e49d2d8fb42551cc71e449553c242add7a689f633062f838263672cb80d",
      signedAt: "2026-07-24T08:05:00.000Z",
      signatoryId: "customer-signatory-001",
    },
    account: {
      username: "acceptance.customer",
      password: "customer-selected-password",
      displayName: "验收企业",
    },
  };
}

async function startApp(
  provisionUser: (
    input: ProvisionWebsiteUserInput,
  ) => Promise<ProvisionedWebsiteUser> = async () => ({
    provision: {
      id: "provision-001",
      projectId: "project-acceptance-001",
      orderId: "order-zpay-000001",
      contractId: "contract-acceptance-000001",
      status: "completed",
      completedAt: "2026-07-24T08:06:00.000Z",
    },
    user: {
      id: 42,
      username: "acceptance.customer",
      displayName: "验收企业",
      role: "user",
      isActive: true,
    },
    replayed: false,
  }),
  serviceToken: string | null = SERVICE_TOKEN,
) {
  const app = express();
  app.use(
    "/api/internal/provisioning",
    createProvisioningRouter({
      env: {
        FRONTMIND_PROVISIONING_SERVICE_TOKEN: serviceToken ?? undefined,
      },
      provisionUser,
    }),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/internal/provisioning/users`;
}

async function startKnowledgeImportApp(
  importKnowledge: NonNullable<
    NonNullable<
      Parameters<typeof createProvisioningRouter>[0]
    >["importKnowledge"]
  >,
) {
  const app = express();
  app.use(
    "/api/internal/provisioning",
    createProvisioningRouter({
      env: {
        FRONTMIND_PROVISIONING_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      importKnowledge,
    }),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/internal/provisioning/projects/project-acceptance-001/knowledge-imports`;
}

describe("provisioning service-token boundary", () => {
  it("accepts only the independently configured exact secret", () => {
    expect(isValidProvisioningServiceToken(SERVICE_TOKEN, SERVICE_TOKEN)).toBe(
      true,
    );
    expect(
      isValidProvisioningServiceToken(`${SERVICE_TOKEN}x`, SERVICE_TOKEN),
    ).toBe(false);
    expect(isValidProvisioningServiceToken("wrong-token", SERVICE_TOKEN)).toBe(
      false,
    );
    expect(isValidProvisioningServiceToken(undefined, SERVICE_TOKEN)).toBe(
      false,
    );

    process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN = "too-short";
    expect(() => assertProvisioningConfigured()).toThrow();
    process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN = SERVICE_TOKEN;
    expect(() => assertProvisioningConfigured()).not.toThrow();
  });

  it("imports a project-scoped knowledge artifact without accepting userId", async () => {
    const importKnowledge = vi.fn().mockResolvedValue({
      status: "completed",
      replayed: false,
      receiptId: "receipt-knowledge-1",
      snapshot: { id: "snapshot-1", version: 1 },
    });
    const url = await startKnowledgeImportApp(importKnowledge);
    const request = {
      schemaVersion: 2,
      companyName: "验收企业",
      taskId: "task-website-kb-1",
      outputItemId: "output-1",
      fileId: "file-1",
      descriptorHash: "a".repeat(64),
      artifactSha256: "b".repeat(64),
      filename: "acceptance_knowledge_base.zip",
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "website-kb-project-acceptance-001",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 2,
      knowledgeImport: {
        id: "receipt-knowledge-1",
        projectId: "project-acceptance-001",
        status: "ready",
      },
    });
    expect(importKnowledge).toHaveBeenCalledWith({
      projectId: "project-acceptance-001",
      idempotencyKey: "website-kb-project-acceptance-001",
      value: request,
    });
  });

  it("preserves the v3 schema version and forwards the archive contract unchanged", async () => {
    const importKnowledge = vi.fn().mockResolvedValue({
      status: "completed",
      replayed: false,
      receiptId: "receipt-knowledge-v3",
      snapshot: { id: "snapshot-v3", version: 1 },
    });
    const url = await startKnowledgeImportApp(importKnowledge);
    const request = {
      schemaVersion: 3,
      archiveContractVersion: 1,
      validationProfile: "website-lead-v1",
      packageManifestSha256: "c".repeat(64),
      companyName: "验收企业",
      taskId: "task-website-kb-v3",
      outputItemId: "output-v3",
      fileId: "file-v3",
      descriptorHash: "a".repeat(64),
      artifactSha256: "b".repeat(64),
      filename: "acceptance_knowledge_base_v3.zip",
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "website-kb-project-acceptance-v3",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 3,
      knowledgeImport: {
        id: "receipt-knowledge-v3",
        projectId: "project-acceptance-001",
        status: "ready",
      },
    });
    expect(importKnowledge).toHaveBeenCalledWith({
      projectId: "project-acceptance-001",
      idempotencyKey: "website-kb-project-acceptance-v3",
      value: request,
    });
  });

  it("preserves the v4 candidate lineage and finalized artifact", async () => {
    const importKnowledge = vi.fn().mockResolvedValue({
      status: "completed",
      replayed: false,
      receiptId: "receipt-knowledge-v4",
      snapshot: { id: "snapshot-v4", version: 1 },
    });
    const url = await startKnowledgeImportApp(importKnowledge);
    const request = {
      schemaVersion: 4,
      companyName: "验收企业",
      candidate: {
        taskId: "task-website-kb-v4",
        outputItemId: "output-v4",
        fileId: "candidate-file-v4",
        descriptorHash: "a".repeat(64),
        sha256: "b".repeat(64),
      },
      finalArtifact: {
        fileId: "final-file-v4",
        filename: "acceptance_knowledge_base_v4.zip",
        sha256: "c".repeat(64),
        archiveContractVersion: 3,
        validationProfile: "website-lead-v1",
        packageManifestSha256: "d".repeat(64),
        finalizerVersion: "website-kb-finalizer-v1",
      },
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "website-kb-project-acceptance-v4",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 4,
      knowledgeImport: {
        id: "receipt-knowledge-v4",
        projectId: "project-acceptance-001",
        status: "ready",
      },
    });
    expect(importKnowledge).toHaveBeenCalledWith({
      projectId: "project-acceptance-001",
      idempotencyKey: "website-kb-project-acceptance-v4",
      value: request,
    });
  });

  it("rejects an incomplete v3 contract before invoking the importer", async () => {
    const importKnowledge = vi.fn();
    const url = await startKnowledgeImportApp(importKnowledge);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "website-kb-project-invalid-v3",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify({
        schemaVersion: 3,
        archiveContractVersion: 1,
        validationProfile: "website-lead-v1",
        companyName: "验收企业",
        taskId: "task-website-kb-v3",
        outputItemId: "output-v3",
        descriptorHash: "a".repeat(64),
        artifactSha256: "b".repeat(64),
        filename: "acceptance_knowledge_base_v3.zip",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(importKnowledge).not.toHaveBeenCalled();
  });

  it("authenticates before parsing JSON or calling the provisioner", async () => {
    const provisionUser = vi.fn();
    const url = await startApp(provisionUser);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frontmind-provisioning-token": "wrong-token",
      },
      body: "{",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_SERVICE_TOKEN" },
    });
    expect(provisionUser).not.toHaveBeenCalled();
  });

  it("fails closed when the dedicated service token is absent", async () => {
    const provisionUser = vi.fn();
    const url = await startApp(provisionUser, null);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify(requestBody()),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROVISIONING_NOT_CONFIGURED" },
    });
    expect(provisionUser).not.toHaveBeenCalled();
  });

  it("rejects role injection before provisioning", async () => {
    const provisionUser = vi.fn();
    const url = await startApp(provisionUser);
    const body = {
      ...requestBody(),
      account: { ...requestBody().account, role: "admin" },
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "website-order-zpay-000001",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(provisionUser).not.toHaveBeenCalled();
  });

  it("returns only safe account data and preserves replay semantics", async () => {
    const provisionUser = vi.fn().mockResolvedValueOnce({
      provision: {
        id: "provision-001",
        projectId: "project-acceptance-001",
        orderId: "order-zpay-000001",
        contractId: "contract-acceptance-000001",
        status: "completed",
        completedAt: "2026-07-24T08:06:00.000Z",
      },
      user: {
        id: 42,
        username: "acceptance.customer",
        displayName: "验收企业",
        role: "user",
        isActive: true,
      },
      replayed: true,
    });
    const url = await startApp(provisionUser);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "website-order-zpay-000001",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify(requestBody()),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("idempotent-replayed")).toBe("true");
    expect(body.user).toMatchObject({ role: "user", id: 42 });
    expect(JSON.stringify(body)).not.toContain("customer-selected-password");
    expect(provisionUser).toHaveBeenCalledWith({
      idempotencyKey: "website-order-zpay-000001",
      request: requestBody(),
    });
  });
});
