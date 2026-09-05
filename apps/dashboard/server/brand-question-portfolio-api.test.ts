import { describe, expect, it } from "vitest";

import { publicBrandQuestionTask } from "./brand-question-portfolio-api";

describe("brand question public task boundary", () => {
  it("returns a strict task identity without upstream auth or metadata", () => {
    const credential = "sentinel-brand-question-credential";
    const task = publicBrandQuestionTask(
      {
        id: "task-brand-1",
        status: "created",
        API_KEY: credential,
        Authorization: `Bearer ${credential}`,
        metadata: {
          Cookie: credential,
          accessToken: "another-token",
        },
        output: [{ text: credential }],
      },
      "task-brand-1",
      credential,
    );
    const serialized = JSON.stringify(task);

    expect(task).toEqual({ id: "task-brand-1", status: "running" });
    expect(serialized).not.toContain(credential);
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("cookie");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("api_key");
    expect(serialized).not.toContain("output");
    expect(serialized).not.toContain("metadata");
  });
});
