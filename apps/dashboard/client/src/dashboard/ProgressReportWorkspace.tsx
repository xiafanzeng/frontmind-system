import {
  ArrowRight,
  BarChart3,
  ChevronRight,
  Eye,
  FileSearch2,
  GitCompareArrows,
  Image as ImageIcon,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  DashboardOptimizationBaseline,
  DashboardOptimizationQuestionReport,
} from "@shared/dashboard";
import { keywordCategoryKey } from "@shared/keyword-categories";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import type { IntentQuestionGroup } from "@/components/ResponseLogicWorkspace";

import OptimizationReportView, {
  type OptimizationReportData,
} from "./OptimizationReportView";
import "./progress-report-workspace.css";

type ReportWorkspaceTab = "baseline" | "progress" | "afterEffect";
type ReportQuestionCategoryKey =
  | "industry"
  | "competitor"
  | "reputation"
  | "scenario";

interface ProgressReportWorkspaceProps {
  report?: OptimizationReportData | null;
  progressToolbar?: ReactNode;
  questionGroups?: readonly IntentQuestionGroup[];
}

const findingLabels = {
  aligned: "一致覆盖",
  missing: "回答缺失",
  conflict: "事实冲突",
  opportunity: "补强机会",
} as const;

const reportQuestionCategories = [
  {
    key: "industry",
    title: "行业排名词",
    subtitle: "行业入口与品牌优胜",
    tone: "amber",
    icon: BarChart3,
  },
  {
    key: "competitor",
    title: "竞品对比词",
    subtitle: "差异定位与选择依据",
    tone: "blue",
    icon: GitCompareArrows,
  },
  {
    key: "reputation",
    title: "美誉舆情词",
    subtitle: "信任证据与品牌口碑",
    tone: "plum",
    icon: Sparkles,
  },
  {
    key: "scenario",
    title: "产品场景词",
    subtitle: "应用需求与决策问题",
    tone: "teal",
    icon: FileSearch2,
  },
] as const;

interface ReportQuestionNavEntry {
  id: string;
  question: string;
  categoryKey: ReportQuestionCategoryKey;
}

function normalizeReportCategory(
  value: string,
): ReportQuestionCategoryKey | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (/(competitor|comparison|竞品|竞争|对比|比较)/.test(normalized)) {
    return "competitor";
  }
  if (/(reputation|public.?opinion|美誉|舆情|口碑|信任)/.test(normalized)) {
    return "reputation";
  }
  if (/(industry|ranking|行业|排名|榜单|品类)/.test(normalized)) {
    return "industry";
  }
  if (/(scenario|product|场景|产品|应用|录取|投入回报)/.test(normalized)) {
    return "scenario";
  }
  return null;
}

function authoritativeQuestionCategories(
  groups: readonly IntentQuestionGroup[],
) {
  const categoryByQuestionId = new Map<string, ReportQuestionCategoryKey>();
  for (const group of groups) {
    const categoryKey =
      normalizeReportCategory(group.id) ??
      normalizeReportCategory(group.title) ??
      null;
    if (!categoryKey) continue;
    for (const question of group.questions) {
      categoryByQuestionId.set(question.id, categoryKey);
    }
  }
  return categoryByQuestionId;
}

function reportEntryCategory(
  id: string,
  category: string,
  question: string,
  categoryByQuestionId: ReadonlyMap<string, ReportQuestionCategoryKey>,
) {
  return (
    categoryByQuestionId.get(id) ??
    normalizeReportCategory(category) ??
    normalizeReportCategory(question) ??
    "scenario"
  );
}

