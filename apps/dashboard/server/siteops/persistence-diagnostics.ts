const SAFE_SITEOPS_PERSISTENCE_COLUMNS = new Set([
  "starter_version",
  "workflow_upstream_version",
  "workflow_version",
]);

const SAFE_SITEOPS_PERSISTENCE_CONSTRAINTS = new Set([
  "conversation_turns_client_request_uq",
  "messages_conversation_sequence_uq",
  "site_builds_21st_credential_fk",
  "site_builds_credential_version_ck",
  "site_builds_id",
  "site_builds_knowledge_snapshot_id_knowledge_base_snapshots_id_fk",
  "site_builds_project_id_site_projects_id_fk",
  "site_builds_project_ordinal_uq",
  "site_builds_quota_pair_ck",
  "site_builds_quota_period_fk",
  "site_builds_style_sample_id_website_style_samples_id_fk",
  "site_builds_user_id_users_id_fk",
  "site_operations_project_request_uq",
  "visual_candidate_pool_pages_batch_uq",
  "visual_candidate_pool_pages_pool_page_uq",
  "website_style_batches_source_ck",
]);

const MYSQL_TRANSPORT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "PROTOCOL_SEQUENCE_TIMEOUT",
]);

function safeDatabaseDriverCode(value: unknown) {
  return typeof value === "string" &&
    (/^ER_[A-Z0-9_]{1,60}$/u.test(value) ||
      MYSQL_TRANSPORT_ERROR_CODES.has(value))
    ? value
    : null;
}

function safeMysqlErrno(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 65_535
    ? value
    : null;
}

function safeMysqlSqlState(value: unknown) {
  return typeof value === "string" && /^[0-9A-Z]{5}$/u.test(value)
    ? value
    : null;
}

function mysqlDatabaseEvidence(record: Record<string, unknown>) {
  const driverCode = safeDatabaseDriverCode(record.code);
  const errno = safeMysqlErrno(record.errno);
  const sqlState = safeMysqlSqlState(record.sqlState ?? record.sqlstate);
  const transport = Boolean(
    driverCode && MYSQL_TRANSPORT_ERROR_CODES.has(driverCode),
  );
  const serverError = Boolean(
    (driverCode?.startsWith("ER_") && (errno !== null || sqlState)) ||
      (errno !== null && sqlState),
  );
  return { driverCode, errno, sqlState, transport, serverError };
}

function errorCauseChain(error: unknown) {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current = error;
  while (
    current &&
    typeof current === "object" &&
    !seen.has(current) &&
    chain.length < 6
  ) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    chain.push(record);
    current = record.cause;
  }
  return chain;
}

export function isSiteOpsPersistenceDatabaseError(error: unknown) {
  for (const record of errorCauseChain(error)) {
    const evidence = mysqlDatabaseEvidence(record);
    if (evidence.transport || evidence.serverError) {
      return true;
    }
  }
  return false;
}

export function siteOpsPersistenceTransactionOutcome(
  error: unknown,
): "rolled_back" | "unknown" {
  let hasServerError = false;
  for (const record of errorCauseChain(error)) {
    const evidence = mysqlDatabaseEvidence(record);
    if (evidence.transport) return "unknown";
    hasServerError ||= evidence.serverError;
  }
  return hasServerError ? "rolled_back" : "unknown";
}

function allowedIdentifier(value: unknown, allowlist: ReadonlySet<string>) {
  return typeof value === "string" && allowlist.has(value) ? value : null;
}

function allowedIdentifierFromMessage(
  message: string,
  expression: RegExp,
  allowlist: ReadonlySet<string>,
) {
  for (const match of message.matchAll(expression)) {
    const identifier = match[1]?.split(".").at(-1);
    if (identifier && allowlist.has(identifier)) return identifier;
  }
  return null;
}

/**
 * Extract the minimal diagnostics needed to identify a SiteOps persistence
 * failure. Raw error messages, SQL, parameters and unrecognised identifiers
 * never cross this boundary.
 */
export function safeSiteOpsPersistenceDiagnostics(error: unknown) {
  let driverCode: string | null = null;
  let errno: number | null = null;
  let sqlState: string | null = null;
  let column: string | null = null;
  let constraint: string | null = null;

  for (const record of errorCauseChain(error)) {
    const evidence = mysqlDatabaseEvidence(record);
    if (!evidence.transport && !evidence.serverError) continue;
    const recordDriverCode = evidence.driverCode;
    const recordErrno = evidence.errno;
    const recordSqlState = evidence.sqlState;

    driverCode ??= recordDriverCode;
    errno ??= recordErrno;
    sqlState ??= recordSqlState;
    column ??= allowedIdentifier(
      record.column,
      SAFE_SITEOPS_PERSISTENCE_COLUMNS,
    );
    constraint ??= allowedIdentifier(
      record.constraint,
      SAFE_SITEOPS_PERSISTENCE_CONSTRAINTS,
    );

    // Only a record carrying driver-shaped metadata may contribute parsed
    // identifiers. The identifier itself must still be a known schema name.
    for (const message of [record.sqlMessage, record.message]) {
      if (typeof message !== "string") continue;
      column ??= allowedIdentifierFromMessage(
        message,
        /\bcolumn\s+['"`]([^'"`]{1,128})['"`]/giu,
        SAFE_SITEOPS_PERSISTENCE_COLUMNS,
      );
      constraint ??= allowedIdentifierFromMessage(
        message,
        /\bconstraint\s+['"`]([^'"`]{1,128})['"`]/giu,
        SAFE_SITEOPS_PERSISTENCE_CONSTRAINTS,
      );
      constraint ??= allowedIdentifierFromMessage(
        message,
        /\bfor\s+key\s+['"`]([^'"`]{1,128})['"`]/giu,
        SAFE_SITEOPS_PERSISTENCE_CONSTRAINTS,
      );
    }
  }

  return {
    ...(driverCode ? { driverCode } : {}),
    ...(errno !== null ? { errno } : {}),
    ...(sqlState ? { sqlState } : {}),
    ...(column ? { column } : {}),
    ...(constraint ? { constraint } : {}),
  };
}
