import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { siteContentPlanWireV2Schema } from "../../shared/siteops-content-plan";
import {
  resolveSiteOpsWireOutput as resolveWireOutput,
  SITEOPS_WIRE_OUTPUT_FILES,
  SiteOpsWireOutputResolutionError,
} from "./manus-wire-output-resolver";

const token = "siteops-design:10000000-0000-4000-8000-000000000001";

function resolveSiteOpsWireOutput(
  input: Omit<
    Parameters<typeof resolveWireOutput>[0],
    "phase" | "expectedFilename"
  >,
) {
  return resolveWireOutput({
    ...input,
    phase: "design",
    expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.design,
  });
}

function marker(operationToken = token, timestamp = 1) {
  return {
    id: `marker-${timestamp}`,
    type: "user_message",
    timestamp,
    user_message: {
      content: `instruction\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken })}`,
    },
  };
}

function rejected(timestamp = 2) {
  return {
    id: `rejected-${timestamp}`,
    type: "structured_output_result",
    timestamp,
    structured_output_result: {
      success: false,
      value: 0,
      error: "structured extraction failed",
    },
  };
}

function rejectedWithoutValue(timestamp = 2) {
  return {
    id: `rejected-no-value-${timestamp}`,
    type: "structured_output_result",
    timestamp,
    structured_output_result: {
      success: false,
      error: "structured extraction failed",
    },
  };
}

function assistant(
  input: { content?: unknown; attachments?: unknown[] },
  timestamp = 3,
) {
  return {
    id: `assistant-${timestamp}`,
    type: "assistant_message",
    timestamp,
    assistant_message: input,
  };
}

function accepted(value: unknown, timestamp = 3) {
  return {
    id: `structured-${timestamp}`,
    type: "structured_output_result",
    timestamp,
    structured_output_result: { success: true, value },
  };
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      ...headers,
    },
  });
}

