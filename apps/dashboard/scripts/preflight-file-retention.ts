import "dotenv/config";

import {
  assertFileRetentionPreflightReady,
  inspectFileRetentionPreflight,
} from "../server/file-retention-preflight";

async function main() {
  const report = await inspectFileRetentionPreflight();
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--require-ready")) {
    assertFileRetentionPreflightReady(report);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
