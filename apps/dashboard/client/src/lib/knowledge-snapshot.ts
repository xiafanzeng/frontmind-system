import {
  captureWorkspaceRestOperation,
  type WorkspaceRestOperation,
} from "./workspace-rest-scope";

const KNOWLEDGE_PUBLISH_REQUEST_TIMEOUT_MS = 30_000;
async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json();
    return (
      payload?.error?.message ||
      payload?.message ||
      `请求失败 (${response.status})`
    );
  } catch {
    return `请求失败 (${response.status})`;
  }
}

export async function syncKnowledgeBaseArchiveFromOutput(input: {
  conversationId: string;
  operation?: WorkspaceRestOperation;
}) {
  const operation = input.operation ?? captureWorkspaceRestOperation();
  // A request deadline leaves the workspace lifetime intact so callers can
  // read the authoritative result after a potentially committed publication.
  const deadline = new AbortController();
  const timer = window.setTimeout(
    () =>
      deadline.abort(
        new DOMException(
          "知识库更新结果待核实，请重新读取当前状态",
          "TimeoutError",
        ),
      ),
    KNOWLEDGE_PUBLISH_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await operation.fetch("/api/dashboard/knowledge/publish", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: input.conversationId }),
      signal: deadline.signal,
    });
    operation.assertActive();
    deadline.signal.throwIfAborted();
    if (!response.ok) throw new Error(await readErrorMessage(response));
    window.dispatchEvent(new CustomEvent("frontmind:knowledge-base-updated"));
    return true;
  } finally {
    window.clearTimeout(timer);
  }
}
