import { createHmac } from "node:crypto";

export class OssMediaSigner {
  private readonly endpoint: URL;

  constructor(
    private readonly options: {
      bucket: string;
      endpoint: string;
      accessKeyId: string;
      accessKeySecret: string;
      now?: () => Date;
    },
  ) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(options.bucket))
      throw new Error("Invalid OSS bucket name");
    this.endpoint = new URL(options.endpoint);
    if (this.endpoint.protocol !== "https:")
      throw new Error("OSS endpoint must use HTTPS");
    if (!options.accessKeyId || !options.accessKeySecret)
      throw new Error("OSS read credentials are required");
  }

  signedGetUrl(key: string, expiresInSeconds = 300): string {
    if (
      !key ||
      key.startsWith("/") ||
      key.includes("\0") ||
      key.split("/").includes("..")
    )
      throw new Error("Invalid OSS object key");
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > 3_600
    ) {
      throw new Error(
        "OSS signed URL lifetime must be between 1 and 3600 seconds",
      );
    }
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const expires = String(
      Math.floor((this.options.now?.() ?? new Date()).getTime() / 1_000) +
        expiresInSeconds,
    );
    const canonicalResource = `/${this.options.bucket}/${encodedKey}`;
    const signature = createHmac("sha1", this.options.accessKeySecret)
      .update(`GET\n\n\n${expires}\n${canonicalResource}`)
      .digest("base64");
    const url = new URL(this.endpoint);
    url.hostname = `${this.options.bucket}.${url.hostname}`;
    url.pathname = `/${encodedKey}`;
    url.searchParams.set("OSSAccessKeyId", this.options.accessKeyId);
    url.searchParams.set("Expires", expires);
    url.searchParams.set("Signature", signature);
    return url.toString();
  }
}
