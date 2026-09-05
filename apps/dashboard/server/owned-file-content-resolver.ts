import axios from "axios";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { getCredentialForUpstreamResource } from "./auth-service";
import {
  assertSafeExternalUrl,
  ExternalUrlRejectedError,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import {
  readStoredPresalesFile,
  removeStoredPresalesFile,
  stagePresalesFileContent,
  type StagedPresalesFile,
  type StoredPresalesFile,
} from "./presales-file-store";
import { getUpstreamBaseUrl } from "./upstream-config";
import { FILE_CONTENT_RETENTION_MS } from "./file-content-retention";

export const OWNED_FILE_CONTENT_RESOLVER_VERSION = 2;
const MAX_OWNED_FILE_CONTENT_BYTES = 100 * 1024 * 1024;

export type FileContentRecoveryAction = "retry" | "reupload" | "contact_admin";

export class OwnedFileContentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly options: {
      statusCode: number;
      retryable: boolean;
      recoveryAction: FileContentRecoveryAction;
      expiresAt?: number;
      upstreamStatus?: number;
    },
  ) {
    super(message);
    this.name = "OwnedFileContentError";
  }

  get statusCode() {
    return this.options.statusCode;
  }

  get retryable() {
    return this.options.retryable;
  }

  get recoveryAction() {
    return this.options.recoveryAction;
  }

  get expiresAt() {
    return this.options.expiresAt;
  }
}

type OwnedResourceCredential = {
  id: string;
  apiKey: string;
  resource: {
    parentTaskId?: string | null;
    contentSource?: "user_upload" | "assistant_output" | null;
    createdAt?: Date | string | number | null;
    uploadedAt?: Date | string | number | null;
    contentExpiresAt?: Date | string | number | null;
    contentDeletedAt?: Date | string | number | null;
  };
};

type ResolverResponse = {
  status: number;
  data: unknown;
  headers?: Record<string, unknown>;
};

export type OwnedFileContentResolverDependencies = {
  getCredential: (
    ownerUserId: number,
    kind: "file",
    fileId: string,
    projectAssignmentId?: string,
  ) => Promise<OwnedResourceCredential | null>;
  readStoredFile: (fileId: string) => Promise<StoredPresalesFile | null>;
  removeStoredFile: (fileId: string) => Promise<void>;
  stageStoredFile: (input: {
    fileId: string;
    stream: Readable;
    maxBytes: number;
  }) => Promise<StagedPresalesFile>;
  getBaseUrl: () => string;
  request: (
    url: string,
    options: Record<string, unknown>,
  ) => Promise<ResolverResponse>;
};

export type OwnedFileAccessInput = {
  ownerUserId: number;
  fileId: string;
  projectAssignmentId?: string | null;
  expectedCredentialId?: string;
  now?: number;
};

export type OwnedFileAuthorization = {
  credentialId: string;
  apiKey: string;
  expiresAt?: number;
  isTaskBoundAssistantOutput: boolean;
};

export type ResolvedOwnedFileContent = {
  fileId: string;
  credentialId: string;
  source: "local" | "upstream";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  sha256?: string;
  expiresAt?: number;
  stream: Readable;
};

function timestampMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function headerValue(
  headers: Record<string, unknown> | undefined,
  name: string,
) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value))
    return value[0] === undefined ? "" : String(value[0]);
  return value === undefined || value === null ? "" : String(value);
}

function cleanFilename(value: unknown, fallback: string) {
  const filename = String(value || fallback)
    .replace(/[\\/\0\r\n"]/g, "_")
    .trim();
  return filename || fallback;
}

function filenameFromContentDisposition(value: string, fallback: string) {
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try {
      return cleanFilename(
        decodeURIComponent(encoded.trim().replace(/^"|"$/g, "")),
        fallback,
      );
    } catch {
      // Fall through to the ASCII filename.
    }
  }
  const basic = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  return cleanFilename(basic?.[1] ?? basic?.[2], fallback);
}

function toReadable(value: unknown) {
  if (value instanceof Readable) return value;
  if (Buffer.isBuffer(value) || typeof value === "string") {
    return Readable.from([value]);
  }
  if (
    value &&
    typeof value === "object" &&
    Symbol.asyncIterator in (value as Record<PropertyKey, unknown>)
  ) {
    return Readable.from(value as AsyncIterable<unknown>);
  }
  throw new OwnedFileContentError(
    "SOURCE_CONTENT_INVALID",
    "文件内容响应无效，请重新上传",
    {
      statusCode: 422,
      retryable: false,
      recoveryAction: "reupload",
    },
  );
}

function destroyResponseStream(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { destroy?: unknown }).destroy === "function"
  ) {
    (value as { destroy: () => void }).destroy();
  }
}

