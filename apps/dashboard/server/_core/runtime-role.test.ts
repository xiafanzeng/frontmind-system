import { describe, expect, it } from "vitest";
import {
  resolveFrontMindRuntimeRole,
  runtimeRoleReadinessRequirements,
  runtimeRoleRunsKnowledgeBaseWorker,
  runtimeRoleRunsSiteOps,
  runtimeRoleServesWeb,
} from "./runtime-role";

describe("FrontMind runtime role", () => {
  it("keeps legacy installations combined when the role is absent", () => {
    expect(resolveFrontMindRuntimeRole(undefined)).toBe("combined");
  });

  it("isolates the public web and SiteOps worker responsibilities", () => {
    expect(runtimeRoleServesWeb(resolveFrontMindRuntimeRole("web"))).toBe(true);
    expect(runtimeRoleRunsSiteOps(resolveFrontMindRuntimeRole("web"))).toBe(
      false,
    );
    expect(
      runtimeRoleServesWeb(resolveFrontMindRuntimeRole("siteops-worker")),
    ).toBe(false);
    expect(
      runtimeRoleRunsSiteOps(resolveFrontMindRuntimeRole("siteops-worker")),
    ).toBe(true);
    expect(
      runtimeRoleRunsKnowledgeBaseWorker(
        resolveFrontMindRuntimeRole("siteops-worker"),
      ),
    ).toBe(true);
    expect(
      runtimeRoleRunsKnowledgeBaseWorker(resolveFrontMindRuntimeRole("web")),
    ).toBe(false);
  });

  it("only requires readiness from workers owned by the current role", () => {
    expect(runtimeRoleReadinessRequirements("combined")).toEqual({
      managedUploads: true,
      knowledgeBaseRecovery: true,
    });
    expect(runtimeRoleReadinessRequirements("web")).toEqual({
      managedUploads: true,
      knowledgeBaseRecovery: false,
    });
    expect(runtimeRoleReadinessRequirements("siteops-worker")).toEqual({
      managedUploads: false,
      knowledgeBaseRecovery: true,
    });
  });

  it("fails closed for misspelled roles", () => {
    expect(() => resolveFrontMindRuntimeRole("worker")).toThrow(
      "FRONTMIND_RUNTIME_ROLE_INVALID",
    );
  });
});
