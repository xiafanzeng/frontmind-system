import { describe, expect, it } from "vitest";

import type {
  ResponseLogicAttachment,
  ResponseLogicDraft,
} from "../shared/response-logic";
import {
  ResponseLogicConfirmedError,
  assertResponseLogicRecordEditable,
  withAuthoritativeAttachments,
} from "./response-logic-service";

function attachment(
  fileId: string,
  kind: ResponseLogicAttachment["kind"] = "file",
): ResponseLogicAttachment {
  return {
    fileId,
    filename: `${fileId}.${kind === "image" ? "png" : "pdf"}`,
    mimeType: kind === "image" ? "image/png" : "application/pdf",
    kind,
    uploadedAt: "2026-07-23T10:00:00.000Z",
  };
}

function draft(attachments: ResponseLogicAttachment[]): ResponseLogicDraft {
  return {
    concern: "",
    conclusion: "",
    facts: "",
    pending: "",
    boundaries: "",
    references: "",
    images: [],
    attachments,
  };
}

describe("response logic attachment persistence", () => {
  it("keeps existing verified files, adds route-verified files and rejects client-only IDs", () => {
    const result = withAuthoritativeAttachments({
      draft: draft([attachment("client-forged")]),
      existingDraft: draft([attachment("verified-existing")]),
      verifiedAttachments: [attachment("verified-new", "image")],
    });

    expect(result.attachments.map((item) => item.fileId)).toEqual([
      "verified-existing",
      "verified-new",
    ]);
  });

  it("deduplicates a file ID when the same verified source is uploaded again", () => {
    const result = withAuthoritativeAttachments({
      draft: draft([]),
      existingDraft: draft([attachment("same-file")]),
      verifiedAttachments: [
        {
          ...attachment("same-file"),
          filename: "renamed.pdf",
          uploadedAt: "2026-07-23T11:00:00.000Z",
        },
      ],
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      fileId: "same-file",
      filename: "renamed.pdf",
      uploadedAt: "2026-07-23T11:00:00.000Z",
    });
  });
});

describe("confirmed response logic lock", () => {
  it("allows drafts and rejects a confirmed record until it is cleared", () => {
    expect(() =>
      assertResponseLogicRecordEditable({ confirmed: null }),
    ).not.toThrow();
    expect(() =>
      assertResponseLogicRecordEditable({
        confirmed: {
          ...draft([]),
          version: 1,
          updatedAt: "2026-08-07T00:00:00.000Z",
        },
      }),
    ).toThrow(ResponseLogicConfirmedError);
  });
});
