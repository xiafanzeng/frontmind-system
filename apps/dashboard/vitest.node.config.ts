import {
  createVitestSuiteConfig,
  nonClientTestIncludes,
} from "./vitest.config";

export default createVitestSuiteConfig({
  environment: "node",
  include: nonClientTestIncludes,
  setupFiles: [],
});
