import { activateWorkspaceUploadScope, captureWorkspaceRestOperation } from "./workspace-rest-scope";
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from "react";

/** One batch belongs to one project/conversation/reset revision, never a page. */
export class KnowledgeBaseUploadBatch {
  private values = new Map<string, unknown>();
  private listeners = new Set<() => void>();
  private readonly refs = new Map<string, { current: unknown }>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeat?: (status: "active" | "cancelled") => void;
  controller: AbortController | null = null;
  disposed = false;
  constructor(readonly key: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  read<T>(key: string, initial: T | (() => T)): T {
    if (!this.values.has(key)) this.values.set(key, typeof initial === "function" ? (initial as () => T)() : initial);
    return this.values.get(key) as T;
  }
  write<T>(key: string, value: SetStateAction<T>) {
    if (this.disposed) return;
    const previous = this.values.get(key) as T;
    const next = typeof value === "function" ? (value as (old: T) => T)(previous) : value;
    if (Object.is(previous, next)) return;
    this.values.set(key, next);
    for (const listener of this.listeners) listener();
  }
  ref<T>(key: string, initial: T): { current: T } {
    if (!this.refs.has(key)) this.refs.set(key, { current: initial });
    return this.refs.get(key)! as { current: T };
  }
  startHeartbeat(coordinate: { conversationId: string; turnId: string; clientRequestId: string; expectedResetRevision: number }) {
    this.endHeartbeat();
    const operation = captureWorkspaceRestOperation(undefined, undefined, { detached: true });
    this.heartbeat = (status) => {
      if (this.disposed || operation.signal.aborted) return;
      const states = this.read<Map<string, { loadedBytes?: number }>>("fileStates", () => new Map());
      const uploadedBytes = [...states.values()].reduce((sum, file) => sum + (file.loadedBytes ?? 0), 0);
      void operation.fetch("/api/knowledge-base/turn/upload-heartbeat", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...coordinate, status, uploadedBytes }),
      }).then((response) => {
        if ([404, 409, 410].includes(response.status)) this.endHeartbeat();
      }).catch(() => undefined);
    };
    this.heartbeat("active");
    this.heartbeatTimer = setInterval(() => this.heartbeat?.("active"), 15_000);
  }
  endHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.heartbeat = undefined;
  }
  stop(reason = "用户已停止上传") {
    this.heartbeat?.("cancelled");
    this.endHeartbeat();
    this.controller?.abort(Object.assign(new DOMException(reason, "AbortError"), { frontmindAbortSource: "USER_STOP" }));
  }
  dispose() {
    this.stop("账号、项目或知识库版本已变化");
    this.disposed = true;
    this.values.clear();
    this.refs.clear();
    this.listeners.clear();
  }
}

export class KnowledgeBaseUploadManager {
  private batches = new Map<string, KnowledgeBaseUploadBatch>();
  batch(key: string) {
    let batch = this.batches.get(key);
    if (!batch) { batch = new KnowledgeBaseUploadBatch(key); this.batches.set(key, batch); }
    return batch;
  }
  retireOtherRevisions(prefix: string, currentKey: string) {
    for (const [key, batch] of this.batches) {
      if (key.startsWith(prefix) && key !== currentKey) { batch.dispose(); this.batches.delete(key); }
    }
  }
  dispose() { for (const batch of this.batches.values()) batch.dispose(); this.batches.clear(); }
}

const UploadContext = createContext<KnowledgeBaseUploadManager | null>(null);

export function KnowledgeBaseUploadProvider({ children, scopeKey }: { children: ReactNode; scopeKey?: string }) {
  const [manager] = useState(() => new KnowledgeBaseUploadManager());
  const lifetime = useRef(0);
  useLayoutEffect(() => scopeKey ? activateWorkspaceUploadScope(scopeKey) : undefined, [scopeKey]);
  useLayoutEffect(() => {
    const generation = ++lifetime.current;
    return () => { queueMicrotask(() => { if (lifetime.current === generation) manager.dispose(); }); };
  }, [manager]);
  return <UploadContext.Provider value={manager}>{children}</UploadContext.Provider>;
}

export function useKnowledgeBaseUploadBatch(key: string, revisionPrefix = key) {
  const shared = useContext(UploadContext);
  // Isolated consumers/previews still get a real manager, without a global
  // cache that could leak files into a different login.
  const [local] = useState(() => new KnowledgeBaseUploadManager());
  const manager = shared ?? local;
  const localLifetime = useRef(0);
  useLayoutEffect(() => {
    const generation = ++localLifetime.current;
    return () => { queueMicrotask(() => { if (!shared && localLifetime.current === generation) local.dispose(); }); };
  }, [shared, local]);
  const batch = manager.batch(key);
  useLayoutEffect(() => { manager.retireOtherRevisions(revisionPrefix, key); }, [manager, revisionPrefix, key]);
  return batch;
}

export function useKnowledgeBaseUploadField<T>(batch: KnowledgeBaseUploadBatch, key: string, initial: T | (() => T)) {
  const read = useCallback(() => batch.read(key, initial), [batch, key]);
  const value = useSyncExternalStore(batch.subscribe, read, read);
  const update = useCallback((next: SetStateAction<T>) => batch.write(key, next), [batch, key]);
  return [value, update] as const;
}

/** Invoke after the server commits an approved reset, before installing its new workspace. */
export function useRetireKnowledgeUploads() {
  const manager = useContext(UploadContext);
  return useCallback(() => manager?.dispose(), [manager]);
}
