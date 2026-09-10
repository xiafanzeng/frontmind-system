import { deliveryProjectHeaders } from "./delivery-project";

type RestScope = { key: string; generation: number; headers: Record<string, string>; controller: AbortController };
type OperationScope = { headers: Record<string, string>; signal: AbortSignal };
let activeScope: RestScope | undefined;
const inheritedScopes = new WeakMap<AbortSignal, OperationScope>();
const scopeHeaderNames = ["x-enterprise-project-id", "x-delivery-project-assignment-id"];

/** The mounted protected workspace owns the lifetime of its business REST requests. */
export function activateWorkspaceRestScope(key: string, projectId?: string): () => void {
  let scope = activeScope;
  if (!scope || scope.key !== key || scope.controller.signal.aborted) {
    scope?.controller.abort();
    const headers: Record<string, string> = {};
    if (projectId) headers["x-enterprise-project-id"] = projectId;
    scope = { key, generation: 0, headers, controller: new AbortController() };
    activeScope = scope;
  }
  const current = ++scope.generation;
  const mountedScope = scope;
  return () => {
    // StrictMode replays effects on the same component; real scope changes abort synchronously above.
    queueMicrotask(() => {
      if (mountedScope.generation !== current) return;
      mountedScope.controller.abort();
      if (activeScope === mountedScope) activeScope = undefined;
    });
  };
}

export type WorkspaceRestOperation = ReturnType<typeof captureWorkspaceRestOperation>;

/** Capture once before an await; pass signal to nested operations so retries inherit this identity. */
export function captureWorkspaceRestOperation(externalSignal?: AbortSignal | null, explicitScope?: { enterpriseProjectId?: string; projectAssignmentId?: string }) {
  const inherited = externalSignal ? inheritedScopes.get(externalSignal) : undefined;
  const currentHeaders = deliveryProjectHeaders();
  if (activeScope) {
    delete currentHeaders["x-enterprise-project-id"];
    Object.assign(currentHeaders, activeScope.headers);
  }
  const frozenHeaders = { ...(inherited?.headers ?? currentHeaders) };
  for (const [name, value] of [["x-enterprise-project-id", explicitScope?.enterpriseProjectId], ["x-delivery-project-assignment-id", explicitScope?.projectAssignmentId]]) {
    if (!value) continue;
    if (frozenHeaders[name!] && frozenHeaders[name!] !== value) throw new Error("请求与当前企业项目范围不一致，请重新进入工作区。");
    frozenHeaders[name!] = value;
  }
  const lifetimeSignal = inherited?.signal ?? activeScope?.controller.signal;
  const signals = [...new Set([lifetimeSignal, externalSignal].filter((signal): signal is AbortSignal => Boolean(signal)))];
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0] ?? new AbortController().signal;
  inheritedScopes.set(signal, { headers: frozenHeaders, signal });
  const assertActive = () => signal.throwIfAborted();
  const headers = (extra: Record<string, string> = {}) => {
    const result = { ...extra };
    for (const name of Object.keys(result)) if (scopeHeaderNames.includes(name.toLowerCase())) delete result[name];
    return { ...result, ...frozenHeaders };
  };
  return {
    signal,
    assertActive,
    headers,
    async fetch(input: RequestInfo | URL, init?: RequestInit, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<Response> {
      assertActive();
      const extraHeaders = init?.headers instanceof Headers || Array.isArray(init?.headers)
        ? Object.fromEntries(new Headers(init.headers).entries())
        : init?.headers as Record<string, string> | undefined;
      const requestHeaders = headers(extraHeaders);
      const requestSignal = init?.signal && init.signal !== signal ? AbortSignal.any([signal, init.signal]) : signal;
      const response = await fetchImpl(input, { ...init, headers: requestHeaders, signal: requestSignal });
      assertActive();
      return response;
    },
  };
}
