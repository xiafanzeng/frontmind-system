import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  validate: vi.fn(),
  patch: vi.fn(),
  record: vi.fn(),
  apply: vi.fn(),
  fail: vi.fn(),
}));
vi.mock("./knowledge-base-materialized-service", () => ({
  readActiveKnowledgeBaseWorkingSet: mocks.read,
  applyKnowledgeBaseRevisionWorkingSet: mocks.apply,
}));
vi.mock("./knowledge-base-materialized-contract", async (actual) => ({
  ...(await actual<typeof import("./knowledge-base-materialized-contract")>()),
  validateKnowledgeBaseWorkingSetArchive: mocks.validate,
}));
vi.mock("./knowledge-base-turn-service", () => ({
  recordKnowledgeNodeEditPatch: mocks.record,
  failKnowledgeNodeEdit: mocks.fail,
}));
vi.mock("./knowledge-node-edit-contract", async (actual) => ({
  ...(await actual<typeof import("./knowledge-node-edit-contract")>()),
  createKnowledgeNodeEditPatch: mocks.patch,
}));
// Any accidental provider import/use in the direct-edit implementation fails.
vi.mock("./providers/knowledge-node-edit-provider", () => {
  throw new Error("manual edit must not import an AI provider");
});
import { dispatchManualKnowledgeNodeEdit } from "./knowledge-node-manual-edit-service";
import type { KnowledgeBaseRecoveryClaim } from "./knowledge-base-turn-service";

const body = "# 节点一\n\n人工修改后的正文";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function claim() {
  return {
    turn: {
      id: "turn",
      userId: 7,
      buildId: "build",
      buildGeneration: 1,
      expectedLeafId: "leaf",
      operationKey: "operation",
      operationType: "revise",
      apiCredentialId: null,
      upstreamTaskId: null,
      attachmentFileIds: [],
    },
    leaseToken: "lease",
    recoveryMetadata: {
      nodeEditMode: "manual_v1",
      contentMarkdown: body,
      contentSha256: hash(body),
      baseContentVersion: 3,
      baseWorkingSetId: "base",
    },
  } as unknown as KnowledgeBaseRecoveryClaim;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({
    build: {
      id: "build",
      activeTurnId: "turn",
      currentLeafId: "leaf",
      contentVersion: 3,
      generation: 1,
    },
    workingSet: { id: "base" },
    bytes: Buffer.from("base"),
  });
  mocks.validate.mockResolvedValue({
    manifest: { leaves: [{ leafId: "leaf", title: "节点一" }] },
  });
  mocks.patch.mockResolvedValue(Buffer.from("patch"));
  mocks.apply.mockResolvedValue({ contentVersion: 4 });
  mocks.fail.mockResolvedValue(undefined);
});

describe("manual knowledge node execution", () => {
  it("applies the frozen body with no AI, credentials or uploaded files", async () => {
    await expect(
      dispatchManualKnowledgeNodeEdit(claim()),
    ).resolves.toMatchObject({ taskId: null, reconciled: true });
    expect(mocks.patch.mock.calls[0][0]).toMatchObject({
      targetLeafId: "leaf",
      contentMarkdown: body,
      images: [],
    });
    expect(mocks.record.mock.calls[0][0]).toMatchObject({
      providerTaskId: null,
      attachmentSourceProofs: [],
      patchSha256: hash("patch"),
    });
    expect(mocks.apply.mock.calls[0][0]).toMatchObject({
      providerTaskId: null,
      resultSource: "local_node_edit",
      targetLeafId: "leaf",
    });
  });
  it("rejects altered frozen input and an attempt to inject a paid provider identity", async () => {
    const tampered = claim();
    tampered.recoveryMetadata.contentMarkdown = "别的正文";
    await expect(dispatchManualKnowledgeNodeEdit(tampered)).rejects.toThrow(
      "AUTHORITY_INVALID",
    );
    const paid = claim();
    paid.turn.apiCredentialId = "credential";
    await expect(dispatchManualKnowledgeNodeEdit(paid)).rejects.toThrow(
      "AUTHORITY_INVALID",
    );
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("refuses to patch a replaced base and releases only this failed edit", async () => {
    mocks.read.mockResolvedValue({
      build: { activeTurnId: "turn", currentLeafId: "leaf", contentVersion: 4 },
      workingSet: { id: "new-base" },
    });
    await expect(dispatchManualKnowledgeNodeEdit(claim())).rejects.toThrow(
      "BASE_CHANGED",
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        turnId: "turn",
        leaseToken: "lease",
      }),
    );
  });
  it("preserves the previous content when validation or activation fails", async () => {
    mocks.apply.mockRejectedValue(new Error("PATCH_CONFLICT"));
    await expect(dispatchManualKnowledgeNodeEdit(claim())).rejects.toThrow(
      "PATCH_CONFLICT",
    );
    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.fail).toHaveBeenCalledTimes(1);
  });
});
