// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  ensureLink: vi.fn(),
  syncAccounts: vi.fn(),
  createRuntime: vi.fn(() => ({ repository: { db: {} }, app: vi.fn() })),
}));
vi.mock("./auth-service", () => ({ authenticateRequest: mocks.authenticate }));
vi.mock("@frontmind/monitoring-api/runtime", () => ({ createMonitoringRuntime: mocks.createRuntime }));
vi.mock("@frontmind/monitoring-db", () => ({
  ensureDashboardAccountLink: mocks.ensureLink,
  syncDashboardMonitoringAccounts: mocks.syncAccounts,
}));
import { monitoringEnvironment, resolveMonitoringIdentity } from "./monitoring-module";

const request = { headers: { "x-user-id": "someone-else", "x-role": "admin" } } as unknown as Request;

describe("unified monitoring identity", () => {
  it("never resolves a second session or trusts browser identity headers", async () => {
    mocks.authenticate.mockResolvedValueOnce(null);
    expect(await resolveMonitoringIdentity(request)).toBeNull();
    expect(mocks.ensureLink).not.toHaveBeenCalled();
  });

  it.each([
    ["user", null, "user"],
    ["admin", "delivery_admin", "user"],
    ["admin", undefined, "user"],
    ["admin", "system_admin", "admin"],
  ])("maps %s/%s using the Dashboard account", async (role, adminAccessLevel, expectedRole) => {
    mocks.authenticate.mockResolvedValueOnce({ id: 42, username: "customer", role, adminAccessLevel });
    mocks.ensureLink.mockResolvedValueOnce({ dashboardUserId: 42, monitoringUserId: "tenant-uuid" });
    const result = await resolveMonitoringIdentity(request);
    expect(mocks.ensureLink).toHaveBeenLastCalledWith({}, 42);
    expect(result?.user).toEqual({ id: "tenant-uuid", username: "customer", role: expectedRole, status: "active" });
    expect(result?.session).toBeNull();
    expect(result?.tokenHash).toBeNull();
  });
});

describe("embedded environment", () => {
  it("derives stable capability secrets without adding a browser session", () => {
    const input = {
      NODE_ENV: "production", FRONTMIND_CREDENTIAL_ENCRYPTION_KEY: "example-key-for-test-only",
      FRONTMIND_PUBLIC_URL: "https://dashboard.example.test/base",
      FRONTMIND_ZPAY_PID: "configured", FRONTMIND_ZPAY_KEY: "test-only-key",
      FRONTMIND_PUBLIC_BASE_URL: "https://website.example.test", WEB_DIST_DIR: "/another-app",
    };
    const first = monitoringEnvironment(input);
    expect(first.SESSION_SECRET).toHaveLength(64);
    expect(first.SESSION_SECRET).toEqual(monitoringEnvironment(input).SESSION_SECRET);
    expect(first.PUBLIC_ORIGIN).toBe("https://dashboard.example.test");
    expect(first.FRONTMIND_PUBLIC_BASE_URL).toBe(first.PUBLIC_ORIGIN);
    expect(first.WEB_DIST_DIR).toBeUndefined();
  });

  it("fails closed without the production signing secret", () => {
    expect(() => monitoringEnvironment({ NODE_ENV: "production" })).toThrow(/SECRET/);
  });
});
