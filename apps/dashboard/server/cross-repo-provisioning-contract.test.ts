import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { websitePurchaseRequestV2Schema } from "../shared/provisioning-v2";
import { siblingWebsiteRepositoryRoot } from "./cross-repo-test-path";
import { knowledgeArchiveDescriptorHash } from "./knowledge-base-artifact";
import { websiteKnowledgeImportSchema } from "./knowledge-import-service";

const localFixturePath = path.resolve(
  process.cwd(),
  "shared/contracts/provisioning-v2.fixture.json",
);
const websiteFixturePath = path.resolve(
  siblingWebsiteRepositoryRoot(),
  "server/geo/contracts/provisioning-v2.fixture.json",
);
const localV4FixturePath = path.resolve(
  process.cwd(),
  "shared/contracts/provisioning-v4.fixture.json",
);
const websiteV4FixturePath = path.resolve(
  siblingWebsiteRepositoryRoot(),
  "server/geo/contracts/provisioning-v4.fixture.json",
);
const websiteCopiesAvailable =
  existsSync(websiteFixturePath) && existsSync(websiteV4FixturePath);

async function fixture(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Agent ↔ Website provisioning v2 shared contract", () => {
  it("parses the shared purchase, categories, and knowledge artifact contract", async () => {
    const value = await fixture(localFixturePath);
    const request = value.purchaseRequest as Record<string, any>;
    for (const category of value.questionCategories as string[]) {
      expect(
        websitePurchaseRequestV2Schema.parse({
          ...request,
          service: {
            ...request.service,
            purchasedQuestion: {
              ...request.service.purchasedQuestion,
              category,
            },
          },
        }).service.purchasedQuestion.category,
      ).toBe(category);
    }
    const knowledgeImport = websiteKnowledgeImportSchema.parse(
      value.knowledgeImport,
    );
    expect(
      knowledgeArchiveDescriptorHash(value.artifactDescriptor as any),
    ).toBe(knowledgeImport.descriptorHash);
  });

  it.skipIf(!websiteCopiesAvailable)(
    "matches the Website-owned copy when both repositories are checked out",
    async () => {
      const [agent, website, agentV4, websiteV4] = await Promise.all([
        fixture(localFixturePath),
        fixture(websiteFixturePath),
        fixture(localV4FixturePath),
        fixture(websiteV4FixturePath),
      ]);
      expect(website).toEqual(agent);
      expect(websiteV4).toEqual(agentV4);
    },
  );

  it("parses v4 and binds candidate lineage separately from the final file", async () => {
    const value = await fixture(localV4FixturePath);
    const knowledgeImport = websiteKnowledgeImportSchema.parse(
      value.knowledgeImport,
    );
    expect(knowledgeImport.schemaVersion).toBe(4);
    if (knowledgeImport.schemaVersion !== 4) throw new Error("expected v4");
    expect(
      knowledgeArchiveDescriptorHash(value.candidateDescriptor as any),
    ).toBe(knowledgeImport.candidate.descriptorHash);
    expect(knowledgeImport.finalArtifact.fileId).not.toBe(
      knowledgeImport.candidate.fileId,
    );
  });
});
