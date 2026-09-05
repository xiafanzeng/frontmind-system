import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditKnowledgeBaseRollout } from "../server/knowledge-base-rollout-audit";

export const KNOWLEDGE_BASE_ROLLOUT_AUDIT_SUCCESS = "KB_ROLLOUT_AUDIT_OK";

function argumentValue(argv: readonly string[], name: string) {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseKnowledgeBaseRolloutAuditArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const sinceValue = String(argumentValue(argv, "--since") || "").trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      sinceValue,
    )
  ) {
    throw new Error("KB_ROLLOUT_SINCE_INVALID");
  }
  const since = new Date(sinceValue);
  if (!Number.isFinite(since.getTime()) || since.getTime() > Date.now()) {
    throw new Error("KB_ROLLOUT_SINCE_INVALID");
  }

  const expectedValue = String(
    argumentValue(argv, "--expected-percent") || "",
  ).trim();
  if (!/^(?:100|[0-9]{1,2})(?:\.\d{1,2})?$/u.test(expectedValue)) {
    throw new Error("KB_ROLLOUT_EXPECTED_PERCENT_INVALID");
  }
  const expectedPercent = Number(expectedValue);
  const configuredValue = String(
    env.FRONTMIND_KB_V4_ROLLOUT_PERCENT || "",
  ).trim();
  if (!/^(?:100|[0-9]{1,2})(?:\.\d{1,2})?$/u.test(configuredValue)) {
    throw new Error("KB_ROLLOUT_CONFIG_PERCENT_INVALID");
  }
  const configuredPercent = Number(configuredValue);
  if (configuredPercent !== expectedPercent) {
    throw new Error("KB_ROLLOUT_PERCENT_MISMATCH");
  }
  const sampleMinimum = (name: string) => {
    const raw = String(argumentValue(argv, name) || "").trim();
    if (!raw) return expectedPercent > 0 ? 1 : 0;
    if (!/^\d{1,9}$/u.test(raw)) {
      throw new Error("KB_ROLLOUT_SAMPLE_MINIMUM_INVALID");
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error("KB_ROLLOUT_SAMPLE_MINIMUM_INVALID");
    }
    return parsed;
  };
  return {
    since,
    expectedPercent,
    minimumBuilds: sampleMinimum("--min-builds"),
    minimumOperations: sampleMinimum("--min-operations"),
  };
}

export function knowledgeBaseRolloutFailureLine(
  violations: readonly { code: string }[],
) {
  const codes = Array.from(
    new Set(
      violations.map((item) =>
        /^[A-Z][A-Z0-9_]{0,79}$/u.test(item.code)
          ? item.code
          : "UNKNOWN_VIOLATION",
      ),
    ),
  ).sort();
  return `KB_ROLLOUT_AUDIT_FAILED count=${violations.length} codes=${codes.join(",")}`;
}

async function runAuditWithoutDependencyLogs(
  audit: typeof auditKnowledgeBaseRollout,
  since: Date,
) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };
  const discard = () => undefined;
  console.log = discard;
  console.warn = discard;
  console.error = discard;
  console.info = discard;
  console.debug = discard;
  try {
    return await audit({ since });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
    console.debug = original.debug;
  }
}

export async function runKnowledgeBaseRolloutAudit(input: {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  audit?: typeof auditKnowledgeBaseRollout;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}) {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const audit = input.audit ?? auditKnowledgeBaseRollout;
  const stdout = input.stdout ?? ((line: string) => console.log(line));
  const stderr = input.stderr ?? ((line: string) => console.error(line));
  try {
    const { since, minimumBuilds, minimumOperations } =
      parseKnowledgeBaseRolloutAuditArguments(argv, env);
    // Dependency diagnostics can contain SQL driver internals or upstream
    // request objects. The gate owns its complete output contract and emits
    // only the allowlisted summary below.
    const result = await runAuditWithoutDependencyLogs(audit, since);
    const violations: Array<{ code: string }> = [...result.violations];
    if (result.scanned < minimumBuilds) {
      violations.push({ code: "INSUFFICIENT_BUILD_SAMPLE" });
    }
    if (result.operations < minimumOperations) {
      violations.push({ code: "INSUFFICIENT_OPERATION_SAMPLE" });
    }
    if (violations.length > 0) {
      stderr(knowledgeBaseRolloutFailureLine(violations));
      return 1;
    }
    stdout(KNOWLEDGE_BASE_ROLLOUT_AUDIT_SUCCESS);
    return 0;
  } catch {
    stderr("KB_ROLLOUT_AUDIT_ERROR");
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const exitCode = await runKnowledgeBaseRolloutAudit({});
  process.exitCode = exitCode;
}
