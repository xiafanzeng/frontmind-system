import { defineConfig } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";

const templateRoot = path.resolve(import.meta.dirname);
const configuredWebsiteTestRoot =
  process.env.FRONTMIND_WEBSITE_REPOSITORY_ROOT?.trim();
const websiteTestRoot = configuredWebsiteTestRoot
  ? path.resolve(configuredWebsiteTestRoot)
  : path.resolve(templateRoot, "../frontmind-website");

export default defineConfig({
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
    environment: "jsdom",
    testTimeout: 20_000,
    include: [
      "server/**/*.test.ts",
      "server/**/*.spec.ts",
      "scripts/**/*.test.ts",
      "shared/**/*.test.ts",
      "client/**/*.test.tsx",
      "client/**/*.test.ts",
    ],
    setupFiles: ["./client/src/test-setup.ts"],
  },
});
