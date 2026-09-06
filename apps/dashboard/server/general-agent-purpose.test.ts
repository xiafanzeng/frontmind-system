import { createHash } from "node:crypto";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import {
  enterpriseQaKnowledgeDocuments,
  enterpriseQaSystemContext,
  frozenGeneralAgentPurpose,
  generalAgentPurposePublic,
  publishedGeneralAgentKnowledge,
  generalAgentKnowledgeAttachment,
  type FrozenGeneralAgentPurpose,
} from "./general-agent-purpose";

describe("enterprise QA frozen published knowledge", () => {
  it("sends only explicitly safe customer document fields, excluding hidden or executable material", () => {
    const documents = [
      {
        title: "产品",
        path: "products.md",
        content: "已发布事实",
        customerVisible: true,
        apiKey: "must-not-travel",
        arbitraryMetadata: { private: true },
      },
      { path: "hidden.md", content: "hidden", customerVisible: false },
      { path: "run.py", content: "executable" },
      { path: "data.md", kind: "script", content: "script" },
      {
        path: "hypothesis.md",
        evidenceStatus: "inferred",
        content: "unsupported",
      },
      { path: "evidence.md", kind: "evidence", content: "internal" },
      { path: "empty.md", content: "  " },
    ];
    expect(enterpriseQaKnowledgeDocuments(documents)).toEqual([
      { title: "产品", path: "products.md", content: "已发布事实" },
    ]);
  });
  it("selects only the current owner's active published snapshot and freezes its safe content hash", async () => {
    let query: ReturnType<MySqlDialect["sqlToQuery"]> | undefined;
    const chain: any = {
      select: () => chain,
      from: () => chain,
      where: (value: any) => {
        query = new MySqlDialect().sqlToQuery(value);
        return chain;
      },
      orderBy: () => chain,
      limit: async () => [
        {
          id: "snapshot-1",
          version: 4,
          sourceFileName: "published.zip",
          documents: [{ path: "intro.md", title: "简介", content: "事实" }],
        },
      ],
    };
    const frozen = await publishedGeneralAgentKnowledge(chain, 71);
    expect(query!.params).toEqual([71, "active"]);
    expect(frozen?.knowledgeBase).toMatchObject({
      snapshotId: "snapshot-1",
      version: 4,
      documentCount: 1,
    });
    expect(frozen?.knowledgeBase.contentHash).toBe(
      createHash("sha256").update(frozen!.knowledgeText).digest("hex"),
    );
    const context: FrozenGeneralAgentPurpose = {
      revision: 1,
      accountUserId: 71,
      purpose: "enterprise_qa",
      ...frozen!,
    };
    const task = { providerRuntime: { generalPurpose: context } };
    expect(frozenGeneralAgentPurpose(task, 71)).toEqual(context);
    expect(() => frozenGeneralAgentPurpose(task, 72)).toThrow(
      "GENERAL_AGENT_PURPOSE_CONTEXT_INVALID",
    );
    expect(generalAgentPurposePublic(context)).not.toHaveProperty(
      "knowledgeText",
    );
    expect(enterpriseQaSystemContext(context)).toContain(
      "frontmind_published_knowledge.md",
    );
    const attachment = generalAgentKnowledgeAttachment(context)!;
    expect(
      Buffer.from(attachment.file_data!.split(",")[1], "base64").toString(
        "utf8",
      ),
    ).toContain("事实");
    context.knowledgeText = "mutated snapshot";
    expect(() => frozenGeneralAgentPurpose(task, 71)).toThrow(
      "GENERAL_AGENT_PURPOSE_CONTEXT_INVALID",
    );
  });
  it("does not claim grounding when there are no customer-visible documents", async () => {
    const chain: any = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => [
        {
          documents: [
            { path: "private.md", content: "secret", customerVisible: false },
          ],
        },
      ],
    };
    expect(await publishedGeneralAgentKnowledge(chain, 71)).toBeNull();
  });
});
