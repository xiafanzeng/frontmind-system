import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { BookOpen, LockKeyhole, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import Home from "@/pages/Home";
import {
  ConversationPurposeProvider,
  useConversation,
} from "@/contexts/ConversationContext";
import { deliveryProjectHeaders } from "@/lib/delivery-project";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import type { TaskResponse } from "@/lib/frontmind-api";

type SourceState = {
  knowledgeBase: TaskResponse["knowledgeBase"];
  loaded: boolean;
  failed: boolean;
  refreshFailed?: boolean;
};

function useKnowledgeSource(
  localTaskId?: string | null,
  enabled = true,
): { source: SourceState; retry: () => void } {
  const search = useSearch();
  const headers = deliveryProjectHeaders();
  const requestKey = JSON.stringify([search, headers, localTaskId ?? null]);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<SourceState & { requestKey: string }>({
    requestKey: "",
    knowledgeBase: null,
    loaded: false,
    failed: false,
  });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let requestVersion = 0;
    let controller: AbortController | undefined;
    let timeoutId: number | undefined;
    const refresh = async () => {
      const version = ++requestVersion;
      controller?.abort();
      window.clearTimeout(timeoutId);
      const requestController = new AbortController();
      controller = requestController;
      let temporaryFailure = true;
      const deadline = new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          temporaryFailure = true;
          requestController.abort();
          reject(new Error("知识库状态读取超时"));
        }, 15000);
      });
      const requestTimeoutId = timeoutId;
      // Revalidate a known source without unmounting the chat or losing an unsent draft.
      // A different scope never reuses it because requestKey is checked during render.
      setSource((current) =>
        current.requestKey === requestKey && current.loaded && !current.failed
          ? current
          : { requestKey, knowledgeBase: null, loaded: false, failed: false },
      );
      try {
        const query = localTaskId
          ? `localTaskId=${encodeURIComponent(localTaskId)}`
          : "purpose=enterprise_qa";
        const response = await Promise.race([
          fetch(`/api/frontmind/v2/runtime-config?${query}`, {
            credentials: "same-origin",
            cache: "no-store",
            headers,
            signal: requestController.signal,
          }),
          deadline,
        ]);
        if (!response.ok) {
          temporaryFailure =
            response.status >= 500 ||
            response.status === 408 ||
            response.status === 429;
          throw new Error("知识库来源读取失败");
        }
        temporaryFailure = false;
        const result: Pick<TaskResponse, "knowledgeBase"> = await Promise.race([
          response.json(),
          deadline,
        ]);
        const knowledgeBase = result.knowledgeBase ?? null;
        if (
          knowledgeBase &&
          (typeof knowledgeBase.snapshotId !== "string" ||
            !knowledgeBase.snapshotId.trim() ||
            !Number.isInteger(knowledgeBase.version) ||
            knowledgeBase.version < 1 ||
            !Number.isInteger(knowledgeBase.documentCount) ||
            knowledgeBase.documentCount < 1 ||
            typeof knowledgeBase.sourceFileName !== "string")
        ) {
          throw new Error("知识库来源无效");
        }
        if (!disposed && version === requestVersion) {
          setSource({ requestKey, knowledgeBase, loaded: true, failed: false });
        }
      } catch (error) {
        // Fetch can reject while reading a successful response body as well as before headers.
        if (error instanceof TypeError) temporaryFailure = true;
        if (!disposed && version === requestVersion) {
          setSource((current) =>
            temporaryFailure &&
            current.requestKey === requestKey &&
            current.loaded &&
            !current.failed &&
            current.knowledgeBase
              ? { ...current, refreshFailed: true }
              : { requestKey, knowledgeBase: null, loaded: true, failed: true },
          );
        }
      } finally {
        window.clearTimeout(requestTimeoutId);
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearTimeout(timeoutId);
      window.removeEventListener("focus", refresh);
    };
    // The key freezes all project/owner transport headers and the selected task for this request.
  }, [requestKey, attempt, enabled]);
  return {
    source:
      source.requestKey === requestKey
        ? source
        : { knowledgeBase: null, loaded: false, failed: false },
    retry: () => setAttempt((value) => value + 1),
  };
}

