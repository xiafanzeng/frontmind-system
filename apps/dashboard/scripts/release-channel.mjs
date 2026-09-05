import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateProductionRuntimeEnvironment } from "./validate-production-runtime.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

export const releasePresentation = Object.freeze({
  releaseChannel: "production",
  websiteUrl: "https://www.frontmind.cn",
  documentTitle: "FrontMind Client",
  preventIndexing: false,
});

const buildEnvironment = Object.freeze({
  FRONTMIND_RELEASE_CHANNEL: releasePresentation.releaseChannel,
  VITE_FRONTMIND_RELEASE_CHANNEL: releasePresentation.releaseChannel,
  VITE_FRONTMIND_WEBSITE_URL: releasePresentation.websiteUrl,
});

const commandPlans = Object.freeze({
  build: {
    environment: buildEnvironment,
    steps: [{ tool: "node", args: ["scripts/build-production-release.mjs"] }],
  },
  audit: {
    steps: [{ tool: "node", args: ["scripts/audit-production-bundle.mjs"] }],
  },
  "repository-test": {
    steps: [
      { tool: "node", args: ["scripts/test-production-release-flow.mjs"] },
    ],
  },
  "runtime-preflight": {
    steps: [
      { tool: "node", args: ["scripts/validate-production-runtime.mjs"] },
    ],
  },
  "database-migrate": {
    steps: [{ tool: "pnpm", args: ["exec", "drizzle-kit", "migrate"] }],
  },
  "database-push": {
    steps: [
      { tool: "pnpm", args: ["db:generate"] },
      { tool: "pnpm", args: ["exec", "drizzle-kit", "migrate"] },
    ],
  },
  "database-bootstrap-test": null,
});

export function releaseCommandPlan(command) {
  if (!Object.hasOwn(commandPlans, command) || commandPlans[command] === null) {
    throw new Error(`RELEASE_CHANNEL_COMMAND_UNSUPPORTED:${String(command)}`);
  }
  return commandPlans[command];
}

export function validateReleaseChannelRuntimeEnvironment(env = process.env) {
  const configuredReleaseChannel = String(env.FRONTMIND_RELEASE_CHANNEL || "")
    .trim()
    .toLowerCase();
  if (
    configuredReleaseChannel &&
    configuredReleaseChannel !== releasePresentation.releaseChannel
  ) {
    throw new Error("FRONTMIND_RUNTIME_RELEASE_CHANNEL_MISMATCH");
  }
  return {
    ...validateProductionRuntimeEnvironment(env),
    releaseChannel: releasePresentation.releaseChannel,
  };
}

function executableFor(tool) {
  return tool === "node" ? process.execPath : tool;
}

export function runReleaseChannelCommand(command) {
  const plan = releaseCommandPlan(command);
  for (const step of plan.steps) {
    execFileSync(executableFor(step.tool), step.args, {
      cwd: projectRoot,
      env: { ...process.env, ...plan.environment },
      stdio: "inherit",
    });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [command, ...extraArguments] = process.argv.slice(2);
  if (!command || extraArguments.length > 0) {
    console.error("RELEASE_CHANNEL_COMMAND_REQUIRED");
    process.exitCode = 1;
  } else {
    try {
      runReleaseChannelCommand(command);
    } catch (error) {
      console.error(
        error instanceof Error
          ? error.message
          : "RELEASE_CHANNEL_COMMAND_FAILED",
      );
      process.exitCode = 1;
    }
  }
}
