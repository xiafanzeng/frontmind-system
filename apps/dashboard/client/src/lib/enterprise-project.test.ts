import { afterEach, describe, expect, it } from "vitest";
import { activeEnterpriseProjectId, enterpriseProjectHeaders, enterpriseWorkspaceScope, projectWorkspaceUrl, switchEnterpriseProject } from "./enterprise-project";
import { DEFAULT_MEDIA_FILTERS, readMediaRouteState, writeMediaRouteState, writePublicationWorkbenchRouteState, readPublicationRouteState } from "../monitoring/features/publishing/queryState";

afterEach(() => { window.history.replaceState(null, "", "/"); sessionStorage.clear(); });

describe("enterprise workspace navigation", () => {
  it("keeps the enterprise and administrator scope through media canonicalization without a refresh loop", () => {
    window.history.replaceState(null, "", "/publishing/media?enterpriseProjectId=project-a&operatorOwnerId=3&query=brand");
    const filters = readMediaRouteState(window.location.search).filters;
    const canonical = writeMediaRouteState("/publishing/media", filters);
    window.history.replaceState(null, "", canonical);
    expect(new URLSearchParams(window.location.search).get("enterpriseProjectId")).toBe("project-a");
    expect(new URLSearchParams(window.location.search).get("operatorOwnerId")).toBe("3");
    expect(writeMediaRouteState("/publishing/media", readMediaRouteState(window.location.search).filters)).toBe(canonical);
    expect(writeMediaRouteState("/publishing/media", DEFAULT_MEDIA_FILTERS)).toContain("enterpriseProjectId=project-a");
    expect(writePublicationWorkbenchRouteState(readPublicationRouteState("status=success"))).toContain("enterpriseProjectId=project-a");
  });

  it("changes projects using history while preserving an explicitly selected project", () => {
    window.history.replaceState(null, "", "/?enterpriseProjectId=old-project&operatorOwnerId=3");
    switchEnterpriseProject(3, "new-project");
    expect(activeEnterpriseProjectId()).toBe("new-project");
    expect(window.location.pathname).toBe("/");
    expect(projectWorkspaceUrl("/publishing?enterpriseProjectId=explicit-project")).toContain("enterpriseProjectId=explicit-project");
    expect(sessionStorage.setItem).toHaveBeenCalledWith("frontmind.enterpriseProject", JSON.stringify({ ownerUserId: 3, id: "new-project" }));
  });

  it("removes enterprise context for account tools and does not widen admin links", () => {
    window.history.replaceState(null, "", "/?enterpriseProjectId=project-a&operatorOwnerId=3");
    expect(projectWorkspaceUrl("/agent")).toBe("/agent");
    expect(projectWorkspaceUrl("/account")).toBe("/account?operatorOwnerId=3");
    expect(projectWorkspaceUrl("/admin/users")).toBe("/admin/users");
    expect(projectWorkspaceUrl("https://example.com/")).toBe("https://example.com/");
    expect(enterpriseWorkspaceScope("/agent", "enterpriseProjectId=project-a")).toBeUndefined();
    window.history.replaceState(null, "", "/agent?enterpriseProjectId=project-a");
    expect(enterpriseProjectHeaders()).toEqual({});
  });
});