function QuestionReportNavigator({
  entries,
  selectedId,
  onSelect,
  navTitle,
}: {
  entries: readonly ReportQuestionNavEntry[];
  selectedId: string;
  onSelect: (id: string) => void;
  navTitle: string;
}) {
  const selected =
    entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const activeCategoryKey = selected?.categoryKey;
  const activeCategory =
    reportQuestionCategories.find(
      (category) => category.key === activeCategoryKey,
    ) ?? reportQuestionCategories[0];
  const activeEntries = entries.filter(
    (entry) => entry.categoryKey === activeCategory.key,
  );
  const activeCanonicalCategory = keywordCategoryKey(activeCategory.key);

  return (
    <aside
      className="progress-question-nav"
      aria-label={navTitle}
      data-tone={activeCategory.tone}
      data-category={activeCanonicalCategory || undefined}
    >
      <div className="progress-question-nav-head">
        <strong>{navTitle}</strong>
        <Sparkles size={18} aria-hidden="true" />
      </div>

      <div
        className="progress-question-category-tabs"
        role="tablist"
        aria-label={`${navTitle}分类`}
      >
        {reportQuestionCategories.map((category) => {
          const Icon = category.icon;
          const canonicalCategory = keywordCategoryKey(category.key);
          const categoryEntries = entries.filter(
            (entry) => entry.categoryKey === category.key,
          );
          const active = category.key === activeCategory.key;
          return (
            <button
              key={category.key}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={categoryEntries.length === 0}
              data-tone={category.tone}
              data-category={canonicalCategory || undefined}
              className={active ? "active" : ""}
              onClick={() => onSelect(categoryEntries[0]!.id)}
            >
              <span>
                <Icon size={15} aria-hidden="true" />
              </span>
              <strong>{category.title}</strong>
            </button>
          );
        })}
      </div>

      <div className="progress-question-list">
        <div className="progress-question-list-title">
          <span>{activeCategory.title}</span>
          <small>{activeCategory.subtitle}</small>
        </div>
        {activeEntries.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === selected?.id ? "active" : ""}
            aria-pressed={entry.id === selected?.id}
            onClick={() => onSelect(entry.id)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{entry.question}</strong>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        ))}
      </div>
    </aside>
  );
}

function safePercent(value: number, maxValue: number) {
  if (!Number.isFinite(value) || !Number.isFinite(maxValue) || maxValue <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (value / maxValue) * 100));
}

