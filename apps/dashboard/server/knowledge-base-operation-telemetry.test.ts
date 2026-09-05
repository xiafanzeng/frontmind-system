import { describe, expect, it, vi } from "vitest";

import {
  KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION,
  knowledgeBaseDispatchPhaseTelemetryRecord,
  knowledgeBaseOperationTelemetryRecord,
  logKnowledgeBaseDispatchPhaseTelemetry,
  logKnowledgeBaseOperationTelemetry,
} from "./knowledge-base-operation-telemetry";

describe("knowledge-base operation telemetry", () => {
  it("keeps only bounded identifiers and the prompt contract version", () => {
    expect(
      knowledgeBaseOperationTelemetryRecord({
        event: "turn_replay_hit",
        buildId: "build-1",
        turnId: "turn-1",
        reasonCode: "exact_request",
        adoptedWinner: true,
      }),
    ).toEqual({
      event: "turn_replay_hit",
      promptVersion: KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION,
      buildId: "build-1",
      turnId: "turn-1",
      reasonCode: "exact_request",
      adoptedWinner: true,
    });
  });

  it("drops customer text, URLs and unsafe provider-controlled values", () => {
    const record = knowledgeBaseOperationTelemetryRecord({
      event: "logo_upload_candidate_rejected",
      buildId: "https://customer.example/private path",
      turnId: "turn\nsecret",
      reasonCode: "raw refusal: 客户正文",
    });
    expect(record).toEqual({
      event: "logo_upload_candidate_rejected",
      promptVersion: KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION,
    });
    expect(JSON.stringify(record)).not.toContain("customer.example");
    expect(JSON.stringify(record)).not.toContain("客户正文");
  });

  it("logs only the sanitized record", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logKnowledgeBaseOperationTelemetry({
      event: "initial_logo_degraded_to_upload",
      buildId: "build-2",
      reasonCode: "LOGO_UPLOAD_INVALID",
    });
    expect(info).toHaveBeenCalledWith(
      "[KnowledgeBaseOperation] initial_logo_degraded_to_upload",
      JSON.stringify({
        event: "initial_logo_degraded_to_upload",
        promptVersion: KNOWLEDGE_BASE_PROMPT_CONTRACT_VERSION,
        buildId: "build-2",
        reasonCode: "LOGO_UPLOAD_INVALID",
      }),
    );
    info.mockRestore();
  });

  it("keeps dispatch diagnostics to safe counts, states, trace and stable codes", () => {
    const record = knowledgeBaseDispatchPhaseTelemetryRecord({
      phase: "validate_ledger",
      traceId: "trace-1047",
      errorCode: "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT",
      userCount: 9,
      expectedCount: 11,
      stagedCount: 9,
      generatedReservationCount: 0,
      mappingCount: 0,
      createState: "not_sent",
      filename: "private.pdf",
      content: "customer secret",
      providerId: "provider-secret",
    } as any);
    expect(record).toEqual({
      event: "dispatch_phase",
      phase: "validate_ledger",
      traceId: "trace-1047",
      errorCode: "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT",
      userCount: 9,
      expected: 11,
      staged: 9,
      generatedReservation: 0,
      mapping: 0,
      createState: "not_sent",
    });
    expect(JSON.stringify(record)).not.toContain("private.pdf");
    expect(JSON.stringify(record)).not.toContain("customer secret");
    expect(JSON.stringify(record)).not.toContain("provider-secret");
  });

  it("logs the sanitized dispatch record only", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logKnowledgeBaseDispatchPhaseTelemetry({
      phase: "map",
      traceId: "trace-1047",
      mappingCount: 11,
      createState: "not_sent",
    });
    expect(info).toHaveBeenCalledWith(
      "[KnowledgeBaseDispatch] map",
      JSON.stringify({
        event: "dispatch_phase",
        phase: "map",
        traceId: "trace-1047",
        mapping: 11,
        createState: "not_sent",
      }),
    );
    info.mockRestore();
  });
});
