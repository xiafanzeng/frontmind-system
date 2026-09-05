import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { websitePurchaseRequestV2Schema } from "../shared/provisioning-v2";
import { siblingWebsiteRepositoryRoot } from "./cross-repo-test-path";
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
const localV5FixturePath = path.resolve(
  process.cwd(),
  "shared/contracts/provisioning-v5.fixture.json",
);
const websiteV5FixturePath = path.resolve(
  siblingWebsiteRepositoryRoot(),
  "server/geo/contracts/provisioning-v5.fixture.json",
);
const websiteCopiesAvailable =
  existsSync(websiteFixturePath) &&
  existsSync(websiteV4FixturePath) &&
  existsSync(websiteV5FixturePath);

async function fixture(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Agent ↔ Website provisioning shared contracts", () => {
  it("parses the shared v2 purchase and category contract", async () => {
    const value = await fixture(localFixturePath);
    const request = value.purchaseRequest as Record<string, any>;
    expect(websitePurchaseRequestV2Schema.parse(request).marketEdition).toBe(
      "overseas",
    );
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
  });

  it.skipIf(!websiteCopiesAvailable)(
    "matches the Website-owned copy when both repositories are checked out",
    async () => {
      const [agent, website, agentV4, websiteV4, agentV5, websiteV5] =
        await Promise.all([
          fixture(localFixturePath),
          fixture(websiteFixturePath),
          fixture(localV4FixturePath),
          fixture(websiteV4FixturePath),
          fixture(localV5FixturePath),
          fixture(websiteV5FixturePath),
        ]);
      expect(website).toEqual(agent);
      expect(websiteV4).toEqual(agentV4);
      expect(websiteV5).toEqual(agentV5);
    },
  );

  it("parses v5 and binds candidate and final local artifacts separately", async () => {
    const value = await fixture(localV5FixturePath);
    const knowledgeImport = websiteKnowledgeImportSchema.parse(
      value.knowledgeImport,
    );
    expect(knowledgeImport.schemaVersion).toBe(5);
    expect(knowledgeImport.finalArtifactId).not.toBe(
      knowledgeImport.candidateArtifactId,
    );
  });
});
