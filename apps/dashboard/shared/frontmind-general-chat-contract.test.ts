import { describe, expect, it } from "vitest";

import {
  parseFrontMindGeneralChatOperationContract,
  stripFrontMindGeneralChatOperationContract,
} from "./frontmind-general-chat-contract";

const suffix = (contract = "dashboard.general-chat", revision = 2) =>
  `hello\n\n# FrontMind operation contract\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify(
    {
      operationToken: "chat-create:bf9ffd2a-8bd7-4d66-b294-c6a8216c0f89",
      contract,
      revision,
    },
  )}`;

describe("ordinary-chat operation contract sanitizer", () => {
  it("strips an exact legacy ordinary-chat suffix", () => {
    expect(stripFrontMindGeneralChatOperationContract(suffix())).toBe("hello");
    expect(
      parseFrontMindGeneralChatOperationContract(suffix())?.operationToken,
    ).toBe("chat-create:bf9ffd2a-8bd7-4d66-b294-c6a8216c0f89");
  });

  it("does not strip knowledge-base, malformed, embedded or extended text", () => {
    for (const value of [
      suffix("dashboard.knowledge-base"),
      suffix("dashboard.general-chat", 3),
      `${suffix()}\nuser text`,
      suffix().replace("chat-create:", "unsafe:"),
      suffix().replace('"revision":2', '"revision":2,"extra":true'),
    ]) {
      expect(stripFrontMindGeneralChatOperationContract(value)).toBe(value);
    }
  });
});
