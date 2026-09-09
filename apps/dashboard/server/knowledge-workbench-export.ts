import { Readable } from "node:stream";
import { getDb } from "./db";
import { KnowledgeBaseMaterializedError } from "./knowledge-base-materialized-service";
import {
  knowledgeWorkbenchCoordinates,
  loadKnowledgeWorkbenchSnapshot,
  assertKnowledgeWorkbenchCoordinates,
  readKnowledgeWorkbenchNodes,
  validateKnowledgeWorkbenchNodes,
} from "./knowledge-workbench-service";
import {
  knowledgeWorkbenchRecord,
  knowledgeWorkbenchStage,
} from "./knowledge-workbench-stage";
import { readValidatedActiveKnowledgeBaseWorkingSet } from "./knowledge-base-materialized-assets";
import { streamKnowledgeBaseLocalSource } from "./knowledge-base-local-source-store";

type ZipEntry = { name: string; content: () => AsyncIterable<Buffer> };
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** Store-mode ZIP with backpressure. Only the small central directory is retained. */
export async function* streamKnowledgeWorkspaceZip(entries: ZipEntry[]) {
  let offset = 0;
  const central: Buffer[] = [];
  for (const entry of entries) {
    if (
      !entry.name ||
      entry.name.startsWith("/") ||
      entry.name.includes("\\") ||
      entry.name
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid ZIP path");
    const name = Buffer.from(entry.name, "utf8"),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x808, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt16LE(name.length, 26);
    const start = offset;
    yield header;
    yield name;
    offset += header.length + name.length;
    let crc = 0xffffffff,
      size = 0;
    for await (const chunk of entry.content()) {
      for (const byte of chunk)
        crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      size += chunk.length;
      offset += chunk.length;
      if (size > 0xffffffff || offset > 0xffffffff)
        throw new Error("Workspace exceeds ZIP size limit");
      yield chunk;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    offset += 16;
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x808, 8);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(size, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(start, 42);
    central.push(Buffer.concat([record, name]));
  }
  const start = offset;
  for (const record of central) {
    yield record;
    offset += record.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - start, 12);
  end.writeUInt32LE(start, 16);
  yield end;
}
const textEntry = (name: string, value: string | Buffer): ZipEntry => ({
  name,
  content: async function* () {
    yield Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  },
});
const safeName = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[\\/\u0000-\u001f\u007f:]/gu, "_")
    .replace(/^\.+/u, "_")
    .slice(0, 180) || "attachment";

export function knowledgeOriginalAttachments(
  start: { metadata: unknown } | null,
) {
  const metadata = knowledgeWorkbenchRecord(start?.metadata);
  const ledger = knowledgeWorkbenchRecord(
    knowledgeWorkbenchRecord(metadata.knowledgeWorkbench)
      .originalAttachmentManifest,
  );
  if (ledger.schemaVersion !== 1)
    return {
      status: "legacy_manifest_unavailable" as const,
      entries: [] as Record<string, any>[],
      expectedCount: null,
    };
  const entries = Array.isArray(ledger.entries)
    ? ledger.entries.map(knowledgeWorkbenchRecord)
    : [];
  const complete =
    ledger.status === "complete" &&
    Number.isSafeInteger(ledger.expectedCount) &&
    ledger.expectedCount === entries.length &&
    entries.every(
      (item, index) =>
        item.index === index &&
        typeof item.filename === "string" &&
        typeof item.storageKey === "string" &&
        /^knowledge-base\/permanent-originals\//u.test(item.storageKey) &&
        /^[a-f0-9]{64}$/u.test(item.contentSha256) &&
        Number.isSafeInteger(item.sizeBytes) &&
        item.sizeBytes > 0,
    );
  return {
    status: complete ? ("complete" as const) : ("incomplete" as const),
    entries: complete ? entries : [],
    expectedCount: ledger.expectedCount,
  };
}

export async function exportKnowledgeBaseWorkspace(
  userId: number,
  value: unknown,
  executor?: NonNullable<Awaited<ReturnType<typeof getDb>>>,
) {
  const input = knowledgeWorkbenchCoordinates.parse(value);
  const db = executor ?? (await getDb());
  if (!db)
    throw new KnowledgeBaseMaterializedError(
      "DATABASE_UNAVAILABLE",
      "数据库暂不可用",
    );
  const snapshot = await db.transaction(
    async (tx: any) => {
      const { build, start } = await loadKnowledgeWorkbenchSnapshot(
        tx,
        userId,
        input,
      );
      assertKnowledgeWorkbenchCoordinates(build, input);
      const nodes = await readKnowledgeWorkbenchNodes(tx, build);
      const active = await readValidatedActiveKnowledgeBaseWorkingSet({
        db: tx,
        build,
      });
      validateKnowledgeWorkbenchNodes(
        build,
        nodes.nodes,
        active.validated.manifest,
      );
      return {
        build,
        start,
        ...nodes,
        manifest: active.validated.manifest,
        active,
      };
    },
    { isolationLevel: "repeatable read" },
  );
  const originals = knowledgeOriginalAttachments(snapshot.start);
  if (originals.status === "incomplete")
    throw new KnowledgeBaseMaterializedError(
      "INVALID_BUILD_STATE",
      "启动原件尚未完整保存，请稍后重试",
    );
  const originalPrefix = `knowledge-base/permanent-originals/${userId}/${snapshot.build.id.toLowerCase()}/g${snapshot.build.generation}/`;
  for (const original of originals.entries) {
    if (
      original.storageKey !== `${originalPrefix}${original.contentSha256}.bin`
    )
      throw new KnowledgeBaseMaterializedError(
        "INVALID_BUILD_STATE",
        "启动原件归属校验失败，请重新读取",
      );
    try {
      // Fail before sending headers when a promised original is missing. The
      // second streaming pass remains bounded and detects concurrent corruption.
      for await (const _chunk of streamKnowledgeBaseLocalSource({
        storageKey: original.storageKey,
        contentSha256: original.contentSha256,
        sizeBytes: original.sizeBytes,
      })) {
        /* integrity preflight */
      }
    } catch {
      throw new KnowledgeBaseMaterializedError(
        "INVALID_BUILD_STATE",
        "启动原件暂不可读取，工作稿未导出，请重试",
      );
    }
  }
  const entries: ZipEntry[] = [];
  const documents = snapshot.nodes.map((node, index) => ({
    leafId: node.leafId,
    title: node.title,
    status: node.status,
    path: `nodes/${String(index + 1).padStart(4, "0")}.md`,
    sha256: node.contentSha256,
  }));
  const originalFiles = originals.entries.map((item, index) => ({
    name: item.filename,
    path: `originals/${String(index + 1).padStart(3, "0")}-${safeName(item.filename)}`,
    sha256: item.contentSha256,
    sizeBytes: item.sizeBytes,
  }));
  entries.push(
    textEntry(
      "README.md",
      `# ${snapshot.build.companyName} 知识库工作稿\n\n本包为当前工作稿，导出不确认节点，也不更新已发布知识库。\n\n原始附件：${originals.status === "complete" ? `${originalFiles.length} 件（启动时的完整清单）` : "旧任务没有可验证的原件清单；本包不声明包含全部原件"}。\n\n包含 manifest.json、知识树、节点正文及关联资源。\n`,
    ),
  );
  entries.push(
    textEntry(
      "manifest.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "frontmind.knowledge-workspace",
          buildId: snapshot.build.id,
          generation: snapshot.build.generation,
          revision: snapshot.build.revision,
          contentVersion: snapshot.build.contentVersion,
          workingSetSha256: snapshot.workingSet.packageSha256,
          nodesSha256: snapshot.nodesSha256,
          phase: knowledgeWorkbenchStage(snapshot.build, snapshot.start).phase,
          originalAttachments: {
            status: originals.status,
            expectedCount: originals.expectedCount,
            files: originalFiles,
          },
          documents,
          resources: [
            ...snapshot.manifest.assets.map((asset) => ({
              path: `resources/${asset.path}`,
              sha256: asset.sha256,
              sizeBytes: asset.bytes,
            })),
            ...snapshot.manifest.evidenceLedger.map((evidence) => ({
              path: `resources/${evidence.path}`,
              sha256: evidence.sha256,
            })),
          ],
        },
        null,
        2,
      ),
    ),
  );
  entries.push(
    textEntry(
      "knowledge-tree.md",
      snapshot.nodes
        .map((node) => `- ${node.branchTitle} / ${node.title}`)
        .join("\n"),
    ),
  );
  for (let index = 0; index < snapshot.nodes.length; index++)
    entries.push(
      textEntry(documents[index].path, snapshot.nodes[index].contentMarkdown!),
    );
  for (let index = 0; index < originals.entries.length; index++) {
    const item = originals.entries[index];
    entries.push({
      name: originalFiles[index].path,
      content: () =>
        streamKnowledgeBaseLocalSource({
          storageKey: item.storageKey,
          contentSha256: item.contentSha256,
          sizeBytes: item.sizeBytes,
        }),
    });
  }
  const resources = new Set([
    ...snapshot.manifest.assets.map((asset) => asset.path),
    ...snapshot.manifest.evidenceLedger.map((evidence) => evidence.path),
  ]);
  for (const resource of resources) {
    const bytes = snapshot.active.validated.files.get(resource);
    if (!bytes)
      throw new KnowledgeBaseMaterializedError(
        "INVALID_BUILD_STATE",
        "关联资料缺失，工作稿未导出",
      );
    entries.push(textEntry(`resources/${resource}`, bytes));
  }
  return {
    filename: `knowledge-workspace-g${snapshot.build.generation}-v${snapshot.build.contentVersion}.zip`,
    stream: Readable.from(streamKnowledgeWorkspaceZip(entries)),
  };
}
