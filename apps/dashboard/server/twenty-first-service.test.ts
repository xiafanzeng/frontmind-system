import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthServiceError } from "./auth-service";
import { encryptPresalesApiKey } from "./presales-service";
import {
  TwentyFirstClient,
  TwentyFirstNativeTemplateError,
  TwentyFirstNativeSourceContractError,
  TwentyFirstToolContractError,
  TWENTY_FIRST_ACTIVE_OPERATION_STATUSES,
  assertTwentyFirstJsonDepth,
  buildTwentyFirstToolArguments,
  deleteTwentyFirstApiCredential,
  finalizePendingTwentyFirstCredentialRevocations,
  decryptTwentyFirstApiKey,
  encryptTwentyFirstApiKey,
  hasActiveTwentyFirstConsumers,
  probeTwentyFirstTemplateCompilerEnvironment,
  projectTwentyFirstMarketplaceTemplateSummaries,
  projectTwentyFirstToolPayload,
  projectTwentyFirstNativeTemplateSummaries,
  replaceTwentyFirstApiCredential,
  validateTwentyFirstApiKeyInput,
} from "./twenty-first-service";

const originalMasterKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;

describe("21st credential encryption", () => {
  beforeEach(() => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      randomBytes(32).toString("base64");
  });

  afterEach(() => {
    if (originalMasterKey === undefined) {
      delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = originalMasterKey;
    }
  });

  it("round-trips without persisting plaintext and binds AAD to the 21st slot", () => {
    const id = randomUUID();
    const apiKey = "21st_sk_secret-that-must-stay-server-side";
    const encrypted = encryptTwentyFirstApiKey(id, apiKey);

    expect(Object.values(encrypted).join(" ")).not.toContain(apiKey);
    expect(decryptTwentyFirstApiKey({ id, ...encrypted })).toBe(apiKey);
    expect(() =>
      decryptTwentyFirstApiKey({ id: randomUUID(), ...encrypted }),
    ).toThrowError(AuthServiceError);
  });

  it("keeps Website and 21st ciphertext in different AAD domains", () => {
    const id = randomUUID();
    const apiKey = "shared-looking-secret-value";
    const website = encryptPresalesApiKey(id, apiKey);
    const twentyFirst = encryptTwentyFirstApiKey(id, apiKey);

    expect(website.encryptedKey).not.toBe(twentyFirst.encryptedKey);
    expect(() => decryptTwentyFirstApiKey({ id, ...website })).toThrowError(
      AuthServiceError,
    );
  });

  it("rejects empty and control-character values before any network request", () => {
    expect(() => validateTwentyFirstApiKeyInput("short")).toThrowError(
      AuthServiceError,
    );
    expect(() =>
      validateTwentyFirstApiKeyInput("21st_sk_valid\u0000suffix"),
    ).toThrowError(AuthServiceError);
    expect(validateTwentyFirstApiKeyInput("  21st_sk_valid  ")).toBe(
      "21st_sk_valid",
    );
  });

  it("bounds provider JSON depth independently from the byte limit", () => {
    let value: unknown = "leaf";
    for (let index = 0; index < 34; index += 1) value = { child: value };
    expect(() => assertTwentyFirstJsonDepth(value)).toThrowError(
      AuthServiceError,
    );
    expect(() => assertTwentyFirstJsonDepth({ tools: [] })).not.toThrow();
  });

  it("does not classify the system-wide 21st slot as a shared user Manus Key", () => {
    const source = readFileSync(
      resolve(process.cwd(), "server/auth-service.ts"),
      "utf8",
    );
    const sharedKeyFunction = source.slice(
      source.indexOf("export async function isUpstreamApiKeyShared"),
      source.indexOf("export async function recordUpstreamResource"),
    );
    expect(sharedKeyFunction).toContain(
      'eq(presalesApiCredentials.slot, "website")',
    );
  });
});

function jsonRpcResponse(id: string | number, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createMcpFetch(tools: string[]) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id?: string | number;
      method: string;
    };
    if (body.method === "initialize") {
      return jsonRpcResponse(body.id!, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "21st-test", version: "1.0.0" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      return jsonRpcResponse(body.id!, {
        tools: tools.map((name) => ({
          name,
          inputSchema:
            name === "search"
              ? {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                    type: {
                      type: "string",
                      enum: ["template", "component"],
                    },
                    limit: { type: "integer", minimum: 1, maximum: 18 },
                  },
                  required: ["query"],
                }
              : name === "get_component"
                ? {
                    type: "object",
                    properties: { id: { type: "number" } },
                    required: ["id"],
                  }
                : { type: "object", properties: {} },
        })),
      });
    }
    if (body.method === "tools/call") {
      const call = body as unknown as {
        id: string | number;
        params: { name: string };
      };
      if (call.params.name === "get_usage") {
        return jsonRpcResponse(call.id, {
          content: [{ type: "text", text: "Usage is available." }],
          isError: false,
        });
      }
      if (call.params.name === "search") {
        return jsonRpcResponse(call.id, {
          structuredContent: { results: [{ id: 143 }] },
          content: [],
          isError: false,
        });
      }
      if (call.params.name === "get_component") {
        return jsonRpcResponse(call.id, {
          structuredContent: { found: true, locked: false },
          content: [
            {
              type: "text",
              text: [
                "Component Code:",
                "```tsx",
                "export default function Hero() { return <main />; }",
                "```",
              ].join("\n"),
            },
          ],
          isError: false,
        });
      }
    }
    throw new Error(`unexpected MCP method: ${body.method}`);
  });
}

