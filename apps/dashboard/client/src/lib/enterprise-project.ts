import { navigate } from "wouter/use-browser-location";
import { requestWorkspaceNavigation } from "./workspace-navigation-guard";

/** WorkspaceQueryProvider replaces transports and caches when this scope changes. */
const PROJECT_KEY = "frontmind.enterpriseProject";
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

export function isEnterpriseWorkspacePath(path: string) {
  return ["/", "/knowledge-base", "/enterprise-qa", "/content-production"].includes(path) || /^\/(monitoring-system|publishing)(?:\/|$)/.test(path);
}

export function enterpriseWorkspaceScope(path: string, search: string): string | undefined {
  if (!isEnterpriseWorkspacePath(path)) return undefined;
  const id = new URLSearchParams(search).get("enterpriseProjectId");
  return validId(id) ? id : undefined;
}

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
  if (url.origin !== window.location.origin) return path;
  if (isEnterpriseWorkspacePath(url.pathname)) {
    if (id && !url.searchParams.has("enterpriseProjectId")) url.searchParams.set("enterpriseProjectId", id);
  } else url.searchParams.delete("enterpriseProjectId");
  const owner = new URLSearchParams(window.location.search).get("operatorOwnerId");
  if (owner && /^\d+$/.test(owner) && (isEnterpriseWorkspacePath(url.pathname) || url.pathname === "/account") && !url.searchParams.has("operatorOwnerId")) url.searchParams.set("operatorOwnerId", owner);
  if (url.pathname === "/agent") url.searchParams.delete("operatorOwnerId");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function switchEnterpriseProject(ownerUserId: number, id: string) {
  const target = projectSwitchPath();
  requestWorkspaceNavigation(() => {
    rememberEnterpriseProject(ownerUserId, id);
    navigate(projectWorkspaceUrl(target, id));
  });
}

/** Keep the current module when switching projects while dropping entity-specific
 * detail parameters that belong to the previous project. */
function projectSwitchPath() {
  if (typeof window === "undefined") return "/?view=knowledge";
  const { pathname, search } = window.location;
  if (pathname === "/agent" || pathname === "/account") return "/?view=knowledge";
  const query = new URLSearchParams(search);
  query.delete("enterpriseProjectId");
  ["questionId", "conversationId", "sessionId", "articleId", "mediaId", "runId", "draftId", "publicationId"].forEach(key => query.delete(key));
  if (pathname === "/" || pathname === "/knowledge-base") {
    const view = query.get("view");
    const known = new Set(["knowledge", "knowledge-display", "keywords", "questions", "response-logic", "monitoring", "reports", "content", "publishing", "articles", "media", "enterprise-qa", "website", "content-insights"]);
    if (!view || !known.has(view)) query.set("view", "knowledge");
    if (query.get("view") === "knowledge-display") query.set("view", "knowledge");
    return `/?${query}`;
  }
  if (pathname.startsWith("/monitoring-system")) return `/monitoring-system${query.toString() ? `?${query}` : ""}`;
  if (pathname.startsWith("/publishing/media")) return `/publishing/media${query.toString() ? `?${query}` : ""}`;
  if (pathname.startsWith("/publishing/articles")) return `/publishing/articles${query.toString() ? `?${query}` : ""}`;
  if (pathname.startsWith("/publishing")) return `/publishing${query.toString() ? `?${query}` : ""}`;
  if (pathname === "/content-production") return `/content-production${query.toString() ? `?${query}` : ""}`;
  if (pathname === "/enterprise-qa") return `/enterprise-qa${query.toString() ? `?${query}` : ""}`;
  return "/?view=knowledge";
}

/** Preserve the project on browser-native image and download requests. */
export function projectResourceUrl(path: string): string {
  const projectId = enterpriseProjectHeaders()["x-enterprise-project-id"];
  if (!projectId || !path.startsWith("/") || path.startsWith("//")) return path;
  const url = new URL(path, "https://frontmind.invalid");
  url.searchParams.set("enterpriseProjectId", projectId);
  return `${url.pathname}${url.search}${url.hash}`;
}
