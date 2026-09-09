import type { ZhipuRecord, ZhipuPreviewFrame } from "./zhipu-managed-client";

export type ZhipuThinkingCapture = {
  eventId: string;
  commandKey: string;
  afterEventId?: string;
  text: string;
  startedAt: string;
  complete: boolean;
  authoritativeText?: true;
};

function nativeThinkingBlockText(block: unknown): string {
  if (!block || typeof block !== "object" || Array.isArray(block)) return "";
  const item = block as Record<string, unknown>;
  if ((item.type === "text" || item.type === "text_delta") && typeof item.text === "string")
    return item.text;
  if (
    (item.type === "thinking" || item.type === "thinking_delta") &&
    typeof item.thinking === "string"
  )
    return item.thinking;
  if (
    (item.type === "thinking" || item.type === "thinking_delta") &&
    typeof item.text === "string"
  )
    return item.text;
  return "";
}

/** Extract only explicitly typed text/thinking content blocks. */
export function nativeThinkingText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(nativeThinkingBlockText).join("");
  return nativeThinkingBlockText(value);
}

function stringField(value: unknown, key: string) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[key] === "string"
    ? String((value as Record<string, unknown>)[key])
    : "";
}

function eventId(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,255}$/u.test(value)
    ? value
    : null;
}

export class ZhipuThinkingStreamCollector {
  private current: ZhipuThinkingCapture | undefined;
  private readonly now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  get active(): ZhipuThinkingCapture | undefined {
    return this.current ? { ...this.current } : undefined;
  }

  private snapshot() {
    return this.current?.text ? { ...this.current } : undefined;
  }

  consumePreview(
    frame: ZhipuPreviewFrame | ZhipuRecord,
    context: { commandKey: string; afterEventId?: string },
  ): ZhipuThinkingCapture | undefined {
    if (frame.type === "event_start") {
      const event = frame.event;
      if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
      const item = event as Record<string, unknown>;
      const id = eventId(item.id);
      if (!id) return undefined;
      if (item.type === "agent.message") {
        const previous = this.snapshot();
        this.current = undefined;
        return previous;
      }
      if (item.type !== "agent.thinking") return undefined;
      if (
        this.current?.eventId === id &&
        this.current.commandKey === context.commandKey
      )
        return this.snapshot();
      const previous = this.snapshot();
      this.current = {
        eventId: id,
        commandKey: context.commandKey,
        ...(context.afterEventId ? { afterEventId: context.afterEventId } : {}),
        text: "",
        startedAt: this.now(),
        complete: false,
      };
      return previous;
    }
    if (frame.type !== "event_delta" || !this.current) return undefined;
    const candidate = frame as Record<string, unknown>;
    const nestedType =
      candidate.event && typeof candidate.event === "object" && !Array.isArray(candidate.event)
        ? (candidate.event as Record<string, unknown>).type
        : undefined;
    // A message delta is never thinking text, even if a provider omits the
    // event_start frame or reconnects at a boundary.
    if (nestedType === "agent.message") return undefined;
    const linked =
      eventId(candidate.event_id) ??
      eventId(candidate.eventId) ??
      eventId((candidate.event as Record<string, unknown> | undefined)?.id);
    if (linked && linked !== this.current.eventId) return undefined;
    const delta = nativeThinkingText(candidate.content_delta);
    if (!delta) return undefined;
    this.current.text += delta;
    return this.snapshot();
  }

  consumeEvent(event: ZhipuRecord): ZhipuThinkingCapture | undefined {
    const type = String(event.type ?? "");
    if (type === "agent.thinking") {
      const id = eventId(event.id);
      if (!id || !this.current || id !== this.current.eventId) return undefined;
      const content =
        nativeThinkingText(event.content) ||
        stringField(event, "text") ||
        stringField(event, "thinking");
      if (content) {
        this.current.text = content;
        this.current.authoritativeText = true;
      }
      this.current.complete = true;
      const result = this.snapshot();
      this.current = undefined;
      return result;
    }
    if (
      type === "span.model_request_end" ||
      type === "session.status_idle" ||
      type === "session.idle"
    ) {
      if (!this.current) return undefined;
      this.current.complete = false;
      const result = this.snapshot();
      this.current = undefined;
      return result;
    }
    return undefined;
  }

  interrupt(): ZhipuThinkingCapture | undefined {
    if (!this.current) return undefined;
    this.current.complete = false;
    const result = this.snapshot();
    this.current = undefined;
    return result;
  }
}
