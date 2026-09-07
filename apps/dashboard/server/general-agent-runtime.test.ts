import { describe, expect, it } from "vitest";
import { generalAgentRuntimeForSelection, generalAgentRuntimeForOperation } from "./general-agent-runtime";

const credential = { provider: "zhipu", upstreamModel: "glm-5.3", upstreamEffort: "max" };
describe("operator general agent effort", () => {
  it("defaults new conversations to High, independent of the credential default", () => {
    expect(generalAgentRuntimeForSelection(credential).upstreamEffort).toBe("high");
  });
  it.each([["frontmind-lite", "low"], ["frontmind-base", "high"], ["frontmind-pro", "max"]])("freezes %s as %s", (profile, effort) => {
    const selected = generalAgentRuntimeForSelection(credential, profile);
    expect(selected.upstreamEffort).toBe(effort);
    expect(generalAgentRuntimeForOperation({ upstreamModel: "glm-5.3", publicProfile: selected.publicProfile })).toEqual(selected);
  });
  it("rejects unsupported models and arbitrary profiles", () => {
    expect(() => generalAgentRuntimeForSelection(credential, "unlimited")).toThrow();
    expect(() => generalAgentRuntimeForSelection({ ...credential, upstreamModel: "other" })).toThrow();
  });
});
