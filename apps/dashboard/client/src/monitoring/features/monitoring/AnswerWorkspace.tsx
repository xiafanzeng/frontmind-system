import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Expand,
  Image as ImageIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import {
  attemptStatusLabel,
  formatDateTime,
  type RunAttempt,
} from "../../domain";
import CitationRail from "./CitationRail";
import AnswerFullscreenDialog from "./AnswerFullscreenDialog";
import ScreenshotViewerDialog from "./ScreenshotViewerDialog";
import { safeExternalUrl } from "./selectors";
import { attemptModelLabel } from "./types";
import type { SourceScope } from "./types";

const safeMarkdownComponents = {
  a: ({
    children,
    href,
    ...properties
  }: React.ComponentPropsWithoutRef<"a">) => {
    const safeUrl = safeExternalUrl(href);
    return safeUrl ? (
      <a
        {...properties}
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img: ({ alt }: React.ComponentPropsWithoutRef<"img">) => (
    <span className="fm-blocked-markdown-image" role="note">
      外部图片已拦截{alt ? `：${alt}` : ""}
    </span>
  ),
};

export function AnswerReader({
  attempt,
  loading = false,
}: {
  attempt: RunAttempt;
  loading?: boolean;
}) {
  return (
    <article className="fm-answer-reader">
      <header>
        <div>
          <span className={`fm-attempt-state ${attempt.status}`}>
            {attemptStatusLabel(attempt.status)}
          </span>
          <strong>{attemptModelLabel(attempt)}</strong>
        </div>
        <small>{formatDateTime(attempt.capturedAt)}</small>
      </header>
      <div className="fm-answer-scroll" aria-busy={loading || undefined}>
        {loading ? (
          <div className="fm-reader-loading" role="status">
            <span />
            <span />
            <span />
            <strong>正在读取完整回答…</strong>
          </div>
        ) : attempt.answer?.trim() ? (
          <ReactMarkdown skipHtml components={safeMarkdownComponents}>
            {attempt.answer}
          </ReactMarkdown>
        ) : (
          <div className="fm-reader-empty">
            <strong>该回答尚无有效正文</strong>
            <span>{attempt.error || "成功且非空的回答才会消耗额度。"}</span>
          </div>
        )}
        {attempt.reasoning && (
          <details className="fm-reasoning">
            <summary>查看思考过程</summary>
            <ReactMarkdown skipHtml components={safeMarkdownComponents}>
              {attempt.reasoning}
            </ReactMarkdown>
          </details>
        )}
      </div>
      <footer>
        <span>
          品牌提及：
          {attempt.brandMentioned === true
            ? "是"
            : attempt.brandMentioned === false
              ? "否"
              : "未返回"}
        </span>
        <span>
          提及位置：
          {attempt.mentionPosition
            ? `第 ${attempt.mentionPosition} 位`
            : "未返回"}
        </span>
        {attempt.revision && <span>结果修订 V{attempt.revision}</span>}
      </footer>
    </article>
  );
}

export default function AnswerWorkspace({
  attempts,
  selected,
  fullscreen,
  onSelect,
  onQuestionChange,
  onFullscreenChange,
  sourceScope,
  onSourceScopeChange,
  detailLoading = false,
  hasMoreAnswers = false,
  loadingMoreAnswers = false,
  onLoadMoreAnswers,
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
}) {
  const [screenshotOpen, setScreenshotOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const fullscreenTriggerRef = useRef<HTMLButtonElement>(null);

  if (!selected) {
    return (
      <div className="fm-answer-empty">
        <strong>尚无可预览回答</strong>
        <span>运行完成后，可在这里查看正文和实际引用信源。</span>
      </div>
    );
  }

  const questions = Array.from(
    new Map(attempts.map((attempt) => [attempt.questionId, attempt.question])),
  );
  const questionIndex = Math.max(
    0,
    questions.findIndex(([id]) => id === selected.questionId),
  );
  const siblings = attempts.filter(
    (attempt) => attempt.questionId === selected.questionId,
  );
  const answerIndex = Math.max(
    0,
    siblings.findIndex((attempt) => attempt.id === selected.id),
  );
  const previousQuestion = questions[questionIndex - 1];
  const nextQuestion = questions[questionIndex + 1];
  const previousAnswer = siblings[answerIndex - 1];
  const nextAnswer = siblings[answerIndex + 1];

  const copyAnswer = async () => {
    if (!selected.answer) return;
    try {
      await navigator.clipboard.writeText(selected.answer);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 2500);
    }
  };

  const copied = copyState === "copied";

  return (
    <section className="fm-answer-workspace">
      <header className="fm-answer-toolbar">
        <div className="fm-pager-group" role="group" aria-label="监控问题切换">
          <button
            type="button"
            className="fm-icon-button"
            disabled={!previousQuestion}
            onClick={() =>
              previousQuestion && onQuestionChange(previousQuestion[0])
            }
            aria-label={
              previousQuestion ? "上一个监控问题" : "没有上一个监控问题"
            }
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            监控问题 {questionIndex + 1} / {questions.length}
          </span>
          <button
            type="button"
            className="fm-icon-button"
            disabled={!nextQuestion}
            onClick={() => nextQuestion && onQuestionChange(nextQuestion[0])}
            aria-label={nextQuestion ? "下一个监控问题" : "没有下一个监控问题"}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="fm-answer-tools">
          <span className="fm-copy-feedback" aria-live="polite">
            {copied
              ? "回答内容已复制"
              : copyState === "failed"
                ? "复制失败，请手动选择回答正文"
                : ""}
          </span>
          <button
            type="button"
            className="fm-tool-button"
            disabled={!selected.answer}
            onClick={() => void copyAnswer()}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            className="fm-tool-button"
            disabled={detailLoading}
            onClick={() => setScreenshotOpen(true)}
          >
            <ImageIcon size={14} /> 截图
          </button>
          <button
            ref={fullscreenTriggerRef}
            type="button"
            className="fm-tool-button"
            aria-label="全屏查看"
            disabled={detailLoading}
            onClick={() => onFullscreenChange(true)}
          >
            <Expand size={14} /> 全屏
          </button>
        </div>
      </header>
      {hasMoreAnswers && (
        <div className="fm-answer-load-more">
          <button
            type="button"
            className="fm-text-button"
            disabled={loadingMoreAnswers}
            onClick={() => void onLoadMoreAnswers?.()}
          >
            {loadingMoreAnswers ? "正在加载更多回答…" : "加载更多回答"}
          </button>
        </div>
      )}
      <section className="fm-current-question" aria-label="当前回答问题">
        <strong>{selected.question}</strong>
        <div className="fm-pager-group" role="group" aria-label="回答内容切换">
          <button
            type="button"
            className="fm-icon-button"
            disabled={!previousAnswer}
            onClick={() => previousAnswer && onSelect(previousAnswer)}
            aria-label={
              previousAnswer ? "上一条回答内容" : "没有上一条回答内容"
            }
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            回答内容 {answerIndex + 1} / {siblings.length}
          </span>
          <button
            type="button"
            className="fm-icon-button"
            disabled={!nextAnswer}
            onClick={() => nextAnswer && onSelect(nextAnswer)}
            aria-label={nextAnswer ? "下一条回答内容" : "没有下一条回答内容"}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </section>
      <div className="fm-answer-layout">
        <AnswerReader attempt={selected} loading={detailLoading} />
        <CitationRail
          attempt={selected}
          scope={sourceScope}
          onScopeChange={onSourceScopeChange}
        />
      </div>
      <ScreenshotViewerDialog
        open={screenshotOpen}
        attempt={selected}
        onOpenChange={setScreenshotOpen}
      />
      <AnswerFullscreenDialog
        open={fullscreen && !detailLoading}
        attempt={selected}
        returnFocusRef={fullscreenTriggerRef}
        onOpenChange={onFullscreenChange}
        sourceScope={sourceScope}
        onSourceScopeChange={onSourceScopeChange}
      />
    </section>
  );
}
