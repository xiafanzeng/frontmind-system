import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(191)
  .refine((value) => value.trim() === value);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export type ResetPollutionCleanupCliCommand =
  | {
      mode: "reset-pollution-preview";
      userId: number;
      conversationId: string;
      buildId: string;
      resetRequestId: string;
      expectedResetRevision: number;
    }
  | {
      mode: "reset-pollution-apply";
      userId: number;
      conversationId: string;
      buildId: string;
      resetRequestId: string;
      expectedResetRevision: number;
      expectedStateSha256: string;
    };

function fail(code: string): never {
  throw new Error(`KB_RESET_POLLUTION_CLI_${code}`);
}

export function parseResetPollutionCleanupCliArgs(
  argv: readonly string[],
): ResetPollutionCleanupCliCommand {
  const [mode, ...options] = argv;
  if (mode !== "reset-pollution-preview" && mode !== "reset-pollution-apply") {
    fail("COMMAND_INVALID");
  }
  const values = new Map<string, string>();
  for (const option of options) {
    const match = option.match(/^--([a-z][a-z0-9-]*)=(.*)$/u);
    if (!match) fail("ARGUMENT_FORMAT_INVALID");
    if (values.has(match[1]!)) fail("ARGUMENT_DUPLICATE");
    values.set(match[1]!, match[2]!);
  }
  const allowed = new Set([
    "user-id",
    "conversation-id",
    "build-id",
    "reset-request-id",
    "expected-reset-revision",
    ...(mode === "reset-pollution-apply" ? ["expected-state-sha256"] : []),
  ]);
  if (
    values.size !== allowed.size ||
    [...values.keys()].some((key) => !allowed.has(key))
  ) {
    fail("ARGUMENT_REQUIRED_OR_UNKNOWN");
  }
  const rawUserId = values.get("user-id")!;
  const rawRevision = values.get("expected-reset-revision")!;
  if (!/^[1-9]\d{0,9}$/u.test(rawUserId)) fail("USER_ID_INVALID");
  if (!/^\d{1,10}$/u.test(rawRevision)) fail("RESET_REVISION_INVALID");
  const userId = Number(rawUserId);
  const expectedResetRevision = Number(rawRevision);
  if (
    !Number.isSafeInteger(userId) ||
    userId > 2_147_483_647 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision > 4_294_967_294
  ) {
    fail("INTEGER_INVALID");
  }
  const conversationId = values.get("conversation-id")!;
  const buildId = values.get("build-id")!;
  const resetRequestId = values.get("reset-request-id")!;
  if (!id.safeParse(conversationId).success) fail("CONVERSATION_ID_INVALID");
  if (!id.safeParse(buildId).success) fail("BUILD_ID_INVALID");
  if (!id.safeParse(resetRequestId).success) fail("RESET_REQUEST_ID_INVALID");
  const common = {
    userId,
    conversationId,
    buildId,
    resetRequestId,
    expectedResetRevision,
  };
  if (mode === "reset-pollution-preview") return { mode, ...common };
  const expectedStateSha256 = values.get("expected-state-sha256")!;
  if (!sha256.safeParse(expectedStateSha256).success) {
    fail("STATE_SHA256_INVALID");
  }
  return { mode, ...common, expectedStateSha256 };
}

type Counts = {
  builds: number;
  conversations: number;
  turns: number;
  nodes: number;
  messages: number;
  attachments: number;
  acceptedReceipts: number;
  uploadIntents: number;
  upstreamResources: number;
};

export function serializeResetPollutionCleanupCliResult(
  input:
    | {
        success: true;
        mode: "reset-pollution-preview";
        status: "eligible";
        stateSha256: string;
        counts: Counts;
      }
    | {
        success: true;
        mode: "reset-pollution-apply";
        status: "cleaned";
        resetRevisionIncremented: true;
        counts: Counts;
      }
    | {
        success: false;
        mode: "reset-pollution-preview" | "reset-pollution-apply" | null;
        code: string;
      },
) {
  const safe = input.success
    ? input
    : {
        success: false,
        mode: input.mode,
        status: "rejected",
        code: /^KB_RESET_POLLUTION_[A-Z0-9_]+$/u.test(input.code)
          ? input.code
          : "KB_RESET_POLLUTION_CLI_FAILED",
      };
  return `${JSON.stringify({ schemaVersion: 1, ...safe })}\n`;
}
