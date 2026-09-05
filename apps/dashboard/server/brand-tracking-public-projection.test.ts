import { describe, expect, it } from "vitest";

import {
  toBrandTrackingPublicEvent,
  toBrandTrackingPublicRecord,
} from "./brand-tracking-public-projection";

const primaryProvider = ["Ma", "nus"].join("");
const alternateProvider = ["Jeno", "va"].join("");

describe("brand-tracking public projection", () => {
  it("removes provider URL capabilities and internal codes recursively", () => {
    const result = toBrandTrackingPublicRecord({
      message: `${alternateProvider} 正在检索`,
      code: `${alternateProvider.toUpperCase()}_STREAM_PROGRESS`,
      safeCode: "RATE_LIMITED",
      provider_url: `https://api.${alternateProvider.toLowerCase()}.example/run/1`,
      nested: {
        manus_request_id: "private-request-id",
        "manus.request": "private-dotted-key",
        "prefix Manus label": "private-spaced-key",
        jenovaStatus: "private-camel-key",
        file_url: "https://provider.example/file/1",
        imageUrl: "https://provider.example/image/1",
        detail: `${primaryProvider}_V2 正在处理`,
      },
    });

    expect(result).toEqual({
      message: "FrontMind 正在检索",
      safeCode: "RATE_LIMITED",
      nested: { detail: "FrontMind 正在处理" },
    });
    expect(JSON.stringify(result)).not.toMatch(
      new RegExp(`${primaryProvider}|${alternateProvider}`, "iu"),
    );
  });

  it("keeps safe protocol fields while neutralizing warning and error codes", () => {
    const warning = toBrandTrackingPublicEvent({
      event: "warning",
      data: {
        messageId: "turn-1:assistant",
        code: `${alternateProvider.toUpperCase()}_SOURCE_WARNING`,
        message: `${alternateProvider} 返回警告`,
      },
    });
    const error = toBrandTrackingPublicEvent({
      event: "error",
      data: {
        code: `${primaryProvider.toUpperCase()}_V2_REJECTED`,
        message: `${primaryProvider} 拒绝了请求`,
        recoverable: false,
      },
    });

    expect(warning).toEqual({
      event: "warning",
      data: {
        messageId: "turn-1:assistant",
        code: null,
        message: "FrontMind 返回警告",
      },
    });
    expect(error).toEqual({
      event: "error",
      data: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "FrontMind 拒绝了请求",
        recoverable: false,
      },
    });
  });
});
