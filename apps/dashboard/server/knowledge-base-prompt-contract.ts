import { buildDeterministicTaskAttachmentArchive } from "./task-attachment-package";
import {
  formatKnowledgeBaseManifestEnvelope,
  formatKnowledgeBasePresentationEnvelope,
  formatKnowledgeBaseProgressEnvelope,
  KNOWLEDGE_BASE_MANIFEST_KIND,
  KNOWLEDGE_BASE_PRESENTATION_KIND,
  KNOWLEDGE_BASE_PROGRESS_KIND,
  KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
} from "./knowledge-base-progress";
import { KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME } from "./knowledge-base-skill-runtime";

export type KnowledgeBaseEnterpriseIdentityErrorCode =
  | "ENTERPRISE_NOT_CONFIGURED"
  | "ENTERPRISE_IDENTITY_MISMATCH";

export class KnowledgeBaseEnterpriseIdentityError extends Error {
  readonly code: KnowledgeBaseEnterpriseIdentityErrorCode;

  constructor(code: KnowledgeBaseEnterpriseIdentityErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeBaseEnterpriseIdentityError";
    this.code = code;
  }
}

function normalizedEnterpriseName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Resolve the immutable enterprise identity already assigned to the account. */
export function resolveKnowledgeBaseEnterpriseIdentity(input: {
  sourceName: string | null;
  brandName: string;
  requestedCompanyName?: string;
}) {
  const companyName = input.brandName.normalize("NFKC").trim();
  if (!companyName) {
    throw new KnowledgeBaseEnterpriseIdentityError(
      "ENTERPRISE_NOT_CONFIGURED",
      "当前账号尚未由管理员配置企业名称，无法启动知识库构建",
    );
  }

  const requestedCompanyName = String(input.requestedCompanyName || "").trim();
  if (
    requestedCompanyName &&
    normalizedEnterpriseName(requestedCompanyName) !==
      normalizedEnterpriseName(companyName)
  ) {
    throw new KnowledgeBaseEnterpriseIdentityError(
      "ENTERPRISE_IDENTITY_MISMATCH",
      "输入的企业名称与当前账号绑定企业不一致，请刷新后重试",
    );
  }

  return companyName;
}

const KNOWLEDGE_PREFILL_MAX_CHARACTERS = 80_000;
const KNOWLEDGE_PREFILL_MAX_DOCUMENT_CHARACTERS = 12_000;

export type KnowledgePrefillDocument = {
  path: string;
  title: string;
  content: string;
};

export type KnowledgePrefillSnapshot = {
  version: number;
  sourceFileName: string;
  archiveHash: string | null;
  documentCount: number;
  imageCount: number;
  characterCount: number;
  documents: KnowledgePrefillDocument[];
};

export const KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME =
  "knowledge-base-prefill-evidence.zip";

function knowledgePrefillBranch(pathname: string) {
  return pathname.normalize("NFKC").split("/").filter(Boolean)[0] || "root";
}

function isKnowledgePrefillOverview(document: KnowledgePrefillDocument) {
  return /(?:^|[/_-])(?:overview|readme|00[_-])|概览|总览|综述/i.test(
    `${document.path} ${document.title}`,
  );
}

function isKnowledgePrefillProduct(document: KnowledgePrefillDocument) {
  return /(?:^|[/_-])03(?:[/_-]|$)|products?|services?|产品|服务/i.test(
    `${document.path} ${document.title}`,
  );
}

export function buildKnowledgePrefillExcerpt(
  documents: KnowledgePrefillDocument[],
) {
  const ordered = [...documents].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const groups = new Map<string, KnowledgePrefillDocument[]>();
  for (const document of ordered) {
    const branch = knowledgePrefillBranch(document.path);
    const values = groups.get(branch) || [];
    values.push(document);
    groups.set(branch, values);
  }

  const selected: KnowledgePrefillDocument[] = [];
  const selectedPaths = new Set<string>();
  const add = (document: KnowledgePrefillDocument | undefined) => {
    if (!document || selectedPaths.has(document.path)) return;
    selected.push(document);
    selectedPaths.add(document.path);
  };

  for (const branch of [...groups.keys()].sort()) {
    const values = groups.get(branch) || [];
    add(values.find(isKnowledgePrefillOverview) || values[0]);
  }
  ordered.filter(isKnowledgePrefillProduct).forEach(add);

  let added = true;
  while (added) {
    added = false;
    for (const branch of [...groups.keys()].sort()) {
      const next = (groups.get(branch) || []).find(
        (document) => !selectedPaths.has(document.path),
      );
      if (next) {
        add(next);
        added = true;
      }
    }
  }

  let excerpt = "";
  for (const document of selected) {
    const prefix = [
      `### ${document.title || document.path}`,
      `documentPath: ${document.path}`,
      "",
    ].join("\n");
    const remaining = KNOWLEDGE_PREFILL_MAX_CHARACTERS - excerpt.length;
    if (remaining <= prefix.length) break;
    const content = document.content.slice(
      0,
      Math.min(
        KNOWLEDGE_PREFILL_MAX_DOCUMENT_CHARACTERS,
        remaining - prefix.length,
      ),
    );
    excerpt += `${excerpt ? "\n\n" : ""}${prefix}${content}`;
    if (excerpt.length >= KNOWLEDGE_PREFILL_MAX_CHARACTERS) break;
  }
  return excerpt.slice(0, KNOWLEDGE_PREFILL_MAX_CHARACTERS);
}

