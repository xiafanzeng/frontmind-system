import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export type ManagedUploadFenceScope =
  | { kind: "user"; userId: number }
  | { kind: "credential"; userId: number; credentialId: string }
  | { kind: "project"; userId: number; projectAssignmentId: string };

export type ManagedUploadDeletionFenceToken = {
  scope: ManagedUploadFenceScope;
  nonce: string;
  /** Present only when permanent account deletion resumes an existing fence. */
  resumed?: true;
};

export class ManagedUploadDeletionFenceError extends Error {
  constructor(
    readonly code:
      | "ACTIVE_INTENT"
      | "DELETION_IN_PROGRESS"
      | "STALE_DELETION_FENCE",
  ) {
    super(code);
    this.name = "ManagedUploadDeletionFenceError";
  }
}

const LOCK_STALE_MS = 2 * 60_000;
const ACCOUNT_RETIREMENT_LOCK_STALE_MS = 15_000;
const FENCE_LEASE_MS = 21 * 60_000;
const FENCE_HEARTBEAT_MS = 30_000;

type ManagedUploadAccountDeletionPhase = "fenced" | "prepared" | "retired";

type ManagedUploadDeletionFenceOptions = {
  disposition?: "require_inactive" | "cancel_active_intents";
  /**
   * Permanent account deletion is resumable by another authenticated system
   * administrator. Other user/credential/project fences keep their existing
   * fail-closed, single-owner behavior.
   */
  purpose?: "account_deletion";
};

function assetRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function intentRoot() {
  return path.join(assetRoot(), "managed-upload-intents");
}

