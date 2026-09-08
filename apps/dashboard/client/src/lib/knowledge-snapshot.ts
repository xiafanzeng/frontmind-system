import {
  captureWorkspaceRestOperation,
  type WorkspaceRestOperation,
} from "./workspace-rest-scope";

const KNOWLEDGE_PUBLISH_REQUEST_TIMEOUT_MS = 30_000;
const KNOWLEDGE_PUBLISH_JOB_TIMEOUT_MS = 180_000;
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
  expectedBuildId?: string;
  expectedRevision?: number;
  expectedContentVersion?: number;
  operation?: WorkspaceRestOperation;
}) {
  const operation = input.operation ?? captureWorkspaceRestOperation();
  // A request deadline leaves the workspace lifetime intact so callers can
  // read the authoritative result after a potentially committed publication.
  const deadline = new AbortController();
  let timer = window.setTimeout(
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
      body: JSON.stringify({
        conversationId: input.conversationId,
        expectedBuildId: input.expectedBuildId,
        expectedRevision: input.expectedRevision,
        expectedContentVersion: input.expectedContentVersion,
        background: true,
      }),
      signal: deadline.signal,
    });
    operation.assertActive();
    deadline.signal.throwIfAborted();
    if (!response.ok) throw new Error(await readErrorMessage(response));
    if (response.status === 202) {
      const accepted = await response.json();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => deadline.abort(new DOMException(
        "知识库更新结果待核实，请重新读取当前状态", "TimeoutError",
      )), KNOWLEDGE_PUBLISH_JOB_TIMEOUT_MS);
      for (;;) {
        const status = await operation.fetch(
          `/api/knowledge-base/progress/${encodeURIComponent(input.conversationId)}`,
          { credentials: "include", signal: deadline.signal },
        );
        operation.assertActive();
        deadline.signal.throwIfAborted();
        if (!status.ok) throw new Error(await readErrorMessage(status));
        const { progress } = await status.json();
        const build = progress?.build;
        if (!build || build.id !== accepted.expectedBuildId ||
          build.revision !== accepted.expectedRevision ||
          (accepted.expectedContentVersion !== undefined &&
            build.contentVersion !== accepted.expectedContentVersion)) {
          throw new Error("工作稿已变化，请重新确认后更新知识库");
        }
        if (build.status === "published") break;
        if (progress.packageState === "attention_required") {
          throw new Error("知识库更新未完成，修改已保存，当前正式版本未受影响，请重新更新");
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
        operation.assertActive();
        deadline.signal.throwIfAborted();
      }
    }
    operation.assertActive();
    deadline.signal.throwIfAborted();
    window.dispatchEvent(new CustomEvent("frontmind:knowledge-base-updated"));
    return true;
  } finally {
    window.clearTimeout(timer);
  }
}