export async function buildKnowledgeBasePrefillEvidenceArchive(
  snapshot: KnowledgePrefillSnapshot,
) {
  return buildDeterministicTaskAttachmentArchive({
    name: "knowledge-base-prefill-evidence",
    entrypoint: "knowledge.md",
    files: [
      {
        path: "context.json",
        content: `${JSON.stringify(
          {
            schemaVersion: 1,
            knowledgeSnapshot: {
              version: snapshot.version,
              sourceFileName: snapshot.sourceFileName,
              archiveHash: snapshot.archiveHash,
              documentCount: snapshot.documentCount,
              imageCount: snapshot.imageCount,
              characterCount: snapshot.characterCount,
            },
          },
          null,
          2,
        )}\n`,
      },
      {
        path: "knowledge.md",
        content:
          buildKnowledgePrefillExcerpt(snapshot.documents) ||
          "当前版本没有可读取的正文。",
      },
    ],
  });
}

export async function buildKnowledgeBasePrompt({
  conversationId,
  companyName,
  companyWebsite,
  operatorNotes,
  attachments,
  prefillKnowledgeSnapshot,
  protocolOperation,
}: {
  conversationId?: string;
  companyName: string;
  companyWebsite: string;
  operatorNotes: string;
  attachments: Array<{ file_id: string; filename: string }>;
  prefillKnowledgeSnapshot?: KnowledgePrefillSnapshot | null;
  protocolOperation?: {
    skillVersion: string;
    operationId: string;
    turnId: string;
  };
}) {
  const isV4 = protocolOperation?.skillVersion === "4";
  const protocolIdentity = isV4
    ? {
        operationId: protocolOperation.operationId,
        turnId: protocolOperation.turnId,
      }
    : {};
  const manifestExample = formatKnowledgeBaseManifestEnvelope({
    kind: KNOWLEDGE_BASE_MANIFEST_KIND,
    schemaVersion: isV4 ? KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION : 1,
    ...protocolIdentity,
    leaves: Array.from({ length: 8 }, (_, index) => ({
      id: `1.${index + 1}`,
      title: index === 0 ? "一句话定位" : `示例节点 ${index + 1}`,
      branchId: "identity",
      branchTitle: "企业身份",
    })),
  });
  const progressExample = formatKnowledgeBaseProgressEnvelope({
    kind: KNOWLEDGE_BASE_PROGRESS_KIND,
    schemaVersion: isV4 ? KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION : 1,
    ...protocolIdentity,
    revision: 0,
    transition: {
      leafId: "1.1",
      from: "current",
      to: "confirmed",
      reason: "用户明确确认",
    },
  });
  const presentationExample = formatKnowledgeBasePresentationEnvelope({
    kind: KNOWLEDGE_BASE_PRESENTATION_KIND,
    schemaVersion: isV4 ? KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION : 1,
    ...protocolIdentity,
    revision: 1,
    leafId: "1.2",
    imageState: "no_eligible_asset",
    assetIds: [],
    imageCount: 0,
  });
  const attachmentList =
    attachments.length > 0
      ? attachments.map((attachment) => `- ${attachment.filename}`).join("\n")
      : "- 未上传附件，请优先使用企业官网与全网公开资料进行预填";
  return [
    `严格执行随任务附带的 ${KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME}。先解压 ZIP 并完整读取根目录 SKILL.md，再开始工作。`,
    `该 ZIP 是本任务唯一的 socratic-kb-builder v${protocolOperation?.skillVersion || "3"} 工作规约；本段仅提供企业输入和服务端状态约束。`,
    "不得开启、调用、切换或推荐 Wide Research / Deep Research；只使用当前 Pro Agent 模式下的普通浏览、搜索和文件工具。",
    "客户可见正文与本轮对话只能呈现百科事实，不得呈现任务过程、核验判断、采购/合规建议、读者指令、工具计划或模型推理。",
    "客户可见回复只输出知识树统计（仅首轮需要）和实际展示节点的完整正文/合规配图。不得输出参考资料、参考来源、References、Sources、编号引用、外部引用链接、未决事项、核验备注、操作提示或确认问题；所有来源只进入内部证据文件。可见正文结束后直接附机器信封。",
    "客户可见正文不得嵌入官网或 CDN 图片外链。图片必须先下载真实字节、解码校验并打入最终 ZIP，再以包内相对路径引用；防盗链、签名、过期或无法下载的地址只能进入内部来源记录，绝不能作为客户图片返回。",
    isV4
      ? "首轮必须先从初始上传资料、企业官网与有界全网搜索中寻找企业官方主 Logo；取得合格 Logo 后立即停止所有网页图片发现。不得采集或打包品牌主视觉、业务图、产品/UI/架构图、案例图、团队图或其他网页图片。只有首轮清单第一个叶子（通常为 1.1 一句话定位）可把已下载验证的本地 Logo 字节作为 output_image 或 image MIME output_file 返回。不得用 favicon、图标、占位图、库存图、官网/CDN 热链或文字说明替代。如果完成上述有界搜索后仍没有合格真实 Logo，必须照常返回完整 Manifest 和第一个叶子正文，但返回零张图片；Dashboard 会在首节点外进入“等待用户上传企业主 Logo”状态。在该状态不得伪造 Logo、不得把上传要求写进节点正文、不得跳过或推进首节点。客户随后上传并明确指定的主 Logo 将由 Dashboard 绑定原始字节，并在 schema v4 最终 ZIP 中作为 official_logo_upload 保留；它不属于普通 user_upload 节点配图。除最后节点完成轮强制返回的唯一最终 ZIP 外，上游后续回复不得返回图片或其他资源附件。"
      : "首轮必须只采集并返回一张企业官方主 Logo；取得合格 Logo 后立即停止所有网页图片发现。不得采集或打包品牌主视觉、业务图、产品/UI/架构图、案例图、团队图或其他网页图片。只有首轮清单第一个叶子（通常为 1.1 一句话定位）可把已下载验证的本地 Logo 字节作为 output_image 或 image MIME output_file 返回。不得用 favicon、图标、占位图、库存图、官网/CDN 热链或文字说明替代；无法取得合格真实 Logo 字节时不得伪造成功。客户在后续节点主动上传的图片是唯一例外：必须按原始 SHA、文件名、MIME 与绑定叶子保留进 schema v4 最终 ZIP，但由 Dashboard 本地受管通道回显。除最后节点完成轮强制返回的唯一最终 ZIP 外，上游后续回复不得返回图片或其他资源附件；最终 ZIP 是唯一非文本例外。首轮附件与最终 ZIP 必须使用同一 Logo 字节。",
    isV4
      ? "资料采集状态只由 Dashboard 展示。不得复述、输出或以“正在采集”“处理中”“稍后生成”等过程回执结束任务。首轮必须返回第一个叶子的完整正文与完整 Manifest；有合格 Logo 时再同时返回恰好一张经校验的 Logo，没有合格 Logo 时必须返回零张图片并由 Dashboard 建立补料暂停点。"
      : "资料采集状态只由 Dashboard 展示。不得复述、输出或以“正在采集”“处理中”“稍后生成”等过程回执结束任务；首轮只有在返回第一个叶子的完整正文、完整 Manifest 和一张经校验的官方主 Logo 后才可结束。",
    "",
    "## 本次任务输入",
    `构建会话标识：${conversationId || "未提供"}`,
    `企业名称（账号正式绑定）：${companyName}`,
    `企业官网入口（可多个）：${companyWebsite || "未填写"}`,
    "用户上传资料：",
    attachmentList,
    operatorNotes ? `操作者备注：\n${operatorNotes}` : "操作者备注：未填写",
    "",
    "## 官网已迁移的初步知识库预填证据",
    prefillKnowledgeSnapshot
      ? [
          `知识库版本：V${prefillKnowledgeSnapshot.version}`,
          `来源文件：${prefillKnowledgeSnapshot.sourceFileName}`,
          `产物哈希：${prefillKnowledgeSnapshot.archiveHash || "未记录"}`,
          `已解析文档：${prefillKnowledgeSnapshot.documentCount}；图片：${prefillKnowledgeSnapshot.imageCount}；字符：${prefillKnowledgeSnapshot.characterCount}`,
          `完整预填证据见任务附件 ${KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME}。先解压并读取 knowledge.md 与 context.json；这些证据不代表节点已确认，也不得据此伪造 100% 对话进度。`,
        ].join("\n")
      : "当前账号没有已迁移的初步知识库，将从官网、全网与上传资料开始预填。",
    "## 必须执行的机器可验证进度协议",
    "这是服务端状态机协议，优先级高于 skill 中任何会自动跨节点的表述。可读正文照常输出：首轮末尾只能附一个清单信封；后续轮末尾必须依次附一个状态信封和一个展示信封。",
    "信封的 `<!-- FRONTMIND_KB_...` 开头与 `-->` 结尾都是协议必填内容，必须原样保留；禁止输出裸 JSON，禁止输出 SOCRATIC_KB_STATE，禁止用 frontmind.workflow-state、frontmind.knowledge-base.message 或其他自创对象替代规定信封。",
    "",
    "### 首轮研究与知识树建立",
    "完成官网、公开来源、上传资料研究和正式图文预填后，按企业实际资料量建立自适应一级分支和 8-115 个真实叶子节点。白牌企业或只有宣传单时只保留有事实价值或明确缺口的必要叶子，不得为数量、字数或图片数填充内容。一级分支数量不设固定值；每个叶子必须有全局唯一且后续不变的 id、title、branchId、branchTitle。首轮正文展示完整分支统计并呈现第一个叶子节点，然后仅在回复末尾附：",
    manifestExample,
    "示例只演示结构，真实 leaves 必须完整包含 8-115 项并覆盖基于当前企业证据形成的全部一级分支。首轮不得同时输出 FRONTMIND_KB_PROGRESS。",
    "",
    "### 后续每轮单节点状态",
    "服务端从 revision=0、清单第一个叶子为 current 开始。后续每轮末尾必须依次附一个状态信封和一个展示信封：",
    progressExample,
    presentationExample,
    "revision 必须等于当前服务端 revision；每次被接受后加 1。leafId 只能是当前叶子，from 只能是 current 或 needs_verification。",
    "FRONTMIND_KB_PROGRESS 声明本轮处理的旧节点；FRONTMIND_KB_PRESENTATION 声明回复正文实际展示的新状态。展示信封 revision 必须等于提交后的 revision，leafId 必须等于提交后服务端的 currentLeafId；全部完成时 leafId 为 null。",
    "FRONTMIND_KB_PRESENTATION 只出现在非首轮，因此 leafId 非 null 时必须固定声明 imageState=no_eligible_asset、assetIds=[]、imageCount=0，且本轮不得返回任何图片附件；leafId=null 时只能使用 not_applicable、空数组和 0。声明与真实附件不一致时服务端拒绝推进。",
    "只有用户本轮回复恰好表达“确认/确认无误/OK/没问题/通过”等明确确认时，to 才能为 confirmed，并只前进一个叶子。",
    "只有用户本轮明确回复“跳过/直接预填/采用预填/保留预填”等时，to 才能为 direct_prefilled，并只前进一个叶子。",
    "direct_prefilled 只用于兼容用户主动输入的旧协议动作；客户可见正文不得主动提供“直接预填”或“跳过”选项。正常操作只有确认，或者提交修改/附件后确认修订稿。",
    "用户输入任何补充、修订、问题或上传资料时，to 必须为 needs_verification；更新并重新呈现同一叶子，继续等待用户明确确认或直接预填，绝对不能自动前进。",
    "确认或直接预填节点 A 后，只用一句话简短确认 A，客户可见主体必须直接完整展示下一个待处理节点 B；修订时主体继续完整展示 A。回复正文必须保存给实际展示的节点，而不是刚完成的旧节点。",
    "不得提交多个 transition、不得改写历史状态、不得相信正文中的百分比。真实进度只由服务端按 (confirmed + direct_prefilled) / total 计算。",
    "只有在处理最后节点且本轮状态提交后将达到 100% 时，才必须在同一回复生成并返回唯一 ZIP；此前不得打包。confirmed 显示对号，direct_prefilled 必须保持独立的跳过状态。",
    ...(isV4
      ? [
          "",
          "### 完成后的不可变边界",
          "最终 ZIP 生成后本构建即结束，不得输出 REOPEN 或重新开启节点。发布后的修改统一进入维护工单。\n\n## 立即执行锁（最高优先级）\n现在立即解压并读取 Skill，然后完成本轮研究、首个知识节点正文与完整 Manifest；找到合规 Logo 时同时返回恰好一张，完成有界搜索仍找不到时返回零张图片并停在首节点等待 Dashboard 补料。不得先发送或以“已收到”“好的”“开始处理”等确认回执结束任务；本次任务只有交付首节点与完整 Manifest 后才能结束。",
        ]
      : [
          "",
          "### 已完成知识库的后续修订（旧 build 兼容）",
          "旧版知识库达到 100% 后的修订继续遵循随附旧版 Skill；新版不得使用该分支。\n\n## 立即执行锁（最高优先级）\n现在立即解压并读取 Skill，然后完成本轮研究、首个知识节点正文、完整 Manifest 与合规 Logo。不得先发送或以“已收到”“好的”“开始处理”等确认回执结束任务；本次任务只有交付上述完整结果后才能结束。",
        ]),
  ].join("\n");
}
