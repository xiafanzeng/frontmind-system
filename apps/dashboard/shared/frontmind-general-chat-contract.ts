const GENERAL_CHAT_CONTRACT = "dashboard.general-chat";
const GENERAL_CHAT_CONTRACT_REVISION = 2;

const GENERAL_CHAT_CONTRACT_SUFFIX =
  /(?:\r?\n){2}# FrontMind operation contract\r?\nFRONTMIND_MANUS_V2_OPERATION_CONTRACT=(\{[^\r\n]+\})[ \t]*$/u;

type GeneralChatOperationContract = {
  operationToken: string;
  contract: typeof GENERAL_CHAT_CONTRACT;
  revision: typeof GENERAL_CHAT_CONTRACT_REVISION;
};

export function parseFrontMindGeneralChatOperationContract(
  value: string,
): GeneralChatOperationContract | null {
  const match = GENERAL_CHAT_CONTRACT_SUFFIX.exec(value);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (
      parsed.contract !== GENERAL_CHAT_CONTRACT ||
      parsed.revision !== GENERAL_CHAT_CONTRACT_REVISION ||
      typeof parsed.operationToken !== "string" ||
      !/^chat-(?:create|send):[A-Za-z0-9-]{8,128}$/u.test(
        parsed.operationToken,
      ) ||
      Object.keys(parsed).some(
        (key) => !["operationToken", "contract", "revision"].includes(key),
      )
    ) {
      return null;
    }
    return parsed as GeneralChatOperationContract;
  } catch {
    return null;
  }
}

/**
 * Removes only the exact, legacy Dashboard ordinary-chat transport suffix.
 * Knowledge-base protocols and user-authored lookalikes remain untouched.
 */
export function stripFrontMindGeneralChatOperationContract(value: string) {
  return parseFrontMindGeneralChatOperationContract(value)
    ? value.replace(GENERAL_CHAT_CONTRACT_SUFFIX, "")
    : value;
}
