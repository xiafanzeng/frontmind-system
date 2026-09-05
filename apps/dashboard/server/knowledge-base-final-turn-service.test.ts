import { beforeEach, describe, expect, it, vi } from "vitest";

const customerUploadMocks = vi.hoisted(() => ({
  declared: vi.fn(),
}));

vi.mock("./knowledge-base-customer-upload", () => ({
  MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES: 80 * 1024 * 1024,
  MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES: 99,
  declaredKnowledgeBaseCustomerUploadsForBuild: customerUploadMocks.declared,
  verifiedKnowledgeBaseCustomerUploadBytesForBuild: vi.fn(),
  verifiedKnowledgeBaseOfficialLogoUploadForBuild: vi.fn(),
}));

import {
  MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES,
  MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES,
} from "./knowledge-base-customer-upload";
import { assertKnowledgeBaseCustomerUploadCapacity } from "./knowledge-base-final-turn-service";

function digest(index: number) {
  return index.toString(16).padStart(64, "0");
}

function existingUploads(count: number, sizeBytes = 1) {
  return Array.from({ length: count }, (_, index) => ({
    sourceSha256: digest(index + 1),
    sizeBytes: [sizeBytes],
  }));
}

function image(filename: string, sizeBytes: number, sha256?: string) {
  return {
    filename,
    sizeBytes,
    mimeType: "image/png",
    lastModified: 1,
    ...(sha256 ? { sha256 } : {}),
  };
}

function assertCapacity(
  attachmentManifest: ReturnType<typeof image>[],
  officialLogoRequired = false,
) {
  return assertKnowledgeBaseCustomerUploadCapacity({
    userId: 1,
    buildId: "build-capacity",
    generation: 1,
    officialLogoSha256: null,
    officialLogoRequired,
    attachmentManifest,
  });
}

describe("knowledge-base hashless customer image capacity", () => {
  beforeEach(() => {
    customerUploadMocks.declared.mockReset();
  });

  it("does not spend virtual slots or bytes before staging supplies a digest", async () => {
    customerUploadMocks.declared.mockResolvedValue(
      existingUploads(MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES),
    );

    await expect(
      assertCapacity([
        image("same-existing.png", 1),
        image("same-batch.png", 1),
      ]),
    ).resolves.toBeUndefined();
    expect(customerUploadMocks.declared).not.toHaveBeenCalled();
  });

  it("still rejects a digest-free image that cannot fit by itself", async () => {
    await expect(
      assertCapacity([
        image("oversized.png", MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES + 1),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(customerUploadMocks.declared).not.toHaveBeenCalled();
  });

  it("deduplicates authoritative staged SHA values against existing and batch images", async () => {
    customerUploadMocks.declared.mockResolvedValue(existingUploads(98));
    const repeatedNewDigest = digest(200);

    await expect(
      assertCapacity([
        image("existing-copy.png", 1, digest(1)),
        image("new-copy-a.png", 1, repeatedNewDigest),
        image("new-copy-b.png", 1, repeatedNewDigest),
      ]),
    ).resolves.toBeUndefined();
  });

  it("uses authoritative staged SHA values for the final exact gate", async () => {
    customerUploadMocks.declared.mockResolvedValue(
      existingUploads(MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES),
    );

    await expect(
      assertCapacity([image("new-unique.png", 1, digest(200))]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("applies the same exact deduplication to authoritative byte capacity", async () => {
    customerUploadMocks.declared.mockResolvedValue([
      {
        sourceSha256: digest(1),
        sizeBytes: [MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES],
      },
    ]);

    await expect(
      assertCapacity([
        image(
          "existing-byte-copy.png",
          MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES,
          digest(1),
        ),
      ]),
    ).resolves.toBeUndefined();
    await expect(
      assertCapacity([image("new-byte.png", 1, digest(2))]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("does not count the required official Logo slot as a customer image", async () => {
    await expect(
      assertCapacity(
        [
          image(
            "official-logo.png",
            MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES + 1,
          ),
        ],
        true,
      ),
    ).resolves.toBeUndefined();
    expect(customerUploadMocks.declared).not.toHaveBeenCalled();
  });
});
