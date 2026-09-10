import type { ReactNode } from "react";
import {
  WorkflowQuestion,
  WorkflowSection,
  WorkflowCompleted,
  WorkflowFeedback,
  WorkflowPagination,
} from "@/dashboard/workflow/Workflow";
import { CONTENT_MODES } from "@/dashboard/content-production/ContentProductionWorkspace";
import type { OperatorView } from "@/dashboard/operator-navigation";
import type { BusinessWorkspaceOutput } from "@/dashboard/BusinessWorkspaceContext";

export type PreviewAgent =
  | Exclude<OperatorView, "knowledge-display">
  | "general";
export type PreviewFlow = {
  branch: string;
  step: number;
  fields: Record<string, string>;
  selected: string[];
  outputs: Array<Omit<BusinessWorkspaceOutput, "onOpen" | "onRevise">>;
  source?: { taskKey: string; agent: PreviewAgent };
  handoffs?: Record<string, string>;
};
export const previewEmptyFlow = (): PreviewFlow => ({
  branch: "",
  step: 0,
  fields: {},
  selected: [],
  outputs: [],
});
const exampleQuestion = "企业如何选择适合自己的智能客服平台？";
const exampleArticle = "企业智能客服选型指南";
const exampleBody =
  "从客户的业务规模和资料范围出发，选择能够持续维护企业知识的产品。\n\n结合产品说明与公开案例，核对接入要求、服务边界和使用成本。以已确认的企业资料为依据，不承诺资料之外的功能。";
export const PREVIEW_OPENINGS: Partial<
  Record<
    PreviewAgent,
    {
      question: string;
      choices: Array<{ id: string; label: string; description?: string }>;
    }
  >
> = {
  keywords: {
    question: "你想从现有词库挑选问题，还是基于当前知识库生成新的词库？",
    choices: [
      { id: "pick", label: "从现有词库挑选" },
      { id: "generate", label: "生成词库" },
    ],
  },
  questions: {
    question: "这次想怎样添加优化问题？",
    choices: [
      { id: "direct", label: "直接输入问题" },
      { id: "library", label: "从词库挑选" },
      { id: "existing", label: "查看已有问题" },
    ],
  },
  "response-logic": {
    question: "想为哪个优化问题整理应答？",
    choices: [
      {
        id: "question",
        label: exampleQuestion,
        description: "产品选型 · 已确认问题",
      },
    ],
  },
  monitoring: {
    question: "这次想开始监控，还是继续已有任务？",
    choices: [
      { id: "new", label: "新建监控任务" },
      { id: "existing", label: "查看已有任务" },
    ],
  },
  reports: {
    question: "这次想分析哪次监控运行？",
    choices: [
      { id: "runs", label: "选择已有运行" },
      { id: "reports", label: "查看已有报告" },
    ],
  },
  content: {
    question: "这次想制作什么内容？",
    choices: CONTENT_MODES.map((item) => ({
      id: item.value,
      label: item.title,
      description: item.description,
    })),
  },
  publishing: {
    question: "接下来要处理哪次投放？",
    choices: [
      { id: "drafts", label: "继续投放草稿" },
      { id: "new", label: "从已冻结稿件开始" },
      { id: "records", label: "查看发布结果" },
    ],
  },
  articles: {
    question: "这次要从哪里开始准备稿件？",
    choices: [
      { id: "import", label: "导入 DOCX" },
      { id: "existing", label: "继续编辑已有稿件" },
      { id: "frozen", label: "查看已冻结版本" },
    ],
  },
  media: {
    question: "这次想怎样选择媒体？",
    choices: [
      { id: "catalog", label: "浏览媒体目录" },
      { id: "requirements", label: "按投放需求筛选" },
    ],
  },
};

