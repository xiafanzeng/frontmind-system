import type { Period } from "./shared";

// Fixed, synthetic records for the local preview. No source-account data or APIs.
export type Article = {
  id: string;
  title: string;
  author: string;
  content: string;
  pv: number;
  uv: number;
  likes: number;
  dislikes: number;
  feedback: number;
  lastVisited: string;
};
export type TrafficSource = {
  id: string;
  website: string;
  clicks: number;
  lastVisited: string;
};
export type QaRecord = {
  id: string;
  question: string;
  answer: string;
  model: string;
  channel: "AI搜索" | "小部件" | "API调用";
  quality: string;
  sessionId: string;
  asker: string;
  createdAt: string;
  internet: boolean;
  sources: Array<{ title: string; url: string }>;
};
export type ChartPoint = {
  date: string;
  pv: number;
  uv: number;
  likes: number;
  dislikes: number;
  feedback: number;
};
export type SearchRecord = {
  id: string;
  term: string;
  count: number;
  users: number;
  results: number;
  lastSearched: string;
};
export type QaFilters = {
  asker: string;
  channel: string;
  answerState: string;
  question: string;
  answer: string;
  sessionId: string;
  model: string;
  internet: string;
  from: string;
  to: string;
};

export const EMPTY_QA_FILTERS: QaFilters = {
  asker: "",
  channel: "全部",
  answerState: "全部",
  question: "",
  answer: "",
  sessionId: "",
  model: "全部",
  internet: "全部",
  from: "",
  to: "",
};

export const QA_MODELS = [
  "GPT-3.5-Turbo",
  "GPT-4",
  "GPT-4o-mini",
  "GPT-4-Turbo",
  "文心一言3.5",
  "Claude-3-Haiku",
  "Claude-4.6-Sonnet",
  "Doubao-pro-32k",
  "DeepSeek-Chat",
  "DeepSeek-Reasoner",
] as const;