export function EnterpriseQaSourceNote({
  currentPublication,
  onRetryPublication,
}: { currentPublication?: SourceState; onRetryPublication?: () => void } = {}) {
  const { activeConversation } = useConversation();
  const localTaskId =
    activeConversation?.previousResponseId ?? activeConversation?.taskId;
  const { source: taskSource, retry: retryTaskSource } = useKnowledgeSource(
    localTaskId,
    !!localTaskId || !currentPublication,
  );
  const source =
    !localTaskId && currentPublication ? currentPublication : taskSource;

  return (
    <header className="border-b border-border/60 bg-background px-5 py-3 pl-16 lg:pl-5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <BookOpen className="h-4 w-4 text-primary" />
        企业问答智能体
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground" role="status">
        {!source.loaded ? (
          "正在读取知识库来源…"
        ) : source.failed ? (
          "知识库来源暂时无法读取，请稍后重试。"
        ) : source.knowledgeBase ? (
          <>
            {localTaskId ? "本会话绑定" : "新会话使用"}已发布知识库 v
            {source.knowledgeBase.version} ·{" "}
            {source.knowledgeBase.sourceFileName} ·{" "}
            {source.knowledgeBase.documentCount} 篇资料
            {localTaskId
              ? "。后续发布不会改变本会话的知识来源。"
              : "。开始问答时绑定当前发布版本。"}
          </>
        ) : (
          <>
            尚无可用的已发布企业知识库。请先
            <Link
              href={projectWorkspaceUrl("/?view=knowledge")}
              className="ml-1 font-medium text-primary underline underline-offset-2"
            >
              构建并发布知识库
            </Link>
            ，再开始问答。
          </>
        )}
      </p>
      {(source.refreshFailed || currentPublication?.refreshFailed) && (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-700"
        >
          <span>知识库状态暂时无法刷新，已保留当前会话和草稿。</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (currentPublication?.refreshFailed) onRetryPublication?.();
              if (taskSource.refreshFailed) retryTaskSource();
            }}
          >
            重新检查知识库
          </Button>
        </div>
      )}
    </header>
  );
}

function EnterpriseQaPublishedWorkspace() {
  // A historical conversation's frozen snapshot cannot unlock a project with no current publication.
  const { source, retry } = useKnowledgeSource();
  if (!source.loaded || source.failed || !source.knowledgeBase) {
    return (
      <div className="h-full min-h-0 overflow-y-auto bg-[#f7f6f9] px-4 py-8 sm:px-6 lg:px-8">
        <section
          aria-label="企业问答暂未解锁"
          className="mx-auto mt-4 w-full max-w-3xl overflow-hidden rounded-[24px] border border-[#e8e1ee] bg-white shadow-[0_18px_48px_rgba(33,19,58,.07)] md:mt-8"
        >
          <div className="border-b border-[#eee8f2] bg-[linear-gradient(135deg,rgba(91,42,134,.08),rgba(200,144,19,.08))] p-6 md:p-8">
            <div
              className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-[#5b2a86] shadow-sm"
              aria-hidden="true"
            >
              {!source.loaded ? (
                <Loader2 className="h-6 w-6 animate-spin" />
              ) : (
                <LockKeyhole className="h-6 w-6" />
              )}
            </div>
            <p className="text-xs font-semibold tracking-wide text-[#8d7b9e]">
              企业问答智能体
            </p>
            <h1 className="mt-2 text-xl font-semibold leading-relaxed text-[#171321] sm:text-2xl">
              {!source.loaded
                ? "正在确认知识库状态"
                : source.failed
                  ? "暂时无法确认知识库状态"
                  : "发布知识库后，即可开始企业问答"}
            </h1>
            <p
              role={source.failed ? "alert" : "status"}
              className="mt-3 max-w-2xl text-sm leading-7 text-[#625a70]"
            >
              {!source.loaded
                ? "确认当前企业项目已发布知识库后，即可进入企业问答。"
                : source.failed
                  ? "知识库状态读取失败，请重新检查后再进入企业问答。"
                  : "当前企业项目尚无可用的已发布知识库。请先完成构建并发布，再开始企业问答。"}
            </p>
          </div>
          <div className="grid gap-5 p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:p-8">
            <div className="flex items-start gap-3 text-[#625a70]">
              <BookOpen
                className="mt-0.5 h-5 w-5 shrink-0 text-[#8d7b9e]"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium text-[#332a48]">
                  以企业知识库为依据回答
                </p>
                <p className="mt-1 text-xs leading-6">
                  完成资料构建与发布后，回来重新检查即可开始问答。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button asChild>
                <Link href={projectWorkspaceUrl("/?view=knowledge")}>
                  前往智能知识库
                </Link>
              </Button>
              <Button
                variant="outline"
                disabled={!source.loaded}
                onClick={retry}
              >
                重新检查
              </Button>
            </div>
          </div>
        </section>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <EnterpriseQaSourceNote
        currentPublication={source}
        onRetryPublication={retry}
      />
      <div className="min-h-0 flex-1">
        <Home
          embedded
          purpose="enterprise_qa"
          hidePortalNavigation
          showKnowledgeBaseStarter={false}
          showAccountMenu={false}
          showSettings={false}
          standardWelcomeVariant="enterprise_qa"
        />
      </div>
    </div>
  );
}

export default function EnterpriseQaWorkspace() {
  return (
    <ConversationPurposeProvider purpose="enterprise_qa">
      <EnterpriseQaPublishedWorkspace />
    </ConversationPurposeProvider>
  );
}
