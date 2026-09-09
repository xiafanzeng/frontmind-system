import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkbenchModules,
  workbenchModuleForView,
} from "./agent-workbench";
import { OPERATOR_MODULES, operatorViewFromRoute } from "./operator-navigation";

describe("module descriptors", () => {
  it("selects the routed subagent with distinct colors and preserves its business destination", () => {
    const open = vi.fn();
    const publishing = createWorkbenchModules(() => null, open, "media").find(
      (module) => module.id === "publishing",
    )!;
    expect(
      publishing.actions
        .filter((action) => action.active)
        .map((action) => action.id),
    ).toEqual(["media"]);
    expect(new Set(publishing.actions.map((action) => action.color)).size).toBe(
      3,
    );
    publishing.actions[1]!.run();
    expect(open).toHaveBeenCalledWith("articles");
    const brand = createWorkbenchModules(
      () => null,
      open,
      "knowledge-display",
    )[0]!;
    expect(brand.actions[0]!.active).toBe(true);
  });
  it("maps all six modules to their own result renderer and existing business actions", () => {
    const open = vi.fn();
    const modules = createWorkbenchModules((id) => <p>{id} 的成果</p>, open);
    expect(modules.map((module) => module.label)).toEqual(
      OPERATOR_MODULES.map((module) => module.label),
    );
    modules.forEach((module) => {
      render(<>{module.renderResult()}</>);
      expect(screen.getByText(`${module.id} 的成果`)).toBeInTheDocument();
      cleanup();
      for (const action of module.actions) {
        action.run();
        expect(open).toHaveBeenLastCalledWith(action.id);
      }
    });
  });
  it.each([
    ["knowledge-agent", "display", "brand"],
    ["brand", "global-keywords", "brand"],
    ["historical-results", "question-1", "intent"],
    ["response-logic", "agent", "intent"],
    ["monitoring-module", null, "progress"],
    ["progress", "optimization", "progress"],
    ["content-production", null, "content"],
    ["publishing-module", "/publishing/media", "publishing"],
    ["enterprise-qa", null, "extensions"],
    ["semantic", "content-insights", "extensions"],
  ])("keeps %s / %s deep links in %s", (section, sub, id) => {
    expect(
      workbenchModuleForView(operatorViewFromRoute({ section: section!, sub }))
        .id,
    ).toBe(id);
  });
});