const TOPICS = [
  [
    "创建团队知识库",
    "在工作台选择新建知识库，填写名称与简介，然后邀请同事一起完善内容。",
  ],
  [
    "配置成员访问权限",
    "在成员管理中选择角色。管理员可以维护设置，编辑者负责内容，访客只能阅读已发布文章。",
  ],
  [
    "从文档导入帮助内容",
    "选择本地文档并检查标题层级，确认预览后再导入。导入完成后可以逐篇调整分类。",
  ],
  [
    "设置企业专属域名",
    "先添加企业域名，再按页面说明配置解析。完成验证后，可将该域名设为知识库访问地址。",
  ],
  [
    "管理文章分类",
    "在内容目录中建立分类，通过拖动调整顺序；移动分类时，其下的文章会一起移动。",
  ],
  [
    "为文章添加目录",
    "使用二级或三级标题组织段落，页面会据此生成目录，帮助读者快速定位所需内容。",
  ],
  [
    "邀请外部协作者",
    "生成协作邀请后发送给相关同事，并按工作需要限制可编辑的知识库与分类。",
  ],
  [
    "检查文章发布状态",
    "草稿仅团队成员可见。发布前检查链接、图片与更新时间，再切换为已发布状态。",
  ],
  [
    "配置站内搜索",
    "为常见问题添加明确的标题与关键词，让读者使用不同说法时也能找到相关帮助。",
  ],
  [
    "优化搜索无结果页面",
    "在无结果页面提供热门内容与联系入口，方便读者继续查找或向团队提出问题。",
  ],
  [
    "设置聊天机器人欢迎语",
    "在机器人设置中编辑欢迎语，说明可回答的问题范围，并提供简短的提问示例。",
  ],
  [
    "更新 AI 知识来源",
    "维护知识来源后检查同步时间。对于已过期的说明，应先更新原文再重新同步。",
  ],
  [
    "查看 AI 回答来源",
    "在问答记录中打开详情，右侧来源区域会列出与当前回答关联的参考文章。",
  ],
  [
    "管理 API 调用凭据",
    "在集成设置中创建凭据，仅向受信任的服务开放。调整权限后，需同步更新调用端配置。",
  ],
  [
    "添加网站聊天部件",
    "复制安装片段并加入网站模板，然后在预览环境确认部件位置与欢迎内容。",
  ],
  [
    "调整部件显示位置",
    "在外观设置中选择部件位置，并检查其是否遮挡网站的主要操作按钮。",
  ],
  [
    "配置联系信息表单",
    "按实际服务流程设置姓名、邮箱等字段，仅收集后续回复确实需要的信息。",
  ],
  [
    "导出问答分析记录",
    "先选择日期和渠道，再导出当前筛选结果。检查字段说明后可在表格软件中继续分析。",
  ],
  [
    "阅读访问趋势图表",
    "按天查看短期变化，按月比较长期趋势。查看数据时应保持日期区间与统计口径一致。",
  ],
  [
    "识别主要流量来源",
    "比较不同入口带来的点击数量，结合热门文章判断读者最常从哪些路径进入知识库。",
  ],
  [
    "收集文章改进建议",
    "为文章开启意见入口，并定期把建议整理为待办，更新后再复查同类问题是否减少。",
  ],
  [
    "恢复历史文章版本",
    "在版本记录中查看修改内容，确认目标版本后恢复，并重新检查发布状态与关联链接。",
  ],
  [
    "为知识库设置品牌外观",
    "上传品牌图标，设置主题色与站点名称，再预览首页、文章页和搜索结果的整体效果。",
  ],
  [
    "建立新员工入职指南",
    "按入职阶段组织账号开通、团队介绍和常见流程，并为各章节指定维护负责人。",
  ],
  [
    "维护产品更新说明",
    "按发布日期记录新功能、改进与使用方式，让读者能够快速了解当前版本的变化。",
  ],
  [
    "创建常见问题合集",
    "把重复出现的问题按使用场景归类，每个答案先给出操作步骤，再补充必要的背景说明。",
  ],
  [
    "设置文章阅读语言",
    "为不同语言建立对应内容，并检查导航、搜索提示与联系入口是否使用一致的语言。",
  ],
  [
    "排查图片显示异常",
    "检查图片格式与文件大小，在编辑器重新预览；若图片已经替换，还需确认文章已重新发布。",
  ],
  [
    "整理跨部门服务流程",
    "将办理条件、负责人和完成标准放在同一篇指南中，避免读者在多处重复查找信息。",
  ],
  [
    "归档过期帮助文章",
    "确认内容不再适用后将文章归档，并把仍在使用的旧链接指向最新的操作说明。",
  ],
  [
    "制定内容维护计划",
    "按访问量和业务变化安排复查顺序，为每个主题指定负责人及下一次检查日期。",
  ],
  [
    "查看团队服务质量",
    "结合有回答比例与具体问答记录寻找改进点，优先补充反复出现但缺少清晰答案的问题。",
  ],
] as const;

const ALL_DATES = { from: "", to: "", unit: "day" } satisfies Period;
const DAY_MS = 86_400_000;
const pad = (value: number) => String(value).padStart(2, "0");
const dateAt = (offset: number) =>
  new Date(Date.UTC(2026, 7, 7) + offset * DAY_MS).toISOString().slice(0, 10);
const timestamp = (offset: number, seed: number) =>
  `${dateAt(offset)} ${pad(9 + (seed % 10))}:${pad((seed * 7) % 60)}:00`;

function dayOf(value: string) {
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().startsWith(day)
    ? day
    : "";
}

/** Inclusive calendar dates; an empty bound is open. Times are not timezone-shifted. */
export function inPeriod(
  date: string,
  period: Pick<Period, "from" | "to">,
): boolean {
  const day = dayOf(date);
  const from = period.from ? dayOf(period.from) : "";
  const to = period.to ? dayOf(period.to) : "";
  if (!day || (period.from && !from) || (period.to && !to)) return false;
  return (!from || day >= from) && (!to || day <= to);
}

