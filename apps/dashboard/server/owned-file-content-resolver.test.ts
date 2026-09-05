import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  OwnedFileContentError,
  OwnedFileContentResolver,
  type OwnedFileContentResolverDependencies,
} from "./owned-file-content-resolver";
import type {
  StagedPresalesFile,
  StoredPresalesFile,
} from "./presales-file-store";

async function readAll(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const value of stream) {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function storedFile(
  bytes: Buffer,
  overrides: Partial<StoredPresalesFile> = {},
): StoredPresalesFile {
  return {
    filename: "report.txt",
    mimeType: "text/plain",
    recordedSizeBytes: bytes.length,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    uploadedAt: null,
    contentExpiresAt: null,
    contentStoredAt: null,
    manifestUpdatedAt: null,
    createReadStream: () => Readable.from([bytes]),
    ...overrides,
  };
}

function createDependencies(input?: {
  initialStored?: StoredPresalesFile | null;
  request?: OwnedFileContentResolverDependencies["request"];
  createdAt?: Date;
  uploadedAt?: Date | null;
  expiresAt?: Date | null;
  parentTaskId?: string | null;
  contentSource?: "user_upload" | "assistant_output" | null;
}) {
  let currentStored = input?.initialStored ?? null;
  const removeStoredFile = vi.fn(async () => {
    currentStored = null;
  });
  const stageStoredFile = vi.fn(async ({ stream, maxBytes }) => {
    const bytes = await readAll(stream);
    if (bytes.length > maxBytes) throw new Error("FILE_TOO_LARGE");
    let consumed = false;
    const staged: StagedPresalesFile = {
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createReadStream: () => Readable.from([bytes]),
      discard: async () => {
        consumed = true;
      },
      commit: async ({ filename, mimeType }) => {
        if (consumed) throw new Error("STAGED_FILE_ALREADY_CONSUMED");
        consumed = true;
        currentStored = storedFile(bytes, {
          filename: filename || "file-1",
          mimeType: mimeType || "application/octet-stream",
        });
      },
    };
    return staged;
  });
  const dependencies: OwnedFileContentResolverDependencies = {
    getCredential: vi.fn(async () => ({
      id: "credential-1",
      apiKey: "secret-api-key",
      resource: {
        parentTaskId: input?.parentTaskId,
        contentSource: input?.contentSource,
        createdAt: input?.createdAt ?? new Date("2026-08-01T00:00:00Z"),
        uploadedAt: input?.uploadedAt ?? null,
        contentExpiresAt:
          input && "expiresAt" in input
            ? input.expiresAt
            : new Date("2026-09-01T00:00:00Z"),
        contentDeletedAt: null,
      },
    })),
    readStoredFile: vi.fn(async () => currentStored),
    removeStoredFile,
    stageStoredFile,
    getBaseUrl: () => "https://api.frontmind.example",
    request:
      input?.request ??
      vi.fn(async () => ({
        status: 404,
        data: Readable.from([]),
        headers: {},
      })),
  };
  return { dependencies, removeStoredFile, stageStoredFile };
}

describe("OwnedFileContentResolver", () => {
  it("serves a size/SHA verified local copy without touching upstream", async () => {
    const bytes = Buffer.from("durable local copy");
    const request = vi.fn();
    const { dependencies } = createDependencies({
      initialStored: storedFile(bytes),
      request,
    });
    const resolver = new OwnedFileContentResolver(dependencies);

    const resolved = await resolver.resolve({
      ownerUserId: 7,
      fileId: "file-1",
      projectAssignmentId: "project-a",
      expectedCredentialId: "credential-1",
      now: Date.parse("2026-08-04T00:00:00Z"),
    });

    expect(resolved.source).toBe("local");
    expect(await readAll(resolved.stream)).toEqual(bytes);
    expect(request).not.toHaveBeenCalled();
    expect(dependencies.getCredential).toHaveBeenCalledWith(
      7,
      "file",
      "file-1",
      "project-a",
    );
  });

  it("isolates a corrupt local copy, follows safe redirects without auth, and recaptures /content", async () => {
    const recovered = Buffer.from("recovered upstream bytes");
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        data: Readable.from([]),
        headers: { location: "https://objects.example/step-1" },
      })
      .mockResolvedValueOnce({
        status: 307,
        data: Readable.from([]),
        headers: { location: "/final" },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: Readable.from([recovered]),
        headers: {
          "content-type": "text/plain",
          "content-length": String(recovered.length),
          "content-disposition": "attachment; filename*=UTF-8''recovered.txt",
        },
      });
    const { dependencies, removeStoredFile, stageStoredFile } =
      createDependencies({
        initialStored: storedFile(Buffer.from("corrupt"), {
          sha256: "0".repeat(64),
        }),
        request,
      });
    const resolver = new OwnedFileContentResolver(dependencies);

    const resolved = await resolver.resolve({
      ownerUserId: 7,
      fileId: "file with spaces",
      expectedCredentialId: "credential-1",
      now: Date.parse("2026-08-04T00:00:00Z"),
    });

    expect(request.mock.calls[0]?.[0]).toBe(
      "https://api.frontmind.example/v1/files/file%20with%20spaces/content",
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      maxRedirects: 0,
      headers: {
        API_KEY: "secret-api-key",
        Authorization: "Bearer secret-api-key",
      },
    });
    for (const [, options] of request.mock.calls.slice(1)) {
      expect(options).not.toHaveProperty("headers.API_KEY");
      expect(options).not.toHaveProperty("headers.Authorization");
      expect(options).toMatchObject({ maxRedirects: 0 });
    }
    expect(request.mock.calls.map(([url]) => url)).not.toContain(
      expect.stringContaining("upload_url"),
    );
    expect(removeStoredFile).toHaveBeenCalledWith("file with spaces");
    expect(stageStoredFile).toHaveBeenCalledTimes(1);
    expect(resolved).toMatchObject({
      source: "upstream",
      filename: "recovered.txt",
      mimeType: "text/plain",
      sizeBytes: recovered.length,
    });
    expect(await readAll(resolved.stream)).toEqual(recovered);
  });

  it.each([
    { name: "missing SHA-256", overrides: { sha256: null } },
    {
      name: "missing recorded size",
      overrides: { recordedSizeBytes: null },
    },
  ])(
    "isolates local content with $name and recovers it from /content",
    async ({ overrides }) => {
      const recovered = Buffer.from("authoritative upstream bytes");
      const request = vi.fn(async () => ({
        status: 200,
        data: Readable.from([recovered]),
        headers: {
          "content-type": "text/plain",
          "content-length": String(recovered.length),
        },
      }));
      const { dependencies, removeStoredFile, stageStoredFile } =
        createDependencies({
          initialStored: storedFile(
            Buffer.from("untrusted local bytes"),
            overrides,
          ),
          request,
        });
      const resolver = new OwnedFileContentResolver(dependencies);

      const resolved = await resolver.resolve({
        ownerUserId: 7,
        fileId: "legacy-local-file",
        now: Date.parse("2026-08-04T00:00:00Z"),
      });

      expect(removeStoredFile).toHaveBeenCalledWith("legacy-local-file");
      expect(request).toHaveBeenCalledWith(
        "https://api.frontmind.example/v1/files/legacy-local-file/content",
        expect.any(Object),
      );
      expect(stageStoredFile).toHaveBeenCalledTimes(1);
      expect(await readAll(resolved.stream)).toEqual(recovered);
    },
  );

  it("does not retry a redirect rejected by the HTTPS/SSRF policy", async () => {
    const request = vi.fn(async () => ({
      status: 302,
      data: Readable.from([]),
      headers: { location: "http://127.0.0.1/private" },
    }));
    const { dependencies } = createDependencies({ request });
    const resolver = new OwnedFileContentResolver(dependencies);

    await expect(
      resolver.resolve({
        ownerUserId: 7,
        fileId: "unsafe-redirect",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_REDIRECT_REJECTED",
      retryable: false,
      recoveryAction: "contact_admin",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops after three redirect hops", async () => {
    const request = vi.fn(async (_url: string, _options: object) => ({
      status: 302,
      data: Readable.from([]),
      headers: { location: "https://objects.example/another-hop" },
    }));
    const { dependencies, stageStoredFile } = createDependencies({ request });
    const resolver = new OwnedFileContentResolver(dependencies);

    await expect(
      resolver.resolve({
        ownerUserId: 7,
        fileId: "file-1",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_REDIRECT_LIMIT_EXCEEDED",
      retryable: false,
      recoveryAction: "contact_admin",
    });
    expect(request).toHaveBeenCalledTimes(4);
    expect(stageStoredFile).not.toHaveBeenCalled();
  });

  it("uses uploadedAt + 30 days when an explicit expiry is absent", async () => {
    const uploadedAt = new Date("2026-07-01T00:00:00Z");
    const { dependencies } = createDependencies({
      initialStored: storedFile(Buffer.from("must not be read")),
      uploadedAt,
      expiresAt: null,
    });
    const resolver = new OwnedFileContentResolver(dependencies);

    await expect(
      resolver.resolve({
        ownerUserId: 7,
        fileId: "legacy-file",
        now: Date.parse("2026-08-01T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_EXPIRED",
      statusCode: 410,
      retryable: false,
      recoveryAction: "reupload",
      expiresAt: Date.parse("2026-07-31T00:00:00Z"),
    } satisfies Partial<OwnedFileContentError>);
    expect(dependencies.readStoredFile).not.toHaveBeenCalled();
    expect(dependencies.request).not.toHaveBeenCalled();
  });

  it("does not expire or persist an upstream output without an upload clock", async () => {
    const generated = Buffer.from("generated output bytes");
    const request = vi.fn(async () => ({
      status: 200,
      data: Readable.from([generated]),
      headers: {
        "content-type": "application/pdf",
        "content-length": String(generated.length),
        "content-disposition": 'inline; filename="generated.pdf"',
      },
    }));
    const { dependencies, stageStoredFile } = createDependencies({
      createdAt: new Date("2020-01-01T00:00:00Z"),
      uploadedAt: null,
      expiresAt: null,
      parentTaskId: "task-generated",
      contentSource: "assistant_output",
      request,
    });
    const resolver = new OwnedFileContentResolver(dependencies);

    const resolved = await resolver.resolve({
      ownerUserId: 7,
      fileId: "generated-file",
      now: Date.parse("2026-08-04T00:00:00Z"),
    });

    expect(resolved).toMatchObject({
      source: "upstream",
      filename: "generated.pdf",
      mimeType: "application/pdf",
      expiresAt: undefined,
    });
    expect(await readAll(resolved.stream)).toEqual(generated);
    expect(stageStoredFile).not.toHaveBeenCalled();
  });

  it("streams JSON for a task-bound assistant output without persisting it", async () => {
    const generated = Buffer.from('{"schemaVersion":2,"status":"ok"}');
    const request = vi.fn(async () => ({
      status: 200,
      data: Readable.from([generated]),
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(generated.length),
        "content-disposition": 'attachment; filename="raw-output.json"',
      },
    }));
    const { dependencies, stageStoredFile } = createDependencies({
      uploadedAt: null,
      expiresAt: null,
      parentTaskId: "task-assessment",
      contentSource: "assistant_output",
      request,
    });
    const resolver = new OwnedFileContentResolver(dependencies);

    const resolved = await resolver.resolve({
      ownerUserId: 7,
      fileId: "assessment-output",
      now: Date.parse("2026-08-04T00:00:00Z"),
    });

    expect(resolved).toMatchObject({
      source: "upstream",
      filename: "raw-output.json",
      mimeType: "application/json",
      expiresAt: undefined,
    });
    expect(await readAll(resolved.stream)).toEqual(generated);
    expect(stageStoredFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an unbound assistant output",
      contentSource: "assistant_output" as const,
      parentTaskId: null,
    },
    {
      name: "a user upload even when it carries a task id",
      contentSource: "user_upload" as const,
      parentTaskId: "task-assessment",
    },
    {
      name: "a legacy resource without provenance",
      contentSource: null,
      parentTaskId: "task-assessment",
    },
  ])("rejects JSON for $name", async ({ contentSource, parentTaskId }) => {
    const upstream = Readable.from(['{"error":"not a trusted output"}']);
    const request = vi.fn(async () => ({
      status: 200,
      data: upstream,
      headers: { "content-type": "application/json" },
    }));
    const { dependencies, stageStoredFile } = createDependencies({
      uploadedAt: null,
      expiresAt: null,
      contentSource,
      parentTaskId,
      request,
    });
    const resolver = new OwnedFileContentResolver(dependencies);

    await expect(
      resolver.resolve({
        ownerUserId: 7,
        fileId: "untrusted-json",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_CONTENT_INVALID",
      statusCode: 422,
      retryable: false,
      recoveryAction: "reupload",
    });
    expect(upstream.destroyed).toBe(true);
    expect(stageStoredFile).not.toHaveBeenCalled();
  });

  it("maps an upstream 404 to an unavailable terminal reupload action", async () => {
    const { dependencies } = createDependencies();
    const resolver = new OwnedFileContentResolver(dependencies);

    await expect(
      resolver.resolve({
        ownerUserId: 7,
        fileId: "missing-file",
        now: Date.parse("2026-08-04T00:00:00Z"),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      statusCode: 410,
      retryable: false,
      recoveryAction: "reupload",
    });
  });
});
