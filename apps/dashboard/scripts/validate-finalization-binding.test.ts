import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeFixture(sourceUploadFileId: string) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "frontmind-finalization-binding-"),
  );
  temporaryRoots.push(root);
  const approvedFirst = "# 企业与品牌\n\n经客户确认的首节点正文。";
  const approvedFinal = "# 销售网络与渠道\n\n经客户确认的终节点正文。";
  const logo = Buffer.from("server-bound-logo-bytes");
  const logoHash = sha256(logo);
  const requiredManifest = {
    branchId: "1",
    documentIds: ["1.1"],
    sourceKind: "official_logo_upload",
    ownership: "first_party",
    assetType: "brand_identity",
    displayRole: "badge",
    sourceUploadIndex: 0,
    sourceUploadFileId: "managed-file-logo",
    sourceUploadFilename: "logo.png",
    sourceUploadMimeType: "image/png",
    sourceUploadSizeBytes: logo.length,
    sourceUploadSha256: logoHash,
  };

  const finalization = new JSZip();
  finalization.file("approved_nodes/000_1.1.md", approvedFirst);
  finalization.file("approved_nodes/001_7.5.md", approvedFinal);
  finalization.file("assets/001_official_logo_logo.png", logo);
  finalization.file(
    "FINALIZATION_INPUT.json",
    JSON.stringify({
      kind: "frontmind.knowledge-base.finalization-input",
      schemaVersion: 1,
      operationId: "operation-current",
      turnId: "turn-current",
      requiredPackage: {
        schemaVersion: 4,
        profile: "dashboard-enterprise-v1",
        buildRevision: 51,
      },
      nodes: [
        {
          id: "1.1",
          title: "企业与品牌",
          branchId: "1",
          branchTitle: "企业与品牌",
          order: 0,
          status: "confirmed",
          contentSha256: sha256(approvedFirst),
          approvedContentPath: "approved_nodes/000_1.1.md",
        },
        {
          id: "7.5",
          title: "销售网络与渠道",
          branchId: "7",
          branchTitle: "合作、交付与支持",
          order: 1,
          status: "confirmed",
          contentSha256: sha256(approvedFinal),
          approvedContentPath: "approved_nodes/001_7.5.md",
        },
      ],
      assets: [
        {
          kind: "official_logo",
          input: {
            path: "assets/001_official_logo_logo.png",
            filename: "logo.png",
            mimeType: "image/png",
            sizeBytes: logo.length,
            sha256: logoHash,
          },
          requiredManifest,
        },
      ],
    }),
  );
  const finalizationPath = path.join(root, "finalization.zip");
  const finalizationBytes = await finalization.generateAsync({
    type: "nodebuffer",
  });
  await fs.writeFile(finalizationPath, finalizationBytes);

  const output = new JSZip();
  output.file(
    "企业/leaf-1.1.md",
    `<!-- FRONTMIND_FORMAL_CONTENT_START -->\n${approvedFirst}\n<!-- FRONTMIND_FORMAL_CONTENT_END -->`,
  );
  output.file(
    "企业/leaf-7.5.md",
    `<!-- FRONTMIND_FORMAL_CONTENT_START -->\n${approvedFinal}\n<!-- FRONTMIND_FORMAL_CONTENT_END -->`,
  );
  output.file("企业/logo.png", logo);
  output.file(
    "企业/00_package_manifest.json",
    JSON.stringify({
      schemaVersion: 4,
      profile: "dashboard-enterprise-v1",
      buildRevision: 51,
      documents: [
        {
          id: "1.1",
          path: "leaf-1.1.md",
          kind: "leaf",
          title: "企业与品牌",
          branchId: "1",
          branchTitle: "企业与品牌",
          order: 0,
        },
        {
          id: "7.5",
          path: "leaf-7.5.md",
          kind: "leaf",
          title: "销售网络与渠道",
          branchId: "7",
          branchTitle: "合作、交付与支持",
          order: 1,
        },
      ],
      assets: [
        {
          id: "asset-logo",
          path: "logo.png",
          sha256: logoHash,
          ...requiredManifest,
          sourceUploadFileId,
        },
      ],
    }),
  );
  const outputPath = path.join(root, "FINAL.zip");
  await fs.writeFile(
    outputPath,
    await output.generateAsync({ type: "nodebuffer" }),
  );
  return {
    finalizationPath,
    finalizationSha256: sha256(finalizationBytes),
    outputPath,
  };
}

function crossValidate(
  outputPath: string,
  finalizationPath: string,
  expectedSha256: string,
  expectedOperationId = "operation-current",
  expectedTurnId = "turn-current",
) {
  const validator = path.resolve(
    process.cwd(),
    "private-workflows/socratic-kb-builder/scripts/validate_archive.py",
  );
  const python = [
    "import importlib.util,json,sys",
    "from pathlib import Path",
    "spec=importlib.util.spec_from_file_location('kb_validator',sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps(module.validate_finalization_binding(Path(sys.argv[2]),Path(sys.argv[3]),sys.argv[4],sys.argv[5],sys.argv[6])))",
  ].join(";");
  const result = spawnSync(
    "python3",
    [
      "-c",
      python,
      validator,
      outputPath,
      finalizationPath,
      expectedSha256,
      expectedOperationId,
      expectedTurnId,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as string[];
}

describe("finalization-input cross binding", () => {
  it("accepts the exact server-authored manifest provenance", async () => {
    const fixture = await writeFixture("managed-file-logo");
    expect(
      crossValidate(
        fixture.outputPath,
        fixture.finalizationPath,
        fixture.finalizationSha256,
      ),
    ).toEqual([]);
  });

  it("rejects a fabricated official Logo sourceUploadFileId", async () => {
    const fixture = await writeFixture("fabricated-provider-file-id");
    expect(
      crossValidate(
        fixture.outputPath,
        fixture.finalizationPath,
        fixture.finalizationSha256,
      ),
    ).toContainEqual(
      expect.stringContaining(
        "sourceUploadFileId must exactly equal FINALIZATION_INPUT.assets[0].requiredManifest.sourceUploadFileId",
      ),
    );
  });

  it("rejects a stale finalization input identity from another turn", async () => {
    const fixture = await writeFixture("managed-file-logo");
    const errors = crossValidate(
      fixture.outputPath,
      fixture.finalizationPath,
      "f".repeat(64),
      "operation-stale",
      "turn-stale",
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SHA-256 does not match"),
        expect.stringContaining("operationId does not match"),
        expect.stringContaining("turnId does not match"),
      ]),
    );
  });

  it("requires all current-turn identity flags on the real CLI", async () => {
    const fixture = await writeFixture("managed-file-logo");
    const validator = path.resolve(
      process.cwd(),
      "private-workflows/socratic-kb-builder/scripts/validate_archive.py",
    );
    const result = spawnSync(
      "python3",
      [
        validator,
        fixture.outputPath,
        "--finalization-input",
        fixture.finalizationPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--finalization-input requires --expected-finalization-sha256",
    );
  });
});
