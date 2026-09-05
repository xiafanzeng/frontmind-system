import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

export type ResetPollutionUploadProof = {
  intentCount: number;
  stateSha256: string;
  retired: boolean;
  items: Array<{
    intentIdSha256: string;
    operationIdSha256: string;
    credentialIdSha256: string;
    ordinal: number;
    total: number;
    state: string;
    providerGeneration: 0 | 1;
    safeErrorCode: string | null;
    fileIdSha256: string | null;
    sizeBytes: number | null;
    sha256: string | null;
  }>;
};

type ProvenIntent = {
  directory: string;
  operationIndex: string;
  intentId: string;
  state: JsonRecord;
};

type InternalProof = ResetPollutionUploadProof & {
  intents: ProvenIntent[];
  resumeIndex: string;
  retired: boolean;
};

function assetRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function storageKey(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function intentRoot() {
  return path.join(assetRoot(), "managed-upload-intents");
}

function operationIndexPath(input: {
  userId: number;
  projectAssignmentId: string | null;
  operationId: string;
}) {
  const key = storageKey(
    JSON.stringify([
      input.userId,
      input.projectAssignmentId,
      input.operationId,
    ]),
  );
  return path.join(intentRoot(), "by-operation", `${key}.json`);
}

function resumeIndexPath(input: {
  userId: number;
  projectAssignmentId: string | null;
  conversationId: string;
  turnId: string;
}) {
  const key = storageKey(
    JSON.stringify([
      input.userId,
      input.projectAssignmentId,
      "knowledge_base",
      input.conversationId,
      input.turnId,
    ]),
  );
  return path.join(intentRoot(), "by-resume-scope", `${key}.json`);
}

async function readJson(target: string) {
  return JSON.parse(await fs.readFile(target, "utf8")) as JsonRecord;
}

async function syncDirectory(target: string) {
  const directory = await fs.open(target, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeJsonAtomic(target: string, value: unknown) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function safeIdentifier(value: unknown, max: number) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= max &&
    !/[\0\r\n]/u.test(value)
  );
}

function safeManifestState(value: JsonRecord) {
  const scope = value.resumeScope as JsonRecord;
  const provider = Array.isArray(value.provider)
    ? (value.provider[0] as JsonRecord | undefined)
    : undefined;
  const receipt = value.receipt as JsonRecord | null;
  return {
    intentIdSha256: storageKey(String(value.intentId)),
    operationIdSha256: storageKey(String(value.operationId)),
    requestHash: value.requestHash,
    batchIdSha256: storageKey(String(value.batchId)),
    ordinal: value.ordinal,
    total: value.total,
    revision: value.revision,
    state: value.state,
    phase: value.phase,
    declaredSizeBytes: value.declaredSizeBytes,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
    clientRequestIdSha256: storageKey(String(scope.clientRequestId)),
    credentialIdSha256: storageKey(String(value.credentialId)),
    filenameSha256: storageKey(String(value.filename)),
    providerGeneration: value.providerGeneration,
    safeErrorCode: value.safeErrorCode,
    fileIdSha256:
      typeof receipt?.fileId === "string" ? storageKey(receipt.fileId) : null,
    providerState: provider?.state ?? null,
    providerOwnershipRecorded: provider?.ownershipRecorded ?? null,
    providerStatus: provider?.providerStatus ?? null,
    providerPutResponse2xx: provider?.putResponse2xx ?? null,
    providerPutReplayed: provider?.putReplayed ?? null,
    receiptUploadedAt: receipt?.uploadedAt ?? null,
    receiptProviderReadyAt: receipt?.providerReadyAt ?? null,
    receiptExpiresAt: receipt?.expiresAt ?? null,
    receiptReplayed: receipt?.replayed ?? null,
    receiptRecreated: receipt?.recreated ?? null,
    createdAt: value.createdAt,
    sealedAt: value.sealedAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
  };
}

function timestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isStrictZeroProviderBrowserFailure(manifest: JsonRecord) {
  const exactStateAndError =
    (manifest.state === "awaiting_browser" &&
      manifest.safeErrorCode === "UPLOAD_BROWSER_BODY_INCOMPLETE") ||
    (manifest.state === "expired" &&
      manifest.safeErrorCode === "UPLOAD_BROWSER_STAGE_EXPIRED");
  return (
    exactStateAndError &&
    manifest.phase === null &&
    manifest.providerGeneration === 0 &&
    Array.isArray(manifest.provider) &&
    manifest.provider.length === 0 &&
    manifest.receipt === null &&
    manifest.sizeBytes === null &&
    manifest.sha256 === null &&
    manifest.sealedAt === null &&
    manifest.completedAt === null
  );
}

function isStrictUploadedGenerationOne(manifest: JsonRecord) {
  const provider = Array.isArray(manifest.provider)
    ? (manifest.provider[0] as JsonRecord | undefined)
    : undefined;
  const receipt = manifest.receipt as JsonRecord | null;
  return Boolean(
    manifest.state === "uploaded" &&
      manifest.phase === null &&
      manifest.providerGeneration === 1 &&
      Array.isArray(manifest.provider) &&
      manifest.provider.length === 1 &&
      provider?.generation === 1 &&
      provider.state === "uploaded" &&
      provider.ownershipRecorded === true &&
      safeIdentifier(provider.fileId, 255) &&
      provider.filename === manifest.filename &&
      provider.providerStatus === "uploaded" &&
      provider.putResponse2xx === true &&
      typeof provider.putReplayed === "boolean" &&
      timestamp(provider.updatedAt) &&
      receipt &&
      receipt.fileId === provider.fileId &&
      receipt.sizeBytes === manifest.sizeBytes &&
      Number.isSafeInteger(receipt.sizeBytes) &&
      Number(receipt.sizeBytes) > 0 &&
      Number.isFinite(receipt.uploadedAt) &&
      Number.isFinite(receipt.providerReadyAt) &&
      Number.isFinite(receipt.expiresAt) &&
      Number(receipt.expiresAt) > Number(receipt.uploadedAt) &&
      typeof receipt.replayed === "boolean" &&
      typeof receipt.recreated === "boolean" &&
      manifest.sizeBytes === manifest.declaredSizeBytes &&
      typeof manifest.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(manifest.sha256) &&
      timestamp(manifest.sealedAt) &&
      timestamp(manifest.completedAt) &&
      manifest.safeErrorCode === null,
  );
}

function proofItem(
  state: JsonRecord,
): ResetPollutionUploadProof["items"][number] {
  return {
    intentIdSha256: String(state.intentIdSha256),
    operationIdSha256: String(state.operationIdSha256),
    credentialIdSha256: String(state.credentialIdSha256),
    ordinal: Number(state.ordinal),
    total: Number(state.total),
    state: String(state.state),
    providerGeneration: Number(state.providerGeneration) as 0 | 1,
    safeErrorCode:
      typeof state.safeErrorCode === "string" ? state.safeErrorCode : null,
    fileIdSha256:
      typeof state.fileIdSha256 === "string" ? state.fileIdSha256 : null,
    sizeBytes: state.sizeBytes === null ? null : Number(state.sizeBytes),
    sha256: typeof state.sha256 === "string" ? state.sha256 : null,
  };
}

async function inspectInternal(input: {
  userId: number;
  projectAssignmentId: string | null;
  conversationId: string;
  turnId: string;
  clientRequestId: string;
}): Promise<InternalProof> {
  const root = intentRoot();
  const resumeIndex = resumeIndexPath(input);
  const indexed = await readJson(resumeIndex).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  let retiredLedger: ResetPollutionUploadProof | null = null;
  if (indexed?.state === "retired") {
    const items = Array.isArray(indexed.items) ? indexed.items : null;
    if (
      indexed.schemaVersion !== 1 ||
      indexed.state !== "retired" ||
      !Array.isArray(indexed.intentIds) ||
      indexed.intentIds.length !== 0 ||
      !timestamp(indexed.retiredAt) ||
      Object.keys(indexed).sort().join("\0") !==
        [
          "intentIds",
          "items",
          "retiredAt",
          "retiredCount",
          "schemaVersion",
          "state",
          "stateSha256",
        ].join("\0") ||
      !Number.isSafeInteger(indexed.retiredCount) ||
      Number(indexed.retiredCount) < 0 ||
      typeof indexed.stateSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(indexed.stateSha256) ||
      !items ||
      items.length !== Number(indexed.retiredCount) ||
      items.some((item) => {
        const value = item as JsonRecord;
        return (
          typeof value.intentIdSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value.intentIdSha256) ||
          typeof value.operationIdSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value.operationIdSha256) ||
          typeof value.credentialIdSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value.credentialIdSha256) ||
          !Number.isSafeInteger(value.ordinal) ||
          !Number.isSafeInteger(value.total) ||
          !["awaiting_browser", "expired", "uploaded"].includes(
            String(value.state),
          ) ||
          ![0, 1].includes(Number(value.providerGeneration)) ||
          !(
            (value.state === "uploaded" &&
              value.providerGeneration === 1 &&
              value.safeErrorCode === null &&
              typeof value.fileIdSha256 === "string" &&
              /^[a-f0-9]{64}$/u.test(value.fileIdSha256) &&
              Number.isSafeInteger(value.sizeBytes) &&
              Number(value.sizeBytes) > 0 &&
              typeof value.sha256 === "string" &&
              /^[a-f0-9]{64}$/u.test(value.sha256)) ||
            (["awaiting_browser", "expired"].includes(String(value.state)) &&
              value.providerGeneration === 0 &&
              ((value.state === "awaiting_browser" &&
                value.safeErrorCode === "UPLOAD_BROWSER_BODY_INCOMPLETE") ||
                (value.state === "expired" &&
                  value.safeErrorCode === "UPLOAD_BROWSER_STAGE_EXPIRED")) &&
              value.fileIdSha256 === null &&
              value.sizeBytes === null &&
              value.sha256 === null)
          )
        );
      })
    ) {
      throw new Error("KB_RESET_POLLUTION_UPLOAD_SCOPE_INDEX_INVALID");
    }
    retiredLedger = {
      intentCount: Number(indexed.retiredCount),
      stateSha256: indexed.stateSha256,
      items: items as ResetPollutionUploadProof["items"],
      retired: true,
    };
  }
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  const intents: ProvenIntent[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      ["by-operation", "by-resume-scope", "deletion-fences"].includes(
        entry.name,
      )
    ) {
      continue;
    }
    const directory = path.join(root, entry.name);
    const manifest = await readJson(path.join(directory, "manifest.json"));
    const scope = manifest.resumeScope as JsonRecord | undefined;
    if (
      scope?.kind !== "knowledge_base" ||
      scope.conversationId !== input.conversationId ||
      scope.turnId !== input.turnId
    ) {
      continue;
    }
    if (
      manifest.schemaVersion !== 2 ||
      manifest.userId !== input.userId ||
      (manifest.projectAssignmentId ?? null) !== input.projectAssignmentId ||
      scope.clientRequestId !== input.clientRequestId ||
      !safeIdentifier(manifest.intentId, 255) ||
      !safeIdentifier(manifest.operationId, 255) ||
      !safeIdentifier(manifest.requestHash, 64) ||
      !safeIdentifier(manifest.credentialId, 36) ||
      !safeIdentifier(manifest.filename, 512) ||
      !(
        isStrictZeroProviderBrowserFailure(manifest) ||
        isStrictUploadedGenerationOne(manifest)
      ) ||
      manifest.leaseOwner !== null ||
      manifest.leaseExpiresAt !== null ||
      manifest.deletedAt !== null ||
      entry.name !== storageKey(String(manifest.intentId))
    ) {
      throw new Error("KB_RESET_POLLUTION_UPLOAD_NOT_NEVER_SENT");
    }
    const operationIndex = operationIndexPath({
      userId: input.userId,
      projectAssignmentId: input.projectAssignmentId,
      operationId: String(manifest.operationId),
    });
    const index = await readJson(operationIndex);
    const activeIndex =
      index.schemaVersion === 1 &&
      index.intentId === manifest.intentId &&
      index.requestHash === manifest.requestHash &&
      index.state === undefined &&
      Object.keys(index).sort().join("\0") ===
        ["intentId", "requestHash", "schemaVersion"].join("\0");
    const retiredIndex =
      index.schemaVersion === 1 &&
      index.state === "retired" &&
      timestamp(index.retiredAt) &&
      Object.keys(index).sort().join("\0") ===
        ["retiredAt", "schemaVersion", "state"].join("\0");
    if ((!activeIndex && !retiredIndex) || (retiredLedger && !retiredIndex)) {
      throw new Error("KB_RESET_POLLUTION_UPLOAD_INDEX_INVALID");
    }
    intents.push({
      directory,
      operationIndex,
      intentId: String(manifest.intentId),
      state: safeManifestState(manifest),
    });
  }
  intents.sort(
    (left, right) => Number(left.state.ordinal) - Number(right.state.ordinal),
  );
  const indexedIds = Array.isArray(indexed?.intentIds) ? indexed.intentIds : [];
  const provenIds = intents.map((intent) => intent.intentId);
  const provenItems = intents.map((intent) => proofItem(intent.state));
  if (retiredLedger) {
    if (
      provenItems.some(
        (item) =>
          !retiredLedger.items.some(
            (expected) => JSON.stringify(expected) === JSON.stringify(item),
          ),
      ) ||
      (intents.length === retiredLedger.intentCount &&
        createHash("sha256")
          .update(JSON.stringify(intents.map((intent) => intent.state)), "utf8")
          .digest("hex") !== retiredLedger.stateSha256)
    ) {
      throw new Error("KB_RESET_POLLUTION_UPLOAD_SCOPE_INDEX_INVALID");
    }
    return {
      ...retiredLedger,
      intents,
      resumeIndex,
    };
  }
  const activeResumeIndex =
    indexed !== null &&
    indexed.schemaVersion === 1 &&
    indexed.state === undefined &&
    Array.isArray(indexed.intentIds) &&
    timestamp(indexed.updatedAt) &&
    Object.keys(indexed).sort().join("\0") ===
      ["intentIds", "schemaVersion", "updatedAt"].join("\0");
  if (
    !activeResumeIndex ||
    (indexed &&
      JSON.stringify([...indexedIds].sort()) !==
        JSON.stringify([...provenIds].sort()))
  ) {
    throw new Error("KB_RESET_POLLUTION_UPLOAD_SCOPE_INDEX_INVALID");
  }
  const stateSha256 = createHash("sha256")
    .update(JSON.stringify(intents.map((intent) => intent.state)), "utf8")
    .digest("hex");
  return {
    intentCount: intents.length,
    stateSha256,
    retired: false,
    items: provenItems,
    intents,
    resumeIndex,
  };
}

