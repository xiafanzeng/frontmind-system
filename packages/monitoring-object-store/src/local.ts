import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ObjectStoreError,
  ObjectStoreReadLimitError,
} from "./errors.js";
import type {
  ObjectMetadata,
  PrivateObjectReader,
  PrivateObjectStore,
  PutObjectInput,
  StoredObject,
} from "./types.js";

export interface LocalPrivateObjectStoreOptions {
  rootDirectory: string;
}

function assertSafeKey(key: string): void {
  if (
    !key.trim() ||
    key.startsWith("/") ||
    key.includes("\0") ||
    key.includes("\\") ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ObjectStoreError("Unsafe object key");
  }
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ObjectStoreError("Local object-store operation was aborted", {
      reason: String(signal.reason ?? "aborted"),
    });
  }
}

/**
 * Private storage on an application-owned directory or persistent shared volume.
 * Production use is explicitly enabled and API/worker must mount the same root.
 * Access is through authenticated domain routes or scoped publication capabilities;
 * this directory must never be mounted as static HTTP content. Immutable keys
 * cannot be overwritten with different bytes.
 */
export class LocalPrivateObjectStore
  implements PrivateObjectStore, PrivateObjectReader
{
  private readonly rootDirectory: string;

  constructor(options: LocalPrivateObjectStoreOptions) {
    const rootDirectory = path.resolve(options.rootDirectory.trim());
    if (
      !path.isAbsolute(options.rootDirectory) ||
      rootDirectory === path.parse(rootDirectory).root
    ) {
      throw new ObjectStoreError(
        "Local object-store root must be an absolute non-root directory",
      );
    }
    this.rootDirectory = rootDirectory;
  }

  async put(
    input: PutObjectInput,
    signal?: AbortSignal,
  ): Promise<StoredObject> {
    assertActive(signal);
    const objectPath = this.objectPath(input.key);
    const body = Buffer.from(input.body);
    const sha256 =
      input.contentSha256 ?? createHash("sha256").update(body).digest("hex");
    await mkdir(path.dirname(objectPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(objectPath, body, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ObjectStoreError(
          "Failed to write local private object",
          {
            key: input.key,
          },
          { cause: error },
        );
      }
      const existing = await readFile(objectPath);
      const existingSha256 = createHash("sha256")
        .update(existing)
        .digest("hex");
      if (
        existingSha256 !== sha256 ||
        existing.byteLength !== body.byteLength
      ) {
        throw new ObjectStoreError(
          "Immutable local object key already contains different bytes",
          { key: input.key },
        );
      }
    }
    assertActive(signal);
    return {
      key: input.key,
      etag: sha256,
      size: body.byteLength,
      contentType: input.contentType,
      contentSha256: sha256,
    };
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    assertActive(signal);
    await rm(this.objectPath(key), { force: true });
  }

  async head(key: string, signal?: AbortSignal): Promise<ObjectMetadata> {
    assertActive(signal);
    const objectPath = this.objectPath(key);
    try {
      const metadata = await stat(objectPath);
      if (!metadata.isFile()) {
        throw new ObjectStoreError("Local object path is not a file", { key });
      }
      return { key, exists: true, size: metadata.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { key, exists: false };
      }
      if (error instanceof ObjectStoreError) throw error;
      throw new ObjectStoreError(
        "Failed to inspect local private object",
        {
          key,
        },
        { cause: error },
      );
    }
  }

  async read(
    key: string,
    signal?: AbortSignal,
    maxBytes?: number,
  ): Promise<Uint8Array | undefined> {
    assertActive(signal);
    try {
      const objectPath = this.objectPath(key);
      if (maxBytes !== undefined) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
          throw new ObjectStoreError("Invalid private object read limit", {
            key,
            maxBytes,
          });
        }
        const metadata = await stat(objectPath);
        if (!metadata.isFile() || metadata.size > maxBytes) {
          throw new ObjectStoreReadLimitError(
            "Private object exceeds read limit",
            {
              key,
              size: metadata.size,
              maxBytes,
            },
          );
        }
      }
      const body = await readFile(objectPath);
      assertActive(signal);
      if (maxBytes !== undefined && body.byteLength > maxBytes) {
        throw new ObjectStoreReadLimitError(
          "Private object exceeds read limit",
          {
            key,
            size: body.byteLength,
            maxBytes,
          },
        );
      }
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof ObjectStoreError) throw error;
      throw new ObjectStoreError(
        "Failed to read local private object",
        { key },
        { cause: error },
      );
    }
  }

  signedGetUrl(_key: string, _expiresInSeconds?: number): string {
    throw new ObjectStoreError(
      "Local private objects are intentionally not exposed by signed URLs",
    );
  }

  private objectPath(key: string): string {
    assertSafeKey(key);
    const objectPath = path.resolve(this.rootDirectory, key);
    if (!objectPath.startsWith(`${this.rootDirectory}${path.sep}`)) {
      throw new ObjectStoreError("Unsafe object key");
    }
    return objectPath;
  }
}
