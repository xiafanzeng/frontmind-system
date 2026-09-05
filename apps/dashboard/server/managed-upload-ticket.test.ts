import { describe, expect, it } from "vitest";

import {
  createManagedUploadTicket,
  deriveManagedUploadTicketKey,
  ManagedUploadTicketError,
  openManagedUploadTicket,
} from "./managed-upload-ticket";

const masterKey = `base64:${Buffer.alloc(32, 7).toString("base64")}`;
const otherMasterKey = `base64:${Buffer.alloc(32, 9).toString("base64")}`;
const key = deriveManagedUploadTicketKey(masterKey);
const now = Date.parse("2026-08-11T08:00:00.000Z");
const target =
  "https://uploads.example.test/company.pdf?X-Amz-Date=20260811T080000Z&X-Amz-Expires=180&X-Amz-Signature=secret";
const binding = {
  fileId: "file-company",
  ownerUserId: 42,
  credentialId: "credential-original",
  projectAssignmentId: null,
  providerFilename: "企业资料.pdf",
};

describe("managed upload capability tickets", () => {
  it("derives an isolated stable key from the existing credential master key", () => {
    expect(deriveManagedUploadTicketKey(masterKey)).toEqual(key);
    expect(deriveManagedUploadTicketKey(otherMasterKey)).not.toEqual(key);
    expect(key).toHaveLength(32);
  });

  it("binds the exact file owner project credential filename target and expiry", () => {
    const created = createManagedUploadTicket(
      {
        ...binding,
        target,
        upstreamExpiresAt: new Date(now + 240_000).toISOString(),
      },
      { key, now },
    );

    expect(created.ticket).toMatch(/^mu1\./u);
    // The signed URL expires first (180s); the ticket keeps a 5s safety margin.
    expect(created.expiresAt).toBe(now + 175_000);
    expect(
      openManagedUploadTicket(created.ticket, binding, {
        key,
        now: now + 1_000,
      }),
    ).toMatchObject({
      ...binding,
      target,
      exp: Math.floor((now + 175_000) / 1_000),
    });
    const { providerFilename: _compatibilityFilename, ...trustedBinding } =
      binding;
    expect(
      openManagedUploadTicket(created.ticket, trustedBinding, {
        key,
        now: now + 1_000,
      }).providerFilename,
    ).toBe(binding.providerFilename);

    for (const mismatch of [
      { ...binding, fileId: "file-other" },
      { ...binding, ownerUserId: 43 },
      { ...binding, credentialId: "credential-rotated" },
      { ...binding, projectAssignmentId: "assignment-other" },
      { ...binding, providerFilename: "different.pdf" },
    ]) {
      expect(() =>
        openManagedUploadTicket(created.ticket, mismatch, {
          key,
          now: now + 1_000,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
      );
    }
  });

  it("rejects modified and cross-domain-key capabilities", () => {
    const { ticket } = createManagedUploadTicket(
      { ...binding, target, upstreamExpiresAt: now + 180_000 },
      { key, now },
    );
    expect(() =>
      openManagedUploadTicket(`${ticket.slice(0, -1)}x`, binding, {
        key,
        now,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
    expect(() =>
      openManagedUploadTicket(ticket, binding, {
        key: deriveManagedUploadTicketKey(otherMasterKey),
        now,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
    expect(() =>
      openManagedUploadTicket(`${ticket}.`, binding, { key, now }),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
  });

  it("preserves opaque identity bytes instead of trimming them", () => {
    const whitespaceBinding = {
      ...binding,
      fileId: " file-company ",
      credentialId: " credential-original ",
      projectAssignmentId: " assignment-1 ",
    };
    const { ticket } = createManagedUploadTicket(
      {
        ...whitespaceBinding,
        target,
        upstreamExpiresAt: now + 180_000,
      },
      { key, now },
    );
    expect(
      openManagedUploadTicket(ticket, whitespaceBinding, { key, now }),
    ).toMatchObject(whitespaceBinding);
    expect(() =>
      openManagedUploadTicket(
        ticket,
        { ...whitespaceBinding, fileId: whitespaceBinding.fileId.trim() },
        { key, now },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
  });

  it("distinguishes an authentic expired ticket for status-only recovery", () => {
    const { ticket } = createManagedUploadTicket(
      { ...binding, target, upstreamExpiresAt: now + 180_000 },
      { key, now },
    );
    expect(() =>
      openManagedUploadTicket(ticket, binding, {
        key,
        now: now + 175_000,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_EXPIRED" }),
    );
    expect(
      openManagedUploadTicket(ticket, binding, {
        key,
        now: now + 175_000,
        allowExpired: true,
      }).fileId,
    ).toBe(binding.fileId);
  });

  it("fails closed without a provider-owned expiry", () => {
    expect(() =>
      createManagedUploadTicket(
        {
          ...binding,
          target: "https://uploads.example.test/no-expiry",
        },
        { key, now },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
    expect(() =>
      createManagedUploadTicket(
        {
          ...binding,
          target:
            "https://uploads.example.test/bad-date?X-Amz-Date=20261340T250000Z&X-Amz-Expires=180",
        },
        { key, now },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
  });

  it("fails closed when any parsed provider deadline is already expired", () => {
    expect(() =>
      createManagedUploadTicket(
        {
          ...binding,
          target,
          upstreamExpiresAt: now - 1,
        },
        { key, now },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
  });

  it("rejects explicit invalid expiry values and non-HTTPS capabilities", () => {
    expect(() =>
      createManagedUploadTicket(
        { ...binding, target, upstreamExpiresAt: "not-a-deadline" },
        { key, now },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
    expect(() =>
      createManagedUploadTicket(
        {
          ...binding,
          target,
          upstreamExpiresAt: "2026-02-31T08:00:00.000Z",
        },
        { key, now },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
    expect(() =>
      createManagedUploadTicket(
        {
          ...binding,
          target:
            "https://uploads.example.test/partial?X-Amz-Date=20260811T080000Z",
          upstreamExpiresAt: now + 180_000,
        },
        { key, now },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
    expect(() =>
      createManagedUploadTicket(
        {
          ...binding,
          target: target.replace("https://", "http://"),
          upstreamExpiresAt: now + 180_000,
        },
        { key, now },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UPLOAD_CAPABILITY_INVALID" }),
    );
  });

  it("fails closed when the credential master key is not exactly 32 bytes", () => {
    expect(() => deriveManagedUploadTicketKey("base64:dG9vLXNob3J0")).toThrow(
      ManagedUploadTicketError,
    );
  });
});
