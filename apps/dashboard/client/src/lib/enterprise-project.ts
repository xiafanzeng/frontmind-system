/** A project switch reloads the document so queued requests and caches cannot cross scopes. */
const PROJECT_KEY = "frontmind.enterpriseProject";
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

export function activeEnterpriseProjectId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const explicit = new URLSearchParams(window.location.search).get("enterpriseProjectId");
  if (validId(explicit)) return explicit;
  return undefined;
}

export function rememberEnterpriseProject(ownerUserId: number, id: string) {
  if (validId(id)) sessionStorage.setItem(PROJECT_KEY, JSON.stringify({ ownerUserId, id }));
}

export function rememberedEnterpriseProject(ownerUserId: number): string | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(PROJECT_KEY) || "null");
    if (value?.ownerUserId === ownerUserId && validId(value.id)) return value.id;
    sessionStorage.removeItem(PROJECT_KEY);
  } catch { sessionStorage.removeItem(PROJECT_KEY); }
  return undefined;
}

export function enterpriseProjectHeaders(headers: Record<string, string> = {}): Record<string, string> {
  if (typeof window !== "undefined" && ["/agent", "/account"].includes(window.location.pathname)) return headers;
  const projectId = activeEnterpriseProjectId();
  return { ...headers, ...(projectId ? { "x-enterprise-project-id": projectId } : {}) };
}

export function clearEnterpriseProject() { sessionStorage.removeItem(PROJECT_KEY); sessionStorage.removeItem("frontmind.pending-build-draft"); }

export function projectWorkspaceUrl(path: string, id = activeEnterpriseProjectId()): string {
  const url = new URL(path, window.location.origin);
  if (id) url.searchParams.set("enterpriseProjectId", id);
  const owner = new URLSearchParams(window.location.search).get("operatorOwnerId");
  if (owner && /^\d+$/.test(owner) && url.pathname !== "/agent") url.searchParams.set("operatorOwnerId", owner);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function switchEnterpriseProject(ownerUserId: number, id: string) {
  rememberEnterpriseProject(ownerUserId, id);
  window.location.assign(projectWorkspaceUrl("/?view=knowledge", id));
}

/** Preserve the project on browser-native image and download requests. */
export function projectResourceUrl(path: string): string {
  const projectId = enterpriseProjectHeaders()["x-enterprise-project-id"];
  if (!projectId || !path.startsWith("/") || path.startsWith("//")) return path;
  const url = new URL(path, "https://frontmind.invalid");
  url.searchParams.set("enterpriseProjectId", projectId);
  return `${url.pathname}${url.search}${url.hash}`;
}