function createTemplateMcpFetch(input: {
  results?: Array<Record<string, unknown>>;
  resultsBySearch?: Array<Array<Record<string, unknown>>>;
  unlocked?: boolean;
  verified?: boolean;
  downloadVersion?: string | number;
  omitDownloadVersion?: boolean;
  downloadUrl?: string;
  advertisePopular?: boolean;
  advertiseTemplateType?: boolean;
  purchaseStatus?: number;
  includedWithPlan?: boolean;
  omitIncludedWithPlan?: boolean;
  purchaseAccess?: (slug: string) => {
    isUnlocked: boolean;
    verified: boolean;
    includedWithPlan: boolean;
  };
  marketplaceItems?: Array<Record<string, unknown>>;
  marketplaceStatus?: number;
  marketplacePayload?: unknown;
}) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const httpCalls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = vi.fn(async (rawUrl: string | URL, init?: RequestInit) => {
    const url = new URL(String(rawUrl));
    if (url.pathname === "/api/trpc/templates.list") {
      httpCalls.push({
        url: url.toString(),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(
        JSON.stringify(
          input.marketplacePayload ?? {
            result: {
              data: {
                json: {
                  items: input.marketplaceItems ?? [marketplaceTemplateItem()],
                },
              },
            },
          },
        ),
        {
          status: input.marketplaceStatus ?? 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.pathname.startsWith("/api/templates/")) {
      httpCalls.push({
        url: url.toString(),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname.endsWith("/purchase")) {
        if (input.purchaseStatus) {
          return new Response("denied", { status: input.purchaseStatus });
        }
        const slug = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        const access = input.purchaseAccess?.(slug);
        return new Response(
          JSON.stringify({
            isUnlocked: access?.isUnlocked ?? input.unlocked ?? true,
            verified: access?.verified ?? input.verified ?? true,
            ...(input.omitIncludedWithPlan
              ? {}
              : {
                  includedWithPlan:
                    access?.includedWithPlan ?? input.includedWithPlan ?? true,
                }),
            name: "Verified starter",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ...(!input.omitDownloadVersion
            ? { version: input.downloadVersion ?? "7" }
            : {}),
          url: input.downloadUrl ?? "https://objects.example.test/site.zip",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const body = JSON.parse(String(init?.body)) as {
      id?: string | number;
      method: string;
      params?: { name: string; arguments: Record<string, unknown> };
    };
    if (body.method === "initialize") {
      return jsonRpcResponse(body.id!, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "21st-test", version: "1.0.0" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      return jsonRpcResponse(body.id!, {
        tools: [
          {
            name: "search",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                type:
                  input.advertiseTemplateType === false
                    ? { type: "string" }
                    : {
                        type: "string",
                        enum: ["component", "template"],
                      },
                limit: { type: "integer", minimum: 1, maximum: 18 },
                sort: {
                  type: "string",
                  enum:
                    input.advertisePopular === false
                      ? ["recommended"]
                      : ["recommended", "popular"],
                },
              },
              required: ["query", "type"],
            },
          },
          {
            name: "get_component",
            inputSchema: {
              type: "object",
              properties: { id: { type: "number" } },
              required: ["id"],
            },
          },
        ],
      });
    }
    if (body.method === "tools/call" && body.params) {
      calls.push(body.params);
      const searchIndex = calls.filter((call) => call.name === "search").length;
      return jsonRpcResponse(body.id!, {
        structuredContent: {
          results: input.resultsBySearch?.[searchIndex - 1] ??
            input.results ?? [
              {
                id: 41,
                slug: "verified-starter",
                name: "Verified starter",
                type: "template",
                verified: true,
                version: "7",
              },
            ],
        },
        content: [],
        isError: false,
      });
    }
    throw new Error(`unexpected request: ${url.pathname} ${body.method}`);
  });
  return { calls, httpCalls, fetchImpl };
}

function marketplaceTemplateItem(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 41,
    template_slug: "verified-starter",
    name: "Verified starter",
    hosting: "hosted",
    verified: true,
    preview_url:
      "https://cdn.21st.dev/user_test/templates/verified-starter/preview.png",
    source: {
      owner: "frontmind-test",
      repo: "verified-starter",
      subdir: "template",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
    },
    ...overrides,
  };
}

function createNativeProbeFetch(input: {
  usageResult?: Record<string, unknown>;
  searchResult: Record<string, unknown>;
  componentResult?: Record<string, unknown>;
}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id?: string | number;
      method: string;
      params?: { name: string };
    };
    if (body.method === "initialize") {
      return jsonRpcResponse(body.id!, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "21st-test", version: "1.0.0" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      return jsonRpcResponse(body.id!, {
        tools: [
          {
            name: "search",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                limit: { type: "integer", minimum: 1, maximum: 18 },
                type: { type: "string", enum: ["component"] },
              },
              required: ["query", "type"],
            },
          },
          {
            name: "get_component",
            inputSchema: {
              type: "object",
              properties: { id: { type: "number" } },
              required: ["id"],
            },
          },
          {
            name: "get_usage",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
    }
    if (body.method === "tools/call" && body.params) {
      calls.push(body.params.name);
      const result =
        body.params.name === "get_usage"
          ? (input.usageResult ?? {
              content: [{ type: "text", text: "Usage available." }],
              isError: false,
            })
          : body.params.name === "search"
            ? input.searchResult
            : (input.componentResult ?? {
                structuredContent: { found: true, locked: false },
                content: [
                  {
                    type: "text",
                    text: "```tsx\nexport default function Page(){ return <main />; }\n```",
                  },
                ],
                isError: false,
              });
      return jsonRpcResponse(body.id!, result);
    }
    throw new Error(`unexpected MCP method: ${body.method}`);
  });
  return { calls, fetchImpl };
}

describe("TwentyFirstClient", () => {
  it("discovers tools and performs a bounded complete-Template readiness probe", async () => {
    const { calls, httpCalls, fetchImpl } = createTemplateMcpFetch({});
    const templateBinaryFetch = vi.fn(async () =>
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
    );
    const result = await new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
      templateBinaryFetch,
      templateCompilerProbe: async () => true,
    }).inspectCapabilities("21st_sk_test_secret");

    expect(result).toMatchObject({
      ok: true,
      endpoint: "https://21st.dev/api/mcp",
      capabilities: {
        search: true,
        getComponent: true,
        getUsage: false,
        getTheme: false,
      },
      nativeVisualReadiness: "ready",
      nativeTemplateReadiness: "ready",
      server: { name: "21st-test", version: "1.0.0" },
    });
    expect(calls).toEqual([]);
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.authorization).toBeNull();
    const catalogUrl = new URL(httpCalls[0]!.url);
    expect(catalogUrl.pathname).toBe("/api/trpc/templates.list");
    expect(JSON.parse(catalogUrl.searchParams.get("input")!)).toEqual({
      json: { lane: "included", sortBy: "recommended", limit: 60 },
    });
    expect(
      httpCalls.every((call) => !call.url.includes("21st_sk_test_secret")),
    ).toBe(true);
    expect(templateBinaryFetch).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "probe", maxBytes: 4_096 }),
    );
  });

  it("validates the local source normalization compiler without requiring Chromium", async () => {
    await expect(probeTwentyFirstTemplateCompilerEnvironment()).resolves.toBe(
      true,
    );
  });

  it("does not make the local compiler a Template catalog readiness gate", async () => {
    const { fetchImpl } = createTemplateMcpFetch({});
    const templateBinaryFetch = vi.fn(async () =>
      Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
    );
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
        templateBinaryFetch,
        templateCompilerProbe: async () => false,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({
      nativeTemplateReadiness: "ready",
    });
  });

  it("bounds capability discovery to three pages and one hundred tools", async () => {
    const cursors: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: string | number;
        method: string;
        params?: { cursor?: string };
      };
      if (body.method === "initialize") {
        return jsonRpcResponse(body.id!, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "21st-test", version: "1.0.0" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        cursors.push(body.params?.cursor);
        const page = cursors.length;
        const tools = Array.from({ length: 34 }, (_, index) => ({
          name:
            page === 3 && index === 0 ? "search" : `page_${page}_tool_${index}`,
          inputSchema: { type: "object", properties: {} },
        }));
        return jsonRpcResponse(body.id!, {
          tools,
          nextCursor: `cursor-${page}`,
        });
      }
      throw new Error(`unexpected MCP method: ${body.method}`);
    });

    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({ capabilities: { search: true } });
    expect(cursors).toEqual([undefined, "cursor-1", "cursor-2"]);
  });

  it("marks a search-only catalog connection unusable for native visuals", async () => {
    const fetchImpl = createMcpFetch(["search"]);
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({
      ok: true,
      capabilities: {
        search: true,
        getComponent: false,
        getUsage: false,
        getTheme: false,
      },
      nativeVisualReadiness: "missing_get_component",
    });
  });

  it("reports an incompatible advertised get_component schema without calling it", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: string | number;
        method: string;
      };
      if (body.method === "initialize") {
        return jsonRpcResponse(body.id!, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "21st-test", version: "1.0.0" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        return jsonRpcResponse(body.id!, {
          tools: [
            {
              name: "search",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
            {
              name: "get_component",
              inputSchema: {
                type: "object",
                properties: { opaque: { type: "object" } },
                required: ["opaque"],
              },
            },
          ],
        });
      }
      throw new Error(`unexpected MCP method: ${body.method}`);
    });

    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({
      capabilities: { search: true, getComponent: true },
      nativeVisualReadiness: "source_contract_incompatible",
    });
    const calledTools = fetchImpl.mock.calls.flatMap(([, init]) => {
      if (!String(init?.body).includes('"tools/call"')) return [];
      return [JSON.parse(String(init?.body)).params?.name];
    });
    expect(calledTools).not.toContain("get_component");
  });

  it("reports a component-only search contract as Template catalog unavailable", async () => {
    const { calls, fetchImpl } = createNativeProbeFetch({
      searchResult: {
        structuredContent: { results: [] },
        content: [],
        isError: false,
      },
    });
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({
      nativeVisualReadiness: "ready",
      nativeTemplateReadiness: "catalog_unavailable",
    });
    expect(calls).toEqual([]);
  });

  it("does not use component-code usage to decide Template entitlement", async () => {
    const { calls, fetchImpl } = createNativeProbeFetch({
      usageResult: {
        structuredContent: {
          usage: { sourceReadsRemaining: 0 },
        },
        content: [],
        isError: false,
      },
      searchResult: {
        structuredContent: { results: [{ id: 143 }] },
        content: [],
        isError: false,
      },
    });
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({
      nativeVisualReadiness: "ready",
      nativeTemplateReadiness: "catalog_unavailable",
    });
    expect(calls).toEqual([]);
  });

  it("does not call a locked get_component while probing Templates", async () => {
    const { calls, fetchImpl } = createNativeProbeFetch({
      searchResult: {
        structuredContent: { results: [{ id: 143 }] },
        content: [],
        isError: false,
      },
      componentResult: {
        structuredContent: { found: true, locked: true },
        content: [{ type: "text", text: "private provider detail" }],
        isError: true,
      },
    });
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({
      nativeVisualReadiness: "ready",
      nativeTemplateReadiness: "catalog_unavailable",
    });
    expect(calls).toEqual([]);
  });

  it("ignores changed component payloads in the Template readiness path", async () => {
    const { fetchImpl } = createNativeProbeFetch({
      searchResult: {
        structuredContent: { results: [{ id: 143 }] },
        content: [],
        isError: false,
      },
      componentResult: {
        structuredContent: { found: true, locked: false },
        content: [{ type: "text", text: '{"status":"ok"}' }],
        isError: false,
      },
    });
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({
      nativeVisualReadiness: "ready",
      nativeTemplateReadiness: "catalog_unavailable",
    });
  });

  it("does not require component source code for complete Templates", async () => {
    const { fetchImpl } = createNativeProbeFetch({
      searchResult: {
        structuredContent: { results: [{ id: 143 }] },
        content: [],
        isError: false,
      },
      componentResult: {
        structuredContent: { found: true, locked: false },
        content: [{ type: "text", text: "Component source is unavailable." }],
        isError: false,
      },
    });
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({
      nativeVisualReadiness: "ready",
      nativeTemplateReadiness: "catalog_unavailable",
    });
  });

  it("fails closed when the required search tool is missing", async () => {
    const fetchImpl = createMcpFetch(["get_component"]);
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
  });

  it("maps authentication failures without reflecting the secret", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("denied", { status: 401 }),
    );
    const error = await new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
    })
      .inspectCapabilities("21st_sk_do-not-reflect")
      .catch((value) => value);

    expect(error).toMatchObject({ code: "INVALID_CREDENTIAL" });
    expect(String(error.message)).not.toContain("21st_sk_do-not-reflect");
  });

  it("discovers live schemas and calls only search/get_component with their advertised keys", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: string | number;
        method: string;
        params?: { name: string; arguments: Record<string, unknown> };
      };
      if (body.method === "initialize") {
        return jsonRpcResponse(body.id!, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "21st-test", version: "1.0.0" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        return jsonRpcResponse(body.id!, {
          tools: [
            {
              name: "search",
              inputSchema: {
                type: "object",
                properties: {
                  searchQuery: { type: "string" },
                  pageSize: { type: "integer", minimum: 1, maximum: 18 },
                  type: { type: "string", enum: ["component", "theme"] },
                },
                required: ["searchQuery"],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: "get_component",
              inputSchema: {
                type: "object",
                properties: { id: { type: "number" } },
                required: ["id"],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: "generate",
              inputSchema: {
                type: "object",
                properties: { prompt: { type: "string" } },
              },
            },
          ],
        });
      }
      if (body.method === "tools/call" && body.params) {
        calls.push(body.params);
        const payload =
          body.params.name === "search"
            ? { results: [{ id: 143 }] }
            : {
                id: 143,
                name: "Responsive editorial hero",
                description: "Light canvas and neutral sans",
                previewUrl: "https://cdn.example.test/143.png",
                componentCode: "RAW_PROVIDER_CODE",
              };
        return jsonRpcResponse(body.id!, {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: false,
        });
      }
      throw new Error(`unexpected MCP method: ${body.method}`);
    });
    const client = new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
      totalTimeoutMs: 5_000,
    });
    const output = await client.withReadOnlySession(
      "21st_sk_test_secret",
      async (session) => ({
        search: await session.search({
          query: "B2B analytics landing page",
          type: "component",
          limit: 10,
        }),
        detail: await session.getComponent!(143),
      }),
    );

    expect(output).toEqual({
      search: { results: [{ id: 143 }] },
      detail: {
        id: 143,
        name: "Responsive editorial hero",
        description: "Light canvas and neutral sans",
        previewUrl: "https://cdn.example.test/143.png",
        componentCode: "RAW_PROVIDER_CODE",
      },
    });
    expect(calls).toEqual([
      {
        name: "search",
        arguments: {
          searchQuery: "B2B analytics landing page",
          pageSize: 10,
          type: "component",
        },
      },
      {
        name: "get_component",
        arguments: { id: 143 },
      },
    ]);
    expect(calls.map((call) => call.name)).not.toContain("generate");
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("x-api-key")).toBe(
        "21st_sk_test_secret",
      );
    }
  });

  it("keeps component search IDs when template search lacks a matching source tool", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: string | number;
        method: string;
        params?: { name: string; arguments: Record<string, unknown> };
      };
      if (body.method === "initialize") {
        return jsonRpcResponse(body.id!, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "21st-test", version: "1.0.0" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        return jsonRpcResponse(body.id!, {
          tools: [
            {
              name: "search",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  kind: { type: "string", enum: ["page", "component"] },
                },
                required: ["query", "kind"],
              },
            },
            {
              name: "get_component",
              inputSchema: {
                type: "object",
                properties: { componentId: { type: "integer" } },
                required: ["componentId"],
              },
            },
          ],
        });
      }
      if (body.method === "tools/call" && body.params) {
        calls.push(body.params);
        return jsonRpcResponse(body.id!, {
          structuredContent: { results: [] },
          content: [],
          isError: false,
        });
      }
      throw new Error(`unexpected MCP method: ${body.method}`);
    });

    const client = new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
    });
    await client.withReadOnlySession("21st_sk_test_secret", async (session) => {
      expect(session.preferredSearchType).toBe("component");
      await session.search({
        query: "enterprise landing page",
        type: session.preferredSearchType!,
        limit: 9,
      });
    });
    expect(calls).toEqual([
      {
        name: "search",
        arguments: {
          query: "enterprise landing page",
          kind: "component",
        },
      },
    ]);
  });

  it("adapts numeric and string provider IDs to the advertised schema", () => {
    const numericTool = {
      name: "get_component",
      inputSchema: {
        type: "object" as const,
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    };
    expect(
      buildTwentyFirstToolArguments({
        operation: "get_component",
        tool: numericTool,
        value: 143,
      }),
    ).toEqual({ id: 143 });
    expect(
      buildTwentyFirstToolArguments({
        operation: "get_component",
        tool: numericTool,
        value: "143",
      }),
    ).toEqual({ id: 143 });
    expect(() =>
      buildTwentyFirstToolArguments({
        operation: "get_component",
        tool: numericTool,
        value: "not-a-number",
      }),
    ).toThrow(TwentyFirstToolContractError);
    expect(
      buildTwentyFirstToolArguments({
        operation: "get_component",
        tool: {
          ...numericTool,
          inputSchema: {
            ...numericTool.inputSchema,
            properties: { id: { type: "string" } },
          },
        },
        value: 143,
      }),
    ).toEqual({ id: "143" });
  });

  it("derives required component type and bounded limit from the live search schema", () => {
    const tool = {
      name: "search",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string" },
          type: { type: "string" },
          limit: { type: "integer", minimum: 2, maximum: 5 },
        },
        required: ["query", "type", "limit"],
      },
    };
    expect(
      buildTwentyFirstToolArguments({
        operation: "search",
        tool,
        value: "企业官网 hero",
        limit: 10,
      }),
    ).toEqual({ query: "企业官网 hero", type: "component", limit: 5 });
    expect(() =>
      buildTwentyFirstToolArguments({
        operation: "search",
        tool: {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: {
              ...tool.inputSchema.properties,
              type: { type: "string", enum: ["theme"] },
            },
          },
        },
        value: "hero",
        limit: 5,
      }),
    ).toThrow(TwentyFirstToolContractError);

    expect(
      buildTwentyFirstToolArguments({
        operation: "search",
        tool: {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: {
              ...tool.inputSchema.properties,
              type: {
                type: "string",
                enum: ["page", "component"],
              },
            },
          },
        },
        value: "landing page",
        limit: 5,
        searchType: "template",
      }),
    ).toEqual({ query: "landing page", type: "page", limit: 5 });
  });

  it("uses Hero tag and recommended sort only when the live schema advertises them", () => {
    const tool = {
      name: "search",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string" },
          tag: { type: "string", enum: ["hero", "pricing"] },
          sort: { type: "string", enum: ["recommended", "newest"] },
        },
        required: ["query"],
      },
    };
    expect(
      buildTwentyFirstToolArguments({
        operation: "search",
        tool,
        value: "hero section landing page",
        searchOptions: { tag: "hero", sort: "recommended" },
      }),
    ).toEqual({
      query: "hero section landing page",
      tag: "hero",
      sort: "recommended",
    });
  });

  it("prefers structured results and uses bounded JSON text only as fallback", () => {
    expect(
      projectTwentyFirstToolPayload({
        structuredContent: { results: [{ id: 1 }] },
        content: [
          { type: "text", text: JSON.stringify({ results: [{ id: 2 }] }) },
        ],
      }),
    ).toEqual({ results: [{ id: 1 }] });
    expect(
      projectTwentyFirstToolPayload({
        structuredContent: { status: "ok" },
        content: [
          { type: "text", text: JSON.stringify({ results: [{ id: 143 }] }) },
        ],
      }),
    ).toEqual({ results: [{ id: 143 }] });
    expect(
      projectTwentyFirstToolPayload({
        structuredContent: { status: "ok" },
        content: [
          {
            type: "text",
            text: JSON.stringify({ data: { results: [{ id: 144 }] } }),
          },
          {
            type: "text",
            text: JSON.stringify({ payload: { results: [{ id: 145 }] } }),
          },
        ],
      }),
    ).toEqual({ results: [{ id: 144 }, { id: 145 }] });
    expect(
      projectTwentyFirstToolPayload({
        structuredContent: { status: "safe-fallback" },
        content: [{ type: "text", text: "x".repeat(1_000_001) }],
      }),
    ).toEqual({ status: "safe-fallback" });
  });

  it("projects the official bounded non-JSON get_component source envelope", () => {
    const sourceText = [
      "Component Code:",
      "```tsx",
      "export default function Hero() { return <main>企业官网</main>; }",
      "```",
      "Demo:",
      "```tsx",
      "import Hero from './hero'; export default () => <Hero />;",
      "```",
    ].join("\n");
    expect(
      projectTwentyFirstToolPayload(
        {
          structuredContent: { found: true, locked: false },
          content: [{ type: "text", text: sourceText }],
          isError: false,
        },
        "get_component",
      ),
    ).toEqual({
      contractKind: "twenty_first_get_component_v1",
      status: { found: true, locked: false },
      sourceText,
    });
  });

  it("projects only explicit complete Template metadata", () => {
    expect(
      projectTwentyFirstNativeTemplateSummaries({
        results: [
          {
            id: 7,
            slug: "saas-starter",
            name: "SaaS starter",
            type: "template",
            verified: true,
            version: 3,
          },
          { id: 8, slug: "hero-card", type: "component" },
          { id: 10, slug: "untyped-template-looking-result" },
          { id: 9, name: "missing slug", type: "template" },
        ],
      }),
    ).toEqual([
      {
        templateId: 7,
        slug: "saas-starter",
        name: "SaaS starter",
        version: "3",
        verified: true,
        includedWithPlan: false,
        sortRank: 0,
      },
    ]);
  });

  it("accepts an untyped coordinate only inside an explicitly Template-filtered search", () => {
    const payload = {
      results: [
        {
          id: 11,
          slug: "official-template",
          name: "Official template",
          verified: true,
        },
        { id: 12, slug: "hero", type: "component", verified: true },
      ],
    };
    expect(projectTwentyFirstNativeTemplateSummaries(payload)).toEqual([]);
    expect(
      projectTwentyFirstNativeTemplateSummaries(payload, 0, {
        templateFilteredSearch: true,
      }),
    ).toEqual([
      expect.objectContaining({
        templateId: 11,
        slug: "official-template",
      }),
    ]);
  });

  it("strictly projects hosted verified included Templates and immutable source coordinates", () => {
    const valid = marketplaceTemplateItem();
    const duplicateId = marketplaceTemplateItem({
      template_slug: "duplicate-id",
    });
    const duplicateSlug = marketplaceTemplateItem({ id: 42 });
    const rejected = [
      marketplaceTemplateItem({ id: 50, hosting: "external" }),
      marketplaceTemplateItem({ id: 51, verified: false }),
      marketplaceTemplateItem({
        id: 52,
        source: {
          owner: "frontmind-test",
          repo: "unsafe",
          subdir: "../secret",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          license: "MIT",
        },
      }),
      marketplaceTemplateItem({
        id: 53,
        source: {
          owner: "frontmind-test",
          repo: "unsafe",
          subdir: null,
          commitSha: "branch-main",
          license: "MIT",
        },
      }),
      marketplaceTemplateItem({
        id: 54,
        preview_url: "http://127.0.0.1/preview.png",
      }),
      marketplaceTemplateItem({
        id: 55,
        source: {
          owner: "frontmind-test",
          repo: "unsafe",
          subdir: null,
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          license: "GPL-3.0",
        },
      }),
    ];
    expect(
      projectTwentyFirstMarketplaceTemplateSummaries({
        result: {
          data: {
            json: { items: [valid, duplicateId, duplicateSlug, ...rejected] },
          },
        },
      }),
    ).toEqual([
      {
        templateId: 41,
        slug: "verified-starter",
        name: "Verified starter",
        version: "0123456789abcdef0123456789abcdef01234567",
        verified: true,
        includedWithPlan: true,
        sortRank: 0,
        previewUrl:
          "https://cdn.21st.dev/user_test/templates/verified-starter/preview.png",
        sourceOwner: "frontmind-test",
        sourceRepo: "verified-starter",
        sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
        sourceSubdirectory: "template",
        sourceLicense: "MIT",
      },
    ]);
  });

  it("requests only the official included/recommended directory and returns at most thirty-two entries", async () => {
    const marketplaceItems = Array.from({ length: 40 }, (_, index) =>
      marketplaceTemplateItem({
        id: index + 1,
        template_slug: `template-${index + 1}`,
        name: `Template ${index + 1}`,
        source: {
          owner: "frontmind-test",
          repo: `template-${index + 1}`,
          subdir: null,
          commitSha: index.toString(16).padStart(40, "0"),
          license: index % 2 === 0 ? "MIT" : "Apache-2.0",
        },
      }),
    );
    const { calls, httpCalls, fetchImpl } = createTemplateMcpFetch({
      marketplaceItems,
    });
    const templates = await new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
    }).listNativeTemplates("21st_sk_test_secret", { limit: 32 });
    expect(templates).toHaveLength(32);
    expect(calls).toEqual([]);
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.authorization).toBeNull();
    const catalogUrl = new URL(httpCalls[0]!.url);
    expect(catalogUrl.pathname).toBe("/api/trpc/templates.list");
    expect(JSON.parse(catalogUrl.searchParams.get("input")!)).toEqual({
      json: { lane: "included", sortBy: "recommended", limit: 60 },
    });
    expect(httpCalls[0]!.url).not.toContain("popular");
    expect(httpCalls[0]!.url).not.toContain("21st_sk_test_secret");
  });

  it("applies prior-page exclusions after strict catalog projection", async () => {
    const { fetchImpl } = createTemplateMcpFetch({
      marketplaceItems: [
        marketplaceTemplateItem({ id: 1, template_slug: "already-by-id" }),
        marketplaceTemplateItem({ id: 2, template_slug: "already-by-slug" }),
        marketplaceTemplateItem({ id: 3, template_slug: "fresh-template" }),
      ],
    });
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).listNativeTemplates("21st_sk_test_secret", {
        limit: 1,
        excludeTemplateIds: ["1"],
        excludeSlugs: ["already-by-slug"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ templateId: 3, slug: "fresh-template" }),
    ]);
  });

  it("fails closed for an empty or malformed Marketplace directory", async () => {
    for (const marketplacePayload of [
      { result: { data: { json: { items: [] } } } },
      { result: { data: { json: { templates: [] } } } },
    ]) {
      await expect(
        new TwentyFirstClient({
          fetchImpl: createTemplateMcpFetch({ marketplacePayload })
            .fetchImpl as unknown as typeof fetch,
          timeoutMs: 1_000,
        }).listNativeTemplates("21st_sk_test_secret", { limit: 1 }),
      ).rejects.toMatchObject({ category: "catalog_unavailable" });
    }
  });

  it("downloads an exact codeload commit ZIP without sending the API key", async () => {
    const { httpCalls, fetchImpl } = createTemplateMcpFetch({});
    const archive = Uint8Array.from([
      0x50, 0x4b, 0x03, 0x04, 0x66, 0x72, 0x6f, 0x6e, 0x74,
    ]);
    const templateBinaryFetch = vi.fn(async () => archive);
    const client = new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
      templateBinaryFetch,
    });
    const result = await client.downloadNativeTemplate("21st_sk_test_secret", {
      templateId: 41,
      slug: "verified-starter",
      version: "0123456789abcdef0123456789abcdef01234567",
      sourceOwner: "frontmind-test",
      sourceRepo: "verified-starter",
      sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceSubdirectory: "template",
      sourceLicense: "MIT",
    });
    expect(result).toMatchObject({
      templateId: 41,
      slug: "verified-starter",
      version: "0123456789abcdef0123456789abcdef01234567",
      contentType: "application/zip",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceUrlOrigin: "https://codeload.github.com",
      sourceSubdirectory: "template",
    });
    expect(result.archive).toEqual(archive);
    expect(templateBinaryFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "full",
        maxBytes: 50 * 1024 * 1024,
        url: "https://codeload.github.com/frontmind-test/verified-starter/zip/0123456789abcdef0123456789abcdef01234567",
      }),
    );
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0]?.authorization).toBeNull();
  });

  it("reuses the strict catalog source proof during the same operation", async () => {
    const { httpCalls, fetchImpl } = createTemplateMcpFetch({});
    const archive = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x01]);
    const client = new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
      templateBinaryFetch: vi.fn(async () => archive),
    });
    const listed = await client.listNativeTemplates("21st_sk_test_secret", {
      limit: 1,
    });
    await client.downloadNativeTemplate("21st_sk_test_secret", {
      templateId: listed[0]!.templateId,
      slug: listed[0]!.slug,
      version: listed[0]!.version,
      sourceOwner: listed[0]!.sourceOwner,
      sourceRepo: listed[0]!.sourceRepo,
      sourceCommitSha: listed[0]!.sourceCommitSha,
      sourceSubdirectory: listed[0]!.sourceSubdirectory,
      sourceLicense: listed[0]!.sourceLicense,
    });
    expect(httpCalls).toHaveLength(1);
  });

  it("rejects caller source coordinates that differ from the catalog proof", async () => {
    const { fetchImpl } = createTemplateMcpFetch({});
    const templateBinaryFetch = vi.fn();
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
        templateBinaryFetch,
      }).downloadNativeTemplate("21st_sk_test_secret", {
        templateId: 41,
        slug: "verified-starter",
        version: "0123456789abcdef0123456789abcdef01234567",
        sourceOwner: "attacker",
        sourceRepo: "different-repo",
        sourceCommitSha: "ffffffffffffffffffffffffffffffffffffffff",
        sourceSubdirectory: null,
        sourceLicense: "Apache-2.0",
      }),
    ).rejects.toMatchObject({ category: "download_unavailable" });
    expect(templateBinaryFetch).not.toHaveBeenCalled();
  });

  it("rejects a selected version that is not the immutable catalog commit", async () => {
    const { fetchImpl } = createTemplateMcpFetch({});
    const templateBinaryFetch = vi.fn();
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
        templateBinaryFetch,
      }).downloadNativeTemplate("21st_sk_test_secret", {
        templateId: 41,
        slug: "verified-starter",
        version: "ffffffffffffffffffffffffffffffffffffffff",
      }),
    ).rejects.toMatchObject({ category: "download_unavailable" });
    expect(templateBinaryFetch).not.toHaveBeenCalled();
  });

  it("rejects a successful download response that is not a ZIP archive", async () => {
    const { fetchImpl } = createTemplateMcpFetch({});
    const client = new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
      templateBinaryFetch: vi.fn(async () =>
        Uint8Array.from([0x7b, 0x7d, 0x0a]),
      ),
    });
    await expect(
      client.downloadNativeTemplate("21st_sk_test_secret", {
        templateId: 41,
        slug: "verified-starter",
        version: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).rejects.toMatchObject({ category: "download_unavailable" });
  });

  it("classifies locked, missing and unknown get_component responses without reflecting text", () => {
    for (const [structuredContent, nativeCode] of [
      [{ found: true, locked: true }, "NATIVE_SOURCE_QUOTA_UNAVAILABLE"],
      [{ found: false, locked: false }, "NATIVE_SOURCE_CANDIDATES_UNAVAILABLE"],
    ] as const) {
      const error = (() => {
        try {
          projectTwentyFirstToolPayload(
            {
              structuredContent,
              content: [{ type: "text", text: "provider-private-detail" }],
            },
            "get_component",
          );
        } catch (value) {
          return value;
        }
      })();
      expect(error).toBeInstanceOf(TwentyFirstNativeSourceContractError);
      expect(error).toMatchObject({ nativeCode });
      expect(String((error as Error).message)).not.toContain(
        "provider-private-detail",
      );
    }

    expect(() =>
      projectTwentyFirstToolPayload(
        {
          structuredContent: { found: true, locked: false },
          content: [{ type: "text", text: "unsafe\u0000source" }],
        },
        "get_component",
      ),
    ).toThrowError(
      expect.objectContaining({
        nativeCode: "NATIVE_SOURCE_CONTRACT_UNAVAILABLE",
      }),
    );
  });

  it("rejects saving a search-only credential before any database access", async () => {
    await expect(
      replaceTwentyFirstApiCredential(1, "21st_sk_test_secret", async () => ({
        ok: true,
        endpoint: "https://21st.dev/api/mcp",
        capabilities: {
          search: true,
          getComponent: false,
          getUsage: false,
          getTheme: false,
        },
        nativeVisualReadiness: "missing_get_component",
        nativeTemplateReadiness: "plan_ineligible",
        server: null,
      })),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
  });

  it("honors Retry-After once with a bounded delay for a read-only request", async () => {
    let listAttempts = 0;
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: string | number;
        method: string;
      };
      if (body.method === "initialize") {
        return jsonRpcResponse(body.id!, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "21st-test", version: "1.0.0" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        listAttempts += 1;
        if (listAttempts === 1) {
          return new Response("busy", {
            status: 429,
            headers: { "retry-after": "99" },
          });
        }
        return jsonRpcResponse(body.id!, {
          tools: ["search", "get_component"].map((name) => ({
            name,
            inputSchema: { type: "object", properties: {} },
          })),
        });
      }
      throw new Error(`unexpected MCP method: ${body.method}`);
    });
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
        maxRetryAfterMs: 50,
        sleep,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({ ok: true });
    expect(listAttempts).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(50);
  });
});

