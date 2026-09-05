import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("admin API Key mutation boundary", () => {
  it("exposes managed account changes only through the unified CAS contract", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "server/admin-router.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\breplaceCredential:\s*adminProcedure/u);
    expect(source).not.toMatch(/\bdeleteCredential:\s*adminProcedure/u);
    expect(source).not.toContain("replaceManagedUserCredential({");
    expect(source).not.toContain("deleteManagedUserCredential({");
    expect(source).toContain("replaceTargetCredential: adminProcedure");
    expect(source).toContain("revokeTargetCredential: adminProcedure");
    expect(source).toContain("bulkReplaceTargetCredentials: adminProcedure");
    expect(source).toContain('confirmation: z.literal("REPLACE_API_KEY")');
    expect(source).toContain('confirmation: z.literal("REVOKE_API_KEY")');
    expect(source).toContain(
      'confirmation: z.literal("BULK_REPLACE_API_KEYS")',
    );
    expect(source).toContain('.enum(["unconfigured_only", "replace_all"])');
    expect(source).toContain('kind: z.literal("customer")');
    expect(source).toContain('kind: z.literal("delivery_admin")');
    expect(source).toContain('kind: z.literal("engineer")');
    expect(source).not.toContain('kind: z.literal("system_admin")');
  });

  it("removes delivery-role mutation aliases and disables the legacy self-service writer", async () => {
    const [deliverySource, credentialSource] = await Promise.all([
      readFile(
        path.resolve(process.cwd(), "server/delivery-role-router.ts"),
        "utf8",
      ),
      readFile(
        path.resolve(process.cwd(), "server/credential-router.ts"),
        "utf8",
      ),
    ]);
    for (const route of [
      "setEngineerApiKey",
      "revokeEngineerApiKey",
      "setDeliveryAdminApiKey",
      "revokeDeliveryAdminApiKey",
    ]) {
      expect(deliverySource).not.toContain(`${route}: adminProcedure`);
    }
    expect(credentialSource).not.toContain("replaceApiCredential(");
    expect(credentialSource).not.toContain("deleteActiveApiCredential(");
    expect(credentialSource).toContain("API 与人员管理");
  });

  it("keeps Jenova brand-tracking credentials behind the system-admin boundary", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "server/admin-router.ts"),
      "utf8",
    );

    expect(source).toContain("brandTrackingCredentials: router({");
    const namespace = source.slice(
      source.indexOf("brandTrackingCredentials: router({"),
      source.indexOf("apiKeyUsageAlerts: router({"),
    );
    for (const operation of [
      "list",
      "configure",
      "bulkAssign",
      "revoke",
      "refreshBalance",
    ]) {
      expect(namespace).toContain(`${operation}: adminProcedure`);
    }
    expect(namespace.match(/requireSystemAdmin\(ctx\.user\)/gu)).toHaveLength(
      5,
    );
    expect(source).toContain("listJenovaBrandTrackingCredentialAssignments");
    expect(source).toContain("bulkAssignJenovaBrandTrackingCredential");
    expect(source).not.toContain("Jenova API Key 由工程师");
  });
});