export async function inspectResetPollutionUploadIntents(input: {
  userId: number;
  projectAssignmentId: string | null;
  conversationId: string;
  turnId: string;
  clientRequestId: string;
}): Promise<ResetPollutionUploadProof> {
  const proof = await inspectInternal(input);
  return {
    intentCount: proof.intentCount,
    stateSha256: proof.stateSha256,
    retired: proof.retired,
    items: proof.items,
  };
}

export async function retireResetPollutionUploadIntents(input: {
  userId: number;
  projectAssignmentId: string | null;
  conversationId: string;
  turnId: string;
  clientRequestId: string;
  expectedStateSha256: string;
}) {
  const proof = await inspectInternal(input);
  if (proof.stateSha256 !== input.expectedStateSha256) {
    throw new Error("KB_RESET_POLLUTION_UPLOAD_STATE_CHANGED");
  }
  if (proof.retired) {
    for (const intent of proof.intents) {
      await fs.rm(intent.directory, { recursive: true, force: true });
    }
    if (proof.intents.length) await syncDirectory(intentRoot());
    return { retiredCount: proof.intentCount };
  }
  const retiredAt = new Date().toISOString();
  // The owning application is stopped for this one-shot maintenance command.
  // Retired indexes are written before bytes disappear, so a crash can never
  // make an old browser reservation executable again.
  for (const intent of proof.intents) {
    await writeJsonAtomic(intent.operationIndex, {
      schemaVersion: 1,
      state: "retired",
      retiredAt,
    });
  }
  await writeJsonAtomic(proof.resumeIndex, {
    schemaVersion: 1,
    state: "retired",
    intentIds: [],
    retiredCount: proof.intentCount,
    stateSha256: proof.stateSha256,
    items: proof.items,
    retiredAt,
  });
  for (const intent of proof.intents) {
    await fs.rm(intent.directory, { recursive: true, force: true });
  }
  if (proof.intents.length) await syncDirectory(intentRoot());
  return { retiredCount: proof.intentCount };
}

