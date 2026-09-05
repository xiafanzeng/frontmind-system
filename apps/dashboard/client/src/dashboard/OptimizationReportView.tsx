import { useEffect, useRef, useState } from "react";
import type {
  DashboardOptimizationBaseline,
  DashboardOptimizationQuestionReport,
} from "@shared/dashboard";

import "./optimization-report-view.css";

export type OptimizationKpi = readonly [
  metric: string,
  before: string,
  after: string,
  progress: number,
  note: string,
];

export type OptimizationPlatform = readonly [
  platform: string,
  rank: string,
  topFive: string,
  accuracy: string,
  officialSource: string,
  weakness: string,
  action: string,
];

export type OptimizationJourney = readonly [
  stage: string,
  intent: string,
  question: string,
  risk: string,
  asset: string,
];

export type OptimizationCompetitorTier = readonly [
  tier: string,
  competitors: string,
  situation: string,
  strategy: string,
];

export type OptimizationSourceMix = readonly [
  source: string,
  share: string,
  coverage: string,
  action: string,
];

export type OptimizationRisk = readonly [
  issue: string,
  level: string,
  symptom: string,
  suggestion: string,
];

export type OptimizationRoadmapItem = readonly [
  period: string,
  theme: string,
  detail: string,
];

export type OptimizationReportRecord = readonly [
  record: string,
  scope: string,
  finding: string,
  status: string,
];

export interface OptimizationReportData {
  period: string;
  title: string;
  subtitle: string;
  executiveSummary: readonly string[];
  kpis: readonly OptimizationKpi[];
  platforms: readonly OptimizationPlatform[];
  journeys: readonly OptimizationJourney[];
  competitorTiers: readonly OptimizationCompetitorTier[];
  sourceMix: readonly OptimizationSourceMix[];
  risks: readonly OptimizationRisk[];
  roadmap: readonly OptimizationRoadmapItem[];
  reportRecords: readonly OptimizationReportRecord[];
  baseline?: DashboardOptimizationBaseline | null;
  questionBaselines?: readonly DashboardOptimizationBaseline[];
  questionReports?: readonly DashboardOptimizationQuestionReport[];
}

interface OptimizationReportViewProps {
  report: OptimizationReportData;
}

const reportSections = [
  {
    id: "summary",
    number: "01",
    label: "执行摘要",
  },
  {
    id: "platforms",
    number: "02",
    label: "平台表现",
  },
  {
    id: "journey",
    number: "03",
    label: "决策旅程",
  },
  {
    id: "competitors",
    number: "04",
    label: "竞品梯队",
  },
  {
    id: "sources",
    number: "05",
    label: "信源结构",
  },
  {
    id: "risks",
    number: "06",
    label: "风险议题",
  },
  {
    id: "roadmap",
    number: "07",
    label: "行动路线图",
  },
  {
    id: "records",
    number: "08",
    label: "复测记录",
  },
] as const;

type ReportSectionId = (typeof reportSections)[number]["id"];

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function parsePercent(value: string) {
  const parsed = Number.parseFloat(value.replace("%", ""));
  return clampPercent(parsed);
}

function riskTone(level: string) {
  if (level.includes("高")) return "high";
  if (level.includes("中")) return "medium";
  return "low";
}

function recordTone(status: string) {
  if (status.includes("已完成")) return "complete";
  if (status.includes("进行")) return "progress";
  if (status.includes("待")) return "pending";
  return "current";
}

