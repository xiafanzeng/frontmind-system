import { describe, expect, it } from "vitest";

import {
  classifyProviderValidationCoordinate,
  safeProviderRequestReference,
} from "./provider-diagnostic-safety";

describe("provider diagnostic safety", () => {
  it("keeps only bounded request references", () => {
    expect(safeProviderRequestReference(" req_01.A-b:c ")).toBe(
      "req_01.A-b:c",
    );
    expect(safeProviderRequestReference("x".repeat(191))).toBe(
      "x".repeat(191),
    );
    expect(safeProviderRequestReference("x".repeat(192))).toBeNull();
    expect(safeProviderRequestReference("req secret/value")).toBeNull();
    expect(safeProviderRequestReference("req\nset-cookie: secret")).toBeNull();
  });

  it.each([
    ["request.agent_profile[0]", "agent_profile"],
    ["structured_output_schema.properties.answer", "structured_output_schema"],
    ["message.content", "message.content"],
    ["attachments[0].file_id", "attachments"],
    ["task_references[0]", "task_references"],
    ["task_id", "task_id"],
    ["title", "title"],
    ["hide_in_task_list", "hide_in_task_list"],
    ["interactive_mode", "interactive_mode"],
    ["share_visibility", "share_visibility"],
  ])("classifies %s without retaining the raw path", (input, expected) => {
    expect(classifyProviderValidationCoordinate(input)).toBe(expected);
  });

  it("drops arbitrary or secret-looking validation coordinates", () => {
    expect(
      classifyProviderValidationCoordinate("customer.secret.api_key"),
    ).toBeNull();
    expect(
      classifyProviderValidationCoordinate("message.content; DROP TABLE"),
    ).toBeNull();
    expect(classifyProviderValidationCoordinate("x".repeat(193))).toBeNull();
    expect(classifyProviderValidationCoordinate({ field: "title" })).toBeNull();
  });
});
