import { createHash, createHmac } from "node:crypto";
import {
  OssRequestError,
  ObjectStoreError,
  ObjectStoreReadLimitError,
} from "./errors.js";
import type {
  ObjectMetadata,
  OssObjectStoreOptions,
  PrivateObjectReader,
  PrivateObjectStore,
  PutObjectInput,
  StoredObject,
} from "./types.js";

const DEFAULT_ENDPOINT = "https://oss-cn-wuhan-lr.aliyuncs.com";

function assertName(value: string, kind: "bucket" | "key"): void {
  if (!value.trim()) throw new ObjectStoreError(`${kind} must not be empty`);
  if (
    kind === "key" &&
    (value.startsWith("/") ||
      value.includes("\0") ||
      value.split("/").includes(".."))
  ) {
    throw new ObjectStoreError("Unsafe object key");
  }
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function canonicalOssHeaders(headers: Headers): string {
  return [...headers.entries()]
    .filter(([name]) => name.toLowerCase().startsWith("x-oss-"))
    .map(
      ([name, value]) =>
        [name.toLowerCase().trim(), value.trim().replace(/\s+/g, " ")] as const,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
}

export function createOssAuthorization(input: {
  method: string;
  bucket: string;
  key: string;
  headers: Headers;
  accessKeyId: string;
  accessKeySecret: string;
  expires?: string;
}): string {
  const canonicalResource = `/${input.bucket}/${encodeKey(input.key)}`;
  const stringToSign = [
    input.method.toUpperCase(),
    input.headers.get("content-md5") ?? "",
    input.headers.get("content-type") ?? "",
    input.expires ?? input.headers.get("date") ?? "",
    `${canonicalOssHeaders(input.headers)}${canonicalResource}`,
  ].join("\n");
  const signature = createHmac("sha1", input.accessKeySecret)
    .update(stringToSign)
    .digest("base64");
  return `OSS ${input.accessKeyId}:${signature}`;
}

export class AliOssPrivateObjectStore
  implements PrivateObjectStore, PrivateObjectReader
{
  private readonly bucket: string;
  private readonly endpoint: URL;
  private readonly accessKeyId: string;
  private readonly accessKeySecret: string;
  private readonly securityToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly encryption: "AES256";

  constructor(options: OssObjectStoreOptions) {
    assertName(options.bucket, "bucket");
    if (
      !options.credentials.accessKeyId.trim() ||
      !options.credentials.accessKeySecret.trim()
    ) {
      throw new ObjectStoreError("OSS credentials must not be empty");
    }
    this.bucket = options.bucket;
    this.endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
    if (this.endpoint.protocol !== "https:")
      throw new ObjectStoreError("OSS endpoint must use HTTPS");
    this.accessKeyId = options.credentials.accessKeyId;
    this.accessKeySecret = options.credentials.accessKeySecret;
    this.securityToken = options.credentials.securityToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.encryption = options.defaultServerSideEncryption ?? "AES256";
  }

  async put(
    input: PutObjectInput,
    signal?: AbortSignal,
  ): Promise<StoredObject> {
    assertName(input.key, "key");
    const body = Buffer.from(input.body);
    const sha256 =
      input.contentSha256 ?? createHash("sha256").update(body).digest("hex");
    const headers = new Headers({
      "content-type": input.contentType,
      "content-md5": createHash("md5").update(body).digest("base64"),
      "content-length": String(body.byteLength),
      "cache-control":
        input.cacheControl ?? "private, max-age=31536000, immutable",
      "x-oss-object-acl": "private",
      "x-oss-server-side-encryption": this.encryption,
      "x-oss-meta-sha256": sha256,
    });
    for (const [name, value] of Object.entries(input.metadata ?? {})) {
      if (!/^[a-z0-9-]+$/i.test(name))
        throw new ObjectStoreError("Invalid OSS metadata name", { name });
      headers.set(`x-oss-meta-${name.toLowerCase()}`, value);
    }
    const response = await this.request(
      "PUT",
      input.key,
      headers,
      body,
      signal,
    );
    return {
      key: input.key,
      etag: response.headers.get("etag")?.replaceAll('"', ""),
      size: body.byteLength,
      contentType: input.contentType,
      contentSha256: sha256,
    };
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    assertName(key, "key");
    await this.request(
      "DELETE",
      key,
      new Headers(),
      undefined,
      signal,
      [204, 404],
    );
  }

  async head(key: string, signal?: AbortSignal): Promise<ObjectMetadata> {
    assertName(key, "key");
    const response = await this.request(
      "HEAD",
      key,
      new Headers(),
      undefined,
      signal,
      [200, 404],
    );
    if (response.status === 404) return { key, exists: false };
    const length = Number(response.headers.get("content-length"));
    return {
      key,
      exists: true,
      etag: response.headers.get("etag")?.replaceAll('"', ""),
      size: Number.isFinite(length) ? length : undefined,
      contentType: response.headers.get("content-type") ?? undefined,
      contentSha256: response.headers.get("x-oss-meta-sha256") ?? undefined,
    };
  }

  async read(
    key: string,
    signal?: AbortSignal,
    maxBytes?: number,
  ): Promise<Uint8Array | undefined> {
    assertName(key, "key");
    const response = await this.request(
      "GET",
      key,
      new Headers(),
      undefined,
      signal,
      [200, 404],
    );
    if (response.status === 404) return undefined;
    if (maxBytes === undefined)
      return new Uint8Array(await response.arrayBuffer());
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new ObjectStoreError("Invalid private object read limit", {
        key,
        maxBytes,
      });
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new ObjectStoreReadLimitError(
        "Private object exceeds read limit",
        {
          key,
          size: declaredLength,
          maxBytes,
        },
      );
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel("Private object exceeds read limit");
          throw new ObjectStoreReadLimitError(
            "Private object exceeds read limit",
            {
              key,
              size: total,
              maxBytes,
            },
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (chunks.length === 1) return chunks[0];
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }

  signedGetUrl(key: string, expiresInSeconds = 300): string {
    assertName(key, "key");
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > 3_600
    ) {
      throw new ObjectStoreError(
        "Signed URL lifetime must be between 1 and 3600 seconds",
      );
    }
    if (this.securityToken) {
      throw new ObjectStoreError(
        "STS credentials require a token-aware signing flow; use long-lived RAM credentials here",
      );
    }
    const expires = String(
      Math.floor(this.now().valueOf() / 1_000) + expiresInSeconds,
    );
    const headers = new Headers();
    const authorization = createOssAuthorization({
      method: "GET",
      bucket: this.bucket,
      key,
      headers,
      accessKeyId: this.accessKeyId,
      accessKeySecret: this.accessKeySecret,
      expires,
    });
    const signature = authorization.slice(authorization.indexOf(":") + 1);
    const url = this.objectUrl(key);
    url.searchParams.set("OSSAccessKeyId", this.accessKeyId);
    url.searchParams.set("Expires", expires);
    url.searchParams.set("Signature", signature);
    return url.toString();
  }

  private objectUrl(key: string): URL {
    const url = new URL(this.endpoint);
    url.hostname = `${this.bucket}.${url.hostname}`;
    url.pathname = `/${encodeKey(key)}`;
    url.search = "";
    return url;
  }

  private async request(
    method: string,
    key: string,
    headers: Headers,
    body: Uint8Array | undefined,
    signal: AbortSignal | undefined,
    acceptedStatuses: readonly number[] = [200],
  ): Promise<Response> {
    headers.set("date", this.now().toUTCString());
    if (this.securityToken)
      headers.set("x-oss-security-token", this.securityToken);
    headers.set(
      "authorization",
      createOssAuthorization({
        method,
        bucket: this.bucket,
        key,
        headers,
        accessKeyId: this.accessKeyId,
        accessKeySecret: this.accessKeySecret,
      }),
    );
    let response: Response;
    try {
      response = await this.fetchImpl(this.objectUrl(key), {
        method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
        signal,
      });
    } catch (cause) {
      throw new ObjectStoreError(
        "OSS request failed",
        { method, key },
        { cause },
      );
    }
    if (!acceptedStatuses.includes(response.status)) {
      const requestId = response.headers.get("x-oss-request-id") ?? undefined;
      throw new OssRequestError(
        `OSS returned HTTP ${response.status}`,
        response.status,
        { method, key, requestId },
      );
    }
    return response;
  }
}
