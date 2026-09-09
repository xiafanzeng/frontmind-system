import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { BookOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import Home from "@/pages/Home";
import {
  ConversationPurposeProvider,
  useConversation,
} from "@/contexts/ConversationContext";
import { deliveryProjectHeaders } from "@/lib/delivery-project";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import type { TaskResponse } from "@/lib/frontmind-api";
import { AgentWorkbenchShell } from "@/components/AgentWorkbenchShell";
import ProjectAgentWorkbench from "./ProjectAgentWorkbench";
import { trpc } from "@/lib/trpc";

type EnterpriseQaWorkspaceProps = {
  workbench?: boolean;
  projectId?: string;
};

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
    <section className="enterprise-qa-source" aria-label="企业问答知识来源">
      <h2>知识来源</h2>
      <dl>
        <div>
          <dt>{localTaskId ? "本任务绑定版本" : "新任务使用版本"}</dt>
          <dd role="status">
            {!source.loaded
              ? "正在读取…"
              : source.failed
                ? "读取失败"
                : source.knowledgeBase
                  ? `v${source.knowledgeBase.version}`
                  : "尚未发布"}
          </dd>
        </div>
        {currentPublication?.knowledgeBase && (
          <div>
            <dt>项目当前发布版本</dt>
            <dd>v{currentPublication.knowledgeBase.version}</dd>
          </div>
        )}
        {source.knowledgeBase && (
          <>
            <div>
              <dt>来源资料</dt>
              <dd>{source.knowledgeBase.sourceFileName}</dd>
            </div>
            <div>
              <dt>资料数量</dt>
              <dd>{source.knowledgeBase.documentCount} 篇</dd>
            </div>
          </>
        )}
      </dl>
      {localTaskId && <p>后续发布保留本任务原有知识版本。</p>}
      {(source.failed ||
        source.refreshFailed ||
        currentPublication?.refreshFailed) && (
        <div role="alert">
          <p>暂时无法刷新知识来源，当前任务和输入已保留。</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onRetryPublication?.();
              retryTaskSource();
            }}
          >
            重新检查知识库
          </Button>
        </div>
      )}
    </section>
  );
}

function KnowledgeUnlockSteps() {
  const progress = trpc.workspace.knowledgeProgress.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: true,
  });
  const data = progress.data?.progress;
  const files = data?.retainedCustomerAttachmentCount;
  const materials = progress.isError
    ? "暂时无法读取"
    : progress.isLoading
      ? "正在读取资料状态…"
      : !data
        ? "待提交企业资料"
        : typeof files === "number" && files > 0
          ? `已保留 ${files} 份资料`
          : "已建立知识构建任务";
  const confirmation = progress.isError
    ? "暂时无法读取"
    : progress.isLoading
      ? "正在读取构建状态…"
      : data?.updateAllowed || data?.packageAllowed
        ? "已确认，可更新知识库"
        : data
          ? "构建与节点确认尚未完成"
          : "等待开始构建";
  return (
    <>
      <ol className="enterprise-qa-unlock-steps">
        <li>
          <span>1</span>
          <div>
            提交企业资料<small>{materials}</small>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            完成构建与确认<small>{confirmation}</small>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            发布知识库<small>尚未发布</small>
          </div>
        </li>
      </ol>
      {progress.isError && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void progress.refetch()}
        >
          重新读取构建状态
        </Button>
      )}
    </>
  );
}

function EnterpriseQaPublishedWorkspace({
  workbench = false,
  projectId = "account",
}: EnterpriseQaWorkspaceProps) {
  // A historical conversation's frozen snapshot cannot unlock a project with no current publication.
  const { source, retry } = useKnowledgeSource();

  if (!source.loaded || source.failed || !source.knowledgeBase) {
    const unlockFlow = (
      <section className="enterprise-qa-unlock" aria-label="企业问答暂未解锁">
        {!source.loaded ? (
          <div>
            <p role="status">
              <Loader2 className="inline-block mr-2 h-4 w-4 animate-spin" />
              正在确认知识库状态…
            </p>
            <Button variant="outline" disabled>
              重新检查
            </Button>
          </div>
        ) : source.failed ? (
          <>
            <p role="alert">知识库状态读取失败，请重新检查。</p>
            <Button variant="outline" onClick={retry}>
              重新检查
            </Button>
          </>
        ) : (
          <>
            <BookOpen size={26} className="text-primary" />
            <h2>先发布企业知识库，即可开始问答</h2>
            <p role="status">当前项目尚无可用的已发布知识库。</p>
            <KnowledgeUnlockSteps />
            <div className="flex flex-wrap gap-3">
              <Button asChild>
                <Link href={projectWorkspaceUrl("/?view=knowledge")}>
                  前往智能知识库
                </Link>
              </Button>
              <Button variant="ghost" onClick={retry}>
                重新检查
              </Button>
            </div>
          </>
        )}
      </section>
    );
    if (!workbench)
      return (
        <div className="h-full min-h-0 overflow-y-auto bg-white px-6 py-8">
          {unlockFlow}
        </div>
      );
    return (
      <AgentWorkbenchShell
        projectId={projectId}
        moduleId="enterprise-qa"
        title="企业问答"
        taskTitle="新任务"
        layout="workflow"
        main={unlockFlow}
        auxiliary={
          <section
            className="enterprise-qa-source"
            aria-label="企业问答知识来源"
          >
            <h2>知识来源</h2>
            <dl>
              <div>
                <dt>项目发布状态</dt>
                <dd>
                  {!source.loaded
                    ? "正在读取"
                    : source.failed
                      ? "暂时无法读取"
                      : "尚未发布"}
                </dd>
              </div>
              <div>
                <dt>任务绑定版本</dt>
                <dd>首次提问时绑定</dd>
              </div>
            </dl>
          </section>
        }
      />
    );
  }
  if (workbench) {
    return (
      <ProjectAgentWorkbench projectId={projectId} purpose="enterprise_qa">
        <EnterpriseQaSourceNote
          currentPublication={source}
          onRetryPublication={retry}
        />
      </ProjectAgentWorkbench>
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

export default function EnterpriseQaWorkspace({
  workbench = false,
  projectId,
}: EnterpriseQaWorkspaceProps = {}) {
  if (workbench) {
    return <EnterpriseQaPublishedWorkspace workbench projectId={projectId} />;
  }
  return (
    <ConversationPurposeProvider purpose="enterprise_qa">
      <EnterpriseQaPublishedWorkspace />
    </ConversationPurposeProvider>
  );
}
