import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { siblingWebsiteRepositoryRoot } from "./cross-repo-test-path";

const DASHBOARD_REPOSITORY_DIRECTORY = "frontmind-dashboard";
const WEBSITE_REPOSITORY_DIRECTORY = "frontmind-website";
const DEVELOPMENT_WORKSPACE_SUFFIX = "-dev";
const dashboardDevelopmentWorkspace = `${DASHBOARD_REPOSITORY_DIRECTORY}${DEVELOPMENT_WORKSPACE_SUFFIX}`;
const websiteDevelopmentWorkspace = `${WEBSITE_REPOSITORY_DIRECTORY}${DEVELOPMENT_WORKSPACE_SUFFIX}`;
const originalConfiguredRoot = process.env.FRONTMIND_WEBSITE_REPOSITORY_ROOT;
const temporaryRoots: string[] = [];

afterEach(() => {
  if (originalConfiguredRoot === undefined) {
    delete process.env.FRONTMIND_WEBSITE_REPOSITORY_ROOT;
  } else {
    process.env.FRONTMIND_WEBSITE_REPOSITORY_ROOT = originalConfiguredRoot;
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureWorkspace(name: string, siblings: string[]) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "frontmind-repos-"));
  temporaryRoots.push(parent);
  const cwd = path.join(parent, name);
  fs.mkdirSync(cwd);
  for (const sibling of siblings) fs.mkdirSync(path.join(parent, sibling));
  return { parent, cwd };
}

describe("cross-repository Website test path", () => {
  it("honors the explicit Website repository root", () => {
    const configured = path.join(os.tmpdir(), "explicit-frontmind-website");
    process.env.FRONTMIND_WEBSITE_REPOSITORY_ROOT = configured;
    expect(
      siblingWebsiteRepositoryRoot(`/ignored/${dashboardDevelopmentWorkspace}`),
    ).toBe(path.resolve(configured));
  });

  it("prefers the Website Dev sibling from a Dashboard Dev workspace", () => {
    delete process.env.FRONTMIND_WEBSITE_REPOSITORY_ROOT;
    const { parent, cwd } = fixtureWorkspace(dashboardDevelopmentWorkspace, [
      WEBSITE_REPOSITORY_DIRECTORY,
      websiteDevelopmentWorkspace,
    ]);
    expect(siblingWebsiteRepositoryRoot(cwd)).toBe(
      path.join(parent, websiteDevelopmentWorkspace),
    );
  });

  it("keeps production priority outside a Dev workspace", () => {
    delete process.env.FRONTMIND_WEBSITE_REPOSITORY_ROOT;
    const { parent, cwd } = fixtureWorkspace(DASHBOARD_REPOSITORY_DIRECTORY, [
      WEBSITE_REPOSITORY_DIRECTORY,
      websiteDevelopmentWorkspace,
    ]);
    expect(siblingWebsiteRepositoryRoot(cwd)).toBe(
      path.join(parent, WEBSITE_REPOSITORY_DIRECTORY),
    );
  });
});
