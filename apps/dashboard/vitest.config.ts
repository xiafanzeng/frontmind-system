import { defineConfig } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";

import { siblingWebsiteRepositoryRoot } from "./server/cross-repo-test-path";

const templateRoot = path.resolve(import.meta.dirname);
const configuredWebsiteTestRoot =
  process.env.FRONTMIND_WEBSITE_REPOSITORY_ROOT?.trim();
const websiteTestRoot = configuredWebsiteTestRoot
  ? path.resolve(configuredWebsiteTestRoot)
  : siblingWebsiteRepositoryRoot(templateRoot);

export const nonClientTestIncludes = [
  "server/**/*.test.ts",
  "server/**/*.spec.ts",
  "scripts/**/*.test.ts",
  "shared/**/*.test.ts",
];

export const clientTestIncludes = [
  "client/**/*.test.tsx",
  "client/**/*.test.ts",
];

type VitestSuiteOptions = {
  environment: "node" | "jsdom";
  include: string[];
  setupFiles: string[];
};

export function createVitestSuiteConfig(options: VitestSuiteOptions) {
  return defineConfig({
    root: templateRoot,
    server: {
      fs: {
        allow: [templateRoot, websiteTestRoot],
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(templateRoot, "client", "src"),
        "@shared": path.resolve(templateRoot, "shared"),
        "@assets": path.resolve(templateRoot, "attached_assets"),
      },
    },
    plugins: [react()],
    test: {
      globals: true,
      environment: options.environment,
      testTimeout: 20_000,
      include: options.include,
      setupFiles: options.setupFiles,
    },
  });
}

export default createVitestSuiteConfig({
  environment: "jsdom",
  include: [...nonClientTestIncludes, ...clientTestIncludes],
  setupFiles: ["./client/src/test-setup.ts"],
});
