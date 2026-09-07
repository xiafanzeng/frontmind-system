import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  validate: vi.fn(),
  local: vi.fn(),
  retain: vi.fn(),
  freeze: vi.fn(),
  begin: vi.fn(),
  bind: vi.fn(),
  record: vi.fn(),
  apply: vi.fn(),
  fail: vi.fn(),
  patch: vi.fn(),
  edit: vi.fn(),
  resources: vi.fn(),
}));
vi.mock("./knowledge-base-materialized-service", () => ({
  readActiveKnowledgeBaseWorkingSet: mocks.read,
  applyKnowledgeBaseRevisionWorkingSet: mocks.apply,
}));
vi.mock("./knowledge-base-materialized-contract", () => ({
  validateKnowledgeBaseWorkingSetArchive: mocks.validate,
}));
vi.mock("./knowledge-base-deferred-upload-recovery", () => ({
  findRetainedKnowledgeBaseLocalAsset: mocks.local,
}));
vi.mock("./knowledge-base-local-source-store", () => ({
  persistKnowledgeBaseBuildSource: mocks.retain,
}));
vi.mock("./knowledge-base-turn-service", () => ({
  beginKnowledgeBaseManusV2Dispatch: mocks.begin,
  bindKnowledgeBaseManusV2Submission: mocks.bind,
  failKnowledgeNodeEdit: mocks.fail,
  freezeKnowledgeBaseTurnAttachments: mocks.freeze,
  recordKnowledgeNodeEditPatch: mocks.record,
}));
vi.mock("./knowledge-node-edit-contract", async (actual) => ({
  ...(await actual<typeof import("./knowledge-node-edit-contract")>()),
  createKnowledgeNodeEditPatch: mocks.patch,
}));
vi.mock("./providers/knowledge-node-edit-provider", () => ({
  KnowledgeNodeEditProvider: class {
    edit = mocks.edit;
  },
  findKnowledgeNodeEditorResources: mocks.resources,
}));
import { dispatchKnowledgeNodeEdit } from "./knowledge-node-edit-service";
import type { DecryptedCredential } from "./auth-service";
import type { KnowledgeBaseRecoveryClaim } from "./knowledge-base-turn-service";
const credential = {
  provider: "zhipu",
  id: "credential",
  userId: 7,
  version: 1,
  apiKey: "test-only",
} as DecryptedCredential;
function claim(text = ""): KnowledgeBaseRecoveryClaim {
  return {
    turn: {
      id: "turn",
      userId: 7,
      buildId: "build",
      buildGeneration: 1,
      expectedLeafId: "1.1",
      operationKey: "operation",
      operationType: "revise",
      upstreamTaskId: null,
      createAttemptState: "not_sent",
    },
    leaseToken: "lease",
    recoveryMetadata: {
      nodeEditMode: "low_v1",
      userMessage: text,
      attachments: [{ file_id: "local-image", filename: "image.png" }],
      attachmentManifest: [
        {
          filename: "image.png",
          mimeType: "image/png",
          sizeBytes: 5,
          sha256: "sha",
        },
      ],
    },
  } as unknown as KnowledgeBaseRecoveryClaim;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({
    build: {
      id: "build",
      generation: 1,
      contentVersion: 1,
      currentLeafId: "1.1",
      activeTurnId: "turn",
      companyName: "company",
      enterpriseProjectId: null,
    },
    workingSet: { id: "working-set", storageKey: "local-base" },
    bytes: Buffer.from("base"),
  });
  mocks.validate.mockResolvedValue({
    manifest: {
      leaves: [{ leafId: "1.1", contentPath: "nodes/1.1.md", assetIds: [] }],
      assets: [],
    },
    files: new Map([["nodes/1.1.md", Buffer.from("# 当前节点")]]),
  });
  mocks.local.mockResolvedValue({
    bytes: Buffer.from("image"),
    contentSha256: "sha",
  });
  mocks.retain.mockResolvedValue({ storageKey: "local-image-retained" });
  mocks.patch.mockResolvedValue(Buffer.from("validated-patch"));
  mocks.resources.mockResolvedValue(null);
  mocks.edit.mockImplementation(async (input) => {
    await input.onSession("session");
    return { sessionId: "session", contentMarkdown: "# 当前节点修改" };
  });
});
describe("knowledge node edit dispatch", () => {
  it("retains and applies image-only changes without any model, resource or task call", async () => {
    await dispatchKnowledgeNodeEdit(claim(), credential);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.resources).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
    expect(mocks.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        contentMarkdown: "# 当前节点",
        images: [
          { bytes: Buffer.from("image"), sha256: "sha", mimeType: "image/png" },
        ],
      }),
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        providerTaskId: null,
        resultSource: "local_node_edit",
        turnId: "turn",
      }),
    );
    expect(mocks.fail).not.toHaveBeenCalled();
  });
  it("gives the text editor only the current node and instruction, never images or the whole Working Set", async () => {
    await dispatchKnowledgeNodeEdit(claim("修改标题"), credential);
    expect(JSON.parse(mocks.edit.mock.calls[0]![0].prompt)).toEqual({
      currentNode: "# 当前节点",
      instruction: "修改标题",
    });
    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "session", leaseToken: "lease" }),
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        providerTaskId: "session",
        resultSource: "local_node_edit",
      }),
    );
  });
  it("keeps the previous version on invalid output and never retries the model", async () => {
    mocks.edit.mockRejectedValue(new Error("INVALID_OUTPUT"));
    await dispatchKnowledgeNodeEdit(claim("修改标题"), credential);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn",
        leaseToken: "lease",
        message: expect.stringContaining("原节点内容已保留"),
      }),
    );
  });
  it("rejects a selected image outside the active project's Working Set without an AI call", async () => {
    const input = claim();
    input.recoveryMetadata.selectedAssetIds = ["foreign-image"];
    await dispatchKnowledgeNodeEdit(input, credential);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledTimes(1);
  });
});
