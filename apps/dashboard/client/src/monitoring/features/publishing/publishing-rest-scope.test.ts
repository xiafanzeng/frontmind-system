import { afterEach, describe, expect, it, vi } from "vitest";
import { activateWorkspaceRestScope } from "@/lib/workspace-rest-scope";
import { createServerBackedPublisherGateway, type PublisherTrpcClient } from "./ProductionPublishingEntry";

let dispose: (() => void) | undefined;
const originalCreateObjectURL = URL.createObjectURL;
afterEach(() => { dispose?.(); dispose = undefined; URL.createObjectURL = originalCreateObjectURL; vi.restoreAllMocks(); });

describe("publishing native REST scope", () => {
  it("does not request a private preview under the next project after an image upload finishes", async () => {
    dispose = activateWorkspaceRestScope("1:project-a", "project-a");
    URL.createObjectURL = vi.fn().mockReturnValue("blob:preview");
    let resolvePayload!: (value: unknown) => void;
    const json = vi.fn(() => new Promise(resolve => { resolvePayload = resolve; }));
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json });
    const gateway = createServerBackedPublisherGateway({} as PublisherTrpcClient, { fetch: fetcher });
    const pending = gateway.uploadArticleImage("article-a", new File(["image"], "image.png", { type: "image/png" }), "图片");
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(json).toHaveBeenCalled());
    dispose = activateWorkspaceRestScope("1:project-b", "project-b");
    resolvePayload({ assetId: "asset-a", contentType: "image/png", publicPath: "/api/monitoring/publisher/assets/asset-a.png", width: 400, height: 300 });
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("x-enterprise-project-id")).toBe("project-a");
  });
});
