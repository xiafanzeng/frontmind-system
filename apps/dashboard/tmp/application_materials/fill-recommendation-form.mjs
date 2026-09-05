import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath =
  "/Users/fanzengxia/Documents/GitHub/frontmind-dashboard/tmp/application_materials/附件3.鲲鹏青年项目入库推荐表（2026版）.xlsx";
const outputDir =
  "/Users/fanzengxia/Documents/GitHub/frontmind-dashboard/outputs/kp_youth_2026";
const outputPath =
  `${outputDir}/深圳鲲鹏青年项目入库推荐表_FrontMind_草拟版.xlsx`;
const previewPath =
  "/Users/fanzengxia/Documents/GitHub/frontmind-dashboard/tmp/application_materials/artifact-previews/filled-form.png";

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("Sheet2");

sheet.getRange("B3:K3").values = [[
  "香港中文大学（深圳）",
  "深圳市超前无限科技有限公司",
  "【待填】统一社会信用代码",
  "FrontMind：可信智能体驱动的企业GEO与AI增长平台",
  "人工智能",
  "夏凡增",
  "【待填】身份证号",
  "【待填】负责人电话",
  "夏凡增",
  "【待填】联系人电话",
]];

sheet.getRange("A3:K3").format.rowHeight = 58;
sheet.getRange("B3:K3").format.wrapText = true;
sheet.getRange("B3:K3").format.verticalAlignment = "center";
sheet.getRange("B3:K3").format.horizontalAlignment = "center";
sheet.getRange("B3:K3").format.font = {
  name: "Noto Sans CJK SC",
  size: 10,
  color: "#000000",
};
sheet.getRange("E3").format.font = {
  name: "Noto Sans CJK SC",
  size: 9,
  color: "#000000",
};

for (const address of ["B3", "C3", "D3", "H3", "I3", "J3", "K3"]) {
  sheet.getRange(address).format.fill = "#FFF2CC";
}
for (const address of ["D3", "H3", "I3", "K3"]) {
  sheet.getRange(address).format.font = {
    name: "Noto Sans CJK SC",
    size: 10,
    color: "#7F6000",
    italic: true,
  };
}

workbook.comments.setSelf({ displayName: "FrontMind 申报材料草拟" });
workbook.comments.addThread(
  { cell: sheet.getRange("B3") },
  "暂按香港中文大学（深圳）推荐路径填写，提交前须由推荐单位确认。来源：https://www.cuhkgeo.com/",
);
workbook.comments.addThread(
  { cell: sheet.getRange("C3") },
  "企业名称依据项目负责人公开履历与检索结果暂拟，提交前请逐字核对营业执照。来源：https://xiafanzeng.github.io/",
);
workbook.comments.addThread(
  { cell: sheet.getRange("E3") },
  "本项目名称为申报口径拟定名，需与后续申请书、路演材料和系统填报保持一致。",
);
workbook.comments.addThread(
  { cell: sheet.getRange("F3") },
  "深圳“20+8”产业集群已将人工智能单列为战略性新兴产业集群。来源：https://www.sz.gov.cn/cn/zjsz/gl/content/post_12553610.html",
);
workbook.comments.addThread(
  { cell: sheet.getRange("G3") },
  "姓名与负责人履历来源：https://xiafanzeng.github.io/；身份证件、年龄及学历证明仍须提交前核验。",
);
workbook.comments.addThread(
  { cell: sheet.getRange("D3") },
  "必须按营业执照填写18位统一社会信用代码。",
);
workbook.comments.addThread(
  { cell: sheet.getRange("H3") },
  "优先填写项目负责人身份证号码，并与系统实名认证信息一致。",
);
workbook.comments.addThread(
  { cell: sheet.getRange("I3") },
  "填写项目负责人本人常用手机号码。",
);
workbook.comments.addThread(
  { cell: sheet.getRange("J3") },
  "联系人暂按项目负责人填写；如由项目运营或申报专员对接，请替换为实际联系人。",
);
workbook.comments.addThread(
  { cell: sheet.getRange("K3") },
  "填写联系人常用手机号码。",
);

const rowCheck = await workbook.inspect({
  kind: "table",
  range: "Sheet2!A1:K4",
  include: "values,formulas",
  tableMaxRows: 4,
  tableMaxCols: 11,
  maxChars: 9000,
});
console.log(rowCheck.ndjson);

const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
});
console.log(formulaErrors.ndjson);

const preview = await workbook.render({
  sheetName: "Sheet2",
  range: "A1:K5",
  scale: 1.5,
  format: "png",
});
await fs.writeFile(
  previewPath,
  new Uint8Array(await preview.arrayBuffer()),
);

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(`OUTPUT=${outputPath}`);
