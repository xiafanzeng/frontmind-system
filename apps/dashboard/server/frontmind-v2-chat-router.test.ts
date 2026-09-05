import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Dashboard ordinary-chat v2 boundary", () => {
  const serverSource = readFileSync(
    resolve(process.cwd(), "server/frontmind-v2-chat-router.ts"),
    "utf8",
  );
  const clientSource = readFileSync(
    resolve(process.cwd(), "client/src/lib/frontmind-api.ts"),
    "utf8",
  );
  const siteOpsServiceSource = readFileSync(
    resolve(process.cwd(), "server/siteops/service.ts"),
    "utf8",
  );
  const dispatchValidationSource = readFileSync(
    resolve(process.cwd(), "server/general-chat-dispatch-validation.ts"),
    "utf8",
  );

  it("uses local task, message, asset and artifact identities", () => {
    expect(serverSource).toContain('router.post("/tasks"');
    expect(serverSource).toContain(
      'router.post("/tasks/:localTaskId/messages"',
    );
    expect(serverSource).toContain('router.post("/assets"');
    expect(serverSource).toContain(
      'router.get("/artifacts/:artifactId/content"',
    );
    expect(serverSource).toContain("providerFileLeases");
    expect(serverSource).toContain(
      "await client.fileDetail(reusable.providerFileId)",
    );
    expect(serverSource).toContain('.set({ uploadState: "expired" })');
  });

  it("wires SiteOps composer uploads through the tenant, reset epoch and exact replay fence", () => {
    const assetRoute = serverSource.slice(
      serverSource.indexOf('router.post("/assets"'),
      serverSource.indexOf('router.get("/assets/:localAssetId/content"'),
    );
    expect(assetRoute).toContain("parseSiteOpsComposerLocalUploadCoordinate(");
    expect(assetRoute).toContain("req.headers,");
    expect(assetRoute).toContain("MAX_SITEOPS_COMPOSER_ASSET_BYTES");
    expect(assetRoute).toContain(
      '["image/jpeg", "image/png", "image/webp"].includes(mimeType)',
    );
    expect(assetRoute).toContain("currentSiteOpsComposerUploadEpoch(");
    expect(serverSource).toContain(
      "!project?.currentBuildId || !project.knowledgeInputEpochId",
    );
    expect(siteOpsServiceSource).toContain(
      "if (!project?.knowledgeInputEpochId)",
    );
    expect(siteOpsServiceSource).toContain(
      "if (!input.project.knowledgeInputEpochId)",
    );
    expect(siteOpsServiceSource).toMatch(
      /eq\(\s*localAssets\.siteOpsKnowledgeInputEpochId,\s*knowledgeInputEpochId,?\s*\)/u,
    );
    expect(assetRoute).toContain("current.knowledgeInputEpochId !==");
    expect(assetRoute).toContain("siteOpsComposerLocalAssetIdentity({");
    expect(assetRoute).toContain(
      "siteOpsComposerLocalAssetExistingRowDisposition({",
    );
    expect(assetRoute).toMatch(
      /siteOpsKnowledgeInputEpochId:\s+siteOpsComposerEpoch\?\.knowledgeInputEpochId \?\? null/u,
    );
    expect(
      assetRoute.match(/await assertSiteOpsComposerCoordinate\(/gu),
    ).toHaveLength(2);
  });

  it("never routes ordinary chat through a Manus v1 endpoint", () => {
    expect(serverSource).not.toMatch(/\/v1\/(?:tasks|responses|files)/u);
    expect(clientSource).toContain(
      "/v2/tasks/${encodeURIComponent(localTaskId)}/messages",
    );
    expect(clientSource).not.toContain(
      "[retrieveTask] /v1/tasks/ is unavailable",
    );
  });

  it("maps and freezes the public create-only model profile", () => {
    expect(serverSource).toContain(
      "upstreamModel: generalAgentModelProfileModel(input.value.modelProfile)",
    );
    expect(serverSource).toContain("modelProfile: input.value.modelProfile");
    expect(serverSource).toContain(
      "agentProfile: reserved.operation.upstreamModel",
    );
    expect(clientSource).toContain(
      "modelProfile: normalizePublicAgentProfile(",
    );
    expect(clientSource).not.toContain('taskMode: "agent"');
    expect(clientSource).not.toContain("agentProfile: modelToUse");
    expect(serverSource).toContain('user?.role === "delivery_member"');
    expect(serverSource).toContain(
      'user.adminAccessLevel === "delivery_admin"',
    );
    expect(serverSource).toContain("GENERAL_AGENT_ROLE_FORBIDDEN");
    expect(serverSource).toContain(
      ".omit({ conversationId: true, modelProfile: true })",
    );
  });

  it("never leaks the internal operation marker into ordinary-chat prompts", () => {
    expect(serverSource).toContain("findCreatedTask({");
    expect(serverSource).not.toContain("promptWithMarker");
    expect(serverSource).toContain("prompt: value.prompt");
    expect(serverSource).toContain("prompt: input.prompt");
    expect(serverSource).toContain(
      "stripFrontMindGeneralChatOperationContract",
    );
    expect(serverSource).toContain('status: "attention_required"');
    expect(serverSource).not.toContain("previous_response_id");
  });

  it("binds persisted ordinary-chat turns and projects server-owned output", () => {
    expect(serverSource).toContain(
      'const GENERAL_CHAT_TURN_TYPE = "general_chat_v2"',
    );
    expect(serverSource).toContain("reservePersistedGeneralChatTurn({");
    expect(serverSource).toContain('kind: "assistant_projection"');
    expect(serverSource).toContain("serverOwned: true");
    expect(serverSource).toContain("providerEventWatermark");
    expect(serverSource).toContain('providerState: "outcome_unknown"');
    expect(serverSource).toContain("orderManusV2EventsByProviderRank(");
    expect(serverSource).toContain('input.events,\n    "oldest_first",');
  });

  it("uses durable dispatch metadata for exact prompt, assets and create coordinates", () => {
    const reserveTurnSource = serverSource.slice(
      serverSource.indexOf("async function reservePersistedGeneralChatTurn"),
      serverSource.indexOf("async function reserveCreate"),
    );

    expect(reserveTurnSource).toContain(
      "validateGeneralChatDispatchMetadata({",
    );
    expect(dispatchValidationSource).toContain(
      "dispatch.providerPrompt !== input.providerPrompt",
    );
    expect(dispatchValidationSource).toContain(
      "dispatch.clientRequestId !== input.clientRequestId",
    );
    expect(dispatchValidationSource).toContain(
      "dispatch.localTaskId !== input.originalLocalTaskId",
    );
    expect(dispatchValidationSource).toContain(
      "assetId !== dispatch.localAssetIds[index]",
    );
    expect(reserveTurnSource).toContain(
      "Compatibility only for snapshots written before durable ordinary-chat",
    );
  });

  it("binds the persisted user message to the authoritative turn and preserves that binding on snapshot replace", () => {
    const reserveTurnSource = serverSource.slice(
      serverSource.indexOf("async function reservePersistedGeneralChatTurn"),
      serverSource.indexOf("async function reserveCreate"),
    );
    const conversationSource = readFileSync(
      resolve(process.cwd(), "server/conversation-router.ts"),
      "utf8",
    );
    const persistSource = conversationSource.slice(
      conversationSource.indexOf("export async function persistSnapshot"),
      conversationSource.indexOf("export async function listSnapshots"),
    );

    expect(reserveTurnSource).toContain('.for("update")');
    expect(reserveTurnSource).toContain(
      "bindPersistedGeneralChatUserMessageTurn({",
    );
    expect(serverSource).toContain('"USER_MESSAGE_TURN_CONFLICT", 409');
    expect(persistSource).toContain("loadGeneralChatSnapshotTurnAuthority(");
    expect(persistSource).toContain(
      "removeAcknowledgedGeneralChatDispatchMetadata({",
    );
    expect(persistSource).toContain(
      "authoritativeGeneralChatTurnIdForBrowserMessage(",
    );
  });

  it("reserves a continuation send before any Provider preparation", () => {
    const sendSource = serverSource.slice(
      serverSource.indexOf("async function sendProviderMessage"),
      serverSource.indexOf("function sendError"),
    );
    const reserveIndex = sendSource.indexOf(".insert(agentEvents)");
    const uploadIndex = sendSource.indexOf("ensureProviderAttachments({");
    const watermarkIndex = sendSource.indexOf("client.listAllMessages({");
    const sendIndex = sendSource.indexOf("client.sendMessage({");
    const freezeIndex = sendSource.indexOf('status: "sending"');

    expect(reserveIndex).toBeGreaterThanOrEqual(0);
    expect(reserveIndex).toBeLessThan(uploadIndex);
    expect(reserveIndex).toBeLessThan(watermarkIndex);
    expect(freezeIndex).toBeLessThan(sendIndex);
    expect(sendSource).toContain('payload.status === "preparing"');
    expect(sendSource).toContain('"SEND_PREPARATION_IN_PROGRESS", 409, true');
    expect(sendSource).toContain(".delete(agentEvents)");
  });

  it("rejects stale creates and cross-conversation continuation bindings", () => {
    const reserveTurnSource = serverSource.slice(
      serverSource.indexOf("async function reservePersistedGeneralChatTurn"),
      serverSource.indexOf("async function reserveCreate"),
    );

    expect(reserveTurnSource).toContain("conversationTaskPointers.some(");
    expect(reserveTurnSource).toContain("!input.continuation &&");
    expect(reserveTurnSource).toContain("authoritativeTaskTurns.length === 0");
    expect(reserveTurnSource).toContain(
      "turn.conversationId !== persistedConversationId",
    );
    expect(reserveTurnSource).toContain('"CONVERSATION_TASK_CONFLICT", 409');
  });

  it("reclaims only a proven pre-Provider create preparation failure", () => {
    const claimSource = serverSource.slice(
      serverSource.indexOf("async function claimCreatePreparation"),
      serverSource.indexOf("async function freezeCreateReconcileEvidence"),
    );
    const createRoute = serverSource.slice(
      serverSource.indexOf('router.post("/tasks"'),
      serverSource.indexOf('router.post("/tasks/:localTaskId/messages"'),
    );
    const reconcileSource = serverSource.slice(
      serverSource.indexOf("async function reconcileUnknownCreate"),
      serverSource.indexOf("async function latestGeneralChatTurnOutputState"),
    );

    expect(claimSource).toContain('status !== "preparation_failed"');
    expect(claimSource).toContain('status: "preparing"');
    expect(createRoute).toContain("freezeCreateReconcileEvidence({");
    expect(createRoute.indexOf("freezeCreateReconcileEvidence({")).toBeLessThan(
      createRoute.indexOf(".createTask({"),
    );
    expect(createRoute).toContain('expectedStatus: "preparing"');
    expect(createRoute).toContain('status: "preparation_failed"');
    expect(createRoute).toContain('expectedStatus: "sending"');
    expect(createRoute).toContain('status: "outcome_unknown"');
    expect(reconcileSource).not.toContain("operationToken");
    expect(reconcileSource).toContain(
      '["sending", "outcome_unknown"].includes',
    );
  });

  it("atomically takes over stale create and send preparation claims", () => {
    const createClaimSource = serverSource.slice(
      serverSource.indexOf("async function claimCreatePreparation"),
      serverSource.indexOf("async function freezeCreateReconcileEvidence"),
    );
    const createFreezeSource = serverSource.slice(
      serverSource.indexOf("async function freezeCreateReconcileEvidence"),
      serverSource.indexOf("async function transitionCreateReservation"),
    );
    const sendSource = serverSource.slice(
      serverSource.indexOf("async function sendProviderMessage"),
      serverSource.indexOf("function sendError"),
    );

    expect(createClaimSource).toContain("createGeneralChatPreparationClaim()");
    expect(createClaimSource).toContain("generalChatPreparationClaimIsStale(");
    expect(createClaimSource).toContain("claimUpdatedAtMs");
    expect(createFreezeSource).toContain(
      "payload.claimToken !== input.claimToken",
    );
    expect(sendSource).toContain("const takeoverClaim =");
    expect(sendSource).toContain('.for("update")');
    expect(sendSource).toContain("generalChatPreparationClaimIsStale(");
    expect(sendSource).toContain(
      "lockedReservation.normalizedPayload.claimToken !== activeClaimToken",
    );
    expect(sendSource).toContain(
      "currentReservation.normalizedPayload.claimToken === activeClaimToken",
    );
    const cleanupSource = sendSource.slice(
      sendSource.indexOf("const currentReservation"),
      sendSource.indexOf("throw error;"),
    );
    expect(cleanupSource).toContain('.for("update")');
    expect(cleanupSource).toContain("await tx");
    expect(cleanupSource).toContain(".delete(agentEvents)");
    expect(cleanupSource).not.toContain("db.delete(agentEvents)");
  });

  it("re-locks and validates the exact bound user message before either Provider boundary", () => {
    const createFreezeSource = serverSource.slice(
      serverSource.indexOf("async function freezeCreateReconcileEvidence"),
      serverSource.indexOf("async function transitionCreateReservation"),
    );
    const sendSource = serverSource.slice(
      serverSource.indexOf("async function sendProviderMessage"),
      serverSource.indexOf("function sendError"),
    );

    for (const source of [createFreezeSource, sendSource]) {
      expect(source).toContain("persistedMessageIdForConversation(");
      expect(source).toContain("eq(messages.turnId,");
      expect(source).toContain("isNull(messages.deletedAt)");
      expect(source).toContain("validateGeneralChatDispatchMetadata({");
      expect(source).toContain('"USER_MESSAGE_TURN_CONFLICT", 409');
      expect(source).toContain('"USER_MESSAGE_DISPATCH_CONFLICT", 409');
      expect(source).toContain('.for("update")');
    }
    expect(createFreezeSource).toContain("originalLocalTaskId: null");
    expect(createFreezeSource).toContain("modelProfile: input.modelProfile");
    expect(sendSource).toContain("originalLocalTaskId: input.task.id");
    expect(sendSource).toContain("modelProfile: null");
  });

  it("settles create DTOs only from acknowledged or proven-rejected evidence and heals a post-create acknowledgement gap", () => {
    const readSource = serverSource.slice(
      serverSource.indexOf("async function readCreateReservation"),
      serverSource.indexOf("async function reconcileUnknownCreate"),
    );
    const createRoute = serverSource.slice(
      serverSource.indexOf('router.post("/tasks"'),
      serverSource.indexOf('router.post("/tasks/:localTaskId/messages"'),
    );

    expect(readSource).toContain(
      "rejectionProven: payload.rejectionProven === true",
    );
    expect(readSource).toContain("input.task.providerTaskId &&");
    expect(readSource).toContain('reservation?.status === "sending"');
    expect(readSource).toContain('reservation?.status === "outcome_unknown"');
    expect(readSource).toContain('status: "acknowledged"');
    expect(readSource).toContain("reservation.rejectionProven");
    expect(readSource).toContain("!owned.task.providerTaskId");
    expect(readSource).toContain("clearConversationTaskPointers: true");
    expect(readSource).toContain("return owned");
    expect(createRoute).toContain("assertCreateTaskDtoMaySettle(");
    expect(createRoute).toContain("rejectionProven: true");
    expect(createRoute).toContain("clearConversationTaskPointers: true");
  });

  it("keeps continuation reservations unresolved unless reconciliation or an explicit Provider rejection proves settlement", () => {
    const sendSource = serverSource.slice(
      serverSource.indexOf("async function sendProviderMessage"),
      serverSource.indexOf("function sendError"),
    );
    const providerCallIndex = sendSource.indexOf("await client.sendMessage({");
    const acknowledgedWriteIndex = sendSource.indexOf(
      'status: "acknowledged"',
      providerCallIndex,
    );

    expect(sendSource).toContain('"SEND_OUTCOME_UNRESOLVED", 409, true');
    expect(sendSource).toContain('error.operation !== "task.sendMessage"');
    expect(sendSource).toContain("error.outcomeUnknown");
    expect(sendSource).toContain("rejectionProven: true");
    expect(sendSource).toContain(
      'new ChatV2HttpError("SEND_REJECTED", 422, false, true)',
    );
    expect(providerCallIndex).toBeGreaterThanOrEqual(0);
    expect(acknowledgedWriteIndex).toBeGreaterThan(providerCallIndex);
  });

  it("settles only the exact current ordinary-chat turn and authoritative Provider projection", () => {
    const persistenceSource = serverSource.slice(
      serverSource.indexOf("async function persistProviderEvents"),
      serverSource.indexOf("async function cachedOutput"),
    );
    const updateSource = serverSource.slice(
      serverSource.indexOf("async function updateTaskState"),
      serverSource.indexOf("type CreateReconcileEvidence"),
    );
    const settlementSource = serverSource.slice(
      serverSource.indexOf(
        "async function latestGeneralChatTurnSettlementContext",
      ),
      serverSource.indexOf("function persistedConversationResourceId"),
    );

    expect(updateSource).toContain("turnId?: string");
    expect(updateSource).toContain("conversationId?: string");
    expect(updateSource).toContain("eq(conversationTurns.id, targetTurn.id)");
    expect(updateSource).toContain(
      "eq(conversationTurns.conversationId, targetTurn.conversationId)",
    );
    expect(updateSource).toContain(
      "return { applied: false as const, superseded: true as const }",
    );
    expect(updateSource).toContain(
      "return { applied: true as const, superseded: false as const }",
    );
    expect(
      updateSource.indexOf(
        "return { applied: false as const, superseded: true as const }",
      ),
    ).toBeLessThan(updateSource.indexOf("const lockedOperation"));
    expect(updateSource).toContain("desc(messages.sequence)");
    expect(updateSource).toContain('eq(messages.role, "user")');
    expect(updateSource).not.toContain("inArray(conversations.id");
    expect(persistenceSource).toContain("generalChatProviderEventEvidence");
    expect(persistenceSource).toContain("status_update:");
    expect(persistenceSource).toContain("error_message:");
    expect(persistenceSource).toContain("user_stop:");
    expect(settlementSource).toContain("providerEventWatermark");
    expect(settlementSource).toContain("latestGeneralChatTurnLifecycle");
    expect(settlementSource).toContain("if (stateUpdate.superseded)");
    expect(settlementSource).toContain("return findOwnedTask(input)");
    expect(settlementSource).toContain("desc(messages.sequence)");
    expect(settlementSource).not.toContain("desc(conversationTurns.createdAt)");
    expect(settlementSource).toContain(
      '["completed", "cancelled"].includes(latestTurn.status)',
    );
    expect(settlementSource).toContain(
      "currentGeneralChatTurnProviderEvidence",
    );
    expect(settlementSource).toContain("generalChat?.serverOwned === true");
    expect(settlementSource).toContain(
      'generalChat.kind === "assistant_projection"',
    );
    expect(settlementSource).toContain(
      "generalChat.agentTaskId === input.localTaskId",
    );
  });

  it("persists URL-only evidence before assigning turns and hides stale projections", () => {
    const evidenceSource = serverSource.slice(
      serverSource.indexOf("async function ensureProviderEventRows"),
      serverSource.indexOf("async function cachedOutput"),
    );
    const projectionSource = serverSource.slice(
      serverSource.indexOf("async function persistAssistantProjection"),
      serverSource.indexOf("const providerAttachmentEvidenceInFlight"),
    );
    const preseed = evidenceSource.indexOf("ensureProviderEventRows({");
    const claim = evidenceSource.indexOf("claimProviderProjectionSnapshot({");
    const durable = evidenceSource.indexOf(
      "persistProviderUserEventEvidence({",
    );
    const assign = evidenceSource.indexOf(
      "const eventTurnState = providerEventTurnAssignments(",
      durable,
    );
    const hide = evidenceSource.indexOf(
      "const applied = await applyProviderProjectionSnapshot({",
      assign,
    );

    expect(evidenceSource).toContain(
      "arbitrateFirstDurableGeneralChatProviderAttachmentEvidence",
    );
    expect(evidenceSource).toContain('.for("update")');
    expect(serverSource).toContain('eq(localAssets.scope, "managed_user")');
    expect(serverSource).toContain(
      "eq(localAssets.accountUserId, input.userId)",
    );
    expect(serverSource).toContain("localAssets.retainUntil");
    expect(serverSource).toContain(
      "bindGeneralChatLocalManifestToProviderFiles(",
    );
    expect(preseed).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(preseed);
    expect(durable).toBeGreaterThan(preseed);
    expect(assign).toBeGreaterThan(durable);
    expect(hide).toBeGreaterThan(assign);
    expect(evidenceSource).toContain("generalChat?.serverOwned !== true");
    expect(evidenceSource).toContain(
      'generalChat.kind !== "assistant_projection"',
    );
    expect(evidenceSource).toContain(
      "generalChat.agentTaskId !== input.taskId",
    );
    expect(evidenceSource).toContain(".set({ deletedAt: new Date() })");
    expect(projectionSource).toContain("deletedAt: null");
    expect(serverSource).not.toContain("forcedAssistantProjection");
    expect(serverSource).not.toContain("syncGeneralChatTaskForRepair");
  });

  it("fences every projection snapshot with one task generation transaction", () => {
    const claimSource = serverSource.slice(
      serverSource.indexOf("async function claimProviderProjectionSnapshot"),
      serverSource.indexOf("async function ensureProviderEventRows"),
    );
    const applySource = serverSource.slice(
      serverSource.indexOf("async function applyProviderProjectionSnapshot"),
      serverSource.indexOf("async function persistProviderEvents"),
    );
    const syncSource = serverSource.slice(
      serverSource.indexOf("async function syncTask"),
      serverSource.indexOf("function persistedConversationResourceId"),
    );

    expect(claimSource).toContain('kind: "local_projection_snapshot"');
    expect(claimSource).toContain("claimEventIds: snapshot.eventIds");
    expect(claimSource).toContain("claimSnapshotHash: snapshot.snapshotHash");
    expect(claimSource).toContain("claimMaxProviderTimestampMs");
    expect(claimSource).not.toContain("promptSha256");
    expect(claimSource).not.toContain("providerAttachmentEvidence");
    expect(claimSource).toContain('.for("update")');
    expect(applySource).toContain("db.transaction(async (tx)");
    expect(applySource).toContain('.for("update")');
    expect(applySource).toContain("generalChatProjectionClaimMatches({");
    expect(applySource).toContain(
      "await reconcileAssistantProjectionVisibility({",
    );
    expect(applySource).toContain("await persistAssistantProjection({");
    expect(applySource).toContain('status: "applied"');
    expect(syncSource).toContain("if (!persisted.applied)");
  });

  it("stages ordinary Provider payload until the final claim transaction", () => {
    const persistSource = serverSource.slice(
      serverSource.indexOf("async function persistProviderEvents"),
      serverSource.indexOf("async function cachedOutput"),
    );
    const applySource = serverSource.slice(
      serverSource.indexOf("async function applyProviderProjectionSnapshot"),
      serverSource.indexOf("async function persistProviderEvents"),
    );
    const claimCheck = applySource.indexOf(
      "generalChatProjectionClaimMatches({",
    );
    const eventLock = applySource.indexOf(
      "eq(agentEvents.providerEventId, staged.event.id)",
    );
    const payloadWrite = applySource.indexOf(
      "normalizedPayload: {\n            ...staged.normalizedPayload",
    );
    const visibility = applySource.indexOf(
      "await reconcileAssistantProjectionVisibility({",
    );
    const messageWrite = applySource.indexOf(
      "await persistAssistantProjection({",
    );
    const applied = applySource.indexOf('status: "applied"');

    expect(persistSource).toContain(
      "const stagedEvents: GeneralChatStagedProviderEvent[] = []",
    );
    expect(persistSource).toContain("stagedEvents.push({");
    expect(persistSource).not.toContain("await db.transaction(async (tx)");
    const preseedSource = serverSource.slice(
      serverSource.indexOf("async function ensureProviderEventRows"),
      serverSource.indexOf("async function providerEventRows"),
    );
    const preseedDuplicateUpdate = preseedSource.slice(
      preseedSource.indexOf(".onDuplicateKeyUpdate"),
    );
    expect(preseedSource).toContain("set: { providerEventId: event.id }");
    expect(preseedDuplicateUpdate).not.toContain(
      "providerTimestampMs: event.timestamp",
    );
    expect(claimCheck).toBeGreaterThanOrEqual(0);
    expect(eventLock).toBeGreaterThan(claimCheck);
    expect(payloadWrite).toBeGreaterThan(eventLock);
    expect(visibility).toBeGreaterThan(payloadWrite);
    expect(messageWrite).toBeGreaterThan(visibility);
    expect(applied).toBeGreaterThan(messageWrite);
  });

  it("uses the same match and unresolved disposition for unknown sends", () => {
    const sendSource = serverSource.slice(
      serverSource.indexOf("async function sendProviderMessage"),
      serverSource.indexOf("function sendError"),
    );
    expect(sendSource).toContain("await persistProviderEvents({");
    expect(sendSource).toContain("if (!persisted.applied) return false");
    expect(sendSource).toContain("persisted.bindings.get(input.turnId)");
    expect(sendSource).toContain("generalChatProviderEvidenceHasUniqueMatch({");
    expect(sendSource).toContain("unresolvedCount: binding.unresolvedCount");
    expect(sendSource).not.toContain("manusV2EventMatchesGeneralChatRequest");
  });

  it("returns no error for complete success and marks preserved partial output", () => {
    const outputSource = serverSource.slice(
      serverSource.indexOf("async function cachedOutput"),
      serverSource.indexOf("function publicStatus"),
    );
    const dtoSource = serverSource.slice(
      serverSource.indexOf("async function taskDto"),
      serverSource.indexOf("async function updateTaskState"),
    );
    expect(outputSource).toContain("visibleEventProjections");
    expect(outputSource).toContain(".orderBy(messages.sequence)");
    expect(outputSource).toContain("message_id: projection.messageId");
    expect(outputSource).toContain("sent_at_ms: projection.sentAtMs");
    expect(outputSource).toContain("server_sequence: projection.sequence");
    expect(outputSource).toContain("general_chat: projection.generalChat");
    expect(dtoSource).toContain('status === "error" && operation.errorCode');
    expect(dtoSource).toContain("GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE");
    expect(dtoSource).toContain("partialResult: true");
  });

  it("canonicalizes assistant links before persisting either Provider events or server-owned messages", () => {
    const persistSource = serverSource.slice(
      serverSource.indexOf("async function persistProviderEvents"),
      serverSource.indexOf("async function cachedOutput"),
    );
    const projectionSource = serverSource.slice(
      serverSource.indexOf("async function persistAssistantProjection"),
      serverSource.indexOf("const providerAttachmentEvidenceInFlight"),
    );
    expect(persistSource).toContain(
      "canonicalizeGeneralChatAssistantMarkdown(",
    );
    expect(persistSource).toContain("text: canonicalMarkdown.text");
    expect(persistSource).toContain("canonicalText: canonicalMarkdown.text");
    expect(projectionSource).toContain("content: input.text");
    expect(projectionSource).toContain("logGeneralChatAssistantProjection({");
    expect(serverSource).toContain(
      "[FrontMindV2] general-chat assistant projection",
    );
  });

  it("authorizes artifact downloads through the ordinary-chat task, turn, conversation and selected project", () => {
    const routeSource = serverSource.slice(
      serverSource.indexOf(
        'router.get("/artifacts/:artifactId/content", async (req, res) =>',
      ),
      serverSource.indexOf("export default router"),
    );
    expect(routeSource).toContain(".innerJoin(\n          agentTasks");
    expect(routeSource).toContain(".innerJoin(\n          conversationTurns");
    expect(routeSource).toContain(".innerJoin(\n          conversations");
    expect(routeSource).toContain(
      "eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE)",
    );
    expect(routeSource).toContain(
      "eq(conversations.projectAssignmentId, projectAssignmentId)",
    );
    expect(routeSource).toContain("isNull(conversations.projectAssignmentId)");
    expect(routeSource).toContain('"ARTIFACT_NOT_FOUND", 404');
    expect(routeSource).toContain(
      "[FrontMindV2] general-chat artifact download",
    );
  });
});
