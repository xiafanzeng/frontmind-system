import { useEffect, useState } from "react";
import {
  Database,
  Home as HomeIcon,
  MessageSquareText,
  PanelsTopLeft,
} from "lucide-react";

import { useAuth } from "@/_core/hooks/useAuth";
import KnowledgeBaseViewer from "@/components/KnowledgeBaseViewer";
import PortalShell from "@/components/PortalShell";
import { trpc } from "@/lib/trpc";
import Home from "@/pages/Home";

const userNav = [
  { label: "企业看板", href: "/", icon: HomeIcon },
  { label: "知识库智能体", href: "/knowledge-base", icon: Database },
];

export default function KnowledgeBaseWorkspace() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"build" | "display">("build");
  const knowledgeQuery = trpc.workspace.knowledge.useQuery(undefined, {
    enabled: user?.role === "user",
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    const refresh = () => {
      void knowledgeQuery.refetch();
      setTab("display");
    };
    window.addEventListener("frontmind:knowledge-base-updated", refresh);
    return () =>
      window.removeEventListener("frontmind:knowledge-base-updated", refresh);
  }, [knowledgeQuery.refetch]);

  return (
    <PortalShell
      eyebrow="知识库智能体"
      title="企业知识库构建与展示"
      navItems={userNav}
      toolbar={
        <div className="flex rounded-xl border border-[#e1d8e8] bg-[#f3eef6] p-1">
          <button
            type="button"
            onClick={() => setTab("build")}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition sm:text-sm ${
              tab === "build"
                ? "bg-white text-[#5b2a86] shadow-sm"
                : "text-[#716a80]"
            }`}
          >
            <MessageSquareText className="h-4 w-4" />
            构建流程
          </button>
          <button
            type="button"
            onClick={() => setTab("display")}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition sm:text-sm ${
              tab === "display"
                ? "bg-white text-[#5b2a86] shadow-sm"
                : "text-[#716a80]"
            }`}
          >
            <PanelsTopLeft className="h-4 w-4" />
            知识库展示
          </button>
        </div>
      }
    >
      {tab === "build" ? (
        <div className="h-[calc(100dvh-142px)] min-h-[640px] overflow-hidden rounded-[20px] border border-[#e1d8e8] bg-white shadow-[0_18px_48px_rgba(33,19,58,.08)]">
          <Home
            embedded
            fixedAgentProfile="frontmind-pro"
            syncKnowledgeBaseSnapshot
          />
        </div>
      ) : (
        <KnowledgeBaseViewer
          snapshot={knowledgeQuery.data?.snapshot}
          loading={knowledgeQuery.isLoading}
        />
      )}
    </PortalShell>
  );
}
