import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { GENERATED_KNOWLEDGE_BASE_WORKING_SET_POLICY } from "../shared/knowledge-base-working-set-policy.generated";
import {
  KNOWLEDGE_BASE_WORKING_SET_POLICY,
  probeKnowledgeBaseWorkingSetPolicy,
  type KnowledgeBaseWorkingSetPolicyProbe,
} from "../shared/knowledge-base-working-set-policy";

const execFileAsync = promisify(execFile);
const policyPath = path.resolve(
  "private-workflows/socratic-kb-builder/references/working-set-policy.json",
);
const validatorPath = path.resolve(
  "private-workflows/socratic-kb-builder/scripts/validate_working_set.py",
);
const fixturePath = path.resolve(
  "server/fixtures/knowledge-base-working-set-policy-probes.json",
);

type Fixture = Readonly<{
  name: string;
  input: KnowledgeBaseWorkingSetPolicyProbe;
  expected: ReturnType<typeof probeKnowledgeBaseWorkingSetPolicy>;
}>;

describe("knowledge-base shared working-set policy", () => {
  it("keeps the generated TypeScript consumer byte-for-byte derived from the canonical JSON", async () => {
    const source = JSON.parse(await fs.readFile(policyPath, "utf8"));
    expect(GENERATED_KNOWLEDGE_BASE_WORKING_SET_POLICY).toEqual(source);
    expect(KNOWLEDGE_BASE_WORKING_SET_POLICY).toBe(
      GENERATED_KNOWLEDGE_BASE_WORKING_SET_POLICY,
    );
    await expect(
      execFileAsync("node", [
        path.resolve("scripts/generate-knowledge-base-working-set-policy.mjs"),
        "--check",
      ]),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("matches TypeScript and Python accept/reject, retention, drops and warnings for every fixture", async () => {
    const fixtures = JSON.parse(
      await fs.readFile(fixturePath, "utf8"),
    ) as Fixture[];
    const python = await execFileAsync("python3", [
      "-c",
      [
        "import importlib.util, json, sys",
        "spec = importlib.util.spec_from_file_location('working_set_validator', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "fixtures = json.load(open(sys.argv[2], encoding='utf-8'))",
        "print(json.dumps([module.working_set_policy_probe(item['input']) for item in fixtures], ensure_ascii=False))",
      ].join("\n"),
      validatorPath,
      fixturePath,
    ]);
    const pythonResults = JSON.parse(python.stdout) as unknown[];
    const typeScriptResults = fixtures.map((fixture) =>
      probeKnowledgeBaseWorkingSetPolicy(fixture.input),
    );

    expect(typeScriptResults).toEqual(
      fixtures.map((fixture) => fixture.expected),
    );
    expect(pythonResults).toEqual(typeScriptResults);
  });
});