export function PreviewBusinessFlow({
  agent,
  flow,
  update,
  handoff,
  dialogue,
  onOpenKnowledge,
}: {
  agent: PreviewAgent;
  flow: PreviewFlow;
  update: (patch: Partial<PreviewFlow>) => void;
  handoff: (agent: PreviewAgent, seed: Partial<PreviewFlow>) => void;
  dialogue: ReactNode;
  onOpenKnowledge: () => void;
}) {
  const field = (key: string, value: string) =>
    update({ fields: { ...flow.fields, [key]: value } });
  const next = () => update({ step: flow.step + 1 });
  const chosenQuestion = flow.fields.question || exampleQuestion;
  const output = (
    id: string,
    title: string,
    type: string,
    status: string,
    version?: string,
  ) =>
    update({
      step: flow.step + 1,
      outputs: [
        ...flow.outputs.filter((item) => item.id !== id),
        { id, title, type, status, version, source: "来源：本地预览确认" },
      ],
    });
  const resource = (label: string, value: string, onSelect: () => void) => (
    <ul className="workflow-resource-list">
      <li>
        <button type="button" onClick={onSelect}>
          {label}
          <small>{value}</small>
        </button>
      </li>
    </ul>
  );
  const actions = (label: string, onClick: () => void, disabled = false) => (
    <div className="workflow-actions">
      <button
        type="button"
        className="workflow-primary"
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </button>
    </div>
  );
  const textField = (
    label: string,
    key: string,
    initial = "",
    multiline = false,
  ) => (
    <label className="workflow-field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={flow.fields[key] ?? initial}
          onChange={(event) => field(key, event.target.value)}
        />
      ) : (
        <input
          value={flow.fields[key] ?? initial}
          onChange={(event) => field(key, event.target.value)}
        />
      )}
    </label>
  );
  const questionPicker = (
    <>
      <input
        className="workflow-search"
        aria-label="搜索词库问题"
        placeholder="搜索词库问题"
        value={flow.fields.query ?? ""}
        onChange={(event) => field("query", event.target.value)}
      />
      <div className="workflow-table-scroll">
        <table>
          <thead>
            <tr>
              <th>问题</th>
              <th>类型</th>
              <th>选择</th>
            </tr>
          </thead>
          <tbody>
            {[
              exampleQuestion,
              "企业知识库如何保持回答准确？",
              "智能客服适合哪些客户服务场景？",
            ]
              .filter((question) => question.includes(flow.fields.query ?? ""))
              .map((question) => (
                <tr key={question}>
                  <td>{question}</td>
                  <td>产品场景</td>
                  <td>
                    <button
                      type="button"
                      aria-pressed={flow.fields.question === question}
                      onClick={() => field("question", question)}
                    >
                      选择问题
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <WorkflowPagination page={0} total={3} onChange={() => undefined} />
    </>
  );
  const sourceNote = (
    <p className="workflow-note">
      以下为交互样例。记录仅保存在当前浏览器，不创建真实业务或费用。
    </p>
  );
  const opening = PREVIEW_OPENINGS[agent];
  const header = opening && (
    <WorkflowQuestion
      variant="entry"
      question={opening.question}
      choices={opening.choices}
      selected={flow.branch}
      onSelect={(branch) => update({ branch, step: 0 })}
    />
  );
  if (agent === "enterprise-qa")
    return flow.step === 0 ? (
      <>
        <WorkflowQuestion
          question="先发布企业知识库，即可开始问答"
          description="企业问答会绑定已发布的知识版本，并在回答下保留可核对的来源。"
        />
        <WorkflowSection id="qa-unlock" title="当前项目尚无可用的已发布知识库">
          <ol className="preview-unlock-steps">
            <li>上传企业介绍、产品资料与公开案例。</li>
            <li>构建并确认知识节点。</li>
            <li>更新知识库，启用可用于问答的正式版本。</li>
          </ol>
          <div className="workflow-actions">
            <button
              type="button"
              className="workflow-primary"
              onClick={onOpenKnowledge}
            >
              前往智能知识库
            </button>
            <button
              type="button"
              onClick={() =>
                output(
                  "qa-knowledge",
                  "企业知识库",
                  "知识依据",
                  "已启用 · 示例",
                  "1",
                )
              }
            >
              预览已解锁问答
            </button>
          </div>
        </WorkflowSection>
      </>
    ) : (
      <>
        <WorkflowCompleted
          id="qa-version"
          summary="本任务已绑定知识库 v1 · 示例"
        />
        <WorkflowQuestion
          question="想了解企业的哪方面信息？"
          choices={[
            { id: "product", label: "产品适合哪些企业？" },
            { id: "source", label: "有哪些已公开的产品资料？" },
          ]}
          onSelect={(choice) =>
            field(
              "qaQuestion",
              choice === "product"
                ? "产品适合哪些企业？"
                : "有哪些已公开的产品资料？",
            )
          }
        />
        {flow.fields.qaQuestion && (
          <WorkflowSection id="qa-answer" title={flow.fields.qaQuestion}>
            <p>
              适合需要统一产品知识和客户回答的团队。具体接入与服务范围，以已确认的企业资料为准。
            </p>
            <p className="workflow-note">
              引用 1 · 企业简介 / 产品能力说明 · 知识库 v1（示例）
            </p>
          </WorkflowSection>
        )}
        {dialogue}
      </>
    );
  if (agent === "website")
    return (
      <WorkflowSection id="site-build" title="从已发布知识开始制作网站">
        {sourceNote}
        {flow.step === 0 ? (
          <>
            {textField(
              "这次的网站需要呈现什么？",
              "brief",
              "介绍核心产品、客户场景和公开案例",
              true,
            )}
            {actions("确认需求并选择模板", next)}
          </>
        ) : (
          <>
            <WorkflowCompleted
              id="site-brief"
              summary="建站需求已确认"
              onRevise={() => update({ step: 0 })}
            />
            <WorkflowQuestion
              question="更偏向哪种页面方向？"
              choices={[
                { id: "product", label: "产品与解决方案" },
                { id: "brand", label: "品牌与案例" },
              ]}
              selected={flow.fields.template}
              onSelect={(value) => field("template", value)}
            />
            {flow.fields.template && (
              <>
                <section
                  className="preview-site-page"
                  aria-label="网站完整预览"
                >
                  <small>星辰科技</small>
                  <h2>让企业知识成为可靠的回答</h2>
                  <p>从产品资料到客户服务，让团队共享清晰、准确的品牌知识。</p>
                  <hr />
                  <h3>产品与解决方案</h3>
                  <p>知识库建设 · 企业问答 · 内容协作</p>
                  <h3>实践案例</h3>
                  <p>把真实业务资料整理为可验证、可维护的企业内容。</p>
                </section>
                {actions("确认网站预览", () =>
                  output(
                    "site-preview",
                    "企业网站预览",
                    "网站草稿",
                    "本地预览已确认 · 尚未部署",
                  ),
                )}
              </>
            )}
          </>
        )}
      </WorkflowSection>
    );
  return (
    <div className="preview-business-flow">
      {header}
      {flow.branch && sourceNote}
      {agent === "keywords" && flow.branch && (
        <>
          {flow.branch === "generate" && (
            <WorkflowSection id="generate" title="使用当前已发布知识生成词库">
              <p>知识库 v1 · 3 类产品与场景问题（示例）</p>
              {flow.step === 0 ? (
                actions("确认生成词库样例", () =>
                  output(
                    "keyword-library",
                    "品牌全域词库",
                    "生成结果",
                    "样例已生成",
                    "1",
                  ),
                )
              ) : (
                <WorkflowFeedback>
                  词库样例已准备好，可从下面挑选选题。
                </WorkflowFeedback>
              )}
            </WorkflowSection>
          )}
          {(flow.branch === "pick" || flow.step > 0) && (
            <WorkflowSection
              id="keyword-picker"
              title="这次想围绕哪个问题展开？"
            >
              {questionPicker}
              {flow.fields.question && (
                <WorkflowSection
                  id="keyword-confirmation"
                  title="将这个问题保留为本任务选题？"
                >
                  <p>{chosenQuestion}</p>
                  {flow.outputs.some((item) => item.id === "keyword-choice")
                    ? actions("交给问题优化", () =>
                        handoff("questions", {
                          branch: "library",
                          step: 1,
                          fields: { question: chosenQuestion },
                        }),
                      )
                    : actions("确认选题", () =>
                        output(
                          "keyword-choice",
                          chosenQuestion,
                          "选题引用",
                          "已确认选题 · 待加入优化问题",
                          "1",
                        ),
                      )}
                </WorkflowSection>
              )}
            </WorkflowSection>
          )}
        </>
      )}
      {agent === "questions" && flow.branch && (
        <WorkflowSection
          id="question-flow"
          title={
            flow.step > 1
              ? "问题已加入优化清单"
              : flow.branch === "direct"
                ? "想优化哪个客户问题？"
                : flow.branch === "library"
                  ? "从词库选择一个问题"
                  : "查看当前项目已有问题"
          }
        >
          {flow.step < 2 ? (
            <>
              {flow.branch === "direct"
                ? textField("目标问题", "question", "", true)
                : flow.branch === "library"
                  ? questionPicker
                  : resource(exampleQuestion, "已确认 · 产品场景", () =>
                      update({
                        step: 1,
                        fields: { ...flow.fields, question: exampleQuestion },
                      }),
                    )}
              {flow.fields.question && (
                <>
                  {flow.step > 0 && (
                    <dl className="workflow-confirmation">
                      <dt>目标问题</dt>
                      <dd>{chosenQuestion}</dd>
                      <dt>来源</dt>
                      <dd>
                        {flow.branch === "library"
                          ? "品牌全域词库 v1 · 选题引用"
                          : "当前任务"}
                      </dd>
                      <dt>剩余配额</dt>
                      <dd>8 个 · 示例</dd>
                    </dl>
                  )}
                  {actions(
                    flow.step ? "确认加入优化问题" : "检查问题并继续",
                    () =>
                      flow.step
                        ? output(
                            "question",
                            chosenQuestion,
                            "优化问题",
                            "已加入优化清单 · 待制作应答",
                            "1",
                          )
                        : next(),
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <p>{chosenQuestion}</p>
              <div className="workflow-actions">
                <button
                  type="button"
                  onClick={() => update({ step: 0, fields: {} })}
                >
                  再添加一个
                </button>
                <button
                  type="button"
                  className="workflow-primary"
                  onClick={() =>
                    handoff("response-logic", {
                      branch: "question",
                      step: 1,
                      fields: { question: chosenQuestion },
                    })
                  }
                >
                  进入应答逻辑
                </button>
              </div>
            </>
          )}
        </WorkflowSection>
      )}
      {agent === "response-logic" && flow.branch && (
        <>
          <WorkflowCompleted
            id="response-question"
            summary={`当前问题：${chosenQuestion}`}
          />
          {dialogue}
          {flow.step === 0 ? (
            <WorkflowSection
              id="response-start"
              title="从已有企业事实开始整理应答"
            >
              <p>可以补充本次回答的重点，或先展开一份结构草稿。</p>
              {actions("展开应答草稿样例", next)}
            </WorkflowSection>
          ) : (
            <WorkflowSection id="response-editor" title="检查并完善应答草稿">
              <div className="workflow-fields">
                {textField(
                  "用户关切",
                  "concern",
                  "适用业务规模、资料范围和接入要求",
                  true,
                )}
                {textField(
                  "核心结论",
                  "conclusion",
                  "先确认业务需求，再结合产品能力提供建议。",
                  true,
                )}
                {textField(
                  "事实与依据",
                  "facts",
                  "已发布产品说明、服务范围与公开案例。",
                  true,
                )}
                {textField(
                  "边界与注意事项",
                  "boundaries",
                  "不承诺企业资料之外的功能和服务。",
                  true,
                )}
              </div>
              {flow.step < 2 ? (
                actions("保存应答草稿", next)
              ) : flow.step === 2 ? (
                <>
                  <WorkflowFeedback>
                    草稿已保存在本地预览，尚未成为正式版本。
                  </WorkflowFeedback>
                  {actions("确认并锁定应答", () =>
                    output(
                      "response",
                      chosenQuestion,
                      "正式应答",
                      "已确认并锁定 · 示例",
                      "1",
                    ),
                  )}
                </>
              ) : (
                <WorkflowCompleted
                  id="response-official"
                  summary="正式应答 v1 已确认 · 示例"
                  onRevise={() => update({ step: 1 })}
                />
              )}
            </WorkflowSection>
          )}
        </>
      )}
      {agent === "media" && flow.branch && (
        <>
          <WorkflowSection id="media-directory" title="选择适合本次内容的媒体">
            {flow.branch === "requirements" && (
              <div className="workflow-fields">
                {textField("行业与目标受众", "audience", "企业服务 / 科技")}
                {textField("预算上限", "budget", "500")}
              </div>
            )}
            <input
              className="workflow-search"
              aria-label="搜索预览媒体"
              placeholder="搜索媒体名称"
              value={flow.fields.query ?? ""}
              onChange={(event) => field("query", event.target.value)}
            />
            <div className="workflow-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>选择</th>
                    <th>媒体名称</th>
                    <th>类型</th>
                    <th>参考报价</th>
                  </tr>
                </thead>
                <tbody>
                  {["科技观察", "产业资讯", "企业服务周刊", "创新视野"]
                    .map((name, index) => ({ name, price: (index + 1) * 100 }))
                    .filter(({ name }) =>
                      name.includes(flow.fields.query ?? ""),
                    )
                    .map(({ name, price }) => (
                      <tr key={name}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`选择${name}`}
                            checked={flow.selected.includes(name)}
                            onChange={(event) =>
                              update({
                                selected: event.target.checked
                                  ? [...flow.selected, name]
                                  : flow.selected.filter(
                                      (item) => item !== name,
                                    ),
                              })
                            }
                          />
                        </td>
                        <td>{name}</td>
                        <td>科技 / 企业服务</td>
                        <td>¥{price} · 示例</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <WorkflowPagination page={0} total={4} onChange={() => undefined} />
            {actions(
              "选择稿件并继续",
              () => update({ step: 1 }),
              !flow.selected.length,
            )}
          </WorkflowSection>
          {flow.step > 0 && (
            <WorkflowSection id="media-article" title="选择冻结稿件">
              {resource(`${exampleArticle} · v1`, "已冻结稿件 · 示例", () =>
                field("article", exampleArticle),
              )}
              {flow.fields.article && (
                <>
                  <WorkflowCompleted
                    id="media-selection"
                    summary={`${flow.selected.length} 家媒体 · ${flow.fields.article} v1`}
                  />
                  {actions("确认投放选择", () =>
                    output(
                      "media-choice",
                      flow.selected.join("、"),
                      "媒体与稿件选择",
                      "已确认 · 等待交接",
                    ),
                  )}
                  {flow.outputs.length > 0 &&
                    actions("交给发布助手", () =>
                      handoff("publishing", {
                        branch: "drafts",
                        step: 1,
                        selected: flow.selected,
                        fields: { article: flow.fields.article },
                      }),
                    )}
                </>
              )}
            </WorkflowSection>
          )}
        </>
      )}
      {agent === "articles" && flow.branch && (
        <>
          {flow.step === 0 ? (
            <WorkflowSection
              id="article-source"
              title={
                flow.branch === "import" ? "选择稿件文件" : "选择本次处理的稿件"
              }
            >
              {flow.branch === "import" ? (
                <>
                  <label className="workflow-field">
                    <span>DOCX 文件</span>
                    <input
                      type="file"
                      accept=".docx"
                      aria-label="导入预览稿件"
                      onChange={(event) =>
                        field("filename", event.target.files?.[0]?.name ?? "")
                      }
                    />
                  </label>
                  {flow.fields.filename && (
                    <WorkflowFeedback>
                      已选择 {flow.fields.filename}
                      。此处只演示导入检查，不读取文档内容。
                    </WorkflowFeedback>
                  )}
                  {actions("打开样例正文编辑器", next)}
                </>
              ) : (
                resource(
                  exampleArticle,
                  flow.branch === "frozen"
                    ? "已冻结 v1 · 示例"
                    : "工作草稿 · 示例",
                  next,
                )
              )}
            </WorkflowSection>
          ) : (
            <WorkflowSection id="article-editor" title="检查稿件正文">
              <div className="workflow-fields">
                {textField("稿件标题", "article", exampleArticle)}
                {textField("完整正文", "body", exampleBody, true)}
              </div>
              {flow.step < 2 ? (
                actions("保存稿件草稿", next)
              ) : flow.step === 2 ? (
                <>
                  <WorkflowFeedback>草稿已保存，尚未冻结。</WorkflowFeedback>
                  {actions("确认并冻结当前版本", () =>
                    output(
                      "article-version",
                      flow.fields.article || exampleArticle,
                      "冻结稿件",
                      "可用于投放 · 示例",
                      "1",
                    ),
                  )}
                </>
              ) : (
                <>
                  <WorkflowCompleted
                    id="article-frozen"
                    summary="稿件 v1 已冻结 · 示例"
                    onRevise={() => update({ step: 1 })}
                  />
                  {actions("为这篇稿件选择媒体", () =>
                    handoff("media", {
                      branch: "catalog",
                      fields: {
                        article: flow.fields.article || exampleArticle,
                      },
                    }),
                  )}
                </>
              )}
            </WorkflowSection>
          )}
        </>
      )}
      {agent === "publishing" && flow.branch && (
        <>
          {flow.branch === "records" ? (
            <WorkflowSection id="publication-records" title="发布批次与回链">
              {resource(
                "企业智能客服选型指南 · 批次样例",
                "1 家媒体 · 已完成 · 示例",
                () => update({ step: 1 }),
              )}
              {flow.step > 0 && (
                <dl className="workflow-confirmation">
                  <dt>媒体</dt>
                  <dd>科技观察</dd>
                  <dt>批次状态</dt>
                  <dd>示例已完成</dd>
                  <dt>回链</dt>
                  <dd>本地样例未创建真实发布链接</dd>
                </dl>
              )}
            </WorkflowSection>
          ) : flow.step === 0 ? (
            <WorkflowSection
              id="publication-source"
              title={flow.branch === "new" ? "选择已冻结稿件" : "恢复投放草稿"}
            >
              {resource(exampleArticle, "稿件 v1 · 科技观察 · 示例", () =>
                update({
                  step: 1,
                  selected: ["科技观察"],
                  fields: { ...flow.fields, article: exampleArticle },
                }),
              )}
            </WorkflowSection>
          ) : (
            <>
              <WorkflowCompleted
                id="publication-resources"
                summary={`${flow.fields.article || exampleArticle} v1 · ${(flow.selected.length ? flow.selected : ["科技观察"]).join("、")}`}
              />
              <WorkflowSection id="publication-titles" title="标题与发布预检">
                {textField(
                  "本次发布标题",
                  "title",
                  flow.fields.article || exampleArticle,
                )}
                {flow.step === 1 && actions("检查标题、版本与媒体报价", next)}
              </WorkflowSection>
              {flow.step >= 2 && (
                <WorkflowSection
                  id="publication-confirmation"
                  title="确认费用与发布内容"
                >
                  <dl className="workflow-confirmation">
                    <dt>稿件版本</dt>
                    <dd>v1 · 已冻结</dd>
                    <dt>媒体</dt>
                    <dd>{flow.selected.join("、") || "科技观察"}</dd>
                    <dt>预估费用</dt>
                    <dd>¥{Math.max(flow.selected.length, 1) * 100} · 仅示例</dd>
                    <dt>预检</dt>
                    <dd>样例检查通过，正式发布仍须以服务返回为准</dd>
                  </dl>
                  {flow.step === 2 ? (
                    actions("确认发布样例", () =>
                      output(
                        "publication-batch",
                        flow.fields.article || exampleArticle,
                        "发布批次",
                        "样例流程完成 · 未产生真实发布",
                      ),
                    )
                  ) : (
                    <WorkflowFeedback>
                      发布样例流程已完成，未产生真实批次或费用。
                    </WorkflowFeedback>
                  )}
                </WorkflowSection>
              )}
            </>
          )}
        </>
      )}
      {agent === "monitoring" && flow.branch && (
        <>
          {flow.step === 0 && (
            <WorkflowSection
              id="monitor-question"
              title={
                flow.branch === "new"
                  ? "选择本次监控的问题"
                  : "选择已有监控任务"
              }
            >
              {resource(exampleQuestion, "已确认优化问题 · 产品选型", () =>
                update({
                  step: 1,
                  fields: { ...flow.fields, question: exampleQuestion },
                }),
              )}
            </WorkflowSection>
          )}
          {flow.step >= 1 && (
            <WorkflowCompleted
              id="monitor-object"
              summary={chosenQuestion}
              onRevise={() => update({ step: 0 })}
            />
          )}
          {flow.step === 1 && (
            <WorkflowSection
              id="monitor-configuration"
              title="怎样执行这次监控？"
            >
              <div className="workflow-fields">
                {textField("监控名称", "name", "产品选型监控")}
                {textField("执行平台", "platform", "示例平台 A、示例平台 B")}
                <label className="workflow-field">
                  <span>执行方式</span>
                  <select
                    value={flow.fields.schedule || "once"}
                    onChange={(event) => field("schedule", event.target.value)}
                  >
                    <option value="once">执行一次</option>
                    <option value="daily">每日执行 · 示例</option>
                  </select>
                </label>
              </div>
              {actions("检查监控配置与费用", next)}
            </WorkflowSection>
          )}
          {flow.step === 2 && (
            <WorkflowSection id="monitor-fee" title="确认本次运行费用">
              <dl className="workflow-confirmation">
                <dt>监控问题</dt>
                <dd>1 个</dd>
                <dt>执行平台</dt>
                <dd>2 个</dd>
                <dt>预计费用</dt>
                <dd>¥2 · 示例</dd>
              </dl>
              {actions("确认运行样例", () =>
                output(
                  "monitor-run",
                  flow.fields.name || "产品选型监控",
                  "监控运行",
                  "样例运行完成 · 未产生费用",
                ),
              )}
            </WorkflowSection>
          )}
          {flow.step >= 3 && (
            <WorkflowSection id="monitor-result" title="运行结果">
              <p>已展示 2 份样例回答，可继续核对引用和品牌提及。</p>
              {actions("交给进度报告", () =>
                handoff("reports", {
                  branch: "runs",
                  step: 1,
                  fields: { run: "产品选型监控 · 运行样例" },
                }),
              )}
            </WorkflowSection>
          )}
        </>
      )}
      {agent === "reports" && flow.branch && (
        <WorkflowSection
          id="report-analysis"
          title={flow.step ? "回答、竞品与引用分析" : "选择分析范围"}
        >
          {!flow.step ? (
            resource(
              "产品选型监控 · 运行样例",
              "2 个平台 · 2 份回答 · 示例数据",
              next,
            )
          ) : (
            <>
              <p className="workflow-note">
                只包含选中运行的数据。此页样例不代表真实项目统计。
              </p>
              <div className="workflow-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>观察项</th>
                      <th>样例结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>品牌提及</td>
                      <td>1 / 2</td>
                    </tr>
                    <tr>
                      <td>可核对引用</td>
                      <td>2 条</td>
                    </tr>
                    <tr>
                      <td>竞品提及</td>
                      <td>1 个</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <details>
                <summary>展开回答与引用</summary>
                <p>回答结合企业产品说明与公开案例解释了适用场景（示例）。</p>
                <p>引用：产品说明 / 服务范围</p>
              </details>
              {actions("确认本次分析", () =>
                output(
                  "report",
                  "产品选型监控分析",
                  "进度报告",
                  "分析范围已确认 · 示例",
                ),
              )}
              {flow.outputs.length > 0 && (
                <div className="workflow-actions">
                  <a
                    className="workflow-text-action"
                    href={`data:text/plain;charset=utf-8,${encodeURIComponent("FrontMind 进度报告 · 本地交互样例\n分析范围：2个平台，2份样例回答。\n此文件不包含真实业务数据。")}`}
                    download="FrontMind-进度报告-样例.txt"
                  >
                    导出样例报告
                  </a>
                </div>
              )}
            </>
          )}
        </WorkflowSection>
      )}
      {agent === "content" && flow.branch && (
        <>
          <WorkflowCompleted
            id="content-mode"
            summary={`制作类型：${opening?.choices.find((choice) => choice.id === flow.branch)?.label ?? flow.branch}`}
          />
          {flow.step === 0 && (
            <WorkflowSection
              id="content-brief"
              title="这次内容要解决什么问题？"
            >
              {textField(
                "内容需求",
                "brief",
                "面向企业客户，介绍智能客服的选型依据。",
                true,
              )}
              {actions("确认需求并展开方案", next)}
            </WorkflowSection>
          )}
          {flow.step > 0 && dialogue}
          {flow.step === 1 && (
            <WorkflowSection id="content-direction" title="确认内容方向">
              <p>
                从业务场景出发，依次介绍资料准备、产品能力、接入要求与服务边界。
              </p>
              {actions("确认方向并展开稿件", next)}
            </WorkflowSection>
          )}
          {flow.step >= 2 && (
            <WorkflowSection id="content-draft" title="检查稿件与交付内容">
              {textField("内容正文", "body", exampleBody, true)}
              {flow.step === 2 ? (
                actions("确认当前交付版本", () =>
                  output(
                    "content-delivery",
                    exampleArticle,
                    "内容交付",
                    "已确认交付 · 样例",
                    "1",
                  ),
                )
              ) : (
                <>
                  <WorkflowCompleted
                    id="content-delivered"
                    summary="当前交付 v1 已确认 · 样例"
                  />
                  {actions("交给稿件助手", () =>
                    handoff("articles", {
                      branch: "existing",
                      step: 1,
                      fields: {
                        article: exampleArticle,
                        body: flow.fields.body || exampleBody,
                      },
                    }),
                  )}
                </>
              )}
            </WorkflowSection>
          )}
        </>
      )}
    </div>
  );
}
