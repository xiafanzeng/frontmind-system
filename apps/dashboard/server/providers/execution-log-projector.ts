import type { ManusV2MessageEvent } from "../manus-v2-client";

const MAX_MESSAGE = 4_000;
/** Project only public messages and fixed tool/status summaries. Tool arguments,
 * results, reasoning, usage spans and workflow input are never public logs. */
export function safeExecutionText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.replace(/\u0000/g, "").trim();
  if (!text || /^[\s`]*(?:\{|\[)/u.test(text)) return undefined;
  if (
    /FRONTMIND_\w+_CONTRACT|prompt_path|expected_output|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/iu.test(
      text,
    )
  )
    return undefined;
  text = text
    .replace(
      /(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]+/giu,
      "[认证信息已隐藏]",
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [已隐藏]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|[a-f0-9]{32,}\.[A-Za-z0-9_-]{12,})\b/giu,
      "[密钥已隐藏]",
    )
    .replace(
      /\b(?:[A-Z_]*(?:API_KEY|TOKEN|PASSWORD|SECRET|ACCESS_KEY)[A-Z_]*|api[_ -]?key|password|secret)\s*[:=]\s*["']?[^\s"',;]+/giu,
      "[密钥已隐藏]",
    )
    .replace(/https?:\/\/[^\s<>"']+/giu, (url) => {
      try {
        const parsed = new URL(url);
        if (parsed.search || parsed.username || parsed.password)
          return "[私密链接已隐藏]";
        return url;
      } catch {
        return "[链接已隐藏]";
      }
    });
  return text.slice(0, MAX_MESSAGE);
}

export function executionEventMessage(
  event: Pick<ManusV2MessageEvent, "type"> & Record<string, unknown>,
): string | undefined {
  if (/thinking|reasoning|usage|span/iu.test(event.type)) return undefined;
  if (
    ![
      "assistant_message",
      "status_update",
      "tool_use",
      "tool_result",
      "agent.tool_use",
      "agent.tool_result",
    ].includes(event.type)
  )
    return undefined;
  // A previously projected message is revalidated on every public response.
  if (typeof event.message === "string")
    return safeExecutionText(event.message);
  if (event.type === "assistant_message") {
    const message = event.assistant_message as
      { content?: unknown; text?: unknown } | undefined;
    const content = message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (item) =>
                  item?.type === "text" && typeof item.text === "string",
              )
              .map((item) => item.text)
              .join("\n")
          : message?.text;
    return safeExecutionText(text);
  }
  if (event.type === "tool_use" || event.type === "agent.tool_use")
    return "开始调用工具。";
  if (event.type === "tool_result" || event.type === "agent.tool_result")
    return event.is_error === true ? "工具执行失败。" : "工具执行完成。";
  if (event.type === "status_update") {
    const status = (
      event.status_update as { agent_status?: string } | undefined
    )?.agent_status;
    return (
      {
        running: "正在执行。",
        waiting: "执行暂停，等待所需输入。",
        stopped: "本轮执行结束，正在验证结果。",
        error: "上游执行异常。",
      } as Record<string, string>
    )[status ?? ""];
  }
  return undefined;
}
