import { describe, expect, it } from "vitest";

import {
  canonicalizeKnowledgeBaseCompanyName,
  canonicalizeKnowledgeBaseWebsite,
  canonicalizeKnowledgeBaseWebsiteLines,
} from "./knowledge-base-company-identity";

describe("knowledge-base company identity", () => {
  it("freezes a primary website and canonical research website list", () => {
    expect(
      canonicalizeKnowledgeBaseWebsiteLines(
        " Example.COM\nhttps://example.com/\nhttp://WWW.Example.com:80/path?q=1 ",
      ),
    ).toEqual({
      primary: "https://example.com/",
      researchWebsites: [
        "https://example.com/",
        "http://www.example.com/path?q=1",
      ],
    });
  });

  it("normalizes only representation-level company differences", () => {
    expect(canonicalizeKnowledgeBaseCompanyName("  示例　企业  ")).toBe(
      "示例 企业",
    );
    expect(canonicalizeKnowledgeBaseWebsite("EXAMPLE.com:443")).toBe(
      "https://example.com/",
    );
    expect(canonicalizeKnowledgeBaseWebsite("http://example.com")).toBe(
      "http://example.com/",
    );
    expect(canonicalizeKnowledgeBaseWebsite("https://例子.测试:443")).toBe(
      "https://xn--fsqu00a.xn--0zwm56d/",
    );
    expect(canonicalizeKnowledgeBaseWebsite("https://faß.de")).toBe(
      "https://xn--fa-hia.de/",
    );
    expect(
      canonicalizeKnowledgeBaseWebsite("https://www.example.com/"),
    ).not.toBe(canonicalizeKnowledgeBaseWebsite("https://example.com/"));
    expect(
      canonicalizeKnowledgeBaseWebsite("https://example.com/path?q=1"),
    ).not.toBe(
      canonicalizeKnowledgeBaseWebsite("https://example.com/path?q=2"),
    );
  });

  it.each([
    "ftp://example.com",
    "https://user:secret@example.com",
    "https://@example.com",
    "https://example.com/#",
    "https://example.com/#section",
    "example.com#",
    "//example.com",
  ])("rejects an unsafe website coordinate: %s", (website) => {
    expect(() => canonicalizeKnowledgeBaseWebsite(website)).toThrow();
  });

  it("allows an at-sign in the path or query but never in URL authority", () => {
    expect(canonicalizeKnowledgeBaseWebsite("https://example.com/@brand")).toBe(
      "https://example.com/@brand",
    );
    expect(
      canonicalizeKnowledgeBaseWebsite("example.com/?contact=a@b.test"),
    ).toBe("https://example.com/?contact=a@b.test");
  });
});
