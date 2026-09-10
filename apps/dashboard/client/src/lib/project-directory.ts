import { QueryClient } from "@tanstack/react-query";
import { createDashboardTransport } from "./dashboard-transport";
import {
  clearDeletedEnterpriseProject,
  navigateAfterEnterpriseProjectDeletion,
  switchEnterpriseProject,
} from "./enterprise-project";

export type DirectoryProject = {
  id: string;
  name: string;
  ownerUserId: number;
  revision: number;
  isLegacyDefault?: boolean;
};
export type ProjectDirectoryData = { projects: DirectoryProject[] };
export type ProjectManagementTarget = Pick<DirectoryProject, "id" | "revision">;

/** Only project directory and management requests live at the viewer-owner level.
 * Business queries continue to belong to the replaceable project scope. */
export class ProjectDirectory {
  readonly queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 20_000, retry: false },
      mutations: { retry: false },
    },
  });
  readonly controller = new AbortController();
  readonly queryKey;
  private readonly client;
  private readonly deleted = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private active = true;
  private pending = false;
  constructor(
    readonly viewerUserId: number,
    readonly ownerUserId: number,
  ) {
    this.queryKey = [
      ["enterpriseProjects", "list"],
      { input: { ownerUserId }, type: "query" },
    ] as const;
    this.client = createDashboardTransport({}, this.controller.signal);
  }
  get alive() {
    return this.active;
  }
  activate() {
    this.active = true;
  }
  deactivate() {
    this.active = false;
  }
  getPending = () => this.pending;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private setPending(value: boolean) {
    this.pending = value;
    for (const listener of this.listeners) listener();
  }
  private filter(data: ProjectDirectoryData): ProjectDirectoryData {
    return {
      ...data,
      projects: data.projects.filter(
        (project) => !this.deleted.has(project.id),
      ),
    };
  }
  readonly queryOptions = () => ({
    queryKey: this.queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const data = await this.client.enterpriseProjects.list.query(
        { ownerUserId: this.ownerUserId },
        { signal },
      );
      return this.filter(data);
    },
    refetchOnWindowFocus: true,
    retry: false as const,
  });
  latest() {
    return this.queryClient.getQueryData<ProjectDirectoryData>(this.queryKey);
  }
  private async refresh() {
    if (!this.alive) return;
    await this.queryClient.cancelQueries({ queryKey: this.queryKey });
    if (!this.alive) return;
    return this.queryClient.fetchQuery({
      ...this.queryOptions(),
      staleTime: 0,
    });
  }
  private scheduleRefresh() {
    if (this.alive)
      void this.refresh().catch(() => {
        /* Known data stays usable; the query exposes its sync error. */
      });
  }
  private async manage<T>(operation: () => Promise<T>) {
    if (!this.alive) throw new Error("当前客户工作区已切换，请重新操作。");
    if (this.pending) throw new Error("项目管理操作正在处理中，请稍候。");
    this.setPending(true);
    try {
      return await operation();
    } finally {
      this.setPending(false);
    }
  }
  private targetClient(id: string) {
    return createDashboardTransport(
      { "x-enterprise-project-id": id },
      this.controller.signal,
    );
  }
  async create(name: string) {
    return this.manage(async () => {
      const result = await this.client.enterpriseProjects.create.mutate({
        name,
        ownerUserId: this.ownerUserId,
        clientRequestId: crypto.randomUUID(),
      });
      if (!this.alive) return;
      const project = result;
      this.queryClient.setQueryData<ProjectDirectoryData>(
        this.queryKey,
        (current) =>
          this.filter({
            ...current,
            projects: [
              ...(current?.projects || []).filter(
                (item) => item.id !== project.id,
              ),
              project,
            ],
          }),
      );
      this.scheduleRefresh();
      switchEnterpriseProject(this.ownerUserId, project.id);
    });
  }
  async rename(name: string, target: ProjectManagementTarget) {
    const captured = { id: target.id, revision: target.revision };
    return this.manage(async () => {
      await this.queryClient.cancelQueries({ queryKey: this.queryKey });
      if (!this.alive) throw new Error("当前客户工作区已切换，请重新操作。");
      try {
        const updated = await this.targetClient(
          captured.id,
        ).enterpriseProjects.rename.mutate({
          enterpriseProjectId: captured.id,
          expectedRevision: captured.revision,
          name,
        });
        if (!this.alive) return;
        this.queryClient.setQueryData<ProjectDirectoryData>(
          this.queryKey,
          (current) =>
            this.filter({
              projects: (current?.projects || []).map((project) =>
                project.id === captured.id ? updated : project,
              ),
            }),
        );
      } catch (error) {
        await this.refresh().catch(() => undefined);
        throw error;
      }
      this.scheduleRefresh();
    });
  }
  async delete(target: ProjectManagementTarget) {
    // Capture the original revision once. A retry never substitutes a fresh revision.
    const captured = { id: target.id, revision: target.revision };
    const operationId = `${captured.id}:${captured.revision}`;
    if (this.completed.has(operationId)) return;
    return this.manage(async () => {
      await this.queryClient.cancelQueries({ queryKey: this.queryKey });
      if (!this.alive) throw new Error("当前客户工作区已切换，请重新操作。");
      try {
        await this.targetClient(captured.id).enterpriseProjects.delete.mutate({
          enterpriseProjectId: captured.id,
          expectedRevision: captured.revision,
        });
      } catch (error) {
        if (!this.alive) throw error;
        const code = (error as { data?: { code?: string } })?.data?.code;
        const fresh = await this.refresh().catch(() => undefined);
        // An absent transport response is not a server rejection. Resolve it only
        // from an authoritative directory refresh; explicit failures remain failures.
        if (
          code ||
          !fresh ||
          fresh.projects.some((project) => project.id === captured.id)
        ) {
          if (!code)
            throw new Error(
              "删除结果尚未确认，已尝试同步项目目录。请重新读取，或使用本次确认的项目版本重试。",
            );
          throw error;
        }
      }
      if (!this.alive || this.completed.has(operationId)) return;
      this.completed.add(operationId);
      this.deleted.add(captured.id);
      this.queryClient.setQueryData<ProjectDirectoryData>(
        this.queryKey,
        (current) => this.filter(current || { projects: [] }),
      );
      clearDeletedEnterpriseProject(this.ownerUserId, captured.id);
      // Read the current owner, module and project, plus the latest directory.
      navigateAfterEnterpriseProjectDeletion(
        this.viewerUserId,
        this.ownerUserId,
        captured.id,
        this.latest()?.projects || [],
      );
      this.scheduleRefresh();
    });
  }
  retire() {
    this.active = false;
    this.controller.abort();
    void this.queryClient.cancelQueries();
    this.queryClient.clear();
    this.listeners.clear();
  }
}
