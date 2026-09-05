import "dotenv/config";

import { closeDbForOneShotMaintenance, getDb } from "../server/db";
import {
  parseExistingManusBuildReconciliationArgs,
  reconcileExistingManusBuild,
} from "../server/siteops/manus-build-reconciliation";

async function main() {
  const args = parseExistingManusBuildReconciliationArgs(process.argv.slice(2));
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL_NOT_CONFIGURED");
  const result = await reconcileExistingManusBuild(db, {
    buildId: args.buildId,
  });
  // This deliberately prints coordinates only. Provider content, signed URLs,
  // prompts, source archives, and credentials must never enter operator logs.
  console.log(JSON.stringify(result));
}

main().then(
  async () => {
    await closeDbForOneShotMaintenance();
    process.exit(0);
  },
  async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    try {
      await closeDbForOneShotMaintenance();
    } finally {
      process.exit(1);
    }
  },
);