const BUILD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ResetPollutionRetainedSourcesInput = {
  userId: number;
  buildId: string;
  generation: number;
  sources: Array<{
    localStorageKey: string;
    contentSha256: string;
    sizeBytes: number;
  }>;
};

async function validateResetPollutionRetainedSources(
  input: ResetPollutionRetainedSourcesInput,
  remove: boolean,
) {
  if (
    !Number.isSafeInteger(input.userId) ||
    input.userId < 1 ||
    !BUILD_ID.test(input.buildId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1
  ) {
    throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_COORDINATE_INVALID");
  }
  const root = assetRoot();
  const unique = new Map(
    input.sources.map((source) => [source.localStorageKey, source]),
  );
  const expectedGenerationRoot = [
    "knowledge-base",
    "build-sources",
    String(input.userId),
    input.buildId.toLowerCase(),
    `g${input.generation}`,
  ].join("/");
  for (const source of unique.values()) {
    const expectedKey = [
      "knowledge-base",
      "build-sources",
      String(input.userId),
      input.buildId.toLowerCase(),
      `g${input.generation}`,
      `${source.contentSha256}.bin`,
    ].join("/");
    if (
      source.localStorageKey !== expectedKey ||
      !/^[a-f0-9]{64}$/u.test(source.contentSha256) ||
      !Number.isSafeInteger(source.sizeBytes) ||
      source.sizeBytes < 1
    ) {
      throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_SCOPE_INVALID");
    }
    const target = path.resolve(root, ...expectedKey.split("/"));
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_SCOPE_INVALID");
    }
    let current = root;
    let missing = false;
    for (const segment of expectedKey.split("/")) {
      current = path.join(current, segment);
      const metadata = await fs.lstat(current).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!metadata) {
        missing = true;
        break;
      }
      if (metadata.isSymbolicLink()) {
        throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_SCOPE_INVALID");
      }
    }
    if (missing) {
      if (remove) continue;
      throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_MISSING");
    }
    const bytes = await fs.readFile(target);
    if (
      bytes.length !== source.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== source.contentSha256
    ) {
      throw new Error("KB_RESET_POLLUTION_LOCAL_SOURCE_INTEGRITY_MISMATCH");
    }
    if (remove) await fs.rm(target, { force: true });
  }
  if (!remove) return { verifiedCount: unique.size };
  const generationDirectory = path.resolve(
    root,
    ...expectedGenerationRoot.split("/"),
  );
  const remaining = await fs.readdir(generationDirectory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  if (remaining.length === 0) {
    await fs.rmdir(generationDirectory).catch((error) => {
      if (
        !["ENOENT", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code || "",
        )
      ) {
        throw error;
      }
    });
  }
  return { removedOrMissingCount: unique.size };
}

export async function inspectResetPollutionRetainedSources(
  input: ResetPollutionRetainedSourcesInput,
) {
  return validateResetPollutionRetainedSources(input, false);
}

export async function removeResetPollutionRetainedSources(
  input: ResetPollutionRetainedSourcesInput,
) {
  return validateResetPollutionRetainedSources(input, true);
}
