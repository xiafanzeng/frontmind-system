import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateProductionRuntimeEnvironment } from "./production-runtime-validator.mjs";

export {
  deriveDownloadTokenSecretFromCredentialMasterKey,
  validateProductionRuntimeEnvironment,
} from "./production-runtime-validator.mjs";

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    validateProductionRuntimeEnvironment();
    console.log("RUNTIME_ENV_OK");
  } catch (error) {
    console.error(
      error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : "RUNTIME_ENV_CHECK_FAILED",
    );
    process.exitCode = 1;
  }
}
