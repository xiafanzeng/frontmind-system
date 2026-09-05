import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MarkdownRenderer, {
  buildSafeGeneralChatMarkdownHref,
  buildSafeMarkdownHref,
  isGeneralChatArtifactHref,
} from "./MarkdownRenderer";

describe("MarkdownRenderer security", () => {
  it("does not turn persisted raw HTML into executable DOM", () => {
    const { container } = render(
      <MarkdownRenderer
        content={
          '安全文本\n<img src="x" onerror="alert(1)"><script>alert(2)</script>'
        }
      />,
    );

    expect(screen.getByText(/安全文本/)).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
  });

  it("opens external PDF references directly instead of using file preparation", () => {
    render(
      <MarkdownRenderer
        content={
          "[申请版本](https://www1.hkexnews.hk/app/report.pdf?version=1)"
        }
      />,
    );

    const link = screen.getByRole("link", { name: "申请版本" });
    expect(link).toHaveAttribute(
      "href",
      "https://www1.hkexnews.hk/app/report.pdf?version=1",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("unwraps historical FrontMind proxy links to their original source", () => {
    const original =
      "https://siliconflow.cn/files/report.pdf?download=1&lang=zh";
    const historical = `https://dashboard.frontmind.net/api/frontmind/proxy-download?url=${encodeURIComponent(
      original,
    )}&filename=report.pdf`;

    expect(buildSafeMarkdownHref(historical)).toBe(original);
  });

  it("keeps ordinary external pages and rejects unsafe protocols", () => {
    expect(buildSafeMarkdownHref("https://siliconflow.cn/about?from=kb")).toBe(
      "https://siliconflow.cn/about?from=kb",
    );
    expect(buildSafeMarkdownHref("javascript:alert(1)")).toBeUndefined();
  });

  it.each([
    "/home/ubuntu/huang_guohua_business_card.png",
    "/mnt/data/huang_guohua_business_card.png",
    "/tmp/huang_guohua_business_card.png",
    "/workspace/huang_guohua_business_card.png",
    "/var/tmp/huang_guohua_business_card.png",
    "sandbox:/mnt/data/huang_guohua_business_card.png",
    "file:///home/ubuntu/huang_guohua_business_card.png",
    "./huang_guohua_business_card.png",
    "huang_guohua_business_card.png",
    "%2Fhome%2Fubuntu%2Fhuang_guohua_business_card.png",
    "//home/ubuntu/huang_guohua_business_card.png",
  ])(
    "renders unresolved Provider-local general-chat paths as plain text: %s",
    (href) => {
      render(
        <MarkdownRenderer
          content={`[下载修改后的名片图片](${href})`}
          generalChatLinks
        />,
      );

      expect(
        screen.queryByRole("link", { name: "下载修改后的名片图片" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("下载修改后的名片图片")).toBeInTheDocument();
      expect(buildSafeGeneralChatMarkdownHref(href)).toBeUndefined();
    },
  );

  it("intercepts a localized artifact link instead of navigating the SPA", () => {
    const onArtifactDownload = vi.fn();
    const href =
      "/api/frontmind/v2/artifacts/artifact_92d000000000000000000000000000/content";
    render(
      <MarkdownRenderer
        content={`[下载修改后的名片图片](${href})`}
        generalChatLinks
        onArtifactDownload={onArtifactDownload}
      />,
    );

    const link = screen.getByRole("link", { name: "下载修改后的名片图片" });
    expect(link).toHaveAttribute("href", href);
    expect(isGeneralChatArtifactHref(href)).toBe(true);
    fireEvent.click(link);
    expect(onArtifactDownload).toHaveBeenCalledWith(href);
  });

  it("never treats an external lookalike path as an authenticated artifact download", () => {
    const onArtifactDownload = vi.fn();
    const href =
      "https://evil.example/api/frontmind/v2/artifacts/artifact_92d/content";
    render(
      <MarkdownRenderer
        content={`[外部链接](${href})`}
        generalChatLinks
        onArtifactDownload={onArtifactDownload}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "外部链接" }));
    expect(isGeneralChatArtifactHref(href)).toBe(false);
    expect(onArtifactDownload).not.toHaveBeenCalled();
  });

  it("keeps safe external, anchor, mail and telephone references in general chat", () => {
    expect(buildSafeGeneralChatMarkdownHref("https://example.test/a")).toBe(
      "https://example.test/a",
    );
    expect(buildSafeGeneralChatMarkdownHref("#result")).toBe("#result");
    expect(buildSafeGeneralChatMarkdownHref("mailto:test@example.test")).toBe(
      "mailto:test@example.test",
    );
    expect(buildSafeGeneralChatMarkdownHref("tel:+8613500000000")).toBe(
      "tel:+8613500000000",
    );
  });
});
