import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolverMocks = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("./owned-file-content-resolver", async () => {
  const actual = await vi.importActual<
    typeof import("./owned-file-content-resolver")
  >("./owned-file-content-resolver");
  return {
    ...actual,
    ownedFileContentResolver: { resolve: resolverMocks.resolve },
  };
});

import {
  downloadOwnedRedirectFile,
  parseRedirectWorkbook,
} from "./delivery-redirect-service";

async function workbookBuffer(rows: Array<[string, string, number | string]>) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("301 跳转");
  sheet.addRow(["源URL", "目标URL", "状态码"]);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("batch redirect workbook parser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the owned workbook through the shared content resolver", async () => {
    const bytes = Buffer.from("redirect workbook bytes");
    resolverMocks.resolve.mockResolvedValue({
      stream: Readable.from([bytes]),
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(
      downloadOwnedRedirectFile(42, "file-redirects"),
    ).resolves.toEqual(bytes);
    expect(resolverMocks.resolve).toHaveBeenCalledWith({
      ownerUserId: 42,
      fileId: "file-redirects",
    });
  });

  it("normalizes a valid redirect file without inventing rows", async () => {
    const result = await parseRedirectWorkbook(
      await workbookBuffer([
        ["https://EXAMPLE.com/old#section", "https://example.com/new", 301],
        ["https://example.com/legacy", "https://example.com/current", "301"],
      ]),
    );

    expect(result).toMatchObject({
      total: 2,
      validCount: 2,
      errorCount: 0,
      errors: [],
    });
    expect(result.rows).toEqual([
      {
        row: 2,
        sourceUrl: "https://example.com/old",
        targetUrl: "https://example.com/new",
        statusCode: 301,
      },
      {
        row: 3,
        sourceUrl: "https://example.com/legacy",
        targetUrl: "https://example.com/current",
        statusCode: 301,
      },
    ]);
  });

  it("reports duplicate sources, cycles and non-301 rows by row", async () => {
    const duplicate = await parseRedirectWorkbook(
      await workbookBuffer([
        ["https://example.com/a", "https://example.com/b", 301],
        ["https://example.com/a", "https://example.com/c", 301],
      ]),
    );
    expect(duplicate.validCount).toBe(0);
    expect(duplicate.errors).toContainEqual({
      row: 3,
      message: "源URL与第 2 行重复。",
    });

    const invalid = await parseRedirectWorkbook(
      await workbookBuffer([
        ["https://example.com/a", "https://example.com/b", 301],
        ["https://example.com/b", "https://example.com/a", 301],
        ["https://example.com/c", "https://example.com/d", 302],
      ]),
    );
    expect(invalid.validCount).toBe(0);
    expect(
      invalid.errors.some((error) => error.message.includes("循环跳转")),
    ).toBe(true);
    expect(invalid.errors).toContainEqual({
      row: 4,
      message: "状态码必须为 301。",
    });
  });

  it("rejects files without the required columns", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("错误模板").addRow(["地址", "说明"]);
    const result = await parseRedirectWorkbook(
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    expect(result.validCount).toBe(0);
    expect(result.errors[0]?.message).toContain("源URL、目标URL、状态码");
  });

  it("does not schedule an empty template", async () => {
    const result = await parseRedirectWorkbook(await workbookBuffer([]));
    expect(result).toMatchObject({
      total: 0,
      validCount: 0,
      errorCount: 1,
    });
    expect(result.errors[0]?.message).toContain("至少需要一条");
  });
});