function ChapterHeading({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  const headingId = `optimization-report-heading-${number}`;

  return (
    <header className="optimization-report-chapter-heading">
      <span className="optimization-report-chapter-number" aria-hidden="true">
        {number}
      </span>
      <div>
        <h3 id={headingId}>{title}</h3>
        <p>{description}</p>
      </div>
    </header>
  );
}

export default function OptimizationReportView({
  report,
}: OptimizationReportViewProps) {
  const [activeSection, setActiveSection] =
    useState<ReportSectionId>("summary");
  const sectionRefs = useRef(new Map<ReportSectionId, HTMLElement>());

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleSection = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (first, second) =>
              second.intersectionRatio - first.intersectionRatio ||
              first.boundingClientRect.top - second.boundingClientRect.top,
          )[0];

        const sectionId = visibleSection?.target.getAttribute(
          "data-report-section",
        ) as ReportSectionId | null;

        if (sectionId) setActiveSection(sectionId);
      },
      {
        rootMargin: "-12% 0px -68% 0px",
        threshold: [0, 0.12, 0.35, 0.6],
      },
    );

    sectionRefs.current.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const registerSection =
    (sectionId: ReportSectionId) => (node: HTMLElement | null) => {
      if (node) {
        sectionRefs.current.set(sectionId, node);
      } else {
        sectionRefs.current.delete(sectionId);
      }
    };

  const navigateToSection = (sectionId: ReportSectionId) => {
    setActiveSection(sectionId);
    sectionRefs.current.get(sectionId)?.scrollIntoView?.({
      behavior: "smooth",
      block: "start",
    });
  };

  return (
    <div className="optimization-report-view">
      <div className="optimization-report-layout">
        <aside className="optimization-report-outline">
          <div className="optimization-report-outline-heading">
            <strong>报告目录</strong>
            <small>{text(report.period)}</small>
          </div>

          <nav aria-label="进度报告章节">
            {reportSections.map((section) => (
              <button
                type="button"
                key={section.id}
                className={
                  activeSection === section.id
                    ? "optimization-report-outline-item active"
                    : "optimization-report-outline-item"
                }
                aria-current={
                  activeSection === section.id ? "location" : undefined
                }
                onClick={() => navigateToSection(section.id)}
              >
                <span aria-hidden="true">{section.number}</span>
                <span>{section.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <article className="optimization-report-document">
          <section
            ref={registerSection("summary")}
            data-report-section="summary"
            aria-labelledby="optimization-report-heading-01"
            className="optimization-report-chapter optimization-report-summary"
          >
            <div className="optimization-report-cover">
              <h2>{text(report.title)}</h2>
              <p>{text(report.subtitle)}</p>
              <div>{text(report.period)}</div>
            </div>

            <ChapterHeading
              number="01"
              title="执行摘要"
              description="聚焦本期核心判断、目标变化与下一阶段最重要的优化抓手。"
            />

            <div className="optimization-report-kpi-band">
              {report.kpis.map(([metric, before, after, progress, note]) => {
                const normalizedProgress = clampPercent(progress);
                return (
                  <div className="optimization-report-kpi" key={metric}>
                    <span>{text(metric)}</span>
                    <div>
                      <small>优化前 {text(before)}</small>
                      <b aria-hidden="true">→</b>
                      <strong>本期 {text(after)}</strong>
                    </div>
                    <div
                      className="optimization-report-progress"
                      role="progressbar"
                      aria-label={`${text(metric)}本期进度`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={normalizedProgress}
                    >
                      <span style={{ width: `${normalizedProgress}%` }} />
                    </div>
                    <small>{text(note)}</small>
                  </div>
                );
              })}
            </div>

            <ol className="optimization-report-summary-list">
              {report.executiveSummary.map((item, index) => (
                <li key={`${index}-${item}`}>
                  <span aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <p>{text(item)}</p>
                </li>
              ))}
            </ol>
          </section>

          <section
            ref={registerSection("platforms")}
            data-report-section="platforms"
            aria-labelledby="optimization-report-heading-02"
            className="optimization-report-chapter"
          >
            <ChapterHeading
              number="02"
              title="平台表现"
              description="横向核对各生成式平台的可见性、回答质量、官方信源覆盖与具体修正动作。"
            />

            <div className="optimization-report-table-scroll">
              <table className="optimization-report-table optimization-platform-matrix">
                <thead>
                  <tr>
                    <th scope="col">平台</th>
                    <th scope="col">平均位次</th>
                    <th scope="col">前五位</th>
                    <th scope="col">准确度</th>
                    <th scope="col">官方源</th>
                    <th scope="col">主要短板</th>
                    <th scope="col">建议动作</th>
                  </tr>
                </thead>
                <tbody>
                  {report.platforms.map(
                    ([
                      platform,
                      rank,
                      topFive,
                      accuracy,
                      officialSource,
                      weakness,
                      action,
                    ]) => (
                      <tr key={platform}>
                        <th scope="row">{text(platform)}</th>
                        <td className="optimization-report-numeric">
                          {text(rank)}
                        </td>
                        <td className="optimization-report-numeric">
                          {text(topFive)}
                        </td>
                        <td className="optimization-report-numeric">
                          {text(accuracy)}
                        </td>
                        <td className="optimization-report-numeric">
                          {text(officialSource)}
                        </td>
                        <td>{text(weakness)}</td>
                        <td className="optimization-report-action-cell">
                          {text(action)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section
            ref={registerSection("journey")}
            data-report-section="journey"
            aria-labelledby="optimization-report-heading-03"
            className="optimization-report-chapter"
          >
            <ChapterHeading
              number="03"
              title="决策旅程"
              description="沿用户从认知到决策的路径，逐段说明真实问题、当前风险与应建设的内容资产。"
            />

            <div className="optimization-report-timeline">
              {report.journeys.map(
                ([stage, intent, question, risk, asset], index) => (
                  <article
                    className="optimization-report-timeline-row"
                    key={stage}
                  >
                    <div className="optimization-report-timeline-marker">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                    </div>
                    <div className="optimization-report-timeline-content">
                      <header>
                        <span>{text(stage)}</span>
                        <h4>{text(intent)}</h4>
                      </header>
                      <blockquote>{text(question)}</blockquote>
                      <dl>
                        <div>
                          <dt>当前风险</dt>
                          <dd>{text(risk)}</dd>
                        </div>
                        <div>
                          <dt>建议资产</dt>
                          <dd>{text(asset)}</dd>
                        </div>
                      </dl>
                    </div>
                  </article>
                ),
              )}
            </div>
          </section>

          <section
            ref={registerSection("competitors")}
            data-report-section="competitors"
            aria-labelledby="optimization-report-heading-04"
            className="optimization-report-chapter"
          >
            <ChapterHeading
              number="04"
              title="竞品梯队"
              description="按竞争强度归纳模型推荐中的主要替代对象、当前局势与差异化应对策略。"
            />

            <div className="optimization-report-table-scroll">
              <table className="optimization-report-table optimization-competitor-matrix">
                <thead>
                  <tr>
                    <th scope="col">梯队</th>
                    <th scope="col">主要竞品</th>
                    <th scope="col">当前局势</th>
                    <th scope="col">应对策略</th>
                  </tr>
                </thead>
                <tbody>
                  {report.competitorTiers.map(
                    ([tier, competitors, situation, strategy]) => (
                      <tr key={tier}>
                        <th scope="row">{text(tier)}</th>
                        <td>{text(competitors)}</td>
                        <td>{text(situation)}</td>
                        <td className="optimization-report-action-cell">
                          {text(strategy)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section
            ref={registerSection("sources")}
            data-report-section="sources"
            aria-labelledby="optimization-report-heading-05"
            className="optimization-report-chapter"
          >
            <ChapterHeading
              number="05"
              title="信源结构"
              description="拆解当前答案信源组成，明确每类信源承担的事实范围与下一步治理动作。"
            />

            <div className="optimization-report-source-list">
              {report.sourceMix.map(([source, share, coverage, action]) => {
                const numericShare = parsePercent(share);
                return (
                  <article
                    className="optimization-report-source-row"
                    key={source}
                  >
                    <div className="optimization-report-source-heading">
                      <strong>{text(source)}</strong>
                      <span>{text(share)}</span>
                    </div>
                    <div
                      className="optimization-report-source-bar"
                      role="progressbar"
                      aria-label={`${text(source)}信源占比`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={numericShare}
                    >
                      <span style={{ width: `${numericShare}%` }} />
                    </div>
                    <dl>
                      <div>
                        <dt>覆盖范围</dt>
                        <dd>{text(coverage)}</dd>
                      </div>
                      <div>
                        <dt>治理动作</dt>
                        <dd>{text(action)}</dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          </section>

          <section
            ref={registerSection("risks")}
            data-report-section="risks"
            aria-labelledby="optimization-report-heading-06"
            className="optimization-report-chapter"
          >
            <ChapterHeading
              number="06"
              title="风险议题"
              description="记录可能导致模型误解、口径失真或主观外推的议题，并给出可执行的修正方式。"
            />

            <div className="optimization-report-table-scroll">
              <table className="optimization-report-table optimization-risk-register">
                <thead>
                  <tr>
                    <th scope="col">风险议题</th>
                    <th scope="col">等级</th>
                    <th scope="col">当前表现</th>
                    <th scope="col">修正建议</th>
                  </tr>
                </thead>
                <tbody>
                  {report.risks.map(([issue, level, symptom, suggestion]) => (
                    <tr key={issue}>
                      <th scope="row">{text(issue)}</th>
                      <td>
                        <span
                          className={`optimization-report-risk-level ${riskTone(
                            level,
                          )}`}
                        >
                          {text(level)}
                        </span>
                      </td>
                      <td>{text(symptom)}</td>
                      <td className="optimization-report-action-cell">
                        {text(suggestion)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section
            ref={registerSection("roadmap")}
            data-report-section="roadmap"
            aria-labelledby="optimization-report-heading-07"
            className="optimization-report-chapter"
          >
            <ChapterHeading
              number="07"
              title="行动路线图"
              description="按照短、中、长期节奏安排口径修正、场景扩展、信源建设与持续复测。"
            />

            <div className="optimization-report-roadmap">
              {report.roadmap.map(([period, theme, detail], index) => (
                <article
                  className="optimization-report-roadmap-row"
                  key={period}
                >
                  <div>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                  </div>
                  <div>
                    <small>{text(period)}</small>
                    <h4>{text(theme)}</h4>
                    <p>{text(detail)}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section
            ref={registerSection("records")}
            data-report-section="records"
            aria-labelledby="optimization-report-heading-08"
            className="optimization-report-chapter"
          >
            <ChapterHeading
              number="08"
              title="复测记录"
              description="保留报告与专项复测的范围、结论和执行状态，形成可追溯的优化档案。"
            />

            <div className="optimization-report-table-scroll">
              <table className="optimization-report-table optimization-record-table">
                <thead>
                  <tr>
                    <th scope="col">记录</th>
                    <th scope="col">复测范围</th>
                    <th scope="col">核心结论</th>
                    <th scope="col">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {report.reportRecords.map(
                    ([record, scope, finding, status]) => (
                      <tr key={record}>
                        <th scope="row">{text(record)}</th>
                        <td>{text(scope)}</td>
                        <td>{text(finding)}</td>
                        <td>
                          <span
                            className={`optimization-report-record-status ${recordTone(
                              status,
                            )}`}
                          >
                            {text(status)}
                          </span>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>

            <footer className="optimization-report-footer">
              <span>报告结束</span>
              <p>{text(report.period)}</p>
            </footer>
          </section>
        </article>
      </div>
    </div>
  );
}