describe("SiteOps wire output resolver", () => {
  it("accepts the exact V2 content-plan attachment in the design phase while preserving strict validation", async () => {
    const planToken =
      "siteops-content-plan:10000000-0000-4000-8000-000000000001:0";
    const value = {
      wireSchemaVersion: 2,
      operationToken: planToken,
      inventorySha256: "a".repeat(64),
      routes: [
        {
          routeId: "home",
          path: "/",
          title: "首页",
          navigation: "primary",
          parentPath: null,
          detailOfPath: null,
          purpose: "介绍企业",
          userQuestions: ["企业提供什么？"],
          h1: "星河智造",
          summary: "可信的设备服务。",
          ctaLabel: null,
          ctaTargetPath: null,
        },
      ],
      sections: [
        {
          routeId: "home",
          sectionId: "overview",
          blockKind: "prose",
          heading: "企业简介",
          purpose: "呈现企业事实",
          body: "星河智造提供设备服务。",
          sourceDocumentIds: ["overview"],
          evidenceExcerpts: ["星河智造提供设备服务。"],
          mediaIds: [],
          entityIds: [],
          faqIds: [],
        },
      ],
      navigation: [{ label: "首页", targetPath: "/" }],
      coverage: [
        {
          sourceDocumentId: "overview",
          status: "used",
          routeIds: ["home"],
          omissionReason: null,
        },
      ],
    };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/content-plan.json"),
    }));

    const events = [
      marker(planToken),
      {
        id: "rejected-content-plan",
        type: "structured_output_result",
        timestamp: 2,
        structured_output_result: {
          success: false,
          value: [],
          error: "structured extraction returned an empty array",
        },
      },
      assistant({
        attachments: [
          {
            filename: "frontmind_site_content_plan_v2_repair_1.json",
            content_type: "application/json",
            url: "https://files.example.test/content-plan.json",
          },
        ],
      }),
    ] as never;
    await expect(
      resolveWireOutput({
        events,
        operationToken: planToken,
        phase: "design",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.contentPlanV2,
        taskCompleted: false,
        fetchPinned: fetchPinned as never,
        validateCandidate: (candidate) => {
          siteContentPlanWireV2Schema.parse(candidate);
        },
      }),
    ).resolves.toBeNull();
    expect(fetchPinned).not.toHaveBeenCalled();

    await expect(
      resolveWireOutput({
        events,
        operationToken: planToken,
        phase: "design",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.contentPlanV2,
        taskCompleted: false,
        acceptCurrentPhaseWhileRunning: true,
        fetchPinned: fetchPinned as never,
        validateCandidate: (candidate) => {
          siteContentPlanWireV2Schema.parse(candidate);
        },
      }),
    ).resolves.toMatchObject({ value, source: "attachment" });
    expect(fetchPinned).toHaveBeenCalledTimes(1);
  });

  it("rejects a token-bound nested alias payload instead of adapting it into SiteContentPlanWireV2", async () => {
    const planToken =
      "siteops-content-plan:10000000-0000-4000-8000-000000000001:1";
    const aliasPayload = {
      wireSchemaVersion: 2,
      operationToken: planToken,
      inventorySha256: "a".repeat(64),
      routes: [
        {
          id: "home",
          slug: "/",
          sections: [
            {
              id: "overview",
              sourceBindings: [{ documentId: "overview" }],
            },
          ],
        },
      ],
      navigation: [],
      coverages: [{ documentId: "overview", status: "used", routes: ["home"] }],
    };

    await expect(
      resolveWireOutput({
        events: [marker(planToken), accepted(aliasPayload)] as never,
        operationToken: planToken,
        phase: "design",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.contentPlanV2,
        taskCompleted: false,
        acceptCurrentPhaseWhileRunning: true,
        validateCandidate: (candidate) => {
          siteContentPlanWireV2Schema.parse(candidate);
        },
      }),
    ).rejects.toMatchObject({ code: "SITEOPS_WIRE_OUTPUT_INVALID" });
  });

  it("uses the content-plan 16 MiB budget instead of the design 256 KiB budget", async () => {
    const planToken =
      "siteops-content-plan:10000000-0000-4000-8000-000000000001:0";
    const value = {
      wireSchemaVersion: 2,
      operationToken: planToken,
      inventorySha256: "a".repeat(64),
      routes: [
        {
          routeId: "home",
          path: "/",
          title: "首页",
          navigation: "primary",
          parentPath: null,
          detailOfPath: null,
          purpose: "介绍企业",
          userQuestions: [],
          h1: "星河智造",
          summary: "可信的设备服务。",
          ctaLabel: null,
          ctaTargetPath: null,
        },
      ],
      sections: Array.from({ length: 16 }, (_, index) => ({
        routeId: "home",
        sectionId: `section-${index}`,
        blockKind: "prose",
        heading: `企业资料 ${index}`,
        purpose: "呈现有来源的企业资料",
        body: "资".repeat(19_000),
        sourceDocumentIds: ["overview"],
        evidenceExcerpts: ["星河智造提供设备服务。"],
        mediaIds: [],
        entityIds: [],
        faqIds: [],
      })),
      navigation: [{ label: "首页", targetPath: "/" }],
      coverage: [
        {
          sourceDocumentId: "overview",
          status: "used",
          routeIds: ["home"],
          omissionReason: null,
        },
      ],
    };
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeGreaterThan(
      256 * 1024,
    );

    await expect(
      resolveWireOutput({
        events: [marker(planToken), accepted(value)] as never,
        operationToken: planToken,
        phase: "design",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.contentPlanV2,
        taskCompleted: false,
        acceptCurrentPhaseWhileRunning: true,
        validateCandidate: (candidate) => {
          siteContentPlanWireV2Schema.parse(candidate);
        },
      }),
    ).resolves.toMatchObject({ value, source: "structured" });
  });

  it("accepts the exact V3 design filename when the React workflow requests it", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 3,
      siteTitle: "可信 React 静态官网",
    };
    await expect(
      resolveWireOutput({
        events: [marker(), accepted(value)] as never,
        operationToken: token,
        phase: "design",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.designV3,
        taskCompleted: true,
      }),
    ).resolves.toMatchObject({ value, source: "structured" });
  });

  it("uses the strict attachment fallback after rejection without a value", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 2,
      siteTitle: "可信",
    };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));
    await expect(
      resolveSiteOpsWireOutput({
        events: [
          marker(),
          rejectedWithoutValue(),
          assistant({
            attachments: [
              {
                filename: SITEOPS_WIRE_OUTPUT_FILES.design,
                content_type: "application/json",
                url: "https://files.example.test/result.json",
              },
            ],
          }),
        ] as never,
        operationToken: token,
        taskCompleted: true,
        fetchPinned: fetchPinned as never,
      }),
    ).resolves.toMatchObject({ value, source: "attachment" });
  });

  it("waits for phase completion before accepting an explicit structured success", async () => {
    const fetchPinned = vi.fn();
    const value = {
      operationToken: token,
      schemaVersion: 1,
      siteTitle: "可信",
    };
    const result = await resolveSiteOpsWireOutput({
      events: [marker(), accepted(value)] as never,
      operationToken: token,
      taskCompleted: false,
      fetchPinned: fetchPinned as never,
    });

    expect(result).toBeNull();
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("allows only an explicit native caller to accept a token-bound receipt while running", async () => {
    const nativeToken =
      "siteops-native-source:10000000-0000-4000-8000-000000000001:1";
    const value = {
      operationToken: nativeToken,
      baseSourceSha256: "a".repeat(64),
      archiveSha256: "b".repeat(64),
      fileCount: 107,
    };
    const events = [marker(nativeToken), accepted(value)] as never;

    await expect(
      resolveWireOutput({
        events,
        operationToken: nativeToken,
        phase: "design",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.sourceReceiptV1,
        taskCompleted: false,
        acceptCurrentPhaseWhileRunning: true,
      }),
    ).resolves.toMatchObject({ value, source: "structured" });

    await expect(
      resolveWireOutput({
        events,
        operationToken: nativeToken,
        phase: "design",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.sourceReceiptV1,
        taskCompleted: false,
      }),
    ).resolves.toBeNull();

    await expect(
      resolveSiteOpsWireOutput({
        events,
        operationToken: nativeToken,
        taskCompleted: false,
        acceptCurrentPhaseWhileRunning: true,
      }),
    ).resolves.toBeNull();
  });

  it("accepts an explicitly enabled content-patch result while the task is still running", async () => {
    const contentToken = "siteops-content:10000000-0000-4000-8000-000000000001";
    const value = {
      wireSchemaVersion: 1,
      operationToken: contentToken,
      baseSourceSha256: "a".repeat(64),
      slots: [],
    };
    const events = [marker(contentToken), accepted(value)] as never;

    await expect(
      resolveWireOutput({
        events,
        operationToken: contentToken,
        phase: "content",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.contentPatchV1,
        taskCompleted: false,
        acceptCurrentPhaseWhileRunning: true,
      }),
    ).resolves.toMatchObject({ value, source: "structured" });

    await expect(
      resolveWireOutput({
        events,
        operationToken: contentToken,
        phase: "content",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.contentPatchV1,
        taskCompleted: false,
      }),
    ).resolves.toBeNull();
  });

  it("prefers an explicit structured success after the task stops", async () => {
    const fetchPinned = vi.fn();
    const value = {
      operationToken: token,
      schemaVersion: 2,
      siteTitle: "可信",
    };
    const result = await resolveSiteOpsWireOutput({
      events: [marker(), accepted(value)] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
    });

    expect(result).toMatchObject({ value, source: "structured" });
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("does not treat a zero extraction value as success or inspect fallback while running", async () => {
    const fetchPinned = vi.fn();
    const result = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        rejected(),
        assistant({
          attachments: [
            {
              filename: SITEOPS_WIRE_OUTPUT_FILES.design,
              content_type: "application/json",
              url: "https://files.example.test/result.json?token=secret",
            },
          ],
        }),
      ] as never,
      operationToken: token,
      taskCompleted: false,
      fetchPinned: fetchPinned as never,
    });

    expect(result).toBeNull();
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("accepts a stopped URL-only JSON attachment without file_id and never returns its signed URL", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 1,
      siteTitle: "可信",
    };
    const signedUrl =
      "https://files.example.test/result.json?signature=do-not-persist";
    const fetchPinned = vi.fn(async (input: { url: string }) => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
      observedUrl: input.url,
    }));
    const result = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        rejected(),
        assistant({
          attachments: [
            {
              filename: SITEOPS_WIRE_OUTPUT_FILES.design,
              url: signedUrl,
            },
          ],
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
    });

    expect(result).toMatchObject({ value, source: "attachment" });
    expect(fetchPinned.mock.calls[0]![0].url).toBe(signedUrl);
    expect(fetchPinned.mock.calls[0]![0]).toMatchObject({
      maxRedirects: 3,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
      },
    });
    expect(JSON.stringify(result)).not.toContain("do-not-persist");
  });

  it("accepts the narrow provider filename normalization and repair suffix seen in production", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 2,
      siteTitle: "可信",
    };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));

    const result = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        rejected(),
        assistant({
          attachments: [
            {
              filename: "frontmind_site_design_wire_v2_repair_1.json",
              content_type: "application/json",
              url: "https://files.example.test/result.json?signature=secret",
            },
          ],
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
    });

    expect(result).toMatchObject({ value, source: "attachment" });
  });

  it("normalizes only the requested PageContentWire V3 attachment stem", async () => {
    const contentToken = "siteops-content:10000000-0000-4000-8000-000000000001";
    const value = { operationToken: contentToken, schemaVersion: 3 };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/content-v3.json"),
    }));

    await expect(
      resolveWireOutput({
        events: [
          marker(contentToken),
          rejected(),
          assistant({
            attachments: [
              {
                filename: "frontmind_page_content_wire_v3_repair_2.json",
                content_type: "application/json",
                url: "https://files.example.test/content-v3.json",
              },
            ],
          }),
        ] as never,
        operationToken: contentToken,
        phase: "content",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.contentV3,
        taskCompleted: true,
        fetchPinned: fetchPinned as never,
      }),
    ).resolves.toMatchObject({ value, source: "attachment" });
  });

  it("accepts valid assistant JSON without requiring provider rejection but keeps the exact token window", async () => {
    const fetchPinned = vi.fn();
    const body = JSON.stringify({ operationToken: token, schemaVersion: 1 });
    const resultWithoutRejection = await resolveSiteOpsWireOutput({
      events: [marker(), assistant({ content: body })] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
    });
    const resultFromOldWindow = await resolveSiteOpsWireOutput({
      events: [
        marker(token, 1),
        rejected(2),
        assistant({ content: body }, 3),
        marker("siteops-content:other", 4),
      ] as never,
      operationToken: "siteops-content:other",
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
    });

    expect(resultWithoutRejection).toMatchObject({
      source: "assistant_json",
      value: JSON.parse(body),
    });
    expect(resultFromOldWindow).toBeNull();
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("reports assistant JSON validation instead of a rejected structured-output placeholder", async () => {
    const placeholder = { operationToken: token, kind: "placeholder" };
    const assistantValue = { operationToken: token, kind: "assistant" };

    await expect(
      resolveSiteOpsWireOutput({
        events: [
          marker(),
          {
            id: "rejected-placeholder",
            type: "structured_output_result",
            timestamp: 2,
            structured_output_result: {
              success: false,
              error: "Failed to extract structured output",
              value: placeholder,
            },
          },
          assistant({ content: JSON.stringify(assistantValue) }),
        ] as never,
        operationToken: token,
        taskCompleted: true,
        validateCandidate: (value, source) => {
          throw new Error(`${source}:${String(value.kind)}`);
        },
      }),
    ).rejects.toMatchObject({
      code: "SITEOPS_WIRE_OUTPUT_INVALID",
      validationError: { message: "assistant_json:assistant" },
      validationCandidate: { source: "assistant_json" },
    });
  });

  it("does not let a structured-result token cut the user-message causal window", async () => {
    const value = { operationToken: token, schemaVersion: 2 };
    const result = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        rejected(),
        accepted(
          {
            operationToken: "siteops-content:other",
            schemaVersion: 2,
          },
          3,
        ),
        assistant({ content: JSON.stringify(value) }, 4),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });

    expect(result).toMatchObject({ value, source: "assistant_json" });
  });

  it("ignores URL attachments without a phase-owned filename", async () => {
    const fetchPinned = vi.fn();
    for (const attachment of [
      { url: "https://files.example.test/result.json" },
      {
        filename: "arbitrary-result.json",
        content_type: "application/json",
        url: "https://files.example.test/result.json",
      },
    ]) {
      await expect(
        resolveSiteOpsWireOutput({
          events: [
            marker(),
            rejectedWithoutValue(),
            assistant({ attachments: [attachment] }),
          ] as never,
          operationToken: token,
          taskCompleted: true,
          fetchPinned: fetchPinned as never,
        }),
      ).resolves.toBeNull();
    }
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("accepts only whole JSON or one pure json fence from assistant text", async () => {
    const value = { operationToken: token, schemaVersion: 1 };
    const whole = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        assistant({ content: JSON.stringify(value) }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });
    const fenced = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        assistant({ content: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });
    const directObject = await resolveSiteOpsWireOutput({
      events: [marker(), assistant({ content: value })] as never,
      operationToken: token,
      taskCompleted: true,
    });
    const prose = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        assistant({
          content: `结果如下：\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });

    expect(whole?.source).toBe("assistant_json");
    expect(fenced?.source).toBe("assistant_json");
    expect(directObject?.source).toBe("assistant_json");
    expect(prose).toBeNull();
  });

  it("normalizes BOM, CRLF JSON fences and one stringified JSON layer", async () => {
    const value = { operationToken: token, schemaVersion: 1 };
    const bom = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        assistant({ content: `\uFEFF${JSON.stringify(value)}` }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });
    const fenced = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        assistant({
          content: `\`\`\`json\r\n${JSON.stringify(value)}\r\n\`\`\``,
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });
    const doubleEncoded = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        assistant({ content: JSON.stringify(JSON.stringify(value)) }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
    });

    expect(bom).toMatchObject({ value, normalizations: ["bom"] });
    expect(fenced).toMatchObject({
      value,
      normalizations: ["json_fence"],
    });
    expect(doubleEncoded).toMatchObject({
      value,
      normalizations: ["double_encoded"],
    });
  });

  it("repairs only bounded JSON transport damage before token validation", async () => {
    const damaged = `{operationToken:${JSON.stringify(token)},"schemaVersion":1,"siteTitle":"line one
line two\\q",}`;
    const result = await resolveSiteOpsWireOutput({
      events: [marker(), assistant({ content: damaged })] as never,
      operationToken: token,
      taskCompleted: true,
    });

    expect(result).toMatchObject({
      value: {
        operationToken: token,
        schemaVersion: 1,
        siteTitle: "line one\nline two\\q",
      },
      normalizations: ["json_repair"],
    });

    const wrongToken = damaged.replace(token, "siteops-design:other");
    await expect(
      resolveSiteOpsWireOutput({
        events: [marker(), assistant({ content: wrongToken })] as never,
        operationToken: token,
        taskCompleted: true,
      }),
    ).rejects.toMatchObject({ code: "SITEOPS_WIRE_OUTPUT_INVALID" });
  });

  it("validates rejected structured values and merges identical production fallback sources", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 2,
      siteTitle: "可信",
    };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));
    const resolution = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        {
          id: "production-rejected-value",
          type: "structured_output_result",
          timestamp: 2,
          structured_output_result: {
            success: false,
            value,
            error: { code: "schema_extraction_failed" },
          },
        },
        assistant({
          content: value,
          attachments: [
            {
              filename: SITEOPS_WIRE_OUTPUT_FILES.design,
              content_type: "application/json",
              url: "https://files.example.test/result.json",
            },
          ],
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
      validateCandidate: (candidate) => {
        if (candidate.schemaVersion !== 2) throw new Error("invalid");
      },
    });

    expect(resolution).toMatchObject({
      value,
      source: "structured",
      sources: ["structured", "assistant_json", "attachment"],
    });
    expect(resolution?.byteCount).toBeGreaterThan(0);
  });

  it("drops schema-invalid sources before conflict comparison", async () => {
    const invalid = { operationToken: token, schemaVersion: 1, siteTitle: "A" };
    const valid = { operationToken: token, schemaVersion: 2, siteTitle: "B" };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(valid),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));
    const resolution = await resolveSiteOpsWireOutput({
      events: [
        marker(),
        accepted(invalid),
        assistant({
          attachments: [
            {
              filename: SITEOPS_WIRE_OUTPUT_FILES.design,
              content_type: "application/json",
              url: "https://files.example.test/result.json",
            },
          ],
        }),
      ] as never,
      operationToken: token,
      taskCompleted: true,
      fetchPinned: fetchPinned as never,
      validateCandidate: (candidate) => {
        if (candidate.schemaVersion !== 2)
          throw new Error("WIRE_SCHEMA_INVALID");
      },
    });

    expect(resolution).toMatchObject({ value: valid, source: "attachment" });
  });

  it("treats a locally valid accepted structured result as authoritative", async () => {
    const first = { operationToken: token, schemaVersion: 1, siteTitle: "A" };
    const second = { operationToken: token, schemaVersion: 1, siteTitle: "B" };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(second),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));

    await expect(
      resolveSiteOpsWireOutput({
        events: [
          marker(),
          accepted(first),
          assistant({
            attachments: [
              {
                filename: SITEOPS_WIRE_OUTPUT_FILES.design,
                content_type: "application/json",
                url: "https://files.example.test/result.json",
              },
            ],
          }),
        ] as never,
        operationToken: token,
        taskCompleted: true,
        fetchPinned: fetchPinned as never,
      }),
    ).resolves.toMatchObject({ value: first, source: "structured" });
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("returns a safe fallback signal when non-authoritative valid sources conflict", async () => {
    const first = { operationToken: token, schemaVersion: 1, siteTitle: "A" };
    const second = { operationToken: token, schemaVersion: 1, siteTitle: "B" };

    await expect(
      resolveSiteOpsWireOutput({
        events: [
          marker(),
          {
            id: "rejected-with-value",
            type: "structured_output_result",
            timestamp: 2,
            structured_output_result: {
              success: false,
              value: first,
              error: "structured extraction failed",
            },
          },
          assistant({ content: second }),
        ] as never,
        operationToken: token,
        taskCompleted: true,
      }),
    ).rejects.toMatchObject({
      code: "SITEOPS_WIRE_OUTPUT_FALLBACK_REQUIRED",
    });
  });

  it("enforces response MIME, root object, UTF-8 and a declared raw hash", async () => {
    const value = { operationToken: token, schemaVersion: 1 };
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const baseEvents = (sha256: string) =>
      [
        marker(),
        rejected(),
        assistant({
          attachments: [
            {
              filename: SITEOPS_WIRE_OUTPUT_FILES.design,
              content_type: "application/json",
              url: "https://files.example.test/result.json",
              sha256,
            },
          ],
        }),
      ] as never;
    const goodFetch = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));
    await expect(
      resolveSiteOpsWireOutput({
        events: baseEvents(expectedSha256),
        operationToken: token,
        taskCompleted: true,
        fetchPinned: goodFetch as never,
      }),
    ).resolves.toMatchObject({ value });

    for (const response of [
      new Response(JSON.stringify(value), {
        headers: { "content-type": "text/plain" },
      }),
      jsonResponse([value]),
      new Response(Uint8Array.of(0xff, 0xfe), {
        headers: { "content-type": "application/json" },
      }),
    ]) {
      const fetchPinned = vi.fn(async () => ({
        response,
        finalUrl: new URL("https://files.example.test/result.json"),
      }));
      await expect(
        resolveSiteOpsWireOutput({
          events: baseEvents(expectedSha256),
          operationToken: token,
          taskCompleted: true,
          fetchPinned: fetchPinned as never,
        }),
      ).rejects.toBeInstanceOf(SiteOpsWireOutputResolutionError);
    }
  });

  it("enforces phase-specific decoded JSON size limits", async () => {
    const value = {
      operationToken: token,
      schemaVersion: 2,
      content: "x".repeat(300 * 1024),
    };
    const fetchPinned = vi.fn(async () => ({
      response: jsonResponse(value),
      finalUrl: new URL("https://files.example.test/result.json"),
    }));
    const events = [
      marker(),
      rejected(),
      assistant({
        attachments: [
          {
            filename: SITEOPS_WIRE_OUTPUT_FILES.design,
            content_type: "application/json",
            url: "https://files.example.test/result.json",
          },
        ],
      }),
    ] as never;
    await expect(
      resolveSiteOpsWireOutput({
        events,
        operationToken: token,
        taskCompleted: true,
        fetchPinned: fetchPinned as never,
      }),
    ).rejects.toMatchObject({ code: "SITEOPS_WIRE_OUTPUT_INVALID" });

    const contentToken = "siteops-content:10000000-0000-4000-8000-000000000001";
    const contentValue = { ...value, operationToken: contentToken };
    const contentFetch = vi.fn(async () => ({
      response: jsonResponse(contentValue),
      finalUrl: new URL("https://files.example.test/content.json"),
    }));
    await expect(
      resolveWireOutput({
        events: [
          marker(contentToken),
          rejected(),
          assistant({
            attachments: [
              {
                filename: SITEOPS_WIRE_OUTPUT_FILES.content,
                content_type: "application/json",
                url: "https://files.example.test/content.json",
              },
            ],
          }),
        ] as never,
        operationToken: contentToken,
        phase: "content",
        expectedFilename: SITEOPS_WIRE_OUTPUT_FILES.content,
        taskCompleted: true,
        fetchPinned: contentFetch as never,
      }),
    ).resolves.toMatchObject({ value: contentValue, source: "attachment" });
  });

  it("rejects private and non-HTTPS attachment coordinates before network access", async () => {
    for (const url of [
      "http://files.example.test/result.json",
      "https://127.0.0.1/result.json",
    ]) {
      await expect(
        resolveSiteOpsWireOutput({
          events: [
            marker(),
            rejected(),
            assistant({
              attachments: [
                {
                  filename: SITEOPS_WIRE_OUTPUT_FILES.design,
                  content_type: "application/json",
                  url,
                },
              ],
            }),
          ] as never,
          operationToken: token,
          taskCompleted: true,
        }),
      ).rejects.toMatchObject({ code: "SITEOPS_WIRE_OUTPUT_INVALID" });
    }
  });
});
