import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDirectory, type DirectoryProject } from "./project-directory";
import {
  installWorkspaceNavigationGuard,
  registerWorkspaceDraft,
} from "./workspace-navigation-guard";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  transport: vi.fn(),
}));
vi.mock("./dashboard-transport", () => ({
  createDashboardTransport: (...args: unknown[]) => {
    api.transport(...args);
    return {
      enterpriseProjects: {
        list: { query: api.list },
        delete: { mutate: api.remove },
        create: { mutate: api.create },
        rename: { mutate: api.rename },
      },
    };
  },
}));
const a: DirectoryProject = {
  id: "a",
  name: "甲",
  ownerUserId: 7,
  revision: 1,
};
const b: DirectoryProject = {
  id: "b",
  name: "乙",
  ownerUserId: 7,
  revision: 2,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { resolve, reject, promise };
}
let directory: ProjectDirectory;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockReset().mockResolvedValue({ projects: [b] });
  api.remove
    .mockReset()
    .mockResolvedValue({ enterpriseProjectId: "a", revision: 2 });
  window.history.replaceState(
    null,
    "",
    "/?enterpriseProjectId=a&operatorOwnerId=7&view=knowledge",
  );
  directory = new ProjectDirectory(1, 7);
  directory.queryClient.setQueryData(directory.queryKey, { projects: [a, b] });
});
afterEach(() => {
  directory.retire();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("owner project directory management", () => {
  it("cancels the old directory before submitting and filters late responses after confirmed deletion", async () => {
    const old = deferred<{ projects: DirectoryProject[] }>();
    const refreshed = deferred<{ projects: DirectoryProject[] }>();
    api.list
      .mockReset()
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => refreshed.promise);
    const oldQuery = directory.queryClient
      .fetchQuery({ ...directory.queryOptions(), staleTime: 0 })
      .catch(() => undefined);
    const oldSignal = api.list.mock.calls[0][1].signal as AbortSignal;
    const removal = deferred<unknown>();
    api.remove.mockImplementation(() => {
      expect(oldSignal.aborted).toBe(true);
      return removal.promise;
    });
    const pending = directory.delete(a);
    await settle();
    expect(directory.latest()?.projects).toEqual([a, b]);
    removal.resolve({});
    await pending;
    old.resolve({ projects: [a, b] });
    refreshed.resolve({ projects: [a, b] });
    await oldQuery;
    await settle();
    expect(directory.latest()?.projects).toEqual([b]);
    expect(api.transport).toHaveBeenLastCalledWith(
      { "x-enterprise-project-id": "a" },
      directory.controller.signal,
    );
  });

  it("uses the live module and latest successor, and never asks a second time about drafts", async () => {
    const response = deferred<unknown>();
    api.remove.mockReturnValue(response.promise);
    const pending = directory.delete(a);
    await settle();
    window.history.replaceState(
      null,
      "",
      "/?enterpriseProjectId=a&operatorOwnerId=7&view=content&articleId=old",
    );
    const newest = { ...b, id: "c", isLegacyDefault: true };
    directory.queryClient.setQueryData(directory.queryKey, {
      projects: [a, newest],
    });
    const prompt = vi.fn();
    const removeGuard = installWorkspaceNavigationGuard(prompt);
    const removeDraft = registerWorkspaceDraft({
      isDirty: () => true,
      label: "草稿",
    });
    try {
      response.resolve({});
      await pending;
      expect(prompt).not.toHaveBeenCalled();
      expect(window.location.search).toContain("enterpriseProjectId=c");
      expect(window.location.search).toContain("view=content");
      expect(window.location.search).not.toContain("articleId");
    } finally {
      removeDraft();
      removeGuard();
    }
  });

  it.each([
    "/?enterpriseProjectId=b&operatorOwnerId=7&view=publishing",
    "/?enterpriseProjectId=a&operatorOwnerId=8",
    "/agent",
    "/account?operatorOwnerId=7",
  ])("preserves a newer destination %s", async (path) => {
    const response = deferred<unknown>();
    api.remove.mockReturnValue(response.promise);
    const pending = directory.delete(a);
    await settle();
    window.history.replaceState(null, "", path);
    response.resolve({});
    await pending;
    expect(window.location.pathname + window.location.search).toBe(path);
    expect(directory.latest()?.projects).toEqual([b]);
  });

  it("deletes the last project into an empty project state while retaining the module and owner", async () => {
    directory.queryClient.setQueryData(directory.queryKey, { projects: [a] });
    api.list.mockResolvedValue({ projects: [] });
    await directory.delete(a);
    expect(window.location.search).not.toContain("enterpriseProjectId");
    expect(window.location.search).toContain("operatorOwnerId=7");
    expect(window.location.search).toContain("view=knowledge");
  });

  it("locks management across the owner scope and treats successful replays as side-effect free", async () => {
    const response = deferred<unknown>();
    api.remove.mockReturnValue(response.promise);
    const pending = directory.delete(a);
    await settle();
    expect(directory.getPending()).toBe(true);
    await expect(directory.rename("新名", b)).rejects.toThrow("正在处理中");
    response.resolve({});
    await pending;
    await settle();
    expect(directory.getPending()).toBe(false);
    const calls = api.list.mock.calls.length;
    window.history.replaceState(
      null,
      "",
      "/?enterpriseProjectId=b&operatorOwnerId=7",
    );
    await directory.delete(a);
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(calls);
    expect(window.location.search).toBe(
      "?enterpriseProjectId=b&operatorOwnerId=7",
    );
  });

  it("refreshes a revision conflict without retrying with the new revision", async () => {
    const conflict = Object.assign(new Error("项目已更新"), {
      data: { code: "CONFLICT" },
    });
    api.remove.mockRejectedValue(conflict);
    api.list.mockResolvedValue({ projects: [{ ...a, revision: 4 }, b] });
    await expect(directory.delete(a)).rejects.toBe(conflict);
    expect(directory.latest()?.projects[0].revision).toBe(4);
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledWith({
      enterpriseProjectId: "a",
      expectedRevision: 1,
    });
    expect(window.location.search).toContain("enterpriseProjectId=a");
  });

  it("recovers a lost success response by reading the directory", async () => {
    api.remove.mockRejectedValue(new Error("Failed to fetch"));
    await directory.delete(a);
    expect(directory.latest()?.projects).toEqual([b]);
    expect(window.location.search).toContain("enterpriseProjectId=b");
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it("preserves unresolved deletion and original revision for an explicit retry", async () => {
    api.remove
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce({});
    api.list
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ projects: [b] });
    const target = { ...a };
    const pending = directory.delete(target);
    target.revision = 8;
    await expect(pending).rejects.toThrow("删除结果尚未确认");
    expect(directory.latest()?.projects).toEqual([a, b]);
    await directory.delete(a);
    expect(
      api.remove.mock.calls.map(([input]) => input.expectedRevision),
    ).toEqual([1, 1]);
  });

  it("does not publish or navigate through a retired viewer-owner lifecycle", async () => {
    const response = deferred<unknown>();
    api.remove.mockReturnValue(response.promise);
    const pending = directory.delete(a);
    await settle();
    directory.retire();
    response.resolve({});
    await pending;
    expect(directory.controller.signal.aborted).toBe(true);
    expect(directory.latest()).toBeUndefined();
    expect(api.list).not.toHaveBeenCalled();
    expect(window.location.search).toContain("enterpriseProjectId=a");
  });

  it("retains a successful rename when the follow-up directory sync fails", async () => {
    api.rename.mockResolvedValue({ ...a, name: "更新后的项目", revision: 2 });
    api.list.mockRejectedValue(new Error("offline"));
    await directory.rename("更新后的项目", a);
    await settle();
    expect(directory.latest()?.projects[0]).toMatchObject({
      name: "更新后的项目",
      revision: 2,
    });
    expect(api.rename).toHaveBeenCalledTimes(1);
    expect(
      directory.queryClient.getQueryState(directory.queryKey)?.error,
    ).toBeInstanceOf(Error);
  });

  it("creates under the captured owner and publishes the real returned project", async () => {
    api.create.mockResolvedValue({ ...b, id: "created" });
    api.list.mockResolvedValue({ projects: [a, b, { ...b, id: "created" }] });
    await directory.create("新项目");
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "新项目",
        ownerUserId: 7,
        clientRequestId: expect.any(String),
      }),
    );
    expect(directory.latest()?.projects.map((project) => project.id)).toContain(
      "created",
    );
    expect(window.location.search).toContain("enterpriseProjectId=created");
  });

  it("removes only the deleted project's persisted identity and draft", async () => {
    const stored = new Map([
      [
        "frontmind.enterpriseProject",
        JSON.stringify({ ownerUserId: 8, id: "another" }),
      ],
      ["frontmind.pending-build-draft:a", "deleted draft"],
      ["frontmind.pending-build-draft:b", "other draft"],
      ["frontmind.pending-build-draft", "account draft"],
    ]);
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key),
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    window.history.replaceState(null, "", "/account?operatorOwnerId=7");
    await directory.delete(a);
    expect(stored.has("frontmind.pending-build-draft:a")).toBe(false);
    expect(stored.get("frontmind.pending-build-draft:b")).toBe("other draft");
    expect(stored.get("frontmind.pending-build-draft")).toBe("account draft");
    expect(
      JSON.parse(stored.get("frontmind.enterpriseProject")!).ownerUserId,
    ).toBe(8);
  });
});