describe("21st credential revocation guard", () => {
  it("does not retain a key for a terminal attention-required search", () => {
    expect(TWENTY_FIRST_ACTIVE_OPERATION_STATUSES).not.toContain(
      "attention_required",
    );
  });

  function executorWithQueryResults(results: unknown[][]) {
    let cursor = 0;
    return {
      select: vi.fn(() => {
        const result = results[cursor++] ?? [];
        const chain = {
          from: () => chain,
          where: () => chain,
          limit: () => chain,
          for: async () => result,
        };
        return chain;
      }),
    };
  }

  it("blocks revocation for a non-terminal 21st provider operation", async () => {
    const executor = executorWithQueryResults([[{ id: "operation" }], [], []]);
    await expect(
      hasActiveTwentyFirstConsumers([randomUUID()], executor),
    ).resolves.toBe(true);
  });

  it("allows revocation after provider operations and credential-bound builds are terminal", async () => {
    const executor = executorWithQueryResults([[], [], []]);
    await expect(
      hasActiveTwentyFirstConsumers([randomUUID()], executor),
    ).resolves.toBe(false);
  });

  it("defers revocation while a published board awaits customer selection", async () => {
    const executor = executorWithQueryResults([[], [], [{ id: "board" }]]);
    await expect(
      hasActiveTwentyFirstConsumers([randomUUID()], executor),
    ).resolves.toBe(true);
  });

  function revocationExecutor() {
    const updates: Record<string, unknown>[] = [];
    const selectChain = {
      from: () => selectChain,
      where: () => selectChain,
      for: async () => [
        { id: "active-credential", status: "active" },
        { id: "retired-credential", status: "retired" },
      ],
    };
    const updateChain = {
      set: (value: Record<string, unknown>) => {
        updates.push(value);
        return updateChain;
      },
      where: async () => undefined,
    };
    return {
      executor: {
        select: () => selectChain,
        update: () => updateChain,
      },
      updates,
    };
  }

  it("marks every retained version pending instead of shredding a live task key", async () => {
    const { executor, updates } = revocationExecutor();
    await expect(
      deleteTwentyFirstApiCredential(async () => true, executor),
    ).resolves.toEqual({ deleted: false, pending: true });
    expect(updates).toEqual([
      expect.objectContaining({ validationStatus: "invalid" }),
    ]);
    expect(updates[0]).not.toHaveProperty("encryptedKey");
  });

  it("cryptoshreds active and retired slot versions when no task consumes them", async () => {
    const { executor, updates } = revocationExecutor();
    await expect(
      deleteTwentyFirstApiCredential(async () => false, executor),
    ).resolves.toEqual({ deleted: true, pending: false });
    expect(updates).toEqual([
      expect.objectContaining({
        status: "deleted",
        validationStatus: "unverified",
        encryptedKey: expect.any(String),
        encryptionIv: expect.any(String),
        encryptionAuthTag: expect.any(String),
      }),
    ]);
  });

  it("automatically shreds only credentials already marked for revocation", async () => {
    const { executor, updates } = revocationExecutor();
    await expect(
      finalizePendingTwentyFirstCredentialRevocations(
        async () => false,
        executor,
      ),
    ).resolves.toEqual({ deleted: 2, pending: false });
    expect(updates).toEqual([
      expect.objectContaining({
        status: "deleted",
        encryptedKey: expect.any(String),
      }),
    ]);
  });
});
