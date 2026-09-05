import { describe, expect, it } from "vitest";

import { collectKnowledgeArchiveDescriptors } from "./knowledge-base-artifact";
import {
  createKnowledgeBaseAuthoritativeFinalOutput,
  deriveKnowledgeBaseAuthoritativeFinalizationPlan,
  hasKnowledgeBaseCompleteFinalProtocol,
  selectKnowledgeBaseAuthoritativeFinalDescriptor,
} from "./knowledge-base-finalization";
import {
  parseKnowledgeBasePresentationEnvelope,
  parseKnowledgeBaseProgressEnvelope,
} from "./knowledge-base-progress";

function fixture() {
  const build = {
    skillVersion: "4" as const,
    status: "confirming" as const,
    generation: 1,
    stateEpoch: 9,
    revision: 46,
    currentLeafId: "7.2",
    totalNodeCount: 2,
    lastTurnAttachmentCount: 0,
    upstreamTaskId: "task-final",
  };
  const activeTurn = {
    id: "turn-final",
    operationKey: "kbv2-final",
    operationType: "retry" as const,
    buildGeneration: 1,
    expectedRevision: 46,
    expectedLeafId: "7.2",
    upstreamTaskId: "task-final",
    status: "running" as const,
  };
  const nodes = [
    {
      leafId: "1.1",
      title: "一句话定位",
      branchId: "identity",
      branchTitle: "企业身份",
      ordinal: 0,
      status: "confirmed",
      contentMarkdown: "## 1.1 一句话定位\n\n已确认。",
      contentSha256: "a".repeat(64),
    },
    {
      leafId: "7.2",
      title: "技术支持与服务体系",
      branchId: "cooperation",
      branchTitle: "合作、交付与支持",
      ordinal: 1,
      status: "current",
      contentMarkdown: "## 7.2 技术支持与服务体系\n\n待确认。",
      contentSha256: "b".repeat(64),
    },
  ];
  return { build, activeTurn, nodes };
}

function malformedLegacyFinalOutput(overrides?: Record<string, unknown>) {
  return [
    {
      id: "assistant-final",
      role: "assistant",
      type: "output_message",
      ...overrides,
      content: [
        {
          type: "output_text",
          text: {
            value:
              '<!-- FRONTMIND_KB_PROGRESS\n{"schemaVersion":4,"revision":47,"node":"7.2","status":"confirmed","action":"final_package","validationResult":"VALID"}\n-->',
          },
        },
        {
          type: "output_file",
          file_id: "file-final",
          file_name: "knowledge-base-final.zip",
          mime_type: "application/zip",
        },
      ],
    },
  ];
}

