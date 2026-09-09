import { describe, expect, it } from "vitest";
import {
  nativeThinkingText,
  ZhipuThinkingStreamCollector,
} from "./zhipu-thinking-stream";

const start = (id: string) =>
  ({ type: "event_start", event: { id, type: "agent.thinking" } }) as any;
const delta = (text: unknown, id?: string) =>
  ({ type: "event_delta", content_delta: text, ...(id ? { event_id: id } : {}) }) as any;

describe("Zhipu thinking preview collector", () => {
  it("extracts only typed text/thinking blocks and preserves whitespace", () => {
    expect(nativeThinkingText("  原文\n")).toBe("  原文\n");
    expect(
      nativeThinkingText([
        { type: "text", text: "一" },
        { type: "thinking", thinking: " 二\n" },
        { type: "thinking_delta", text: "三" },
        { type: "output_text", text: "丢弃" },
      ]),
    ).toBe("一 二\n三");
    expect(nativeThinkingText({ type: "text_delta", text: "单个" })).toBe("单个");
    expect(nativeThinkingText({ text: "不接受" })).toBe("");
  });

  it("captures event_start and ordered deltas with context and Unicode", () => {
    const collector = new ZhipuThinkingStreamCollector(() => "2026-01-01T00:00:00.000Z");
    expect(collector.consumePreview(start("think-1"), { commandKey: "turn:1", afterEventId: "msg-1" })).toBeUndefined();
    expect(collector.consumePreview(delta([{ type: "thinking", thinking: "  分析" }]), { commandKey: "wrong" })).toMatchObject({
      eventId: "think-1", commandKey: "turn:1", afterEventId: "msg-1", text: "  分析", complete: false,
    });
    expect(collector.consumePreview(delta("\n结论"), { commandKey: "wrong" })?.text).toBe("  分析\n结论");
  });

  it("rejects mismatched IDs and isolates agent.message", () => {
    const collector = new ZhipuThinkingStreamCollector(() => "now");
    collector.consumePreview(start("think-1"), { commandKey: "turn" });
    expect(collector.consumePreview(delta("错", "think-2"), { commandKey: "turn" })).toBeUndefined();
    expect(collector.consumeEvent({ id: "msg", type: "agent.message", content: "不要串入" })).toBeUndefined();
    expect(collector.active?.text).toBe("");
  });

  it("completes with the matching event and does not duplicate accumulated deltas", () => {
    const collector = new ZhipuThinkingStreamCollector(() => "now");
    collector.consumePreview(start("think-1"), { commandKey: "turn" });
    collector.consumePreview(delta("思考"), { commandKey: "turn" });
    const done = collector.consumeEvent({ id: "think-1", type: "agent.thinking", content: [{ type: "text", text: "思考完成" }] });
    expect(done).toMatchObject({ text: "思考完成", complete: true, authoritativeText: true });
    expect(collector.active).toBeUndefined();
    collector.consumePreview(start("think-empty"), { commandKey: "turn" });
    collector.consumePreview(delta("保留片段"), { commandKey: "turn" });
    const empty = collector.consumeEvent({ id: "think-empty", type: "agent.thinking" });
    expect(empty).toMatchObject({ text: "保留片段", complete: true });
    expect(empty).not.toHaveProperty("authoritativeText");
    expect(collector.consumeEvent({ id: "think-empty", type: "agent.thinking" })).toBeUndefined();
  });

  it("retains cumulative text as incomplete on idle/end or interrupt, and ignores empty captures", () => {
    const collector = new ZhipuThinkingStreamCollector(() => "now");
    collector.consumePreview(start("think-1"), { commandKey: "turn" });
    expect(collector.consumeEvent({ type: "span.model_request_end" })).toBeUndefined();
    expect(collector.active).toBeUndefined();
    collector.consumePreview(start("think-2"), { commandKey: "turn" });
    collector.consumePreview(delta("片段"), { commandKey: "turn" });
    expect(collector.consumeEvent({ type: "session.status_idle" })).toMatchObject({ text: "片段", complete: false });
    collector.consumePreview(start("think-3"), { commandKey: "turn" });
    collector.consumePreview(delta("中断"), { commandKey: "turn" });
    expect(collector.interrupt()).toMatchObject({ text: "中断", complete: false });
  });

  it("ends on message starts, rotates IDs without mixing, and ignores stale IDs", () => {
    const collector = new ZhipuThinkingStreamCollector(() => "now");
    collector.consumePreview(start("think-1"), { commandKey: "turn" });
    collector.consumePreview(delta("前"), { commandKey: "turn" });
    expect(
      collector.consumePreview(
        { type: "event_start", event: { id: "msg-1", type: "agent.message" } } as any,
        { commandKey: "turn" },
      ),
    ).toMatchObject({ text: "前", complete: false });
    expect(collector.active).toBeUndefined();
    collector.consumePreview(start("think-2"), { commandKey: "turn" });
    collector.consumePreview(delta("新"), { commandKey: "turn" });
    expect(collector.consumePreview(start("think-3"), { commandKey: "turn" })).toMatchObject({ text: "新", complete: false });
    expect(collector.active?.eventId).toBe("think-3");
    expect(collector.consumePreview(delta("旧", "think-2"), { commandKey: "turn" })).toBeUndefined();
    expect(
      collector.consumePreview(
        { type: "event_delta", event: { type: "agent.message" }, content_delta: "消息" } as any,
        { commandKey: "turn" },
      ),
    ).toBeUndefined();
    collector.consumePreview(delta("三"), { commandKey: "turn" });
    expect(collector.consumePreview(start("think-3"), { commandKey: "other-turn" })).toMatchObject({ text: "三", complete: false });
    expect(collector.active?.commandKey).toBe("other-turn");
  });
});
