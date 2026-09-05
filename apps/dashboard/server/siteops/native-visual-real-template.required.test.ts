import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { prepareNativeTemplateCandidate } from "./native-visual-source";

const FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/sanitized-vite-landing/", import.meta.url),
);
const ZIP_ROOT = "sanitized-vite-landing";
const FIXED_ZIP_DATE = new Date("2026-01-01T00:00:00.000Z");

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixtureFiles(
  directory = FIXTURE_ROOT,
  prefix = "",
): Promise<Array<{ path: string; bytes: Buffer }>> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await fixtureFiles(absolute, relative)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Fixture entry must be a regular file: ${relative}`);
    }
    files.push({ path: relative, bytes: await readFile(absolute) });
  }
  return files;
}

async function realTemplateZip() {
  const zip = new JSZip();
  const files = await fixtureFiles();
  for (const file of files) {
    zip.file(`${ZIP_ROOT}/${file.path}`, file.bytes, {
      createFolders: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  return { archive, files };
}

describe("required sanitized real Vite Template preparation", () => {
  it("validates, builds, renders, and freezes the untouched provider ZIP", async () => {
    const { archive, files: fixture } = await realTemplateZip();
    const fixturePaths = fixture.map((file) => file.path);
    expect(fixturePaths).toEqual(
      expect.arrayContaining([
        "package.json",
        "index.html",
        "vite.config.ts",
        "tsconfig.json",
        "src/main.tsx",
        "src/App.tsx",
        "src/App.css",
        "src/index.css",
        "src/components/Header.tsx",
        "src/components/Hero.tsx",
        "src/components/FeatureGrid.tsx",
        "src/components/Footer.tsx",
        "src/assets/product-preview.svg",
        "src/assets/dot-grid.svg",
        "public/brand-mark.svg",
      ]),
    );

    const providerZip = await JSZip.loadAsync(archive, { checkCRC32: true });
    expect(providerZip.file(`${ZIP_ROOT}/src/main.tsx`)).not.toBeNull();
    expect(
      providerZip.file(`${ZIP_ROOT}/src/components/Hero.tsx`),
    ).not.toBeNull();

    const marketplacePreview = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 31, g: 41, b: 55 },
      },
    })
      .png()
      .toBuffer();
    let previewFetches = 0;
    let unexpectedRemoteFetches = 0;
    const prepared = await prepareNativeTemplateCandidate({
      templateId: "sanitized-real-vite-landing",
      slug: "sanitized-real-vite-landing",
      version: "fixture-v1",
      archive,
      expectedArchiveSha256: sha256(archive),
      previewUrl: "https://cdn.21st.dev/templates/sanitized-preview.png",
      signal: AbortSignal.timeout(120_000),
      fetchRemoteAsset: async ({ url }) => {
        previewFetches += 1;
        expect(url).toBe(
          "https://cdn.21st.dev/templates/sanitized-preview.png",
        );
        return {
          finalUrl: url,
          mimeType: "image/png" as const,
          buffer: marketplacePreview,
          width: 1200,
          height: 800,
          sha256: sha256(marketplacePreview),
          visualSignals: {
            dominantHex: "#1f2937",
            brightness: 40,
            contrast: 0,
          },
        };
      },
      fetchRemoteStyleAsset: async () => {
        unexpectedRemoteFetches += 1;
        throw new Error("The sanitized fixture must not fetch remote styles");
      },
    });

    expect(previewFetches).toBe(0);
    expect(unexpectedRemoteFetches).toBe(0);
    expect(prepared).toMatchObject({
      templateId: "sanitized-real-vite-landing",
      templateSlug: "sanitized-real-vite-landing",
      sourceFormat: "provider_archive_v1",
      framework: "vite_react",
      entrypoint: "src/main.tsx",
      demoEntrypoint: "src/main.tsx",
      sourceDirectory: "source",
    });
    expect(prepared.sourceArchiveSha256).toBe(sha256(prepared.sourceArchive));
    expect(prepared.previewSha256).toBe(sha256(prepared.preview));

    const screenshot = await sharp(prepared.preview).metadata();
    expect(screenshot).toMatchObject({
      format: "png",
      width: 1440,
      height: 1000,
    });

    const frozen = await JSZip.loadAsync(prepared.sourceArchive, {
      checkCRC32: true,
    });
    expect(Object.keys(frozen.files).sort()).toEqual([
      "frontmind-provider-template-source-v1.json",
      "provider-source.zip",
    ]);
    const manifest = JSON.parse(
      await frozen
        .file("frontmind-provider-template-source-v1.json")!
        .async("string"),
    );
    expect(manifest).toMatchObject({
      sourceFormat: "provider_archive_v1",
      providerTemplateId: "sanitized-real-vite-landing",
      providerSlug: "sanitized-real-vite-landing",
      providerVersion: "fixture-v1",
      entrypoint: "src/main.tsx",
      sourceTreeSha256: prepared.sourceTreeSha256,
    });
    const restoredProviderArchive = await frozen
      .file("provider-source.zip")!
      .async("nodebuffer");
    expect(restoredProviderArchive.equals(archive)).toBe(true);
  }, 150_000);
});