type Activity = Omit<ChartPoint, "date"> & {
  articleId: string;
  sourceId: string;
  searchId: string;
  date: string;
  clicks: number;
  searches: number;
  searchUsers: number;
  bytes: number;
};

const ARTICLE_INFO = TOPICS.map(([title, content], index) => ({
  id: `demo-article-${pad(index + 1)}`,
  title,
  content,
  author: ["知识运营组", "产品支持组", "客户服务组", "内容维护组"][index % 4],
}));
const SOURCE_INFO = [
  "https://www.example.com/",
  "https://docs.example.com/",
  "https://support.example.com/",
  "https://community.example.com/",
  "https://www.example.com/product",
  "https://www.example.com/blog",
  "https://learn.example.com/",
  "https://www.example.com/resources",
  "https://events.example.com/",
  "https://partners.example.com/",
  "https://www.example.com/contact",
  "https://status.example.com/",
  "https://www.example.com/guide",
  "https://academy.example.com/",
  "https://news.example.com/",
  "https://www.example.com/start",
  "https://help.example.com/",
  "https://www.example.com/tutorial",
  "https://portal.example.com/",
  "https://www.example.com/release-notes",
].map((website, index) => ({ id: `demo-source-${pad(index + 1)}`, website }));
const SEARCH_INFO = [
  "成员权限",
  "导入文档",
  "聊天机器人",
  "企业域名",
  "API 集成",
  "文章发布",
  "流量来源",
  "版本恢复",
].map((term, index) => ({
  id: `demo-search-${pad(index + 1)}`,
  term,
  results: 2 + (index % 5),
}));

// The same activities drive article totals, traffic, searches and overview buckets.
// September 2 is deliberately quiet, providing a real zero-day chart scenario.
const ACTIVITY: Activity[] = ARTICLE_INFO.flatMap((article, index) => {
  const offsets = [index % 31, (index * 7 + 3) % 31, (index * 11 + 9) % 31];
  if (index < 3) offsets.push(-3 + index, 31 + index);
  return offsets.map((offset, visit) => {
    const pv = 18 + ((index * 19 + visit * 13) % 173);
    return {
      articleId: article.id,
      sourceId: SOURCE_INFO[(index + visit * 7) % SOURCE_INFO.length].id,
      searchId: SEARCH_INFO[(index + visit) % SEARCH_INFO.length].id,
      date: timestamp(offset === 26 ? 25 : offset, index + visit),
      pv,
      uv: Math.max(1, Math.floor(pv * (0.48 + (index % 5) * 0.06))),
      likes: (index + visit * 3) % 9,
      dislikes: (index + visit) % 4 === 0 ? 1 : 0,
      feedback: (index + visit * 2) % 7 === 0 ? 1 : 0,
      clicks: 3 + ((index * 11 + visit * 7) % 48),
      searches: 2 + ((index + visit * 3) % 13),
      searchUsers: Math.min(
        2 + ((index + visit * 3) % 13),
        1 + ((index + visit) % 5),
      ),
      bytes: pv * (58_000 + (index % 4) * 12_000),
    };
  });
});

function activitiesIn(period: Pick<Period, "from" | "to">) {
  return ACTIVITY.filter((row) => inPeriod(row.date, period));
}

