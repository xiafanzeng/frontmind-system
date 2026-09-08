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
};

function useKnowledgeSource(localTaskId?: string | null, enabled = true) {
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
    const refresh = async () => {
      const version = ++requestVersion;
      controller?.abort();
      controller = new AbortController();
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
        const response = await fetch(
          `/api/frontmind/v2/runtime-config?${query}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            headers,
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error("知识库来源读取失败");
        const result: Pick<TaskResponse, "knowledgeBase"> =
          await response.json();
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
      } catch {
        if (!disposed && version === requestVersion) {
          setSource({
            requestKey,
            knowledgeBase: null,
            loaded: true,
            failed: true,
          });
        }
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      controller?.abort();
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
}: { currentPublication?: SourceState } = {}) {
  const { activeConversation } = useConversation();
  const localTaskId =
    activeConversation?.previousResponseId ?? activeConversation?.taskId;
  const { source: taskSource } = useKnowledgeSource(
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
    </header>
  );
}

function EnterpriseQaPublishedWorkspace() {
  // A historical conversation's frozen snapshot cannot unlock a project with no current publication.
  const { source, retry } = useKnowledgeSource();
  if (!source.loaded || source.failed || !source.knowledgeBase) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background p-6">
        <section
          aria-label="企业问答暂未解锁"
          className="w-full max-w-md rounded-2xl border border-border/70 bg-card p-8 text-center shadow-sm"
        >
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {!source.loaded ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <LockKeyhole className="h-6 w-6" />
            )}
          </div>
          <p className="text-sm font-medium text-muted-foreground">
            企业问答智能体
          </p>
          <h1 className="mt-2 text-xl font-semibold">
            {!source.loaded
              ? "正在确认知识库状态"
              : source.failed
                ? "暂时无法确认知识库状态"
                : "先构建并发布企业知识库"}
          </h1>
          <p
            role={source.failed ? "alert" : "status"}
            className="mt-3 text-sm leading-6 text-muted-foreground"
          >
            {!source.loaded
              ? "确认当前企业项目已发布知识库后，即可进入企业问答。"
              : source.failed
                ? "知识库状态读取失败，请重新检查后再进入企业问答。"
                : "当前企业项目尚无可用的已发布知识库。请先完成构建并发布，再开始企业问答。"}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href={projectWorkspaceUrl("/?view=knowledge")}>
                构建并发布知识库
              </Link>
            </Button>
            <Button variant="outline" disabled={!source.loaded} onClick={retry}>
              重新检查
            </Button>
          </div>
        </section>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <EnterpriseQaSourceNote currentPublication={source} />
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
