import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser, DecryptedCredential } from "../auth-service";
import type { FrontMindRequest } from "./express-auth";

const authMocks = vi.hoisted(() => ({
  getCredentialForUpstreamResource: vi.fn(),
  getEffectiveDecryptedCredentialForAccount: vi.fn(),
}));

vi.mock("../auth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-service")>()),
  getCredentialForUpstreamResource: authMocks.getCredentialForUpstreamResource,
  getEffectiveDecryptedCredentialForAccount:
    authMocks.getEffectiveDecryptedCredentialForAccount,
}));

import { resolveUpstreamCredential } from "./upstream-credential";

function user(id: number): AuthenticatedUser {
  const now = new Date();
  return {
    id,
    openId: null,
    username: `user-${id}`,
    displayName: `User ${id}`,
    name: `User ${id}`,
    email: null,
    loginMethod: "password",
    role: "user",
    adminAccessLevel: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
}

function credential({
  id,
  userId,
  apiKey,
  fingerprint = "fp_shared_key",
}: {
  id: string;
  userId: number;
  apiKey: string;
  fingerprint?: string;
}): DecryptedCredential {
  return {
    id,
    userId,
    version: 1,
    apiKey,
    fingerprint,
    status: "active",
    verifiedAt: new Date(),
  };
}

function request(
  accountId: number,
  attachmentFileId: string,
): FrontMindRequest {
  return {
    method: "POST",
    originalUrl: "/api/frontmind/v1/tasks/task-current",
    body: {
      attachments: [{ file_id: attachmentFileId }],
    },
    frontmindUser: user(accountId),
  } as FrontMindRequest;
}

function response() {
  const json = vi.fn();
  const res = {
    status: vi.fn(),
    json,
  };
  res.status.mockReturnValue(res);
  return res;
}

describe("resolveUpstreamCredential attachment API Key policy", () => {
  it("defers only knowledge-base scoped managed-upload creation to its frozen reservation", async () => {
    const req = {
      method: "POST",
      originalUrl: "/api/frontmind/v1/managed-uploads",
      body: {
        resumeScope: {
          kind: "knowledge_base",
          conversationId: "conversation-1",
          turnId: "turn-1",
          clientRequestId: "request-1",
        },
      },
      frontmindUser: { id: 42, role: "user" },
      query: {},
    } as never;
    const res = response();
    const next = vi.fn();

    await resolveUpstreamCredential(req, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("still requires an active credential for unscoped managed-upload creation", async () => {
    authMocks.getEffectiveDecryptedCredentialForAccount.mockResolvedValue(null);
    const req = {
      method: "POST",
      originalUrl: "/api/frontmind/v1/managed-uploads",
      body: {},
      frontmindUser: { id: 42, role: "user" },
      query: {},
    } as never;
    const res = response();
    const next = vi.fn();

    await resolveUpstreamCredential(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(428);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows an attachment owned by the same account when different credential IDs decrypt to the same raw API Key", async () => {
    const taskCredential = credential({
      id: "credential-current",
      userId: 7,
      apiKey: "sk-shared-account-key",
    });
    const attachmentCredential = credential({
      id: "credential-historical",
      userId: 7,
      apiKey: "sk-shared-account-key",
    });
    authMocks.getCredentialForUpstreamResource.mockImplementation(
      async (accountId: number, kind: string, upstreamId: string) => {
        if (
          accountId === 7 &&
          kind === "task" &&
          upstreamId === "task-current"
        ) {
          return taskCredential;
        }
        if (
          accountId === 7 &&
          kind === "file" &&
          upstreamId === "file-shared-key"
        ) {
          return attachmentCredential;
        }
        return null;
      },
    );

    const req = request(7, "file-shared-key");
    const res = response();
    const next = vi.fn();

    await resolveUpstreamCredential(req, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.frontmindCredential).toBe(taskCredential);
    expect(authMocks.getCredentialForUpstreamResource).toHaveBeenCalledWith(
      7,
      "file",
      "file-shared-key",
      undefined,
    );
  });

  it("rejects a same-account attachment when the raw API Key differs, even if the fingerprint is the same", async () => {
    const taskCredential = credential({
      id: "credential-current",
      userId: 7,
      apiKey: "sk-current-key-000",
    });
    const attachmentCredential = credential({
      id: "credential-historical",
      userId: 7,
      apiKey: "sk-different-key-0",
    });
    authMocks.getCredentialForUpstreamResource.mockImplementation(
      async (accountId: number, kind: string, upstreamId: string) => {
        if (
          accountId === 7 &&
          kind === "task" &&
          upstreamId === "task-current"
        ) {
          return taskCredential;
        }
        if (
          accountId === 7 &&
          kind === "file" &&
          upstreamId === "file-different-key"
        ) {
          return attachmentCredential;
        }
        return null;
      },
    );

    const req = request(7, "file-different-key");
    const res = response();
    const next = vi.fn();

    await resolveUpstreamCredential(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: "附件不属于当前账号，或与当前任务使用的 API Key 不一致",
        code: "ATTACHMENT_FORBIDDEN",
      },
    });
  });

  it("rejects an attachment owned by another account even when both accounts share the same raw API Key", async () => {
    const resources = [
      {
        accountId: 7,
        kind: "task",
        upstreamId: "task-current",
        credential: credential({
          id: "credential-account-7",
          userId: 7,
          apiKey: "sk-shared-across-accounts",
        }),
      },
      {
        accountId: 8,
        kind: "file",
        upstreamId: "file-account-8",
        credential: credential({
          id: "credential-account-8",
          userId: 8,
          apiKey: "sk-shared-across-accounts",
        }),
      },
    ];
    authMocks.getCredentialForUpstreamResource.mockImplementation(
      async (accountId: number, kind: string, upstreamId: string) =>
        resources.find(
          (resource) =>
            resource.accountId === accountId &&
            resource.kind === kind &&
            resource.upstreamId === upstreamId,
        )?.credential ?? null,
    );

    const req = request(7, "file-account-8");
    const res = response();
    const next = vi.fn();

    await resolveUpstreamCredential(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(
      resources.find((resource) => resource.upstreamId === "file-account-8")
        ?.credential.apiKey,
    ).toBe(
      resources.find((resource) => resource.upstreamId === "task-current")
        ?.credential.apiKey,
    );
    expect(authMocks.getCredentialForUpstreamResource).toHaveBeenCalledWith(
      7,
      "file",
      "file-account-8",
      undefined,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: "附件不属于当前账号，或与当前任务使用的 API Key 不一致",
        code: "ATTACHMENT_FORBIDDEN",
      },
    });
  });

  it("lets read-only file routes resolve an expired ledger row so the content resolver can return 410", async () => {
    const fileCredential = credential({
      id: "credential-file",
      userId: 7,
      apiKey: "sk-file-key",
    });
    authMocks.getCredentialForUpstreamResource.mockResolvedValue(
      fileCredential,
    );
    const req = {
      method: "GET",
      originalUrl: "/api/frontmind/v1/files/file%2Fexpired/content",
      body: {},
      frontmindUser: user(7),
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    await resolveUpstreamCredential(req, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(authMocks.getCredentialForUpstreamResource).toHaveBeenCalledWith(
      7,
      "file",
      "file/expired",
      undefined,
      { allowExpiredFileContent: true },
    );
  });

  it.each([
    ["PUT", "/api/frontmind/proxy-upload?upload_intent_id=mui_1"],
    ["POST", "/api/frontmind/v1/managed-uploads/recovery"],
    ["DELETE", "/api/frontmind/v1/managed-uploads"],
  ])(
    "lets an existing intent %s operation resolve its frozen credential in the intent service",
    async (method, originalUrl) => {
      authMocks.getEffectiveDecryptedCredentialForAccount.mockResolvedValue(
        null,
      );
      const req = {
        method,
        originalUrl,
        query: method === "PUT" ? { upload_intent_id: "mui_1" } : undefined,
        body: {},
        frontmindUser: user(7),
      } as FrontMindRequest;
      const res = response();
      const next = vi.fn();

      await resolveUpstreamCredential(req, res as never, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(
        authMocks.getEffectiveDecryptedCredentialForAccount,
      ).not.toHaveBeenCalled();
      expect(req.frontmindCredential).toBeUndefined();
    },
  );

  it("still requires the active credential when allocating a new intent", async () => {
    authMocks.getEffectiveDecryptedCredentialForAccount.mockResolvedValue(null);
    const req = {
      method: "POST",
      originalUrl: "/api/frontmind/v1/managed-uploads",
      body: {},
      frontmindUser: user(7),
    } as FrontMindRequest;
    const res = response();
    const next = vi.fn();

    await resolveUpstreamCredential(req, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(428);
  });
});