function safeOwnedFileRedirectUrl(location: string, baseUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(location, baseUrl);
  } catch {
    throw new ExternalUrlRejectedError("Invalid owned file redirect URL");
  }
  // The configured upstream /content endpoint may intentionally be HTTP in a
  // local/private deployment, but an upstream-directed hop is an untrusted
  // bearerless fetch and must never downgrade to plaintext.
  if (parsed.protocol !== "https:") {
    throw new ExternalUrlRejectedError("Owned file redirects must use HTTPS");
  }
  return assertSafeExternalUrl(parsed.toString());
}

async function validateStoredFile(stored: StoredPresalesFile) {
  if (
    !Number.isSafeInteger(stored.recordedSizeBytes) ||
    Number(stored.recordedSizeBytes) < 1 ||
    typeof stored.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(stored.sha256)
  ) {
    throw new Error("LOCAL_FILE_INTEGRITY_METADATA_MISSING");
  }
  let sizeBytes = 0;
  const hash = createHash("sha256");
  for await (const value of stored.createReadStream()) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  if (
    sizeBytes < 1 ||
    sizeBytes !== stored.sizeBytes ||
    sizeBytes !== stored.recordedSizeBytes
  ) {
    throw new Error("LOCAL_FILE_CONTENT_SIZE_MISMATCH");
  }
  const sha256 = hash.digest("hex");
  if (stored.sha256.toLowerCase() !== sha256) {
    throw new Error("LOCAL_FILE_CONTENT_SHA256_MISMATCH");
  }
  return sha256;
}

function upstreamFailure(status: number, expiresAt?: number) {
  if (status === 404 || status === 410) {
    return new OwnedFileContentError(
      "SOURCE_UNAVAILABLE",
      "本地和上游均没有可用的文件内容，请重新上传",
      {
        statusCode: 410,
        retryable: false,
        recoveryAction: "reupload",
        expiresAt,
        upstreamStatus: status,
      },
    );
  }
  if (status === 401 || status === 403) {
    return new OwnedFileContentError(
      "SOURCE_FORBIDDEN",
      "文件所属 API Key 已删除或不可用，请联系管理员",
      {
        statusCode: 403,
        retryable: false,
        recoveryAction: "contact_admin",
        expiresAt,
        upstreamStatus: status,
      },
    );
  }
  const retryable = status === 408 || status === 429 || status >= 500;
  return new OwnedFileContentError(
    "SOURCE_DOWNLOAD_FAILED",
    `上游文件内容读取失败 (${status})`,
    {
      statusCode: retryable ? 503 : 502,
      retryable,
      recoveryAction: retryable ? "retry" : "contact_admin",
      expiresAt,
      upstreamStatus: status,
    },
  );
}

export class OwnedFileContentResolver {
  constructor(
    private readonly dependencies: OwnedFileContentResolverDependencies = {
      getCredential: (ownerUserId, kind, fileId, projectAssignmentId) =>
        getCredentialForUpstreamResource(
          ownerUserId,
          kind,
          fileId,
          projectAssignmentId,
          { allowExpiredFileContent: true },
        ),
      readStoredFile: readStoredPresalesFile,
      removeStoredFile: removeStoredPresalesFile,
      stageStoredFile: stagePresalesFileContent,
      getBaseUrl: getUpstreamBaseUrl,
      request: (url, options) => axios.get(url, options),
    },
  ) {}

  async authorize(
    input: OwnedFileAccessInput,
  ): Promise<OwnedFileAuthorization> {
    // fileId is an opaque upstream identifier. Whitespace is significant and
    // must not be rewritten; trim is used only to reject an empty-looking ID.
    const fileId = String(input.fileId ?? "");
    if (!fileId.trim()) {
      throw new OwnedFileContentError(
        "SOURCE_FORBIDDEN",
        "文件不属于当前账号或客户项目，请联系管理员",
        {
          statusCode: 403,
          retryable: false,
          recoveryAction: "contact_admin",
        },
      );
    }
    const credential = await this.dependencies.getCredential(
      input.ownerUserId,
      "file",
      fileId,
      input.projectAssignmentId ?? undefined,
    );
    if (
      !credential ||
      (input.expectedCredentialId &&
        credential.id !== input.expectedCredentialId)
    ) {
      throw new OwnedFileContentError(
        "SOURCE_FORBIDDEN",
        "文件不属于当前账号或客户项目，请联系管理员",
        {
          statusCode: 403,
          retryable: false,
          recoveryAction: "contact_admin",
        },
      );
    }

    const explicitExpiresAt = timestampMillis(
      credential.resource.contentExpiresAt,
    );
    const uploadedAt = timestampMillis(credential.resource.uploadedAt);
    const expiresAt =
      explicitExpiresAt ??
      (uploadedAt === undefined
        ? undefined
        : uploadedAt + FILE_CONTENT_RETENTION_MS);
    const deletedAt = timestampMillis(credential.resource.contentDeletedAt);
    const now = input.now ?? Date.now();
    if (
      deletedAt !== undefined ||
      (expiresAt !== undefined && expiresAt <= now)
    ) {
      throw new OwnedFileContentError(
        "SOURCE_EXPIRED",
        "文件已超过 30 天，请重新上传",
        {
          statusCode: 410,
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: expiresAt ?? deletedAt,
        },
      );
    }

    const isTaskBoundAssistantOutput =
      credential.resource.contentSource === "assistant_output" &&
      typeof credential.resource.parentTaskId === "string" &&
      credential.resource.parentTaskId.trim().length > 0;

    return {
      credentialId: credential.id,
      apiKey: credential.apiKey,
      expiresAt,
      isTaskBoundAssistantOutput,
    };
  }

