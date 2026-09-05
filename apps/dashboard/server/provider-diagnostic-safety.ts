const SAFE_PROVIDER_REQUEST_REFERENCE = /^[A-Za-z0-9_.:-]+$/u;
const SAFE_PROVIDER_COORDINATE = /^[A-Za-z0-9_.[\]-]+$/u;

export function safeProviderRequestReference(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized &&
    normalized.length <= 191 &&
    SAFE_PROVIDER_REQUEST_REFERENCE.test(normalized)
    ? normalized
    : null;
}

const PROVIDER_VALIDATION_COORDINATE_CATEGORIES: ReadonlyArray<
  readonly [category: string, matcher: RegExp]
> = [
  ["agent_profile", /(?:^|[.\[])(?:agent_profile)(?:$|[.\[])/iu],
  [
    "structured_output_schema",
    /(?:^|[.\[])(?:structured_output_schema|input_schema)(?:$|[.\[])/iu,
  ],
  ["message.content", /(?:^|[.\[])message\.content(?:$|[.\[])/iu],
  [
    "attachments",
    /(?:^|[.\[])(?:attachments|file_id|file_data|filename|mime_type)(?:$|[.\[])/iu,
  ],
  ["task_references", /(?:^|[.\[])task_references(?:$|[.\[])/iu],
  ["task_id", /(?:^|[.\[])task_id(?:$|[.\[])/iu],
  ["title", /(?:^|[.\[])title(?:$|[.\[])/iu],
  [
    "hide_in_task_list",
    /(?:^|[.\[])hide_in_task_list(?:$|[.\[])/iu,
  ],
  ["interactive_mode", /(?:^|[.\[])interactive_mode(?:$|[.\[])/iu],
  ["share_visibility", /(?:^|[.\[])share_visibility(?:$|[.\[])/iu],
];

/** Retain a provider-neutral category, never arbitrary response text. */
export function classifyProviderValidationCoordinate(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !normalized ||
    normalized.length > 192 ||
    !SAFE_PROVIDER_COORDINATE.test(normalized)
  ) {
    return null;
  }
  return (
    PROVIDER_VALIDATION_COORDINATE_CATEGORIES.find(([, matcher]) =>
      matcher.test(normalized),
    )?.[0] ?? null
  );
}
