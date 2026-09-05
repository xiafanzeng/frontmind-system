import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MarkdownRenderer, {
  buildSafeMarkdownHref,
} from "./MarkdownRenderer";

describe("MarkdownRenderer security", () => {
  it("does not turn persisted raw HTML into executable DOM", () => {
    const { container } = render(
      <MarkdownRenderer
        content={'安全文本\n<img src="x" onerror="alert(1)"><script>alert(2)</script>'}
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
    const historical =
      `https://dashboard.frontmind.net/api/frontmind/proxy-download?url=${encodeURIComponent(
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
});