  async resolve(
    input: OwnedFileAccessInput,
  ): Promise<ResolvedOwnedFileContent> {
    const fileId = String(input.fileId ?? "");
    const authorization = await this.authorize({ ...input, fileId });

    try {
      const stored = await this.dependencies.readStoredFile(fileId);
      if (stored) {
        const sha256 = await validateStoredFile(stored);
        return {
          fileId,
          credentialId: authorization.credentialId,
          source: "local",
          filename: cleanFilename(stored.filename, fileId),
          mimeType: stored.mimeType || "application/octet-stream",
          sizeBytes: stored.sizeBytes,
          sha256,
          expiresAt: authorization.expiresAt,
          stream: stored.createReadStream(),
        };
      }
    } catch (error) {
      // A damaged local copy must never be served. The authenticated upstream
      // content endpoint is the only recovery source; upload_url is never read.
      console.warn(
        "[OwnedFileContent] Local copy unavailable; using upstream",
        {
          fileId,
          code: error instanceof Error ? error.message : "LOCAL_FILE_INVALID",
        },
      );
      await this.dependencies.removeStoredFile(fileId).catch(() => undefined);
    }

    const contentUrl = `${this.dependencies
      .getBaseUrl()
      .replace(/\/$/, "")}/v1/files/${encodeURIComponent(fileId)}/content`;
    let response: ResolverResponse;
    try {
      response = await this.dependencies.request(contentUrl, {
        headers: {
          API_KEY: authorization.apiKey,
          Authorization: `Bearer ${authorization.apiKey}`,
        },
        responseType: "stream",
        timeout: 5 * 60 * 1_000,
        maxContentLength: Infinity,
        maxRedirects: 0,
        proxy: false,
        validateStatus: () => true,
      });
      let redirectBase = contentUrl;
      for (let redirectCount = 0; redirectCount < 3; redirectCount += 1) {
        const location = headerValue(response.headers, "location");
        if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
          break;
        }
        const redirectUrl = safeOwnedFileRedirectUrl(location, redirectBase);
        destroyResponseStream(response.data);
        redirectBase = redirectUrl;
        response = await this.dependencies.request(redirectUrl, {
          ...safeExternalRequestOptions,
          // Deliberately omit API_KEY/Authorization on every redirected hop.
          responseType: "stream",
          timeout: 5 * 60 * 1_000,
          maxContentLength: Infinity,
          maxRedirects: 0,
          validateStatus: () => true,
        });
      }
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        headerValue(response.headers, "location")
      ) {
        destroyResponseStream(response.data);
        throw new OwnedFileContentError(
          "SOURCE_REDIRECT_LIMIT_EXCEEDED",
          "上游文件重定向次数过多",
          {
            statusCode: 502,
            retryable: false,
            recoveryAction: "contact_admin",
            expiresAt: authorization.expiresAt,
          },
        );
      }
    } catch (error) {
      if (error instanceof OwnedFileContentError) throw error;
      const invalidRedirect = error instanceof ExternalUrlRejectedError;
      throw new OwnedFileContentError(
        invalidRedirect ? "SOURCE_REDIRECT_REJECTED" : "SOURCE_DOWNLOAD_FAILED",
        invalidRedirect
          ? "上游文件重定向地址不安全"
          : "上游文件内容暂时无法读取",
        {
          statusCode: invalidRedirect ? 502 : 503,
          retryable: !invalidRedirect,
          recoveryAction: invalidRedirect ? "contact_admin" : "retry",
          expiresAt: authorization.expiresAt,
        },
      );
    }

    if (response.status < 200 || response.status >= 300) {
      destroyResponseStream(response.data);
      throw upstreamFailure(response.status, authorization.expiresAt);
    }

    const mimeType =
      headerValue(response.headers, "content-type").split(";")[0]?.trim() ||
      "application/octet-stream";
    // A JSON response from /content can be an API error envelope returned with
    // an incorrect 2xx status. Only the immutable task-output ledger can prove
    // that JSON is the expected file payload rather than an untrusted response.
    if (
      mimeType.toLowerCase() === "application/json" &&
      !authorization.isTaskBoundAssistantOutput
    ) {
      destroyResponseStream(response.data);
      throw new OwnedFileContentError(
        "SOURCE_CONTENT_INVALID",
        "上游未返回有效文件内容，请重新上传",
        {
          statusCode: 422,
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: authorization.expiresAt,
        },
      );
    }
    const declaredSize = Number(
      headerValue(response.headers, "content-length"),
    );
    const sizeBytes =
      Number.isSafeInteger(declaredSize) && declaredSize > 0
        ? declaredSize
        : undefined;
    const filename = filenameFromContentDisposition(
      headerValue(response.headers, "content-disposition"),
      fileId,
    );
    // Assistant/generated output files deliberately have no upload retention
    // clock. Stream those responses directly: persisting them here would create
    // an untracked local copy that the user-upload retention worker can never
    // reclaim.
    if (authorization.expiresAt === undefined) {
      return {
        fileId,
        credentialId: authorization.credentialId,
        source: "upstream",
        filename,
        mimeType,
        sizeBytes,
        expiresAt: undefined,
        stream: toReadable(response.data),
      };
    }
    if (sizeBytes !== undefined && sizeBytes > MAX_OWNED_FILE_CONTENT_BYTES) {
      destroyResponseStream(response.data);
      throw new OwnedFileContentError(
        "SOURCE_CONTENT_TOO_LARGE",
        "文件超过 100 MB，无法保留",
        {
          statusCode: 413,
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: authorization.expiresAt,
        },
      );
    }
    let staged: StagedPresalesFile | null = null;
    try {
      staged = await this.dependencies.stageStoredFile({
        fileId,
        stream: toReadable(response.data),
        maxBytes: MAX_OWNED_FILE_CONTENT_BYTES,
      });
      if (staged.sizeBytes < 1) {
        throw new OwnedFileContentError(
          "SOURCE_CONTENT_INVALID",
          "上游未返回有效文件内容，请重新上传",
          {
            statusCode: 422,
            retryable: false,
            recoveryAction: "reupload",
            expiresAt: authorization.expiresAt,
          },
        );
      }
      if (sizeBytes !== undefined && staged.sizeBytes !== sizeBytes) {
        throw new OwnedFileContentError(
          "SOURCE_DOWNLOAD_FAILED",
          "文件内容读取不完整，请重试",
          {
            statusCode: 503,
            retryable: true,
            recoveryAction: "retry",
            expiresAt: authorization.expiresAt,
          },
        );
      }
      await staged.commit({
        filename,
        mimeType,
        uploadedAt: new Date(
          authorization.expiresAt - FILE_CONTENT_RETENTION_MS,
        ),
        contentExpiresAt: new Date(authorization.expiresAt),
      });
      staged = null;
    } catch (error) {
      await staged?.discard().catch(() => undefined);
      if (error instanceof OwnedFileContentError) throw error;
      const tooLarge =
        error instanceof Error && error.message === "FILE_TOO_LARGE";
      throw new OwnedFileContentError(
        tooLarge ? "SOURCE_CONTENT_TOO_LARGE" : "SOURCE_CAPTURE_FAILED",
        tooLarge
          ? "文件超过 100 MB，无法保留"
          : "历史文件已取回，但本地保留失败，请重试",
        {
          statusCode: tooLarge ? 413 : 503,
          retryable: !tooLarge,
          recoveryAction: tooLarge ? "reupload" : "retry",
          expiresAt: authorization.expiresAt,
        },
      );
    }

    const captured = await this.dependencies.readStoredFile(fileId);
    if (!captured) {
      throw new OwnedFileContentError(
        "SOURCE_CAPTURE_FAILED",
        "历史文件已取回，但本地保留失败，请重试",
        {
          statusCode: 503,
          retryable: true,
          recoveryAction: "retry",
          expiresAt: authorization.expiresAt,
        },
      );
    }
    const sha256 = await validateStoredFile(captured).catch(async (error) => {
      await this.dependencies.removeStoredFile(fileId).catch(() => undefined);
      throw new OwnedFileContentError(
        "SOURCE_CAPTURE_FAILED",
        error instanceof Error ? error.message : "本地保留校验失败",
        {
          statusCode: 503,
          retryable: true,
          recoveryAction: "retry",
          expiresAt: authorization.expiresAt,
        },
      );
    });
    return {
      fileId,
      credentialId: authorization.credentialId,
      source: "upstream",
      filename: captured.filename || filename,
      mimeType: captured.mimeType || mimeType,
      sizeBytes: captured.sizeBytes,
      sha256,
      expiresAt: authorization.expiresAt,
      stream: captured.createReadStream(),
    };
  }
}

export const ownedFileContentResolver = new OwnedFileContentResolver();
