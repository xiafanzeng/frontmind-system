import { fetchRemoteMedia, type PrivateObjectStore } from "@frontmind/monitoring-object-store";
import { normalizePublisherLogo, PUBLISHER_LOGO_CONTENT_TYPES } from "@frontmind/monitoring-publisher";
import type { PublisherWorkerDependencies } from "./ports.js";

export type ArchivedLogoFile = {
  sourceUrl: string; objectKey: string; contentType: "image/png" | "image/jpeg";
  sizeBytes: number; sha256: string;
};

/** Cache file metadata, never thousands of decoded image buffers. All media
 * still receive their own version-checked asset association in the repository. */
export class PublisherLogoArchiveCache {
  private readonly entries = new Map<string, { expiresAt: number; promise: Promise<ArchivedLogoFile> }>();
  constructor(
    private readonly objectStore: PrivateObjectStore,
    private readonly fetcher: NonNullable<PublisherWorkerDependencies["mediaFetcher"]> = fetchRemoteMedia,
    private readonly now = () => Date.now(),
  ) {}

  resolve(sourceUrl: string, signal?: AbortSignal): Promise<ArchivedLogoFile> {
    const key = new URL(sourceUrl).toString();
    const current = this.entries.get(key);
    if (current && current.expiresAt > this.now()) return current.promise;
    this.entries.delete(key);
    if (this.entries.size >= 10_000) this.entries.delete(this.entries.keys().next().value!);
    const entry = { expiresAt: this.now() + 12 * 60 * 60_000, promise: null as unknown as Promise<ArchivedLogoFile> };
    entry.promise = this.fetchAndStore(key, signal).catch(error => {
      // Briefly share failures too, so a broken platform icon cannot flood its host.
      entry.expiresAt = this.now() + 5 * 60_000;
      if (signal?.aborted) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }

  private async fetchAndStore(url: string, signal?: AbortSignal): Promise<ArchivedLogoFile> {
    const fetched = await this.fetcher(url, {
      maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3,
      allowedContentTypes: PUBLISHER_LOGO_CONTENT_TYPES, signal,
    });
    const normalized = await normalizePublisherLogo({ bytes: fetched.body, sourceMimeType: fetched.contentType });
    if (normalized.bytes.length > 2 * 1024 * 1024) throw new Error("Normalized Logo exceeds 2 MiB");
    const objectKey = `publisher/media-logos/${normalized.sha256}.${normalized.mimeType === "image/png" ? "png" : "jpg"}`;
    await this.objectStore.put({ key: objectKey, body: normalized.bytes, contentType: normalized.mimeType,
      contentSha256: normalized.sha256, cacheControl: "private, max-age=31536000, immutable",
      metadata: { kind: "publisher-media-logo" } }, signal);
    return { sourceUrl: fetched.finalUrl, objectKey, contentType: normalized.mimeType,
      sizeBytes: normalized.bytes.length, sha256: normalized.sha256 };
  }
}
