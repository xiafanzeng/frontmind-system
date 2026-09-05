import { MessagesSquare } from "lucide-react";

import type { RunAttempt } from "../../../domain";
import AnswerWorkspace from "../AnswerWorkspace";
import type { SourceScope } from "../types";
import PanelFrame from "./PanelFrame";

export default function AnswerDetailPanel({
  attempts,
  selected,
  fullscreen,
  onSelect,
  onQuestionChange,
  onFullscreenChange,
  sourceScope,
  onSourceScopeChange,
  detailLoading,
  hasMoreAnswers,
  loadingMoreAnswers,
  onLoadMoreAnswers,
  exportHref,
}: {
  attempts: RunAttempt[];
  selected?: RunAttempt;
  fullscreen: boolean;
  onSelect: (attempt: RunAttempt) => void;
  onQuestionChange: (question: string) => void;
  onFullscreenChange: (open: boolean) => void;
  sourceScope: SourceScope;
  onSourceScopeChange: (scope: SourceScope) => void;
  detailLoading?: boolean;
  hasMoreAnswers?: boolean;
  loadingMoreAnswers?: boolean;
  onLoadMoreAnswers?: () => void | Promise<void>;
  exportHref?: string;
}) {
  return (
    <PanelFrame
      id="monitor-answers"
      labelledBy="monitor-tab-answers"
      icon={<MessagesSquare size={17} />}
      title="问答明细"
      meta={`${attempts.length} 条已加载回答`}
      exportHref={exportHref}
      exportFileName="frontmind-monitoring-answers.xlsx"
      className="fm-answer-panel"
      fullscreenEnabled={false}
    >
      <AnswerWorkspace
        attempts={attempts}
        selected={selected}
        fullscreen={fullscreen}
        onSelect={onSelect}
        onQuestionChange={onQuestionChange}
        onFullscreenChange={onFullscreenChange}
        sourceScope={sourceScope}
        onSourceScopeChange={onSourceScopeChange}
        detailLoading={detailLoading}
        hasMoreAnswers={hasMoreAnswers}
        loadingMoreAnswers={loadingMoreAnswers}
        onLoadMoreAnswers={onLoadMoreAnswers}
      />
    </PanelFrame>
  );
}