function safeScreenshotUrl(value: string) {
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

type AnswerScreenshot =
  DashboardOptimizationQuestionReport["before"]["screenshots"][number];

interface ScreenshotGalleryState {
  title: string;
  screenshots: readonly AnswerScreenshot[];
}

function AnswerScreenshotButton({
  title,
  screenshots,
  onOpen,
}: {
  title: string;
  screenshots: readonly AnswerScreenshot[] | undefined;
  onOpen: (gallery: ScreenshotGalleryState) => void;
}) {
  const safeScreenshots = (screenshots ?? []).filter((item) =>
    Boolean(safeScreenshotUrl(item.url)),
  );
  if (safeScreenshots.length === 0) return null;

  return (
    <button
      type="button"
      className="question-answer-screenshot-button"
      onClick={() => onOpen({ title, screenshots: safeScreenshots })}
    >
      <Eye size={14} aria-hidden="true" />
      显示答案截图（{safeScreenshots.length}）
    </button>
  );
}

function ScreenshotGallery({
  gallery,
  onClose,
}: {
  gallery: ScreenshotGalleryState;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="question-screenshot-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="question-screenshot-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={gallery.title}
      >
        <header>
          <div>
            <ImageIcon size={17} aria-hidden="true" />
            <h3>{gallery.title}</h3>
          </div>
          <button type="button" aria-label="关闭答案截图" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="question-screenshot-grid">
          {gallery.screenshots.map((screenshot, index) => (
            <figure key={screenshot.id || `${screenshot.url}-${index}`}>
              <img
                src={safeScreenshotUrl(screenshot.url)}
                alt={screenshot.alt || `${gallery.title} ${index + 1}`}
                loading="lazy"
              />
            </figure>
          ))}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function BaselineEmptyState() {
  return (
    <section className="progress-report-empty">
      <span aria-hidden="true">
        <FileSearch2 size={25} />
      </span>
      <div>
        <h2>尚未发布优化前基准</h2>
        <p>
          完成首轮问题监控和知识库事实核验后，这里将展示五维语义资产评分、平台表现与事实差距。
        </p>
      </div>
    </section>
  );
}

function BaselineReportView({
  baseline,
}: {
  baseline: DashboardOptimizationBaseline;
}) {
  const hasScore = baseline.totalScore !== null;

  return (
    <article className="baseline-report-document">
      <header className="baseline-report-cover">
        <div>
          <span>优化前基准</span>
          <h2>{baseline.title}</h2>
          {baseline.subtitle && <p>{baseline.subtitle}</p>}
        </div>
        {(baseline.period || baseline.generatedAt) && (
          <small>{baseline.period || baseline.generatedAt}</small>
        )}
      </header>

      {(baseline.question || baseline.sample) && (
        <section className="baseline-scope-strip" aria-label="本次基准范围">
          {baseline.question && (
            <div>
              <span>本次问题</span>
              <strong>{baseline.question}</strong>
            </div>
          )}
          {baseline.sample && (
            <dl>
              <div>
                <dt>监控平台</dt>
                <dd>{baseline.sample.platforms.join("、") || "—"}</dd>
              </div>
              <div>
                <dt>有效回答</dt>
                <dd>
                  {baseline.sample.successfulResponses} /{" "}
                  {baseline.sample.expectedResponses}
                </dd>
              </div>
              <div>
                <dt>未返回</dt>
                <dd>{baseline.sample.failedResponses}</dd>
              </div>
            </dl>
          )}
        </section>
      )}

      <section className="baseline-score-section">
        {hasScore ? (
          <div
            className="baseline-score-ring"
            style={{
              background: `conic-gradient(#6c3194 ${
                Math.max(0, Math.min(100, baseline.totalScore || 0)) * 3.6
              }deg, #e9e2ed 0deg)`,
            }}
            aria-label={`优化前基准得分 ${baseline.totalScore} 分`}
          >
            <span>
              <strong>{baseline.totalScore}</strong>
              <small>/ 100</small>
            </span>
          </div>
        ) : (
          <div className="baseline-score-pending">
            <BarChart3 size={24} />
            <span>未提供综合分</span>
          </div>
        )}
        <div className="baseline-score-copy">
          <span>{baseline.scopeLabel || "优化前真实样本基准"}</span>
          <h3>
            {baseline.grade ? `当前等级 ${baseline.grade}` : "当前基准判断"}
          </h3>
          <p>{baseline.summary || "当前基准摘要尚未发布。"}</p>
        </div>
      </section>

      {baseline.dimensions.length > 0 && (
        <section className="baseline-report-section">
          <header className="baseline-section-heading">
            <span>01</span>
            <div>
              <small>语义资产维度</small>
              <h3>五维语义资产基准</h3>
              <p>基于当前问题、监控样本与企业知识库，对优化前状态统一留档。</p>
            </div>
          </header>
          <div className="baseline-dimension-grid">
            {baseline.dimensions.map((dimension) => (
              <article key={dimension.id}>
                <div>
                  <strong>{dimension.label}</strong>
                  <span>
                    {dimension.score} / {dimension.maxScore}
                  </span>
                </div>
                <div
                  className="baseline-dimension-track"
                  role="progressbar"
                  aria-label={`${dimension.label}基准得分`}
                  aria-valuemin={0}
                  aria-valuemax={dimension.maxScore}
                  aria-valuenow={dimension.score}
                >
                  <span
                    style={{
                      width: `${safePercent(
                        dimension.score,
                        dimension.maxScore,
                      )}%`,
                    }}
                  />
                </div>
                {dimension.summary && <p>{dimension.summary}</p>}
              </article>
            ))}
          </div>
        </section>
      )}

      {baseline.platforms.length > 0 && (
        <section className="baseline-report-section">
          <header className="baseline-section-heading">
            <span>02</span>
            <div>
              <small>平台基准</small>
              <h3>平台基准表现</h3>
              <p>只呈现实际采集的回答数量与可核验指标，不用推测值补齐空白。</p>
            </div>
          </header>
          <div className="baseline-table-scroll">
            <table className="baseline-platform-table">
              <thead>
                <tr>
                  <th scope="col">平台</th>
                  <th scope="col">有效回答</th>
                  <th scope="col">品牌提及</th>
                  <th scope="col">平均位次</th>
                  <th scope="col">事实准确</th>
                  <th scope="col">主张命中</th>
                  <th scope="col">答案引用</th>
                  <th scope="col">基准判断</th>
                </tr>
              </thead>
              <tbody>
                {baseline.platforms.map((platform) => (
                  <tr key={platform.platform}>
                    <th scope="row">{platform.platform}</th>
                    <td>{platform.responseCount}</td>
                    <td>{platform.mentionRate || "—"}</td>
                    <td>{platform.averageRank || "—"}</td>
                    <td>{platform.factAccuracy || "—"}</td>
                    <td>{platform.propositionHitRate || "—"}</td>
                    <td>{platform.citationCount}</td>
                    <td>{platform.verdict || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {baseline.findings.length > 0 && (
        <section className="baseline-report-section">
          <header className="baseline-section-heading">
            <span>03</span>
            <div>
              <small>知识事实与回答差距</small>
              <h3>知识事实与模型回答差距</h3>
              <p>将一致覆盖、事实冲突、回答缺失和补强机会分开呈现。</p>
            </div>
          </header>
          <div className="baseline-finding-list">
            {baseline.findings.map((finding, index) => (
              <article key={`${finding.topic}-${index}`}>
                <header>
                  <span className={`finding-status ${finding.status}`}>
                    {findingLabels[finding.status]}
                  </span>
                  <h4>{finding.topic}</h4>
                </header>
                <dl>
                  {finding.currentEvidence && (
                    <div>
                      <dt>当前证据</dt>
                      <dd>{finding.currentEvidence}</dd>
                    </div>
                  )}
                  {finding.gap && (
                    <div>
                      <dt>基准差距</dt>
                      <dd>{finding.gap}</dd>
                    </div>
                  )}
                  {finding.action && (
                    <div>
                      <dt>待补强项</dt>
                      <dd>{finding.action}</dd>
                    </div>
                  )}
                </dl>
              </article>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

function BaselineReportCollection({
  baselines,
  questionGroups,
}: {
  baselines: readonly DashboardOptimizationBaseline[];
  questionGroups: readonly IntentQuestionGroup[];
}) {
  const categoryByQuestionId = useMemo(
    () => authoritativeQuestionCategories(questionGroups),
    [questionGroups],
  );
  const entries = useMemo(
    () =>
      baselines.map((baseline, index) => {
        const id =
          baseline.questionId || baseline.id || `baseline-${index + 1}`;
        return {
          id,
          question: baseline.question || baseline.title,
          categoryKey: reportEntryCategory(
            id,
            baseline.category,
            baseline.question,
            categoryByQuestionId,
          ),
          baseline,
        };
      }),
    [baselines, categoryByQuestionId],
  );
  const [selectedBaselineId, setSelectedBaselineId] = useState(
    entries[0]?.id || "",
  );

  useEffect(() => {
    if (entries.some((entry) => entry.id === selectedBaselineId)) return;
    setSelectedBaselineId(entries[0]?.id || "");
  }, [entries, selectedBaselineId]);

  if (entries.length === 0) return <BaselineEmptyState />;

  const selected =
    entries.find((entry) => entry.id === selectedBaselineId) || entries[0];

  return (
    <div className="progress-question-layout">
      <QuestionReportNavigator
        entries={entries}
        selectedId={selected.id}
        onSelect={setSelectedBaselineId}
        navTitle="基准问题"
      />
      <div className="progress-question-document">
        <BaselineReportView baseline={selected.baseline} />
      </div>
    </div>
  );
}

function QuestionReportEmptyState() {
  return (
    <section className="progress-report-empty">
      <span aria-hidden="true">
        <GitCompareArrows size={25} />
      </span>
      <div>
        <h2>尚未发布问题进度报告</h2>
        <p>
          完成同问题、同平台和同采样口径的复测后，可在这里发布优化前答案、差距、优化后答案与改善分析。
        </p>
      </div>
    </section>
  );
}

function QuestionProgressReport({
  questionReports,
  questionGroups,
}: {
  questionReports: readonly DashboardOptimizationQuestionReport[];
  questionGroups: readonly IntentQuestionGroup[];
}) {
  const categoryByQuestionId = useMemo(
    () => authoritativeQuestionCategories(questionGroups),
    [questionGroups],
  );
  const entries = useMemo(() => {
    const reportsById = new Map(
      questionReports.map((report) => [report.id, report]),
    );
    const questions = questionGroups.flatMap((group) =>
      group.questions.map((question) => ({
        id: question.id,
        question: question.question,
        categoryKey: reportEntryCategory(
          question.id,
          group.title || group.id,
          question.question,
          categoryByQuestionId,
        ),
        report: reportsById.get(question.id),
      })),
    );
    const questionIds = new Set(questions.map((question) => question.id));
    return [
      ...questions,
      ...questionReports
        .filter((report) => !questionIds.has(report.id))
        .map((report) => ({
          id: report.id,
          question: report.question,
          categoryKey: reportEntryCategory(
            report.id,
            report.category,
            report.question,
            categoryByQuestionId,
          ),
          report,
        })),
    ];
  }, [categoryByQuestionId, questionGroups, questionReports]);
  const [selectedQuestionId, setSelectedQuestionId] = useState(
    entries[0]?.id || "",
  );
  const [screenshotGallery, setScreenshotGallery] =
    useState<ScreenshotGalleryState | null>(null);

  useEffect(() => {
    if (entries.some((entry) => entry.id === selectedQuestionId)) return;
    setSelectedQuestionId(entries[0]?.id || "");
  }, [entries, selectedQuestionId]);

  const selected =
    entries.find((entry) => entry.id === selectedQuestionId) || entries[0];
  if (!selected) return <QuestionReportEmptyState />;
  const selectedCategory =
    reportQuestionCategories.find(
      (category) => category.key === selected.categoryKey,
    ) ?? reportQuestionCategories[0];
  const selectedCanonicalCategory = keywordCategoryKey(selectedCategory.key);
  if (!selected.report) {
    return (
      <div className="progress-question-layout">
        <QuestionReportNavigator
          entries={entries}
          selectedId={selected.id}
          onSelect={setSelectedQuestionId}
          navTitle="报告问题"
        />
        <div className="progress-question-document">
          <QuestionReportEmptyState />
        </div>
      </div>
    );
  }

  return (
    <div className="progress-question-layout">
      <QuestionReportNavigator
        entries={entries}
        selectedId={selected.id}
        onSelect={setSelectedQuestionId}
        navTitle="报告问题"
      />

      <article
        className="question-progress-report progress-question-document"
        data-tone={selectedCategory.tone}
        data-category={selectedCanonicalCategory || undefined}
      >
        <header className="question-report-cover">
          <span>{selectedCategory.title}</span>
          <h2>{selected.report.question}</h2>
        </header>

        {selected.report.metrics.length > 0 && (
          <section
            className="question-report-metrics"
            aria-label="本题前后指标"
          >
            {selected.report.metrics.map((metric) => (
              <article key={metric.label}>
                <span>{metric.label}</span>
                <div>
                  <small>{metric.before || "—"}</small>
                  <ArrowRight size={14} aria-hidden="true" />
                  <strong>{metric.after || "—"}</strong>
                </div>
                {metric.change && <b>{metric.change}</b>}
                {metric.note && <p>{metric.note}</p>}
              </article>
            ))}
          </section>
        )}

        <section className="question-answer-comparison">
          <article className="question-answer-panel before">
            <header>
              <div>
                <small>优化前</small>
                <h3>优化前答案</h3>
              </div>
              <AnswerScreenshotButton
                title="优化前答案截图"
                screenshots={selected.report.before.screenshots}
                onOpen={setScreenshotGallery}
              />
            </header>
            <div className="question-answer-content">
              {selected.report.before.content ? (
                <MarkdownRenderer content={selected.report.before.content} />
              ) : (
                <span className="question-answer-empty">
                  尚未上传优化前答案。
                </span>
              )}
            </div>
          </article>

          <article className="question-answer-panel after">
            <header>
              <div>
                <small>优化后</small>
                <h3>优化后答案</h3>
              </div>
              <AnswerScreenshotButton
                title="优化后答案截图"
                screenshots={selected.report.after.screenshots}
                onOpen={setScreenshotGallery}
              />
            </header>
            <div className="question-answer-content">
              {selected.report.after.content ? (
                <MarkdownRenderer content={selected.report.after.content} />
              ) : (
                <span className="question-answer-empty">
                  尚未上传优化后答案。
                </span>
              )}
            </div>
          </article>
        </section>

        {(selected.report.expectedLogic ||
          selected.report.gaps.length > 0 ||
          selected.report.improvements.length > 0 ||
          selected.report.summary ||
          selected.report.analysis) && (
          <section
            className="question-report-analysis-components"
            aria-label="本题分析"
          >
            {selected.report.expectedLogic && (
              <article className="question-analysis-card logic">
                <h3>标准应答逻辑</h3>
                <MarkdownRenderer content={selected.report.expectedLogic} />
              </article>
            )}
            {selected.report.gaps.length > 0 && (
              <article className="question-analysis-card gap">
                <h3>与应答逻辑的差距</h3>
                <ul>
                  {selected.report.gaps.map((gap, index) => (
                    <li key={`${index}-${gap}`}>{gap}</li>
                  ))}
                </ul>
              </article>
            )}
            {selected.report.improvements.length > 0 && (
              <article className="question-analysis-card filled">
                <h3>本轮已填补</h3>
                <ul>
                  {selected.report.improvements.map((improvement, index) => (
                    <li key={`${index}-${improvement}`}>{improvement}</li>
                  ))}
                </ul>
              </article>
            )}
            {(selected.report.summary || selected.report.analysis) && (
              <article className="question-analysis-card analysis">
                <h3>改善分析</h3>
                {selected.report.summary && <p>{selected.report.summary}</p>}
                {selected.report.analysis && <p>{selected.report.analysis}</p>}
              </article>
            )}
          </section>
        )}
        {screenshotGallery && (
          <ScreenshotGallery
            gallery={screenshotGallery}
            onClose={() => setScreenshotGallery(null)}
          />
        )}
      </article>
    </div>
  );
}

const gapClosureLabels = {
  filled: "已填补",
  partial: "部分填补",
  open: "仍需补强",
} as const;

function QuestionAfterEffect({
  report,
  categoryKey,
}: {
  report: DashboardOptimizationQuestionReport;
  categoryKey: ReportQuestionCategoryKey;
}) {
  const effect = report.afterEffect;
  if (!effect?.released) return null;
  const category =
    reportQuestionCategories.find((item) => item.key === categoryKey) ??
    reportQuestionCategories[0];
  const canonicalCategory = keywordCategoryKey(category.key);

  return (
    <article
      className="question-after-effect progress-question-document"
      data-tone={category.tone}
      data-category={canonicalCategory || undefined}
    >
      <header className="question-report-cover">
        <span>优化后效果</span>
        <h2>{report.question}</h2>
      </header>

      {(effect.totalScore !== null || effect.summary || effect.grade) && (
        <section className="after-effect-score-section">
          {effect.totalScore !== null ? (
            <div
              className="baseline-score-ring"
              style={{
                background: `conic-gradient(#237a57 ${
                  Math.max(0, Math.min(100, effect.totalScore)) * 3.6
                }deg, #e9e2ed 0deg)`,
              }}
              aria-label={`优化后语义资产评分 ${effect.totalScore} 分`}
            >
              <span>
                <strong>{effect.totalScore}</strong>
                <small>/ 100</small>
              </span>
            </div>
          ) : (
            <div className="baseline-score-pending">
              <BarChart3 size={24} aria-hidden="true" />
              <span>未提供综合分</span>
            </div>
          )}
          <div className="baseline-score-copy">
            <span>优化后语义资产评分</span>
            {effect.grade && <h3>当前等级 {effect.grade}</h3>}
            {effect.summary && <p>{effect.summary}</p>}
          </div>
        </section>
      )}

      {effect.dimensions.length > 0 && (
        <section className="baseline-report-section">
          <header className="baseline-section-heading">
            <span>01</span>
            <div>
              <h3>优化后语义资产维度</h3>
            </div>
          </header>
          <div className="baseline-dimension-grid">
            {effect.dimensions.map((dimension) => (
              <article key={dimension.id}>
                <div>
                  <strong>{dimension.label}</strong>
                  <span>
                    {dimension.score} / {dimension.maxScore}
                  </span>
                </div>
                <div
                  className="baseline-dimension-track"
                  role="progressbar"
                  aria-label={`${dimension.label}优化后得分`}
                  aria-valuemin={0}
                  aria-valuemax={dimension.maxScore}
                  aria-valuenow={dimension.score}
                >
                  <span
                    style={{
                      width: `${safePercent(
                        dimension.score,
                        dimension.maxScore,
                      )}%`,
                    }}
                  />
                </div>
                {dimension.summary && <p>{dimension.summary}</p>}
              </article>
            ))}
          </div>
        </section>
      )}

      {effect.platforms.length > 0 && (
        <section className="baseline-report-section">
          <header className="baseline-section-heading">
            <span>02</span>
            <div>
              <h3>不同平台的优化后情况</h3>
            </div>
          </header>
          <div className="baseline-table-scroll">
            <table className="baseline-platform-table">
              <thead>
                <tr>
                  <th scope="col">平台</th>
                  <th scope="col">有效回答</th>
                  <th scope="col">品牌提及</th>
                  <th scope="col">平均位次</th>
                  <th scope="col">事实准确</th>
                  <th scope="col">主张命中</th>
                  <th scope="col">答案引用</th>
                  <th scope="col">优化后判断</th>
                </tr>
              </thead>
              <tbody>
                {effect.platforms.map((platform) => (
                  <tr key={platform.platform}>
                    <th scope="row">{platform.platform}</th>
                    <td>{platform.responseCount}</td>
                    <td>{platform.mentionRate || "—"}</td>
                    <td>{platform.averageRank || "—"}</td>
                    <td>{platform.factAccuracy || "—"}</td>
                    <td>{platform.propositionHitRate || "—"}</td>
                    <td>{platform.citationCount}</td>
                    <td>{platform.verdict || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(effect.gapFillSummary || effect.gapClosures.length > 0) && (
        <section className="baseline-report-section">
          <header className="baseline-section-heading">
            <span>03</span>
            <div>
              <h3>知识事实与模型回答差距的填补</h3>
            </div>
          </header>
          {effect.gapFillSummary && (
            <div className="after-effect-gap-summary">
              <MarkdownRenderer content={effect.gapFillSummary} />
            </div>
          )}
          {effect.gapClosures.length > 0 && (
            <div className="after-effect-gap-list">
              {effect.gapClosures.map((closure, index) => (
                <article key={`${closure.topic}-${index}`}>
                  <header>
                    <h4>{closure.topic}</h4>
                    <span data-status={closure.status}>
                      {gapClosureLabels[closure.status]}
                    </span>
                  </header>
                  <dl>
                    {closure.beforeGap && (
                      <div>
                        <dt>优化前差距</dt>
                        <dd>{closure.beforeGap}</dd>
                      </div>
                    )}
                    {closure.result && (
                      <div>
                        <dt>本轮结果</dt>
                        <dd>{closure.result}</dd>
                      </div>
                    )}
                  </dl>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </article>
  );
}

function AfterEffectCollection({
  questionReports,
  questionGroups,
}: {
  questionReports: readonly DashboardOptimizationQuestionReport[];
  questionGroups: readonly IntentQuestionGroup[];
}) {
  const categoryByQuestionId = useMemo(
    () => authoritativeQuestionCategories(questionGroups),
    [questionGroups],
  );
  const entries = useMemo(
    () =>
      questionReports
        .filter((report) => report.afterEffect?.released)
        .map((report) => ({
          id: report.id,
          question: report.question,
          categoryKey: reportEntryCategory(
            report.id,
            report.category,
            report.question,
            categoryByQuestionId,
          ),
          report,
        })),
    [categoryByQuestionId, questionReports],
  );
  const [selectedQuestionId, setSelectedQuestionId] = useState(
    entries[0]?.id || "",
  );

  useEffect(() => {
    if (entries.some((entry) => entry.id === selectedQuestionId)) return;
    setSelectedQuestionId(entries[0]?.id || "");
  }, [entries, selectedQuestionId]);

  const selected =
    entries.find((entry) => entry.id === selectedQuestionId) || entries[0];
  if (!selected) return null;

  return (
    <div className="progress-question-layout">
      <QuestionReportNavigator
        entries={entries}
        selectedId={selected.id}
        onSelect={setSelectedQuestionId}
        navTitle="优化后效果问题"
      />
      <QuestionAfterEffect
        report={selected.report}
        categoryKey={selected.categoryKey}
      />
    </div>
  );
}

function ProgressReportContent({
  report,
  questionGroups,
}: {
  report: OptimizationReportData | null;
  questionGroups: readonly IntentQuestionGroup[];
}) {
  const questionReports = useMemo(
    () => report?.questionReports || [],
    [report?.questionReports],
  );
  return questionReports.length > 0 || !report ? (
    <QuestionProgressReport
      questionReports={questionReports}
      questionGroups={questionGroups}
    />
  ) : (
    <OptimizationReportView report={report} />
  );
}

export default function ProgressReportWorkspace({
  report,
  progressToolbar,
  questionGroups = [],
}: ProgressReportWorkspaceProps) {
  const baselines = useMemo(
    () =>
      report?.questionBaselines?.length
        ? report.questionBaselines
        : report?.baseline
          ? [report.baseline]
          : [],
    [report?.baseline, report?.questionBaselines],
  );
  const questionReports = useMemo(
    () => report?.questionReports || [],
    [report?.questionReports],
  );
  const hasReleasedAfterEffect = questionReports.some(
    (question) => question.afterEffect?.released,
  );
  const [activeTab, setActiveTab] = useState<ReportWorkspaceTab>(
    baselines.length > 0 ? "baseline" : "progress",
  );

  useEffect(() => {
    if (activeTab === "baseline" && baselines.length === 0) {
      setActiveTab("progress");
    }
    if (activeTab === "afterEffect" && !hasReleasedAfterEffect) {
      setActiveTab("progress");
    }
  }, [activeTab, baselines.length, hasReleasedAfterEffect]);

  return (
    <div className="progress-report-workspace">
      <div
        className={`progress-report-primary-tabs${
          hasReleasedAfterEffect ? " has-after-effect" : ""
        }`}
        role="tablist"
        aria-label="进度报告类型"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "baseline"}
          className={activeTab === "baseline" ? "active" : ""}
          onClick={() => setActiveTab("baseline")}
        >
          <FileSearch2 size={17} />
          <span>
            <strong>优化前基准</strong>
            <small>首轮监控与语义资产现状</small>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "progress"}
          className={activeTab === "progress" ? "active" : ""}
          onClick={() => setActiveTab("progress")}
        >
          <GitCompareArrows size={17} />
          <span>
            <strong>优化进度报告</strong>
            <small>逐问题复测、前后对比与案例</small>
          </span>
        </button>
        {hasReleasedAfterEffect && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "afterEffect"}
            className={activeTab === "afterEffect" ? "active" : ""}
            onClick={() => setActiveTab("afterEffect")}
          >
            <BarChart3 size={17} />
            <span>
              <strong>优化后效果</strong>
              <small>逐问题评分、平台效果与差距填补</small>
            </span>
          </button>
        )}
      </div>

      {activeTab === "baseline" ? (
        <BaselineReportCollection
          baselines={baselines}
          questionGroups={questionGroups}
        />
      ) : activeTab === "afterEffect" ? (
        <AfterEffectCollection
          questionReports={questionReports}
          questionGroups={questionGroups}
        />
      ) : (
        <>
          {progressToolbar}
          <ProgressReportContent
            report={report ?? null}
            questionGroups={questionGroups}
          />
        </>
      )}
    </div>
  );
}
