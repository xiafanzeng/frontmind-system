import { describe, expect, it } from "vitest";
import { shouldIsolateAuthOperation } from "./trpc-link-routing";

describe("tRPC transport routing", () => {
  it("isolates every auth operation from workspace batches", () => {
    expect(shouldIsolateAuthOperation("auth.me")).toBe(true);
    expect(shouldIsolateAuthOperation("auth.login")).toBe(true);
    expect(shouldIsolateAuthOperation("auth.logout")).toBe(true);
    expect(shouldIsolateAuthOperation("conversation.list")).toBe(false);
    expect(shouldIsolateAuthOperation("workspace.siteOps.observe")).toBe(false);
  });
});
