import { clientTestIncludes, createVitestSuiteConfig } from "./vitest.config";

export default createVitestSuiteConfig({
  environment: "jsdom",
  include: clientTestIncludes,
  setupFiles: ["./client/src/test-setup.ts"],
});
