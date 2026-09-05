import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ObjectStoreError } from "./errors.js";

export interface CompressedJsonPayload {
  body: Uint8Array;
  sha256: string;
  uncompressedBytes: number;
  compressedBytes: number;
}

export function compressJsonPayload(
  value: unknown,
  maxUncompressedBytes = 20 * 1024 * 1024,
): CompressedJsonPayload {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new ObjectStoreError(
      "Provider result cannot be serialized as JSON",
      {},
      { cause },
    );
  }
  if (json === undefined)
    throw new ObjectStoreError("Provider result is not JSON-serializable");
  const source = Buffer.from(json, "utf8");
  if (source.byteLength > maxUncompressedBytes) {
    throw new ObjectStoreError(
      "Provider result exceeds raw archive size limit",
      {
        uncompressedBytes: source.byteLength,
        maxUncompressedBytes,
      },
    );
  }
  const body = gzipSync(source, { level: 9 });
  return {
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
    uncompressedBytes: source.byteLength,
    compressedBytes: body.byteLength,
  };
}
