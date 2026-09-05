import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const ARCHIVE_DATE = new Date("1980-01-01T00:00:00.000Z");

type ArchiveFile = {
  path: string;
  content: Buffer | string;
};

function assertSafeArchivePath(relativePath: string) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsafe task attachment path: ${relativePath}`);
  }
  return normalized;
}

export async function buildDeterministicTaskAttachmentArchive(input: {
  name: string;
  entrypoint: string;
  files: readonly ArchiveFile[];
  metadata?: Record<string, unknown>;
}) {
  const files = input.files
    .map((file) => ({
      path: assertSafeArchivePath(file.path),
      content: Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(file.content, "utf8"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (!files.some((file) => file.path === input.entrypoint)) {
    throw new Error(
      `Task attachment ${input.name} is missing ${input.entrypoint}`,
    );
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error(`Task attachment ${input.name} contains duplicate paths`);
  }

  const fileManifest = files.map((file) => ({
    path: file.path,
    bytes: file.content.byteLength,
    sha256: createHash("sha256").update(file.content).digest("hex"),
  }));
  const contentHash = createHash("sha256")
    .update(JSON.stringify(fileManifest))
    .digest("hex");
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content, {
      date: ARCHIVE_DATE,
      unixPermissions: 0o100644,
      createFolders: false,
    });
  }
  zip.file(
    "MANIFEST.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: input.name,
        entrypoint: input.entrypoint,
        contentHash,
        files: fileManifest,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      null,
      2,
    )}\n`,
    {
      date: ARCHIVE_DATE,
      unixPermissions: 0o100644,
      createFolders: false,
    },
  );
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  return { bytes, contentHash };
}

export async function buildDirectorySkillArchive(input: {
  name: string;
  version: string;
  directoryCandidates: readonly string[];
  files: readonly string[];
}) {
  let lastError: unknown;
  for (const directoryCandidate of input.directoryCandidates) {
    try {
      const directory = await fs.realpath(directoryCandidate);
      const expectedRoot = `${directory}${path.sep}`;
      const files = await Promise.all(
        input.files.map(async (relativePath) => {
          const resolved = path.resolve(directory, relativePath);
          if (!resolved.startsWith(expectedRoot)) {
            throw new Error(`Unsafe Skill path: ${relativePath}`);
          }
          const canonical = await fs.realpath(resolved);
          if (!canonical.startsWith(expectedRoot)) {
            throw new Error(`Unsafe Skill symlink: ${relativePath}`);
          }
          return {
            path: relativePath,
            content: await fs.readFile(canonical),
          };
        }),
      );
      const archive = await buildDeterministicTaskAttachmentArchive({
        name: input.name,
        entrypoint: "SKILL.md",
        files,
        metadata: { version: input.version },
      });
      return { ...archive, version: input.version };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not load Skill ${input.name}`);
}