export function articleRows(period: Period): Article[] {
  const rows = new Map<string, Article>();
  for (const activity of activitiesIn(period)) {
    const existing = rows.get(activity.articleId);
    const row = existing ?? {
      ...ARTICLE_INFO.find((article) => article.id === activity.articleId)!,
      pv: 0,
      uv: 0,
      likes: 0,
      dislikes: 0,
      feedback: 0,
      lastVisited: "",
    };
    row.pv += activity.pv;
    row.uv += activity.uv;
    row.likes += activity.likes;
    row.dislikes += activity.dislikes;
    row.feedback += activity.feedback;
    if (activity.date > row.lastVisited) row.lastVisited = activity.date;
    rows.set(activity.articleId, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.pv - a.pv || a.id.localeCompare(b.id),
  );
}

export function trafficRows(period: Period): TrafficSource[] {
  const rows = new Map<string, TrafficSource>();
  for (const activity of activitiesIn(period)) {
    const row = rows.get(activity.sourceId) ?? {
      ...SOURCE_INFO.find((source) => source.id === activity.sourceId)!,
      clicks: 0,
      lastVisited: "",
    };
    row.clicks += activity.clicks;
    if (activity.date > row.lastVisited) row.lastVisited = activity.date;
    rows.set(activity.sourceId, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.clicks - a.clicks || a.id.localeCompare(b.id),
  );
}

export function searchRows(period: Period): SearchRecord[] {
  const rows = new Map<string, SearchRecord>();
  for (const activity of activitiesIn(period)) {
    const row = rows.get(activity.searchId) ?? {
      ...SEARCH_INFO.find((search) => search.id === activity.searchId)!,
      count: 0,
      users: 0,
      lastSearched: "",
    };
    row.count += activity.searches;
    row.users += activity.searchUsers;
    if (activity.date > row.lastSearched) row.lastSearched = activity.date;
    rows.set(activity.searchId, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.count - a.count || a.id.localeCompare(b.id),
  );
}

export const ARTICLES = articleRows(ALL_DATES);
export const TRAFFIC_SOURCES = trafficRows(ALL_DATES);
export const SEARCH_RECORDS = searchRows(ALL_DATES);

const emptyPoint = (date: string): ChartPoint => ({
  date,
  pv: 0,
  uv: 0,
  likes: 0,
  dislikes: 0,
  feedback: 0,
});
const METRICS = ["pv", "uv", "likes", "dislikes", "feedback"] as const;

export function overviewSeries(period: Period): ChartPoint[] {
  const orderedDates = ACTIVITY.map((row) => row.date.slice(0, 10)).sort();
  const from = period.from ? dayOf(period.from) : orderedDates[0];
  const to = period.to ? dayOf(period.to) : orderedDates.at(-1)!;
  if (!from || !to || from > to) return [];

  const buckets = new Map<string, ChartPoint>();
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let day = start; day <= end; day += DAY_MS) {
    const date = new Date(day)
      .toISOString()
      .slice(0, period.unit === "month" ? 7 : 10);
    if (!buckets.has(date)) buckets.set(date, emptyPoint(date));
  }
  for (const activity of activitiesIn({ from, to })) {
    const date = activity.date.slice(0, period.unit === "month" ? 7 : 10);
    const bucket = buckets.get(date)!;
    for (const metric of METRICS) bucket[metric] += activity[metric];
  }
  return [...buckets.values()];
}

export function overviewTotals(period: Period): {
  pv: number;
  uv: number;
  mb: number;
  likes: number;
  dislikes: number;
  feedback: number;
} {
  const totals = { pv: 0, uv: 0, mb: 0, likes: 0, dislikes: 0, feedback: 0 };
  let bytes = 0;
  for (const activity of activitiesIn(period)) {
    for (const metric of METRICS) totals[metric] += activity[metric];
    bytes += activity.bytes;
  }
  totals.mb = Math.round((bytes / 1_000_000) * 100) / 100;
  return totals;
}

const CHANNELS: QaRecord["channel"][] = ["AI搜索", "小部件", "API调用"];
const COLLABORATOR_GUIDE = [
  "邀请外部协作者前，先确认对方需要参与的工作范围。建议从一个具体分类开始协作，完成首次内容核验后，再按实际需要调整权限。",
  "一、进入成员管理，选择邀请成员。填写用于接收邀请的工作邮箱，并说明本次协作的目标，例如补充产品说明或核验服务流程。",
  "二、选择合适的角色。需要维护文章的同事可使用编辑角色；只负责校对的人员应优先使用阅读或评论权限，避免误改正式内容。",
  "三、限定可访问的知识库与分类。外部协作者不需要看到全部内部资料，应仅开放本次任务涉及的内容，并确认附件的访问范围。",
  "四、发送前核对邮箱、角色与有效期限。请特别检查相似的邮箱后缀；邀请说明应写明负责人和反馈渠道，便于对方确认邀请来源。",
  "五、对方接受邀请后，先共同打开一篇演示文章，确认能够查看、评论或编辑相应内容。不要直接用正在发布的重要文章做权限测试。",
  "六、如果对方没有收到邀请，可先检查垃圾邮件和邮箱拼写，再查看邀请是否过期。重新发送时，避免同时保留多条重复邀请。",
  "七、开始编辑前约定标题、分类和引用规范。协作者提交的内容先保存为草稿，由内部负责人复核事实、链接及图片后统一发布。",
  "八、涉及客户案例时，使用已经获准公开的资料。缺少来源的数字或结论应标记为待确认，不要为了补齐页面而填写未经核实的信息。",
  "九、多人维护同一主题时，先分配章节和检查顺序。每次修改附上简短说明，记录更新原因及涉及的流程，方便后续追踪版本差异。",
  "十、阶段任务完成后，检查待处理评论、未发布草稿与失效链接。确认交接完成，再关闭不再需要的访问范围或撤销临时成员资格。",
  "如需延长协作，请由负责人再次确认范围和期限。保留必要的修改记录即可，不应把邀请邮件、个人联系方式等内容放进公开知识库。",
  "建议把以上步骤整理为团队的协作清单，并在下一次邀请时复用。这样可以减少重复沟通，让内容审核和权限回收都有明确的检查点。",
].join("\n\n");
export const QA_RECORDS: QaRecord[] = Array.from({ length: 40 }, (_, index) => {
  const topic = TOPICS[index % TOPICS.length];
  const noAnswer = index % 7 === 4;
  const offset = index < 36 ? (index * 13) % 31 : [-3, -1, 31, 33][index - 36];
  const answer = noAnswer
    ? ""
    : index === 38
      ? COLLABORATOR_GUIDE
      : `${topic[1]}${index % 5 === 0 ? "\n\n操作建议：\n1. 先确认当前知识库和操作权限。\n2. 在对应设置页面查看当前配置。\n3. 调整后使用预览检查结果，再与团队确认。\n\n如果流程与团队实际需求不同，可以把问题记录在内部内容维护清单中，由相关负责人补充说明。" : ""}`;
  return {
    id: `demo-qa-${pad(index + 1)}`,
    question: `如何${topic[0]}？`,
    answer,
    model: QA_MODELS[index % QA_MODELS.length],
    channel: CHANNELS[index % CHANNELS.length],
    quality: noAnswer ? "—" : ["满意", "未评价", "待改进"][index % 3],
    sessionId: `demo-session-${pad(Math.floor(index / 2) + 1)}`,
    asker: `演示用户 ${pad((index % 9) + 1)}`,
    createdAt: timestamp(offset, index),
    internet: index % 3 === 0,
    sources:
      noAnswer || index % 6 === 3
        ? []
        : [
            {
              title: topic[0],
              url: `https://docs.example.com/help/topic-${pad((index % TOPICS.length) + 1)}`,
            },
            ...(index % 5 === 0
              ? [
                  {
                    title: "团队知识库使用指南",
                    url: "https://docs.example.com/help/team-guide",
                  },
                ]
              : []),
          ],
  };
}).sort(
  (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
);

const normalise = (value: string) => value.trim().toLocaleLowerCase();
const includes = (value: string, filter: string) =>
  normalise(value).includes(normalise(filter));
const selected = (value: string, filter: string) =>
  !filter || filter === "全部" || normalise(value) === normalise(filter);

export function filterQa(filters: QaFilters): QaRecord[] {
  return QA_RECORDS.filter(
    (row) =>
      includes(row.asker, filters.asker) &&
      selected(row.channel, filters.channel) &&
      includes(row.question, filters.question) &&
      includes(row.answer, filters.answer) &&
      includes(row.sessionId, filters.sessionId) &&
      selected(row.model, filters.model) &&
      selected(row.internet ? "是" : "否", filters.internet) &&
      selected(row.answer.trim() ? "有回答" : "无回答", filters.answerState) &&
      inPeriod(row.createdAt, filters),
  );
}
