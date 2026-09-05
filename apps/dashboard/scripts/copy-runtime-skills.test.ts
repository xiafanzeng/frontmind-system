import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

describe("copy-runtime-skills", () => {
  it("freshly bundles frozen 2.2/2.3/2.4 and current 2.6 SiteOps workflows", async () => {
    await execFileAsync(process.execPath, ["scripts/copy-runtime-skills.mjs"], {
      cwd: projectRoot,
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    });

    for (const version of ["2.2.0", "2.3.0", "2.4.0", "2.6.0"]) {
      const workflowRoot = path.join(
        projectRoot,
        "dist",
        "private-workflows",
        `react-static-company-site-workflow-v${version}`,
      );
      const requiredFiles = [
        "MANIFEST.json",
        "SKILL.md",
        "runtime-contract.json",
        "adapters/frontmind-dashboard.md",
        "schemas/frontmind-run-envelope.schema.json",
        "assets/host-starter-contract.json",
        ...(version === "2.4.0"
          ? [
              "schemas/site-content-draft-v1.schema.json",
              "schemas/materialization-stage-v3.schema.json",
              "assets/materializer-contract.json",
            ]
          : version === "2.6.0"
            ? [
                "schemas/site-content-patch-wire-v1.schema.json",
                "schemas/materialization-stage-v3.schema.json",
                "assets/materializer-contract.json",
              ]
            : [
                "schemas/site-design-wire-v3.schema.json",
                "schemas/page-content-wire-v3.schema.json",
                "schemas/materialization-stage-v2.schema.json",
              ]),
      ];
      for (const relativePath of requiredFiles) {
        const absolutePath = path.join(workflowRoot, relativePath);
        await access(absolutePath);
        expect((await stat(absolutePath)).size, absolutePath).toBeGreaterThan(
          0,
        );
      }
      const runtime = JSON.parse(
        await readFile(
          path.join(workflowRoot, "runtime-contract.json"),
          "utf8",
        ),
      );
      if (version === "2.4.0") {
        expect(runtime).toMatchObject({
          adapterVersion: version,
          aiTask: {
            taskCount: 1,
            stageCount: 1,
            output: "SiteContentDraftV1-flat-transport",
            designOutputAllowed: false,
          },
          contentSystem: {
            buildContract: "BuildContractV4",
            missingContentPolicy: "verified-brief-fallback",
          },
          renderer: {
            primary: "react_static_v2",
            fallback: "trusted_static_html_v1",
            componentLibraryVersion: version,
            materializerVersion: version,
          },
        });
      } else if (version === "2.6.0") {
        expect(runtime).toMatchObject({
          adapterVersion: version,
          aiTask: {
            taskCount: 1,
            stageCount: 1,
            output: "SiteContentPatchWireV1",
            designOutputAllowed: false,
            sourceOutputAllowed: false,
          },
          contentSystem: {
            buildContract: "BuildContractV4",
            missingContentPolicy: "verified-brief-fallback",
          },
          renderer: {
            primary: "react_static_v2",
            fallback: "trusted_static_html_v1",
            componentLibraryVersion: version,
            materializerVersion: version,
          },
        });
      } else {
        expect(runtime).toMatchObject({
          adapterVersion: version,
          aiTask: { phaseTwoOutput: "PageContentWireV3" },
          contentSystem: { buildContract: "BuildContractV4" },
          renderer: {
            kind: "react_static_v2",
            componentLibraryVersion: version,
            materializerVersion: version,
          },
        });
      }
    }
  }, 120_000);
});
