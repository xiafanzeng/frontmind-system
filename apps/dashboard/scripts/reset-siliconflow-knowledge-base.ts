import "dotenv/config";

import {
  executeSiliconFlowKnowledgeBaseReset,
  previewSiliconFlowKnowledgeBaseReset,
  SILICONFLOW_MAINTENANCE_BRAND,
} from "../server/siliconflow-kb-maintenance";

function valueFor(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(
    prefix.length,
  );
}

const userId = Number(valueFor("user-id"));
if (!Number.isSafeInteger(userId) || userId <= 0) {
  throw new Error(
    "用法：pnpm kb:reset:siliconflow -- --user-id=<明确用户ID> [--execute --maintenance-confirmed=硅基流动:<用户ID>]",
  );
}

const preview = await previewSiliconFlowKnowledgeBaseReset(userId);
console.log(
  JSON.stringify(
    {
      mode: "preview",
      target: {
        userId: preview.userId,
        formalBrandName: preview.formalBrandName,
        buildCompanyNames: Array.from(new Set(preview.buildCompanyNames)),
      },
      cleanup: preview.counts,
      resetRevision: {
        current: preview.resetRevision,
        afterExecute: preview.resetRevision + 1,
      },
      fingerprint: preview.fingerprint,
    },
    null,
    2,
  ),
);

if (!process.argv.includes("--execute")) {
  console.log("仅完成预览，数据库和外部资源均未修改。");
  process.exit(0);
}

const result = await executeSiliconFlowKnowledgeBaseReset({
  userId,
  expectedFingerprint: preview.fingerprint,
  maintenanceConfirmation: valueFor("maintenance-confirmed") || "",
});
console.log(
  JSON.stringify(
    {
      mode: "executed",
      expectedBrand: SILICONFLOW_MAINTENANCE_BRAND,
      ...result,
    },
    null,
    2,
  ),
);

if (result.externalCleanup.failed > 0) {
  process.exitCode = 2;
}
