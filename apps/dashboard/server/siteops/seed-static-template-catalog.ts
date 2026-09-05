import {
  getStaticTemplateCatalogReadiness,
  seedStaticTemplateCatalog,
} from "./static-template-catalog";
import {
  REQUIRED_STATIC_TEMPLATE_EXECUTION_CANDIDATE_ID,
  buildStaticTemplateExecutionAdmission,
} from "./static-template-execution-admission";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && args[0] !== "--check-active")) {
    throw new Error("usage: siteops:seed-template-catalog [--check-active]");
  }
  if (args[0] === "--check-active") {
    const readiness = await getStaticTemplateCatalogReadiness({
      verifyAssetHashes: true,
    });
    process.stdout.write(`${JSON.stringify(readiness)}\n`);
    if (!readiness.ready) process.exitCode = 1;
    return;
  }
  const seeded = await seedStaticTemplateCatalog({
    executionAdmissionBuilder: buildStaticTemplateExecutionAdmission,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      reused: seeded.reused,
      workflowVersion: seeded.catalog.workflowVersion,
      catalogVersion: seeded.catalog.catalogVersion,
      entryCount: seeded.catalog.entryCount,
      admittedCount: seeded.catalog.entries.filter(
        (entry) => entry.executionAdmission.status === "admitted",
      ).length,
      requiredAdmissionReady:
        seeded.catalog.entries.find(
          (entry) =>
            entry.candidateId ===
            REQUIRED_STATIC_TEMPLATE_EXECUTION_CANDIDATE_ID,
        )?.executionAdmission.status === "admitted",
      pageSize: seeded.catalog.pageSize,
      pageCount: seeded.catalog.pageCount,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "STATIC_TEMPLATE_CATALOG_SEED_FAILED"}\n`,
  );
  process.exitCode = 1;
});
