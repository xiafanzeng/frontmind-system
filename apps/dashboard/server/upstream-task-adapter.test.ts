import { describe, expect, it } from "vitest";

import {
  assertExpectedUpstreamTaskId,
  canonicalUpstreamTask,
  upstreamAliasedIdentity,
  upstreamTaskId,
} from "./upstream-task-adapter";

describe("upstream task adapter identity boundary", () => {
  it("uses one nested task without mixing wrapper metadata", () => {
    const payload = {
      id: "wrapper-id",
      task: { id: "task-id", task_id: "task-id", status: "done" },
    };
    expect(canonicalUpstreamTask(payload)).toBe(payload.task);
    expect(upstreamTaskId(payload)).toBe("task-id");
  });

  it("rejects conflicting aliases instead of choosing one", () => {
    expect(() => upstreamTaskId({ id: "task-a", task_id: "task-b" })).toThrow(
      "别名字段相互冲突",
    );
  });

  it("rejects an overlong identity instead of truncating it", () => {
    expect(() => upstreamTaskId({ id: "x".repeat(256) })).toThrow(
      "超过 255 个字符",
    );
    expect(() =>
      upstreamAliasedIdentity({
        record: { file_id: "f".repeat(256) },
        aliases: ["file_id", "fileId"],
        label: "上游文件标识",
        required: true,
      }),
    ).toThrow("超过 255 个字符");
  });

  it("rejects a numeric identity that JavaScript cannot represent losslessly", () => {
    expect(() => upstreamTaskId({ id: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      "无法无损表示",
    );
  });

  it("rejects surrounding whitespace instead of rewriting an identity", () => {
    expect(() => upstreamTaskId({ id: " task-1 " })).toThrow("含首尾空白");
  });

  it("requires the response identity to match the requested task", () => {
    expect(
      assertExpectedUpstreamTaskId({ task: { task_id: "task-1" } }, "task-1"),
    ).toEqual({ task_id: "task-1" });
    expect(() =>
      assertExpectedUpstreamTaskId({ id: "task-2" }, "task-1"),
    ).toThrow("与请求不一致");
  });
});