describe("authoritative final knowledge-base completion", () => {
  it("derives the final retry transition from durable server state", () => {
    const input = fixture();
    expect(
      deriveKnowledgeBaseAuthoritativeFinalizationPlan({
        ...input,
        transitionTarget: "confirmed",
      }),
    ).toEqual({
      operationId: "kbv2-final",
      turnId: "turn-final",
      taskId: "task-final",
      generation: 1,
      revision: 46,
      nextRevision: 47,
      leafId: "7.2",
      from: "current",
      to: "confirmed",
      reason: "用户明确确认",
    });
  });

  it("recovers one physical ZIP when only the model text protocol is malformed", () => {
    const input = fixture();
    const plan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
      ...input,
      transitionTarget: "confirmed",
    })!;
    const output = malformedLegacyFinalOutput();
    const descriptor = selectKnowledgeBaseAuthoritativeFinalDescriptor({
      output,
      scopedOutput: [],
      plan,
    });
    expect(descriptor).toMatchObject({
      fileId: "file-final",
      filename: "knowledge-base-final.zip",
      mimeType: "application/zip",
    });

    const authoritative = createKnowledgeBaseAuthoritativeFinalOutput({
      descriptor: descriptor!,
      plan,
    });
    const protocolText = (
      authoritative[0]!.content[0]!.text as { value: string }
    ).value;
    expect(parseKnowledgeBaseProgressEnvelope(protocolText)).toMatchObject({
      schemaVersion: 2,
      operationId: "kbv2-final",
      turnId: "turn-final",
      revision: 46,
      transition: { leafId: "7.2", from: "current", to: "confirmed" },
    });
    expect(parseKnowledgeBasePresentationEnvelope(protocolText)).toMatchObject({
      schemaVersion: 2,
      revision: 47,
      leafId: null,
      imageState: "not_applicable",
    });
    expect(
      hasKnowledgeBaseCompleteFinalProtocol({
        assistantText: protocolText,
        plan,
      }),
    ).toBe(true);
    expect(collectKnowledgeArchiveDescriptors(authoritative)).toHaveLength(1);
  });

  it("rejects a legacy type=file projection during malformed-protocol recovery", () => {
    const input = fixture();
    const plan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
      ...input,
      transitionTarget: "confirmed",
    })!;
    const output = malformedLegacyFinalOutput();
    output[0]!.content[1]!.type = "file";

    expect(() =>
      selectKnowledgeBaseAuthoritativeFinalDescriptor({
        output,
        scopedOutput: [],
        plan,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID" }));
  });

  it("rejects an extra non-text resource before repairing malformed protocol text", () => {
    const input = fixture();
    const plan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
      ...input,
      transitionTarget: "confirmed",
    })!;
    const output = malformedLegacyFinalOutput();
    output[0]!.content.push({
      type: "output_file",
      file_id: "file-extra",
      file_name: "extra.pdf",
      mime_type: "application/pdf",
    });

    expect(() =>
      selectKnowledgeBaseAuthoritativeFinalDescriptor({
        output,
        scopedOutput: [],
        plan,
      }),
    ).toThrowError(expect.objectContaining({ code: "AMBIGUOUS" }));
  });

  it("does not treat the legacy schema-v4 archive summary as final protocol", () => {
    const input = fixture();
    const plan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
      ...input,
      transitionTarget: "confirmed",
    })!;
    const legacyText = (
      malformedLegacyFinalOutput()[0]!.content[0]!.text as { value: string }
    ).value;
    expect(
      hasKnowledgeBaseCompleteFinalProtocol({
        assistantText: legacyText,
        plan,
      }),
    ).toBe(false);
  });

  it("rejects a ZIP item that explicitly claims another operation", () => {
    const input = fixture();
    const plan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
      ...input,
      transitionTarget: "confirmed",
    })!;
    expect(
      selectKnowledgeBaseAuthoritativeFinalDescriptor({
        output: malformedLegacyFinalOutput({ operationId: "kbv2-other" }),
        scopedOutput: [],
        plan,
      }),
    ).toBeNull();
  });

  it("rejects identity claims with leading or trailing whitespace instead of normalizing them", () => {
    const input = fixture();
    const plan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
      ...input,
      transitionTarget: "confirmed",
    })!;

    for (const claim of [
      { operationId: " kbv2-final" },
      { turnId: "turn-final " },
      { taskId: " task-final " },
    ]) {
      expect(
        selectKnowledgeBaseAuthoritativeFinalDescriptor({
          output: malformedLegacyFinalOutput(claim),
          scopedOutput: [],
          plan,
        }),
      ).toBeNull();
    }
  });

  it("does not derive authority from whitespace-normalized durable identities", () => {
    const input = fixture();
    expect(
      deriveKnowledgeBaseAuthoritativeFinalizationPlan({
        ...input,
        activeTurn: {
          ...input.activeTurn,
          operationKey: " kbv2-final",
        },
        transitionTarget: "confirmed",
      }),
    ).toBeNull();
    expect(
      deriveKnowledgeBaseAuthoritativeFinalizationPlan({
        ...input,
        build: { ...input.build, upstreamTaskId: "task-final " },
        activeTurn: {
          ...input.activeTurn,
          upstreamTaskId: "task-final ",
        },
        transitionTarget: "confirmed",
      }),
    ).toBeNull();
  });

  it("selects only the ZIP nested in the latest malformed final message", () => {
    const input = fixture();
    const plan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
      ...input,
      transitionTarget: "confirmed",
    })!;
    const current = malformedLegacyFinalOutput();
    const stale = malformedLegacyFinalOutput();
    stale[0]!.id = "assistant-old";
    stale[0]!.content[1]!.file_id = "file-old";

    expect(
      selectKnowledgeBaseAuthoritativeFinalDescriptor({
        output: [...stale, ...current],
        scopedOutput: [],
        plan,
      }),
    ).toMatchObject({ fileId: "file-final" });
  });

  it("does not reuse an older nested ZIP when the latest final message has none", () => {
    const input = fixture();
    const plan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
      ...input,
      transitionTarget: "confirmed",
    })!;
    const stale = malformedLegacyFinalOutput();
    stale[0]!.id = "assistant-old";
    stale[0]!.content[1]!.file_id = "file-old";
    const current = malformedLegacyFinalOutput();
    current[0]!.content.pop();

    expect(
      selectKnowledgeBaseAuthoritativeFinalDescriptor({
        output: [...stale, ...current],
        scopedOutput: [],
        plan,
      }),
    ).toBeNull();
  });

  it("does not lend an independent unscoped ZIP to malformed final text", () => {
    const input = fixture();
    const plan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
      ...input,
      transitionTarget: "confirmed",
    })!;
    const malformed = malformedLegacyFinalOutput();
    const detached = malformed[0]!.content.pop()!;

    expect(
      selectKnowledgeBaseAuthoritativeFinalDescriptor({
        output: [
          ...malformed,
          {
            id: "detached-old-package",
            role: "assistant",
            type: "output_file",
            ...detached,
          },
        ],
        scopedOutput: [],
        plan,
      }),
    ).toBeNull();
  });

  it("does not authorize a non-final or attachment-bearing turn", () => {
    const input = fixture();
    expect(
      deriveKnowledgeBaseAuthoritativeFinalizationPlan({
        ...input,
        build: { ...input.build, lastTurnAttachmentCount: 1 },
        transitionTarget: "confirmed",
      }),
    ).toBeNull();
    expect(
      deriveKnowledgeBaseAuthoritativeFinalizationPlan({
        ...input,
        nodes: input.nodes.map((node, index) =>
          index === 0 ? { ...node, status: "current" } : node,
        ),
        transitionTarget: "confirmed",
      }),
    ).toBeNull();
  });
});
