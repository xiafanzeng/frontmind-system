import { useEffect, useState } from "react";
import { Link } from "wouter";
import { BookOpen } from "lucide-react";
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

export function EnterpriseQaSourceNote() {
  const { activeConversation } = useConversation();
  const localTaskId =
    activeConversation?.previousResponseId ?? activeConversation?.taskId;
  const [source, setSource] = useState<SourceState>({
    knowledgeBase: null,
    loaded: false,
    failed: false,
  });
  useEffect(() => {
    let disposed = false;
    let requestVersion = 0;
    setSource({ knowledgeBase: null, loaded: false, failed: false });
    const refresh = async () => {
      const version = ++requestVersion;
      try {
        const query = localTaskId
          ? `localTaskId=${encodeURIComponent(localTaskId)}`
          : "purpose=enterprise_qa";
        const response = await fetch(
          `/api/frontmind/v2/runtime-config?${query}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            headers: deliveryProjectHeaders(),
          },
        );
        if (!response.ok) throw new Error("知识库来源读取失败");
        const result: Pick<TaskResponse, "knowledgeBase"> =
          await response.json();
        if (!disposed && version === requestVersion) {
          setSource({
            knowledgeBase: result.knowledgeBase ?? null,
            loaded: true,
            failed: false,
          });
        }
      } catch {
        if (!disposed && version === requestVersion) {
          setSource({ knowledgeBase: null, loaded: true, failed: true });
        }
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [localTaskId]);

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

export default function EnterpriseQaWorkspace() {
  return (
    <ConversationPurposeProvider purpose="enterprise_qa">
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <EnterpriseQaSourceNote />
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
    </ConversationPurposeProvider>
  );
}
