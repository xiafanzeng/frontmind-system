import { describe, expect, it } from "vitest";
import { knowledgeBaseBrowserUpload } from "../shared/knowledge-base-upload-status";
describe("upload connection evidence", () => {
  const status = { status: "active", uploadedBytes: 1024, lastHeartbeatAt: 100_000, lastProgressAt: 80_000 };
  it("separates stalled bytes from a disconnected browser without deleting files", () => {
    expect(knowledgeBaseBrowserUpload(status, 101_000)?.connection).toBe("active");
    expect(knowledgeBaseBrowserUpload(status, 111_000)?.connection).toBe("stalled");
    expect(knowledgeBaseBrowserUpload(status, 160_000)).toEqual({ connection: "disconnected", uploadedBytes: 1024, lastActivity: 100_000 });
    expect(knowledgeBaseBrowserUpload({ ...status, status: "cancelled" }, 160_000)?.connection).toBe("cancelled");
  });
});