function storageKey(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fenceRoot() {
  return path.join(intentRoot(), "deletion-fences");
}

function scopeCoordinate(scope: ManagedUploadFenceScope) {
  return scope.kind === "user"
    ? [scope.kind, scope.userId]
    : scope.kind === "credential"
      ? // Credential ids are globally unique. The credential owner can be an
        // administrator while the intent actor is a customer using that shared
        // key, so userId must not partition the cryptoshred fence.
        [scope.kind, scope.credentialId]
      : [scope.kind, scope.userId, scope.projectAssignmentId];
}

function scopeKey(scope: ManagedUploadFenceScope) {
  return createHash("sha256")
    .update(JSON.stringify(scopeCoordinate(scope)), "utf8")
    .digest("hex");
}

function fencePath(scope: ManagedUploadFenceScope) {
  return path.join(fenceRoot(), `${scopeKey(scope)}.json`);
}

function lockPath(scope: ManagedUploadFenceScope) {
  return path.join(fenceRoot(), "locks", `${scopeKey(scope)}.lock`);
}

function accountRetirementLockPath(userId: number) {
  return path.join(
    fenceRoot(),
    "account-retirement-locks",
    `${storageKey(String(userId))}.lock`,
  );
}

function intentDeletionAuthorityPath(intentId: string) {
  return path.join(
    fenceRoot(),
    "intent-authority",
    `${storageKey(intentId)}.json`,
  );
}

async function ensurePrivateDirectory(directory: string) {
  const resolved = path.resolve(directory);
  const firstCreated = await fs.mkdir(resolved, {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  if (firstCreated) {
    let created = path.resolve(firstCreated);
    for (;;) {
      await fsyncDirectory(path.dirname(created));
      if (created === resolved) break;
      const next = path.relative(created, resolved).split(path.sep)[0];
      if (!next || next === "..") {
        throw new Error("MANAGED_UPLOAD_DIRECTORY_DURABILITY_INVALID");
      }
      created = path.join(created, next);
    }
  }
}

async function fsyncDirectory(directory: string) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(target: string, value: unknown) {
  await ensurePrivateDirectory(path.dirname(target));
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
    await fsyncDirectory(path.dirname(target));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function acquireFilesystemLock(input: {
  target: string;
  maxAttempts: number;
  staleMs: number;
}) {
  const { target, maxAttempts, staleMs } = input;
  await ensurePrivateDirectory(path.dirname(target));
  const nonce = randomUUID();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const handle = await fs.open(target, "wx", 0o600);
      try {
        await handle.writeFile(`${nonce}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(path.dirname(target));
      let heartbeat = Promise.resolve();
      const timer = setInterval(
        () => {
          heartbeat = heartbeat
            .then(async () => {
              const current = await fs.readFile(target, "utf8").catch(() => "");
              if (current.trim() !== nonce) return;
              const now = new Date();
              await fs.utimes(target, now, now);
            })
            .catch(() => undefined);
        },
        Math.max(1_000, Math.floor(staleMs / 3)),
      );
      timer.unref?.();
      return async () => {
        clearInterval(timer);
        await heartbeat;
        const current = await fs.readFile(target, "utf8").catch(() => "");
        if (current.trim() === nonce) {
          await fs.rm(target, { force: true });
          await fsyncDirectory(path.dirname(target));
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stats = await fs.stat(target).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > staleMs) {
        const quarantine = `${target}.stale.${randomUUID()}`;
        try {
          await fs.rename(target, quarantine);
          const moved = await fs.stat(quarantine);
          if (Date.now() - moved.mtimeMs > staleMs) {
            await fs.rm(quarantine, { force: true });
            await fsyncDirectory(path.dirname(target));
            continue;
          }
          await fs.rename(quarantine, target).catch(async () => {
            await fs.rm(quarantine, { force: true });
          });
        } catch (moveError) {
          if ((moveError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw moveError;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new ManagedUploadDeletionFenceError("DELETION_IN_PROGRESS");
}

async function acquireScopeLock(
  scope: ManagedUploadFenceScope,
  maxAttempts = 80,
) {
  return acquireFilesystemLock({
    target: lockPath(scope),
    maxAttempts,
    staleMs: LOCK_STALE_MS,
  });
}

async function acquireAccountRetirementLock(userId: number) {
  return acquireFilesystemLock({
    target: accountRetirementLockPath(userId),
    // A live retirement keeps this lock fresh. A crashed owner is replaced
    // after at most 15 seconds, rather than inheriting the 21-minute fence
    // lease used by upload workers.
    maxAttempts: 2_400,
    staleMs: ACCOUNT_RETIREMENT_LOCK_STALE_MS,
  });
}

async function readFence(scope: ManagedUploadFenceScope) {
  try {
    const value = JSON.parse(
      await fs.readFile(fencePath(scope), "utf8"),
    ) as Record<string, unknown>;
    const deletingShapeValid =
      value.state !== "deleting" ||
      (typeof value.leaseOwner === "string" &&
        typeof value.leaseExpiresAt === "string" &&
        Number.isFinite(Date.parse(value.leaseExpiresAt)) &&
        typeof value.updatedAt === "string" &&
        Number.isFinite(Date.parse(value.updatedAt)));
    const storedScope = value.scope as ManagedUploadFenceScope | undefined;
    const storedCoordinateValid =
      storedScope !== undefined &&
      JSON.stringify(scopeCoordinate(storedScope)) ===
        JSON.stringify(scopeCoordinate(scope));
    if (
      (value.state !== "deleting" && value.state !== "deleted") ||
      value.scopeKey !== scopeKey(scope) ||
      typeof value.nonce !== "string" ||
      !deletingShapeValid ||
      !storedCoordinateValid
    ) {
      throw new Error("MANAGED_UPLOAD_DELETION_FENCE_INVALID");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function manifestMatchesScope(
  value: Record<string, unknown>,
  scope: ManagedUploadFenceScope,
) {
  if (scope.kind === "credential") {
    return value.credentialId === scope.credentialId;
  }
  if (
    value.userId !== scope.userId &&
    value.credentialOwnerUserId !== scope.userId
  ) {
    return false;
  }
  if (scope.kind === "project") {
    if (value.userId !== scope.userId) return false;
    return value.projectAssignmentId === scope.projectAssignmentId;
  }
  return true;
}

async function hasActiveIntent(scope: ManagedUploadFenceScope) {
  const entries = await fs
    .readdir(intentRoot(), { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === "by-operation" ||
      entry.name === "by-resume-scope" ||
      entry.name === "deletion-fences"
    ) {
      continue;
    }
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(
        await fs.readFile(
          path.join(intentRoot(), entry.name, "manifest.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
    } catch {
      // An unreadable directory cannot be attributed to this user safely. It
      // remains non-executable and is left for orphan cleanup, but must not
      // make every unrelated account impossible to delete.
      continue;
    }
    const leaseIsActive =
      typeof value.leaseOwner === "string" &&
      typeof value.leaseExpiresAt === "string" &&
      Date.parse(value.leaseExpiresAt) > Date.now();
    const expiredHasKnownProvider =
      value.state === "expired" &&
      Array.isArray(value.provider) &&
      value.provider.some((candidate) => {
        if (!candidate || typeof candidate !== "object") return false;
        const generation = candidate as Record<string, unknown>;
        return (
          typeof generation.fileId === "string" &&
          generation.fileId.length > 0 &&
          generation.state !== "discarded"
        );
      });
    if (
      manifestMatchesScope(value, scope) &&
      (leaseIsActive ||
        expiredHasKnownProvider ||
        !["uploaded", "cancelled", "expired"].includes(String(value.state)))
    ) {
      return true;
    }
  }
  return false;
}

export async function assertManagedUploadScopesAvailable(
  scopes: ManagedUploadFenceScope[],
) {
  for (const scope of scopes) {
    if (await readFence(scope)) {
      throw new ManagedUploadDeletionFenceError("DELETION_IN_PROGRESS");
    }
  }
}

/** Holds every scope guard across intent allocation to close create/delete races. */
export async function acquireManagedUploadScopeGuards(
  scopes: ManagedUploadFenceScope[],
) {
  const unique = [
    ...new Map(scopes.map((scope) => [scopeKey(scope), scope])).values(),
  ].sort((left, right) => scopeKey(left).localeCompare(scopeKey(right)));
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const scope of unique) releases.push(await acquireScopeLock(scope));
    await assertManagedUploadScopesAvailable(unique);
    return async () => {
      for (const release of releases.reverse()) await release();
    };
  } catch (error) {
    for (const release of releases.reverse()) await release();
    throw error;
  }
}

export async function acquireManagedUploadDeletionFence(
  scope: ManagedUploadFenceScope,
  options: ManagedUploadDeletionFenceOptions = {},
): Promise<ManagedUploadDeletionFenceToken> {
  // A live create/PUT holds this guard through its durable result CAS. Wait
  // through the provider PUT ceiling so an active upload delays, but never
  // rejects, a system-admin permanent deletion.
  const release = await acquireScopeLock(
    scope,
    options.disposition === "cancel_active_intents" ? 10_000 : 80,
  );
  try {
    const existing = await readFence(scope);
    if (existing) {
      if (
        scope.kind === "user" &&
        options.purpose === "account_deletion" &&
        existing.state === "deleting" &&
        existing.purpose === "account_deletion"
      ) {
        // A permanent-delete retry resumes the exact durable fence. The
        // account-retirement lock serializes local cleanup/provider claims,
        // and the final user-row transaction remains the database CAS.
        return { scope, nonce: String(existing.nonce), resumed: true };
      }
      if (
        existing.state === "deleting" &&
        Date.parse(String(existing.leaseExpiresAt)) <= Date.now()
      ) {
        throw new ManagedUploadDeletionFenceError("STALE_DELETION_FENCE");
      }
      throw new ManagedUploadDeletionFenceError("DELETION_IN_PROGRESS");
    }
    const token = { scope, nonce: randomUUID() };
    const timestamp = new Date();
    await writeAtomic(fencePath(scope), {
      schemaVersion: 1,
      scopeKey: scopeKey(scope),
      state: "deleting",
      nonce: token.nonce,
      scope,
      leaseOwner: token.nonce,
      leaseExpiresAt: new Date(
        timestamp.getTime() + FENCE_LEASE_MS,
      ).toISOString(),
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
      ...(options.purpose === "account_deletion"
        ? {
            purpose: "account_deletion",
            accountDeletionPhase:
              "fenced" satisfies ManagedUploadAccountDeletionPhase,
          }
        : {}),
    });
    if (
      options.disposition !== "cancel_active_intents" &&
      (await hasActiveIntent(scope))
    ) {
      await fs.rm(fencePath(scope), { force: true });
      await fsyncDirectory(fenceRoot());
      throw new ManagedUploadDeletionFenceError("ACTIVE_INTENT");
    }
    return token;
  } finally {
    await release();
  }
}

export async function advanceManagedUploadAccountDeletionFence(
  token: ManagedUploadDeletionFenceToken,
  phase: Exclude<ManagedUploadAccountDeletionPhase, "fenced">,
) {
  if (token.scope.kind !== "user") {
    throw new Error("MANAGED_UPLOAD_ACCOUNT_DELETION_FENCE_INVALID");
  }
  const rank: Record<ManagedUploadAccountDeletionPhase, number> = {
    fenced: 0,
    prepared: 1,
    retired: 2,
  };
  const release = await acquireScopeLock(token.scope);
  try {
    const current = await readFence(token.scope);
    if (
      !current ||
      current.state !== "deleting" ||
      current.nonce !== token.nonce ||
      current.purpose !== "account_deletion"
    ) {
      throw new Error("MANAGED_UPLOAD_ACCOUNT_DELETION_FENCE_TOKEN_INVALID");
    }
    const currentPhase = ["fenced", "prepared", "retired"].includes(
      String(current.accountDeletionPhase),
    )
      ? (current.accountDeletionPhase as ManagedUploadAccountDeletionPhase)
      : "fenced";
    if (rank[currentPhase] >= rank[phase]) return currentPhase;
    await writeAtomic(fencePath(token.scope), {
      ...current,
      accountDeletionPhase: phase,
      updatedAt: new Date().toISOString(),
    });
    return phase;
  } finally {
    await release();
  }
}

function managedUploadIntentDirectory(intentId: string) {
  return path.join(intentRoot(), storageKey(intentId));
}

function operationIndexPath(value: Record<string, unknown>) {
  return path.join(
    intentRoot(),
    "by-operation",
    `${storageKey(
      JSON.stringify([
        value.userId,
        value.projectAssignmentId ?? null,
        value.operationId,
      ]),
    )}.json`,
  );
}

function resumeScopeIndexPath(value: Record<string, unknown>) {
  const resumeScope = value.resumeScope as Record<string, unknown> | null;
  if (
    !resumeScope ||
    resumeScope.kind !== "knowledge_base" ||
    typeof resumeScope.conversationId !== "string" ||
    typeof resumeScope.turnId !== "string"
  ) {
    return null;
  }
  return path.join(
    intentRoot(),
    "by-resume-scope",
    `${storageKey(
      JSON.stringify([
        value.userId,
        value.projectAssignmentId ?? null,
        resumeScope.kind,
        resumeScope.conversationId,
        resumeScope.turnId,
      ]),
    )}.json`,
  );
}

async function retireResumeIndex(
  target: string,
  intentId: string,
  timestamp: string,
) {
  const current = await fs
    .readFile(target, "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  if (!current) return;
  const remaining = Array.isArray(current.intentIds)
    ? current.intentIds.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate !== intentId,
      )
    : [];
  await writeAtomic(target, {
    schemaVersion: 1,
    ...(remaining.length > 0
      ? { intentIds: [...new Set(remaining)], updatedAt: timestamp }
      : { state: "retired", intentIds: [], retiredAt: timestamp }),
  });
}

export type ManagedUploadAccountRetirementResult = {
  matched: number;
  retired: number;
  cleanupPending: number;
  corrupt: number;
  warnings: number;
};

export type ManagedUploadAccountProviderCleanupTarget = {
  intentId: string;
  userId: number;
  projectAssignmentId: string | null;
  credentialId: string;
  credentialOwnerUserId: number;
  credentialVersion: number;
  fileId: string;
};

type ManagedUploadAccountProviderCleanup = (
  target: ManagedUploadAccountProviderCleanupTarget,
) => Promise<void>;

type ProviderCleanupRecord = {
  fileId: string;
  state: "pending" | "attempted" | "discarded";
  requestedAt: string;
  attemptedAt: string | null;
  completedAt: string | null;
};

function providerCleanupRecords(
  value: Record<string, unknown>,
  previous: unknown,
  timestamp: string,
) {
  const prior = new Map<string, ProviderCleanupRecord>();
  if (Array.isArray(previous)) {
    for (const candidate of previous) {
      if (!candidate || typeof candidate !== "object") continue;
      const record = candidate as Partial<ProviderCleanupRecord>;
      if (
        typeof record.fileId !== "string" ||
        !["pending", "attempted", "discarded"].includes(String(record.state))
      ) {
        continue;
      }
      prior.set(record.fileId, {
        fileId: record.fileId,
        state: record.state!,
        requestedAt:
          typeof record.requestedAt === "string"
            ? record.requestedAt
            : timestamp,
        attemptedAt:
          typeof record.attemptedAt === "string" ? record.attemptedAt : null,
        completedAt:
          typeof record.completedAt === "string" ? record.completedAt : null,
      });
    }
  }
  if (Array.isArray(value.provider)) {
    for (const candidate of value.provider) {
      if (!candidate || typeof candidate !== "object") continue;
      const generation = candidate as Record<string, unknown>;
      if (
        typeof generation.fileId !== "string" ||
        generation.fileId.length === 0 ||
        generation.state === "discarded"
      ) {
        continue;
      }
      if (!prior.has(generation.fileId)) {
        prior.set(generation.fileId, {
          fileId: generation.fileId,
          state: "pending",
          requestedAt: timestamp,
          attemptedAt: null,
          completedAt: null,
        });
      }
    }
  }
  return [...prior.values()];
}

async function readCleanupRequest(target: string) {
  return fs
    .readFile(target, "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
}

type ManagedUploadCorruptIntentIndexProof = {
  intentId: string;
  operationIndexes: Array<{
    path: string;
    requestHash: string;
  }>;
  resumeIndexes: string[];
  targetAuthority: boolean;
  foreignAuthority: boolean;
  matchingKnowledgeBaseConversation: boolean;
};

function explicitIntentIndexAuthority(value: Record<string, unknown>) {
  const authority =
    value.authority &&
    typeof value.authority === "object" &&
    !Array.isArray(value.authority)
      ? (value.authority as Record<string, unknown>)
      : null;
  if (
    !authority ||
    !Number.isSafeInteger(authority.userId) ||
    typeof authority.operationId !== "string" ||
    (typeof authority.projectAssignmentId !== "string" &&
      authority.projectAssignmentId !== null)
  ) {
    return null;
  }
  const credentialOwnerUserId = Number.isSafeInteger(
    authority.credentialOwnerUserId,
  )
    ? Number(authority.credentialOwnerUserId)
    : null;
  return {
    userId: Number(authority.userId),
    credentialOwnerUserId,
    projectAssignmentId: authority.projectAssignmentId as string | null,
    operationId: authority.operationId,
    resumeScope:
      authority.resumeScope &&
      typeof authority.resumeScope === "object" &&
      !Array.isArray(authority.resumeScope)
        ? (authority.resumeScope as Record<string, unknown>)
        : null,
  };
}

async function collectCorruptIntentIndexProofs(input: {
  targetUserId: number;
  knowledgeBaseConversationIds?: ReadonlySet<string>;
}) {
  const proofs = new Map<string, ManagedUploadCorruptIntentIndexProof>();
  const authorityRoot = path.join(fenceRoot(), "intent-authority");
  const entries = await fs
    .readdir(authorityRoot, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const target = path.join(authorityRoot, entry.name);
    const value = await fs
      .readFile(target, "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null);
    if (
      !value ||
      typeof value.intentId !== "string" ||
      typeof value.requestHash !== "string" ||
      entry.name !== `${storageKey(value.intentId)}.json`
    ) {
      continue;
    }
    const authority = explicitIntentIndexAuthority(value);
    if (!authority) continue;
    const operationTarget = operationIndexPath({
      userId: authority.userId,
      projectAssignmentId: authority.projectAssignmentId,
      operationId: authority.operationId,
    });
    const operation = await fs
      .readFile(operationTarget, "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null);
    if (
      !operation ||
      operation.state === "retired" ||
      operation.intentId !== value.intentId ||
      operation.requestHash !== value.requestHash
    ) {
      continue;
    }
    const resumeIndexes: string[] = [];
    let matchingKnowledgeBaseConversation = false;
    const resumeScope = authority.resumeScope;
    if (
      resumeScope?.kind === "knowledge_base" &&
      typeof resumeScope.conversationId === "string" &&
      typeof resumeScope.turnId === "string"
    ) {
      const resumeTarget = resumeScopeIndexPath({
        userId: authority.userId,
        projectAssignmentId: authority.projectAssignmentId,
        resumeScope,
      });
      if (!resumeTarget) continue;
      const resume = await fs
        .readFile(resumeTarget, "utf8")
        .then((raw) => JSON.parse(raw) as Record<string, unknown>)
        .catch(() => null);
      if (
        resume &&
        resume.state !== "retired" &&
        Array.isArray(resume.intentIds) &&
        resume.intentIds.includes(value.intentId)
      ) {
        resumeIndexes.push(resumeTarget);
        matchingKnowledgeBaseConversation = Boolean(
          !input.knowledgeBaseConversationIds ||
            input.knowledgeBaseConversationIds.has(resumeScope.conversationId),
        );
      }
    }
    const targetAuthority =
      authority.userId === input.targetUserId ||
      authority.credentialOwnerUserId === input.targetUserId;
    proofs.set(value.intentId, {
      intentId: value.intentId,
      operationIndexes: [
        { path: operationTarget, requestHash: value.requestHash },
      ],
      resumeIndexes,
      targetAuthority,
      foreignAuthority: !targetAuthority,
      matchingKnowledgeBaseConversation,
    });
  }
  return proofs;
}

async function quarantineProvablyOwnedCorruptIntent(input: {
  entryName: string;
  targetUserId: number;
  proof: ManagedUploadCorruptIntentIndexProof | null;
  parsedManifest: Record<string, unknown> | null;
  knowledgeBaseConversationIds?: ReadonlySet<string>;
}) {
  const { parsedManifest, proof } = input;
  const manifestIntentId =
    typeof parsedManifest?.intentId === "string" &&
    storageKey(parsedManifest.intentId) === input.entryName
      ? parsedManifest.intentId
      : null;
  const manifestOwned = Boolean(
    manifestIntentId &&
      (parsedManifest?.userId === input.targetUserId ||
        parsedManifest?.credentialOwnerUserId === input.targetUserId),
  );
  const manifestHasAuthority = Boolean(
    manifestIntentId &&
      (Number.isSafeInteger(parsedManifest?.userId) ||
        Number.isSafeInteger(parsedManifest?.credentialOwnerUserId)),
  );
  if (manifestHasAuthority && !manifestOwned) return false;
  const manifestConversation =
    parsedManifest?.resumeScope &&
    typeof parsedManifest.resumeScope === "object" &&
    !Array.isArray(parsedManifest.resumeScope) &&
    (parsedManifest.resumeScope as Record<string, unknown>).kind ===
      "knowledge_base" &&
    typeof (parsedManifest.resumeScope as Record<string, unknown>)
      .conversationId === "string"
      ? String(
          (parsedManifest.resumeScope as Record<string, unknown>)
            .conversationId,
        )
      : null;
  const resetScopeMatches = input.knowledgeBaseConversationIds
    ? Boolean(
        (manifestOwned &&
          manifestConversation &&
          input.knowledgeBaseConversationIds.has(manifestConversation)) ||
          (proof?.targetAuthority &&
            proof.matchingKnowledgeBaseConversation &&
            !proof.foreignAuthority),
      )
    : true;
  const indexOwned = Boolean(
    proof?.targetAuthority && !proof.foreignAuthority && resetScopeMatches,
  );
  if ((!manifestOwned && !indexOwned) || !resetScopeMatches) return false;
  const intentId = manifestIntentId ?? proof?.intentId;
  if (!intentId || storageKey(intentId) !== input.entryName) return false;

  const timestamp = new Date().toISOString();
  const operationIndexes = new Map(
    (proof?.operationIndexes || []).map((entry) => [entry.path, entry]),
  );
  if (
    manifestOwned &&
    typeof parsedManifest?.operationId === "string" &&
    typeof parsedManifest.requestHash === "string" &&
    Number.isSafeInteger(parsedManifest.userId) &&
    (typeof parsedManifest.projectAssignmentId === "string" ||
      parsedManifest.projectAssignmentId === null)
  ) {
    const target = operationIndexPath(parsedManifest);
    operationIndexes.set(target, {
      path: target,
      requestHash: parsedManifest.requestHash,
    });
  }
  for (const operation of operationIndexes.values()) {
    await writeAtomic(operation.path, {
      schemaVersion: 1,
      state: "retired",
      requestHash: operation.requestHash,
      retiredAt: timestamp,
    });
  }
  const resumeIndexes = new Set(proof?.resumeIndexes || []);
  if (manifestOwned) {
    const target = resumeScopeIndexPath(parsedManifest!);
    if (target) resumeIndexes.add(target);
  }
  for (const target of resumeIndexes) {
    await retireResumeIndex(target, intentId, timestamp);
  }
  await fs.rm(intentDeletionAuthorityPath(intentId), { force: true });

  const directory = path.join(intentRoot(), input.entryName);
  await Promise.all([
    fs.rm(path.join(directory, "upload.part"), { force: true }),
    fs.rm(path.join(directory, "upload.content"), { force: true }),
  ]);
  const quarantineRoot = path.join(fenceRoot(), "quarantine");
  await ensurePrivateDirectory(quarantineRoot);
  const quarantine = path.join(
    quarantineRoot,
    `${input.entryName}.${randomUUID()}`,
  );
  await fs.rename(directory, quarantine);
  await fsyncDirectory(intentRoot());
  await fsyncDirectory(quarantineRoot);
  await writeAtomic(path.join(quarantine, "retirement.json"), {
    schemaVersion: 1,
    reason: "account_deleted_corrupt_intent",
    targetUserId: input.targetUserId,
    retiredAt: timestamp,
  });
  return true;
}

async function assertAccountRetirementAuthority(
  token: ManagedUploadDeletionFenceToken,
  allowDeletedTombstone: boolean,
) {
  const current = await readFence(token.scope);
  if (
    !current ||
    current.nonce !== token.nonce ||
    (current.state !== "deleting" &&
      !(allowDeletedTombstone && current.state === "deleted"))
  ) {
    throw new Error("MANAGED_UPLOAD_DELETION_FENCE_TOKEN_INVALID");
  }
}

/**
 * Irreversibly retires local upload capabilities for a permanently deleted
 * account. The user deletion fence is the durable authority boundary; remote
 * Provider cleanup remains best effort and never blocks account deletion.
 */
export async function retireManagedUploadIntentsForAccountDeletion(input: {
  userId: number;
  token: ManagedUploadDeletionFenceToken;
  knowledgeBaseConversationIds?: ReadonlySet<string>;
  discardProviderFile?: ManagedUploadAccountProviderCleanup;
  /** Used only by missing-user replay after the durable tombstone is proven. */
  allowDeletedTombstone?: boolean;
}): Promise<ManagedUploadAccountRetirementResult> {
  if (
    input.token.scope.kind !== "user" ||
    input.token.scope.userId !== input.userId
  ) {
    throw new Error("MANAGED_UPLOAD_ACCOUNT_DELETION_FENCE_INVALID");
  }
  const releaseRetirementLock = await acquireAccountRetirementLock(
    input.userId,
  );
  try {
    await assertAccountRetirementAuthority(
      input.token,
      input.allowDeletedTombstone === true,
    );
    const result: ManagedUploadAccountRetirementResult = {
      matched: 0,
      retired: 0,
      cleanupPending: 0,
      corrupt: 0,
      warnings: 0,
    };
    const entries = await fs
      .readdir(intentRoot(), { withFileTypes: true })
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
    const corruptIndexProofs = await collectCorruptIntentIndexProofs({
      targetUserId: input.userId,
      ...(input.knowledgeBaseConversationIds
        ? {
            knowledgeBaseConversationIds: input.knowledgeBaseConversationIds,
          }
        : {}),
    });
    const indexedProofForDirectory = (entryName: string) => {
      const candidates = [...corruptIndexProofs.values()].filter(
        (proof) => storageKey(proof.intentId) === entryName,
      );
      return candidates.length === 1 ? candidates[0]! : null;
    };
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name === "by-operation" ||
        entry.name === "by-resume-scope" ||
        entry.name === "deletion-fences"
      ) {
        continue;
      }
      const manifestPath = path.join(intentRoot(), entry.name, "manifest.json");
      let value: Record<string, unknown> | null = null;
      try {
        value = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        result.corrupt += 1;
        const retired = await quarantineProvablyOwnedCorruptIntent({
          entryName: entry.name,
          targetUserId: input.userId,
          proof: indexedProofForDirectory(entry.name),
          parsedManifest: null,
          ...(input.knowledgeBaseConversationIds
            ? {
                knowledgeBaseConversationIds:
                  input.knowledgeBaseConversationIds,
              }
            : {}),
        }).catch(() => false);
        if (retired) {
          result.matched += 1;
          result.retired += 1;
        } else {
          result.warnings += 1;
        }
        continue;
      }
      if (!manifestMatchesScope(value, input.token.scope)) {
        const retired = await quarantineProvablyOwnedCorruptIntent({
          entryName: entry.name,
          targetUserId: input.userId,
          proof: indexedProofForDirectory(entry.name),
          parsedManifest: value,
          ...(input.knowledgeBaseConversationIds
            ? {
                knowledgeBaseConversationIds:
                  input.knowledgeBaseConversationIds,
              }
            : {}),
        }).catch(() => false);
        if (retired) {
          result.corrupt += 1;
          result.matched += 1;
          result.retired += 1;
        }
        continue;
      }
      if (input.knowledgeBaseConversationIds) {
        const resumeScope = value.resumeScope as
          | Record<string, unknown>
          | null
          | undefined;
        if (
          resumeScope?.kind !== "knowledge_base" ||
          typeof resumeScope.conversationId !== "string" ||
          !input.knowledgeBaseConversationIds.has(resumeScope.conversationId)
        ) {
          continue;
        }
      }
      result.matched += 1;
      try {
        if (
          typeof value.intentId !== "string" ||
          storageKey(value.intentId) !== entry.name ||
          typeof value.operationId !== "string" ||
          typeof value.requestHash !== "string"
        ) {
          result.corrupt += 1;
          const retired = await quarantineProvablyOwnedCorruptIntent({
            entryName: entry.name,
            targetUserId: input.userId,
            proof: indexedProofForDirectory(entry.name),
            parsedManifest: value,
            ...(input.knowledgeBaseConversationIds
              ? {
                  knowledgeBaseConversationIds:
                    input.knowledgeBaseConversationIds,
                }
              : {}),
          }).catch(() => false);
          if (retired) result.retired += 1;
          else result.warnings += 1;
          continue;
        }
        const timestamp = new Date().toISOString();
        const directory = managedUploadIntentDirectory(value.intentId);
        const cleanupRequestPath = path.join(directory, "cleanup-request.json");
        const existingCleanupRequest =
          await readCleanupRequest(cleanupRequestPath);
        let cleanupRecords = providerCleanupRecords(
          value,
          existingCleanupRequest?.providerFiles,
          timestamp,
        );
        const persistCleanupRequest = () =>
          writeAtomic(cleanupRequestPath, {
            schemaVersion: 1,
            reason: "account_deleted",
            requestedAt:
              typeof existingCleanupRequest?.requestedAt === "string"
                ? existingCleanupRequest.requestedAt
                : timestamp,
            providerFiles: cleanupRecords,
          });
        await persistCleanupRequest();
        // Retire every browser capability before touching bytes or Provider
        // state. A late ticket/resume request can no longer discover this
        // intent even if the process exits on the next instruction.
        await writeAtomic(operationIndexPath(value), {
          schemaVersion: 1,
          state: "retired",
          requestHash: value.requestHash,
          retiredAt: timestamp,
        });
        const resumeIndex = resumeScopeIndexPath(value);
        if (resumeIndex) {
          await retireResumeIndex(resumeIndex, value.intentId, timestamp);
        }
        const revision = Number.isSafeInteger(value.revision)
          ? Number(value.revision) + 1
          : 1;
        await writeAtomic(manifestPath, {
          ...value,
          state: cleanupRecords.length > 0 ? "cleanup_pending" : "cancelled",
          phase: cleanupRecords.length > 0 ? "cleanup_pending" : null,
          revision,
          leaseOwner: null,
          leaseExpiresAt: null,
          safeErrorCode: "UPLOAD_ACCOUNT_DELETED",
          updatedAt: timestamp,
          deletedAt: timestamp,
        });
        await Promise.all([
          fs.rm(path.join(directory, "upload.part"), { force: true }),
          fs.rm(path.join(directory, "upload.content"), { force: true }),
        ]);
        await fsyncDirectory(directory);

        // This callback is reachable only while the exact deletion-fence token
        // remains authoritative. Claim each file once before the remote call so
        // crash replay cannot duplicate side effects.
        for (const record of cleanupRecords) {
          if (record.state !== "pending" || !input.discardProviderFile)
            continue;
          const attemptedAt = new Date().toISOString();
          cleanupRecords = cleanupRecords.map((candidate) =>
            candidate.fileId === record.fileId
              ? { ...candidate, state: "attempted", attemptedAt }
              : candidate,
          );
          await persistCleanupRequest();
          try {
            await input.discardProviderFile({
              intentId: value.intentId,
              userId: Number(value.userId),
              projectAssignmentId:
                typeof value.projectAssignmentId === "string"
                  ? value.projectAssignmentId
                  : null,
              credentialId: String(value.credentialId),
              credentialOwnerUserId: Number(value.credentialOwnerUserId),
              credentialVersion: Number(value.credentialVersion),
              fileId: record.fileId,
            });
            const completedAt = new Date().toISOString();
            cleanupRecords = cleanupRecords.map((candidate) =>
              candidate.fileId === record.fileId
                ? { ...candidate, state: "discarded", completedAt }
                : candidate,
            );
          } catch {
            result.warnings += 1;
          }
          await persistCleanupRequest();
        }

        const pendingFileIds = new Set(
          cleanupRecords
            .filter((record) => record.state !== "discarded")
            .map((record) => record.fileId),
        );
        const retiredAt = new Date().toISOString();
        const provider = Array.isArray(value.provider)
          ? value.provider.map((candidate) => {
              if (!candidate || typeof candidate !== "object") return candidate;
              const generation = candidate as Record<string, unknown>;
              if (typeof generation.fileId !== "string") return generation;
              return {
                ...generation,
                state: pendingFileIds.has(generation.fileId)
                  ? "discard_sending"
                  : "discarded",
                ownershipRecorded: pendingFileIds.has(generation.fileId)
                  ? generation.ownershipRecorded
                  : false,
                updatedAt: retiredAt,
              };
            })
          : [];
        await writeAtomic(manifestPath, {
          ...value,
          state: pendingFileIds.size > 0 ? "cleanup_pending" : "cancelled",
          phase: pendingFileIds.size > 0 ? "cleanup_pending" : null,
          provider,
          receipt: pendingFileIds.size > 0 ? value.receipt : null,
          revision: revision + 1,
          leaseOwner: null,
          leaseExpiresAt: null,
          safeErrorCode:
            pendingFileIds.size > 0
              ? "UPLOAD_ACCOUNT_DELETION_CLEANUP_PENDING"
              : "UPLOAD_ACCOUNT_DELETED",
          updatedAt: retiredAt,
          deletedAt: retiredAt,
        });
        if (pendingFileIds.size > 0) result.cleanupPending += 1;
        await fs.rm(intentDeletionAuthorityPath(value.intentId), {
          force: true,
        });
        result.retired += 1;
      } catch {
        // Preserve the irreversible pieces even when manifest/provider cleanup
        // failed. In particular, reset may roll its temporary user fence back;
        // operation and resume capabilities must already be retired first.
        if (
          typeof value.intentId === "string" &&
          storageKey(value.intentId) === entry.name &&
          typeof value.operationId === "string" &&
          typeof value.requestHash === "string"
        ) {
          const failedAt = new Date().toISOString();
          const directory = managedUploadIntentDirectory(value.intentId);
          await writeAtomic(path.join(directory, "cleanup-request.json"), {
            schemaVersion: 1,
            reason: "account_deleted",
            requestedAt: failedAt,
            retirementIncomplete: true,
          }).catch(() => undefined);
          await writeAtomic(operationIndexPath(value), {
            schemaVersion: 1,
            state: "retired",
            requestHash: value.requestHash,
            retiredAt: failedAt,
          }).catch(() => undefined);
          const resumeIndex = resumeScopeIndexPath(value);
          if (resumeIndex) {
            await retireResumeIndex(
              resumeIndex,
              value.intentId,
              failedAt,
            ).catch(() => undefined);
          }
          await Promise.all([
            fs.rm(path.join(directory, "upload.part"), { force: true }),
            fs.rm(path.join(directory, "upload.content"), { force: true }),
            fs.rm(intentDeletionAuthorityPath(value.intentId), { force: true }),
          ]).catch(() => undefined);
        }
        result.warnings += 1;
      }
    }
    return result;
  } finally {
    await releaseRetirementLock();
  }
}

/** Retires only old KB browser-upload scopes after an approved reset. */
export async function retireManagedUploadIntentsForKnowledgeBaseReset(input: {
  userId: number;
  conversationIds: string[];
  discardProviderFile?: ManagedUploadAccountProviderCleanup;
}): Promise<ManagedUploadAccountRetirementResult> {
  const empty: ManagedUploadAccountRetirementResult = {
    matched: 0,
    retired: 0,
    cleanupPending: 0,
    corrupt: 0,
    warnings: 0,
  };
  const conversations = new Set(input.conversationIds.filter(Boolean));
  if (conversations.size === 0) return empty;
  const scope = { kind: "user" as const, userId: input.userId };
  let token: ManagedUploadDeletionFenceToken;
  try {
    token = await acquireManagedUploadDeletionFence(scope, {
      disposition: "cancel_active_intents",
    });
  } catch {
    return { ...empty, warnings: 1 };
  }
  try {
    return await retireManagedUploadIntentsForAccountDeletion({
      userId: input.userId,
      token,
      knowledgeBaseConversationIds: conversations,
      discardProviderFile: input.discardProviderFile,
    });
  } finally {
    await rollbackManagedUploadDeletionFence(token).catch(() => undefined);
  }
}

/**
 * Missing-user replay may only retire local capabilities after proving the
 * durable deleted tombstone. It never retries Provider cleanup: credentials
 * may already be gone and every remote attempt is claimed exactly once.
 */
export async function replayManagedUploadRetirementForDeletedAccount(
  userId: number,
) {
  const scope = { kind: "user" as const, userId };
  const release = await acquireScopeLock(scope);
  let token: ManagedUploadDeletionFenceToken;
  try {
    const current = await readFence(scope);
    if (!current || current.state !== "deleted") {
      throw new Error("MANAGED_UPLOAD_DELETED_ACCOUNT_TOMBSTONE_REQUIRED");
    }
    token = { scope, nonce: String(current.nonce) };
  } finally {
    await release();
  }
  return retireManagedUploadIntentsForAccountDeletion({
    userId,
    token,
    allowDeletedTombstone: true,
  });
}

/**
 * Bounded startup repair for the crash window after the user row committed
 * but before local upload retirement finished. It scans only durable fence
 * tombstones, never Provider tasks/conversations, and never performs remote
 * cleanup.
 */
export async function reconcileDeletedManagedUploadAccountRetirements(
  limit = 25,
) {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, 100))
    : 25;
  const entries = await fs
    .readdir(fenceRoot(), { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  let scanned = 0;
  let reconciled = 0;
  let failed = 0;
  for (const entry of entries
    .filter(
      (candidate) => candidate.isFile() && candidate.name.endsWith(".json"),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, boundedLimit)) {
    scanned += 1;
    try {
      const value = JSON.parse(
        await fs.readFile(path.join(fenceRoot(), entry.name), "utf8"),
      ) as Record<string, unknown>;
      const scope = value.scope as ManagedUploadFenceScope | undefined;
      if (
        value.state !== "deleted" ||
        !scope ||
        scope.kind !== "user" ||
        entry.name !== `${scopeKey(scope)}.json`
      ) {
        continue;
      }
      await readFence(scope);
      await replayManagedUploadRetirementForDeletedAccount(scope.userId);
      reconciled += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned, reconciled, failed };
}

/** Returns only bounded, strictly validated user-fence coordinates. */
export async function listManagedUploadUserDeletionFences(limit = 25) {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, 100))
    : 25;
  const entries = await fs
    .readdir(fenceRoot(), { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  const fences: Array<{
    scope: Extract<ManagedUploadFenceScope, { kind: "user" }>;
    state: "deleting" | "deleted";
    leaseExpiresAt: string | null;
    purpose: "account_deletion" | null;
    accountDeletionPhase: ManagedUploadAccountDeletionPhase | null;
  }> = [];
  for (const entry of entries
    .filter(
      (candidate) => candidate.isFile() && candidate.name.endsWith(".json"),
    )
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (fences.length >= boundedLimit) break;
    const raw = JSON.parse(
      await fs.readFile(path.join(fenceRoot(), entry.name), "utf8"),
    ) as Record<string, unknown>;
    const scope = raw.scope as ManagedUploadFenceScope | undefined;
    if (!scope || scope.kind !== "user") continue;
    if (entry.name !== `${scopeKey(scope)}.json`) {
      throw new Error("MANAGED_UPLOAD_DELETION_FENCE_INVALID");
    }
    const value = await readFence(scope);
    if (!value) continue;
    fences.push({
      scope,
      state: value.state as "deleting" | "deleted",
      leaseExpiresAt:
        typeof value.leaseExpiresAt === "string" ? value.leaseExpiresAt : null,
      purpose: value.purpose === "account_deletion" ? "account_deletion" : null,
      accountDeletionPhase: ["fenced", "prepared", "retired"].includes(
        String(value.accountDeletionPhase),
      )
        ? (value.accountDeletionPhase as ManagedUploadAccountDeletionPhase)
        : null,
    });
  }
  return fences;
}

/**
 * Reconciles only an expired deletion fence after the caller has checked the
 * authoritative database state. A live lease is never stolen merely because
 * the row still looks active while the first transaction is in flight.
 */
export async function reconcileStaleManagedUploadDeletionFence(
  scope: ManagedUploadFenceScope,
  disposition: "active" | "deleted",
) {
  const release = await acquireScopeLock(scope);
  try {
    const current = await readFence(scope);
    if (!current) return disposition;
    if (current.state === "deleted") return "deleted" as const;
    if (
      disposition === "active" &&
      Date.parse(String(current.leaseExpiresAt)) > Date.now()
    ) {
      throw new ManagedUploadDeletionFenceError("DELETION_IN_PROGRESS");
    }
    if (disposition === "deleted") {
      await writeAtomic(fencePath(scope), {
        ...current,
        schemaVersion: 1,
        scopeKey: scopeKey(scope),
        state: "deleted",
        nonce: current.nonce,
        scope,
        createdAt:
          typeof current.createdAt === "string"
            ? current.createdAt
            : new Date().toISOString(),
        completedAt: new Date().toISOString(),
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: undefined,
      });
    } else {
      await fs.rm(fencePath(scope), { force: true });
      await fsyncDirectory(fenceRoot());
    }
    return disposition;
  } finally {
    await release();
  }
}

export async function renewManagedUploadDeletionFence(
  token: ManagedUploadDeletionFenceToken,
) {
  const release = await acquireScopeLock(token.scope);
  try {
    const current = await readFence(token.scope);
    if (
      !current ||
      current.state !== "deleting" ||
      current.nonce !== token.nonce
    ) {
      throw new Error("MANAGED_UPLOAD_DELETION_FENCE_TOKEN_INVALID");
    }
    const timestamp = new Date();
    await writeAtomic(fencePath(token.scope), {
      ...current,
      leaseOwner: token.nonce,
      leaseExpiresAt: new Date(
        timestamp.getTime() + FENCE_LEASE_MS,
      ).toISOString(),
      updatedAt: timestamp.toISOString(),
    });
  } finally {
    await release();
  }
}

export function startManagedUploadDeletionFenceHeartbeat(
  token: ManagedUploadDeletionFenceToken,
) {
  let stopped = false;
  let failure: unknown = null;
  let current = Promise.resolve();
  const timer = setInterval(() => {
    current = current
      .then(() => renewManagedUploadDeletionFence(token))
      .catch((error) => {
        failure = error;
      });
  }, FENCE_HEARTBEAT_MS);
  timer.unref?.();
  return async () => {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
    }
    await current;
    if (failure) throw failure;
  };
}

async function assertToken(token: ManagedUploadDeletionFenceToken) {
  const current = await readFence(token.scope);
  if (
    !current ||
    current.state !== "deleting" ||
    current.nonce !== token.nonce
  ) {
    throw new Error("MANAGED_UPLOAD_DELETION_FENCE_TOKEN_INVALID");
  }
}

export async function completeManagedUploadDeletionFence(
  token: ManagedUploadDeletionFenceToken,
) {
  const release = await acquireScopeLock(token.scope);
  try {
    await assertToken(token);
    const current = (await readFence(token.scope))!;
    await writeAtomic(fencePath(token.scope), {
      ...current,
      schemaVersion: 1,
      scopeKey: scopeKey(token.scope),
      state: "deleted",
      nonce: token.nonce,
      scope: token.scope,
      createdAt:
        typeof current.createdAt === "string"
          ? current.createdAt
          : new Date().toISOString(),
      completedAt: new Date().toISOString(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: undefined,
    });
  } finally {
    await release();
  }
}

export async function listManagedUploadCredentialDeletionFenceScopes(
  ownerUserId: number,
) {
  const entries = await fs
    .readdir(fenceRoot(), { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  const scopes: Array<
    Extract<ManagedUploadFenceScope, { kind: "credential" }>
  > = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = JSON.parse(
      await fs.readFile(path.join(fenceRoot(), entry.name), "utf8"),
    ) as Record<string, unknown>;
    const scope = value.scope as ManagedUploadFenceScope | undefined;
    if (!scope || scope.kind !== "credential" || scope.userId !== ownerUserId) {
      continue;
    }
    if (
      entry.name !== `${scopeKey(scope)}.json` ||
      value.scopeKey !== scopeKey(scope)
    ) {
      throw new Error("MANAGED_UPLOAD_DELETION_FENCE_INVALID");
    }
    // Re-read through the strict validator before returning authority-bearing
    // coordinates to auth-service.
    await readFence(scope);
    scopes.push(scope);
  }
  return scopes;
}

export async function rollbackManagedUploadDeletionFence(
  token: ManagedUploadDeletionFenceToken,
) {
  const release = await acquireScopeLock(token.scope);
  try {
    await assertToken(token);
    await fs.rm(fencePath(token.scope), { force: true });
    await fsyncDirectory(fenceRoot());
  } finally {
    await release();
  }
}

export function assertCredentialDeletionFenceToken(
  token: ManagedUploadDeletionFenceToken,
  input: { userId: number; credentialId: string },
) {
  if (
    token.scope.kind !== "credential" ||
    token.scope.userId !== input.userId ||
    token.scope.credentialId !== input.credentialId
  ) {
    throw new Error("MANAGED_UPLOAD_DELETION_FENCE_SCOPE_MISMATCH");
  }
}
