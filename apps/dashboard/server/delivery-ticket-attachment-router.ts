import { and, eq } from "drizzle-orm";
import { Router, type Response } from "express";

import {
  deliveryTicketAttachments,
  deliveryTicketEvents,
  deliveryTickets,
} from "../drizzle/schema";
import {
  AuthServiceError,
  getCredentialForUpstreamResource,
  type AuthenticatedUser,
} from "./auth-service";
import { assertWorkspaceAccess } from "./dashboard-service";
import {
  DeliveryTicketError,
  isDeliveryTicketAttachmentVisible,
} from "./delivery-ticket-service";
import { assertDeliveryProjectContext } from "./delivery-role-service";
import { getDb } from "./db";
import {
  OwnedFileContentError,
  ownedFileContentResolver,
} from "./owned-file-content-resolver";
import type { FrontMindRequest } from "./_core/express-auth";

const router = Router();
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function safeFilename(value: string) {
  return value.replace(/[\\/\0"\r\n]/g, "_").trim() || "attachment";
}

function contentDisposition(filename: string) {
  const safe = safeFilename(filename);
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
}

export function canCustomerDownloadTicketAttachment(input: {
  actorUserId: number;
  ticketUserId: number;
  eventVisibility: "customer" | "internal" | null;
}) {
  return (
    input.actorUserId === input.ticketUserId &&
    isDeliveryTicketAttachmentVisible(false, input.eventVisibility)
  );
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new DeliveryTicketError(
      "DATABASE_UNAVAILABLE",
      "数据库暂时不可用。",
      503,
    );
  }
  return db;
}

/**
 * Resolve by opaque ticket attachment id first. Callers can never substitute
 * an upstream file id to download a file that is not attached to a ticket.
 */
export async function resolveAuthorizedTicketAttachment(input: {
  actor: AuthenticatedUser;
  attachmentId: string;
  projectAssignmentId?: string | null;
}) {
  const db = await requireDb();
  const rows = await db
    .select({
      attachment: deliveryTicketAttachments,
      ticketUserId: deliveryTickets.userId,
      ticketStatus: deliveryTickets.status,
      assignedProjectAssignmentId: deliveryTickets.assignedProjectAssignmentId,
      assignedMemberId: deliveryTickets.assignedMemberId,
      eventVisibility: deliveryTicketEvents.visibility,
    })
    .from(deliveryTicketAttachments)
    .innerJoin(
      deliveryTickets,
      eq(deliveryTickets.id, deliveryTicketAttachments.ticketId),
    )
    .leftJoin(
      deliveryTicketEvents,
      and(
        eq(deliveryTicketEvents.id, deliveryTicketAttachments.eventId),
        eq(deliveryTicketEvents.ticketId, deliveryTicketAttachments.ticketId),
      ),
    )
    .where(eq(deliveryTicketAttachments.id, input.attachmentId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new DeliveryTicketError(
      "ATTACHMENT_NOT_FOUND",
      "工单附件不存在。",
      404,
    );
  }
  if (input.actor.role === "user") {
    if (
      !canCustomerDownloadTicketAttachment({
        actorUserId: input.actor.id,
        ticketUserId: row.ticketUserId,
        eventVisibility: row.eventVisibility,
      })
    ) {
      throw new DeliveryTicketError(
        "ATTACHMENT_NOT_FOUND",
        "工单附件不存在。",
        404,
      );
    }
  } else if (input.actor.role === "delivery_member") {
    const terminal = ["completed", "rejected", "cancelled"].includes(
      row.ticketStatus,
    );
    if (!terminal) {
      if (
        !input.projectAssignmentId ||
        row.assignedProjectAssignmentId !== input.projectAssignmentId
      ) {
        throw new DeliveryTicketError(
          "ATTACHMENT_NOT_FOUND",
          "工单附件不存在。",
          404,
        );
      }
      await assertDeliveryProjectContext({
        actor: input.actor,
        projectAssignmentId: input.projectAssignmentId,
        customerUserId: row.ticketUserId,
      });
    }
    if (row.assignedMemberId !== input.actor.id) {
      throw new DeliveryTicketError(
        "ATTACHMENT_NOT_FOUND",
        "工单附件不存在。",
        404,
      );
    }
  } else {
    await assertWorkspaceAccess(input.actor, row.ticketUserId);
  }
  if (!row.attachment.upstreamFileId) {
    throw new DeliveryTicketError(
      "ATTACHMENT_UNAVAILABLE",
      "附件文件不可用。",
      410,
    );
  }
  const credentialProjectAssignmentId =
    input.actor.role === "delivery_member"
      ? row.assignedProjectAssignmentId || input.projectAssignmentId
      : null;
  const projectCredential =
    input.actor.role === "delivery_member" && credentialProjectAssignmentId
      ? await getCredentialForUpstreamResource(
          input.actor.id,
          "file",
          row.attachment.upstreamFileId,
          credentialProjectAssignmentId,
        )
      : null;
  const customerCredential =
    !projectCredential && row.attachment.ownerUserId === row.ticketUserId
      ? await getCredentialForUpstreamResource(
          row.ticketUserId,
          "file",
          row.attachment.upstreamFileId,
        )
      : null;
  const credential =
    input.actor.role === "delivery_member"
      ? (projectCredential ?? customerCredential)
      : await getCredentialForUpstreamResource(
          row.attachment.ownerUserId,
          "file",
          row.attachment.upstreamFileId,
        );
  if (!credential) {
    throw new DeliveryTicketError(
      "ATTACHMENT_UNAVAILABLE",
      "附件原始凭据已失效，无法下载。",
      410,
    );
  }
  const usesProjectCredential = Boolean(projectCredential);
  return {
    ...row,
    credential,
    credentialOwnerUserId: usesProjectCredential
      ? input.actor.id
      : row.attachment.ownerUserId,
    credentialProjectAssignmentId: usesProjectCredential
      ? credentialProjectAssignmentId
      : null,
  };
}

export async function downloadAuthorizedTicketAttachment(
  attachment: Awaited<ReturnType<typeof resolveAuthorizedTicketAttachment>>,
) {
  const upstreamFileId = attachment.attachment.upstreamFileId;
  if (!upstreamFileId) {
    throw new DeliveryTicketError(
      "ATTACHMENT_UNAVAILABLE",
      "附件暂时无法下载。",
      410,
    );
  }
  let resolved;
  try {
    resolved = await ownedFileContentResolver.resolve({
      ownerUserId: attachment.credentialOwnerUserId,
      fileId: upstreamFileId,
      projectAssignmentId: attachment.credentialProjectAssignmentId,
      expectedCredentialId: attachment.credential.id,
    });
  } catch (error) {
    if (error instanceof OwnedFileContentError) {
      throw new DeliveryTicketError(
        error.code,
        error.message,
        error.statusCode,
      );
    }
    throw error;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of resolved.stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_ATTACHMENT_BYTES) {
      resolved.stream.destroy();
      throw new DeliveryTicketError(
        "ATTACHMENT_TOO_LARGE",
        "附件超过 100MB，无法在线下载。",
        413,
      );
    }
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks, size);
  return {
    content,
    contentType:
      attachment.attachment.mimeType ||
      resolved.mimeType ||
      "application/octet-stream",
  };
}

function sendError(res: Response, error: unknown) {
  if (error instanceof DeliveryTicketError) {
    res.status(error.statusCode).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof AuthServiceError) {
    res.status(error.code === "NOT_FOUND" ? 404 : 403).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  console.error("[DeliveryTicketAttachment] Download failed", error);
  res.status(502).json({
    error: {
      code: "ATTACHMENT_DOWNLOAD_FAILED",
      message: "附件暂时无法下载。",
    },
  });
}

router.get("/:attachmentId/content", async (req: FrontMindRequest, res) => {
  try {
    const actor = req.frontmindUser;
    if (!actor) {
      res
        .status(401)
        .json({ error: { code: "UNAUTHORIZED", message: "请先登录。" } });
      return;
    }
    const attachment = await resolveAuthorizedTicketAttachment({
      actor,
      attachmentId: req.params.attachmentId,
      projectAssignmentId:
        req.frontmindDeliveryProjectContext?.projectAssignmentId,
    });
    const result = await downloadAuthorizedTicketAttachment(attachment);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", result.contentType);
    res.setHeader(
      "Content-Disposition",
      contentDisposition(attachment.attachment.filename),
    );
    res.setHeader("Content-Length", String(result.content.byteLength));
    res.send(result.content);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
