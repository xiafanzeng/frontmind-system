import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("React-only application boot", () => {
  const html = readFileSync(
    resolve(process.cwd(), "client/index.html"),
    "utf8",
  );
  const main = readFileSync(
    resolve(process.cwd(), "client/src/main.tsx"),
    "utf8",
  );
  const app = readFileSync(
    resolve(process.cwd(), "client/src/App.tsx"),
    "utf8",
  );

  it("leaves the root empty until React renders and retains the noscript notice", () => {
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain(
      '<script type="module" src="/src/main.tsx"></script>',
    );
    expect(html).toContain(
      "<noscript>FrontMind 需要启用 JavaScript 才能打开工作空间。</noscript>",
    );
  });

  it("does not restore the removed purple static shell or boot event", () => {
    const entry = `${html}\n${main}`;

    expect(entry).not.toMatch(/frontmind-boot-/);
    expect(entry).not.toContain("frontmind:booted");
    expect(entry).not.toContain("BootCompletionSignal");
    expect(html).not.toContain(">F</div>");
    expect(html).not.toContain("#641b96");
    expect(html).not.toContain("window.setTimeout");
  });

  it("keeps authentication and workspace suspense on one React loading state", () => {
    expect(app.match(/<WorkspaceLoadingState \/>/g)).toHaveLength(2);
    expect(app.match(/正在打开工作空间/g)).toHaveLength(1);
    expect(app.match(/rounded-2xl bg-muted/g)).toHaveLength(1);
    expect(app.match(/animate-spin text-primary/g)).toHaveLength(1);
  });
});
