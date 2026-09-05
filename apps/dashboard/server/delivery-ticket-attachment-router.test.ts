import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const dependencies = vi.hoisted(() => ({
  assertDeliveryProjectContext: vi.fn(),
  assertWorkspaceAccess: vi.fn(),
  getCredentialForUpstreamResource: vi.fn(),
  getDb: vi.fn(),
  resolveOwnedFile: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("./delivery-role-service", () => ({
  assertDeliveryProjectContext: dependencies.assertDeliveryProjectContext,
}));
vi.mock("./dashboard-service", () => ({
  assertWorkspaceAccess: dependencies.assertWorkspaceAccess,
}));
vi.mock("./auth-service", async () => {
  const actual =
    await vi.importActual<typeof import("./auth-service")>("./auth-service");
  return {
    ...actual,
    getCredentialForUpstreamResource:
      dependencies.getCredentialForUpstreamResource,
  };
});
vi.mock("./owned-file-content-resolver", async () => {
  const actual = await vi.importActual<
    typeof import("./owned-file-content-resolver")
  >("./owned-file-content-resolver");
  return {
    ...actual,
    ownedFileContentResolver: { resolve: dependencies.resolveOwnedFile },
  };
});

import {
  canCustomerDownloadTicketAttachment,
  downloadAuthorizedTicketAttachment,
  resolveAuthorizedTicketAttachment,
} from "./delivery-ticket-attachment-router";

const engineer = {
  id: 42,
  username: "knowledge-engineer",
  role: "delivery_member",
  engineerRoleType: "ai_operations_engineer",
  isActive: true,
} as const;

function attachmentDatabase(row: Record<string, unknown>) {
  const query: Record<string, any> = {
    innerJoin: () => query,
    leftJoin: () => query,
    where: () => query,
    limit: async () => [row],
  };
  return {
    select: () => ({
      from: () => query,
    }),
  };
}

describe("delivery ticket attachment authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.assertDeliveryProjectContext.mockResolvedValue({
      projectAssignmentId: "project-a",
      customerUserId: 7,
      roleType: "ai_operations_engineer",
    });
    dependencies.getCredentialForUpstreamResource.mockResolvedValue({
      id: "credential-1",
      apiKey: "sk-test",
    });
  });

  it("requires both ticket ownership and a customer-visible event", () => {
    expect(
      canCustomerDownloadTicketAttachment({
        actorUserId: 7,
        ticketUserId: 7,
        eventVisibility: "customer",
      }),
    ).toBe(true);
    expect(
      canCustomerDownloadTicketAttachment({
        actorUserId: 7,
        ticketUserId: 7,
        eventVisibility: "internal",
      }),
    ).toBe(false);
    expect(
      canCustomerDownloadTicketAttachment({
        actorUserId: 7,
        ticketUserId: 7,
        eventVisibility: null,
      }),
    ).toBe(false);
    expect(
      canCustomerDownloadTicketAttachment({
        actorUserId: 8,
        ticketUserId: 7,
        eventVisibility: "customer",
      }),
    ).toBe(false);
  });

  it("rejects an attachment when the selected project does not own its ticket", async () => {
    dependencies.getDb.mockResolvedValue(
      attachmentDatabase({
        attachment: {
          id: "attachment-1",
          upstreamFileId: "file-1",
        },
        ticketUserId: 7,
        ticketStatus: "in_progress",
        assignedProjectAssignmentId: "project-a",
        assignedMemberId: engineer.id,
        eventVisibility: "internal",
      }),
    );

    await expect(
      resolveAuthorizedTicketAttachment({
        actor: engineer,
        attachmentId: "attachment-1",
        projectAssignmentId: "project-b",
      }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_FOUND",
      statusCode: 404,
    });
    expect(dependencies.assertDeliveryProjectContext).not.toHaveBeenCalled();
    expect(
      dependencies.getCredentialForUpstreamResource,
    ).not.toHaveBeenCalled();
  });

  it("rejects an active ticket after its member assignment has moved", async () => {
    dependencies.getDb.mockResolvedValue(
      attachmentDatabase({
        attachment: {
          id: "attachment-1",
          upstreamFileId: "file-1",
        },
        ticketUserId: 7,
        ticketStatus: "in_progress",
        assignedProjectAssignmentId: "project-a",
        assignedMemberId: 99,
        eventVisibility: "internal",
      }),
    );

    await expect(
      resolveAuthorizedTicketAttachment({
        actor: engineer,
        attachmentId: "attachment-1",
        projectAssignmentId: "project-a",
      }),
    ).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_FOUND",
      statusCode: 404,
    });
    expect(dependencies.assertDeliveryProjectContext).toHaveBeenCalledWith({
      actor: engineer,
      projectAssignmentId: "project-a",
      customerUserId: 7,
    });
    expect(
      dependencies.getCredentialForUpstreamResource,
    ).not.toHaveBeenCalled();
  });

  it("allows the originally assigned engineer to read a terminal task attachment without an active project assignment", async () => {
    dependencies.getDb.mockResolvedValue(
      attachmentDatabase({
        attachment: {
          id: "attachment-1",
          ownerUserId: engineer.id,
          upstreamFileId: "file-1",
        },
        ticketUserId: 7,
        ticketStatus: "completed",
        assignedProjectAssignmentId: "project-a",
        assignedMemberId: engineer.id,
        eventVisibility: "internal",
      }),
    );

    await expect(
      resolveAuthorizedTicketAttachment({
        actor: engineer,
        attachmentId: "attachment-1",
      }),
    ).resolves.toMatchObject({
      ticketStatus: "completed",
      assignedMemberId: engineer.id,
    });
    expect(dependencies.assertDeliveryProjectContext).not.toHaveBeenCalled();
    expect(dependencies.getCredentialForUpstreamResource).toHaveBeenCalledWith(
      engineer.id,
      "file",
      "file-1",
      "project-a",
    );
  });

  it("downloads authorized bytes through the shared resolver with exact scope", async () => {
    const bytes = Buffer.from("ticket attachment bytes");
    dependencies.resolveOwnedFile.mockResolvedValue({
      stream: Readable.from([bytes]),
      mimeType: "application/pdf",
    });

    const result = await downloadAuthorizedTicketAttachment({
      attachment: {
        upstreamFileId: "file-1",
        mimeType: null,
      },
      credential: { id: "credential-1" },
      credentialOwnerUserId: engineer.id,
      credentialProjectAssignmentId: "project-a",
    } as Awaited<ReturnType<typeof resolveAuthorizedTicketAttachment>>);

    expect(result).toEqual({
      content: bytes,
      contentType: "application/pdf",
    });
    expect(dependencies.resolveOwnedFile).toHaveBeenCalledWith({
      ownerUserId: engineer.id,
      fileId: "file-1",
      projectAssignmentId: "project-a",
      expectedCredentialId: "credential-1",
    });
  });
});
