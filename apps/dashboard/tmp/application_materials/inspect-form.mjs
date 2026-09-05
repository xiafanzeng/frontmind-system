import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath =
  "/Users/fanzengxia/Documents/GitHub/frontmind-dashboard/tmp/application_materials/附件3.鲲鹏青年项目入库推荐表（2026版）.xlsx";
const previewDir =
  "/Users/fanzengxia/Documents/GitHub/frontmind-dashboard/tmp/application_materials/artifact-previews";

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const summary = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 12000,
  tableMaxRows: 30,
  tableMaxCols: 14,
  tableMaxCellChars: 140,
});
console.log(summary.ndjson);

const sheets = await workbook.inspect({
  kind: "sheet",
  include: "id,name",
  maxChars: 4000,
});
console.log(sheets.ndjson);

const firstSheet = workbook.worksheets.getItemAt(0);
const usedRange = firstSheet.getUsedRange();
console.log(`USED_RANGE=${usedRange.address}`);

const region = await workbook.inspect({
  kind: "region",
  sheetId: firstSheet.name,
  range: usedRange.address,
  maxChars: 18000,
});
console.log(region.ndjson);

const styles = await workbook.inspect({
  kind: "computedStyle",
  sheetId: firstSheet.name,
  range: usedRange.address,
  maxChars: 8000,
});
console.log(styles.ndjson);

await fs.mkdir(previewDir, { recursive: true });
const preview = await workbook.render({
  sheetName: firstSheet.name,
  autoCrop: "all",
  scale: 1.5,
  format: "png",
});
await fs.writeFile(
  `${previewDir}/template.png`,
  new Uint8Array(await preview.arrayBuffer()),
);
