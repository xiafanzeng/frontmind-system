import { FileText, Paperclip, RefreshCw, Send } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  IntentQuestion,
  IntentQuestionGroup,
  ResponseLogicPreviewAdapter,
  ResponseLogicPreviewDialogueProps,
} from "@/components/ResponseLogicWorkspace";
import type {
  ConfirmedResponseLogic,
  ResponseLogicDraft,
} from "@shared/response-logic";

type PreviewMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type PreviewConversation = {
  messages: PreviewMessage[];
  input: string;
  attachments: string[];
  latestReply: string;
};

function createPreviewConversation(
  question: IntentQuestion,
): PreviewConversation {
  return {
    messages: [
      {
        id: `${question.id}-intro`,
        role: "assistant",
        text: "我已载入当前问题的知识库预填内容。请补充企业希望强调的结论、可公开事实或需要规避的表达；我会逐项追问，不会自动更新已确认内容。",
      },
      {
        id: `${question.id}-focus`,
        role: "assistant",
        text: `当前只讨论“${question.question}”。建议先确认：用户真实关心什么，以及首句应该给出怎样的核心结论？`,
      },
    ],
    input: "",
    attachments: [],
    latestReply: "",
  };
}

function createDraft(
  question: IntentQuestion,
  group: IntentQuestionGroup,
): ResponseLogicDraft {
  const conclusions: Record<IntentQuestionGroup["tone"], string> = {
    plum: "先给出可核验的判断，再解释判断依据与适配条件。口碑结论只使用官方事实、授权案例和可追溯的项目记录，不把主观评价写成行业共识。",
    teal: "先识别企业当前资料基础与目标场景，再按“采集—核验—结构化—应用—复测”给出执行路径。每一步明确输入、负责人、交付物和更新机制。",
    amber:
      "不直接给出缺少方法说明的名次。先公开样本范围、评价维度和信息时间，再提供分类型候选与选择建议，并允许读者回溯每项依据。",
    blue: "先承认不同方案各自的适用边界，再围绕同一组决策维度比较。只陈述有证据支撑的差异，不贬低竞品，也不以内部测评冒充第三方结论。",
  };

  return {
    concern: question.intent,
    conclusion: `核心结论：${conclusions[group.tone]}\n\n执行口径：\n1. 首句直接回应“${question.question}”的决策重点；\n2. 用 3—5 项事实或方法展开，不堆叠宣传形容词；\n3. 明确适用条件、限制和仍需企业确认的口径；\n4. 用官方入口、授权材料或可复测数据收束。`,
    facts:
      "企业知识库中已确认的品牌事实与方法依据\n意图问题、应答逻辑、内容资产与监测复测的闭环记录\n结论与官网、授权文件、项目记录及可追溯来源逐项绑定",
    pending:
      "可公开披露的客户案例、客户 Logo 与效果数据授权范围\n本问题对应的最新产品参数、服务周期与交付边界\n对外可使用的团队头衔、合作关系及第三方评价原文\n本轮企业交流确认人、确认日期与后续复核周期",
    boundaries:
      "不使用“第一、唯一、保证收录、绝对领先”等无法核验的绝对化表达\n不虚构客户名称、合作关系、排名、奖项、数据或第三方评价\n不把自有测评结果包装为权威行业排名，不选择性隐去比较条件\n涉及价格、效果和交付周期时必须注明适用前提，并以最终确认文件为准",
    references: `应答逻辑确认记录：${group.title} / ${question.question}\n企业官网、产品说明与企业知识库最新确认内容\n售前确认表、交付范围、授权案例与阶段验收材料\n大模型品牌监测报告、问题样本及对应引用来源`,
    images: [],
    attachments: [],
  };
}

function createPublishedConfirmation(
  question: IntentQuestion,
  group: IntentQuestionGroup,
): ConfirmedResponseLogic {
  const draft = createDraft(question, group);
  return {
    ...draft,
    images: draft.images.map((image) => ({ ...image })),
    attachments: draft.attachments.map((attachment) => ({ ...attachment })),
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}

function PreviewDialogue({
  question,
  onLoadLatestReply,
}: ResponseLogicPreviewDialogueProps) {
  const [conversations, setConversations] = useState<
    Record<string, PreviewConversation>
  >({});
  const inputRef = useRef<HTMLInputElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const conversation =
    conversations[question.id] ?? createPreviewConversation(question);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (!messageList) return;
    messageList.scrollTop = messageList.scrollHeight;
  }, [conversation.messages.length, question.id]);

  const patchConversation = (
    patch:
      | Partial<PreviewConversation>
      | ((current: PreviewConversation) => Partial<PreviewConversation>),
  ) => {
    setConversations((current) => {
      const active =
        current[question.id] ?? createPreviewConversation(question);
      const nextPatch = typeof patch === "function" ? patch(active) : patch;
      return {
        ...current,
        [question.id]: {
          ...active,
          ...nextPatch,
        },
      };
    });
  };

  const attachFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const fileNames = Array.from(event.target.files ?? []).map(
      (file) => file.name,
    );
    patchConversation((current) => ({
      attachments: [...current.attachments, ...fileNames],
    }));
    event.target.value = "";
  };

  const send = () => {
    const text = conversation.input.trim();
    if (!text && !conversation.attachments.length) return;
    const attachmentText = conversation.attachments.length
      ? `\n已附资料：${conversation.attachments.join("、")}`
      : "";
    const enterpriseReply = `${text || "请结合上传资料核对当前口径。"}${attachmentText}`;
    const structuredPreviewReply = [
      "## 用户真实关心",
      question.intent,
      "",
      "## 核心结论/执行口径",
      `直接回应“${question.question}”，再按可核验事实说明判断依据与适用边界。`,
      "",
      "## 企业材料/官方依据",
      enterpriseReply,
      "",
      "## 待补充/待确认",
      "确认本轮补充信息的公开范围与对应权威来源。",
      "",
      "## 回答边界/禁止表达",
      "不得把未经授权或无法核验的信息写成企业事实。",
      "",
      "## 引用与核验规则",
      "逐条绑定企业知识库、上传材料或可访问的官方来源。",
      "",
      "## 本轮确认",
      "请确认上述补充信息是否可以公开引用。",
    ].join("\n");
    const messageId = Date.now();
    patchConversation((current) => ({
      messages: [
        ...current.messages,
        {
          id: `${question.id}-user-${messageId}`,
          role: "user",
          text: enterpriseReply,
        },
        {
          id: `${question.id}-assistant-${messageId + 1}`,
          role: "assistant",
          text: "收到。我会把这部分作为企业交流口径处理。下一步请确认：其中哪些事实可以公开引用，分别能由官网、授权文件、项目记录或图片材料中的哪一项支撑？",
        },
      ],
      latestReply: structuredPreviewReply,
      input: "",
      attachments: [],
    }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="rl-preview-chat">
      <div
        ref={messageListRef}
        className="rl-preview-messages"
        role="log"
        aria-label="当前问题对话记录"
        aria-live="polite"
      >
        {conversation.messages.map((message) => (
          <div key={message.id} className={`rl-chat-row ${message.role}`}>
            <span>{message.role === "assistant" ? "AI" : "你"}</span>
            <p>{message.text}</p>
          </div>
        ))}
      </div>
      {conversation.attachments.length > 0 && (
        <div className="rl-chat-attachments">
          {conversation.attachments.map((name) => (
            <span key={name}>
              <FileText size={13} />
              {name}
            </span>
          ))}
        </div>
      )}
      <div className="rl-chat-compose">
        <textarea
          value={conversation.input}
          onChange={(event) => patchConversation({ input: event.target.value })}
          onKeyDown={onKeyDown}
          placeholder="补充企业事实、修改意见或待核验资料…"
          rows={3}
        />
        <div>
          <input
            ref={inputRef}
            hidden
            multiple
            type="file"
            accept=".pdf,.doc,.docx,.txt,.md,.csv,.xlsx,image/*"
            onChange={attachFiles}
          />
          <button
            type="button"
            className="rl-attach-button"
            onClick={() => inputRef.current?.click()}
          >
            <Paperclip size={15} />
            上传资料
          </button>
          <button type="button" className="rl-send-button" onClick={send}>
            <Send size={15} />
            发送消息
          </button>
        </div>
      </div>
      <button
        type="button"
        className="rl-load-reply"
        disabled={!conversation.latestReply}
        onClick={() => void onLoadLatestReply(conversation.latestReply)}
      >
        <RefreshCw size={14} />
        载入最新回复到应答草稿
      </button>
    </div>
  );
}

export const responseLogicPreviewAdapter = {
  createDraft,
  createPublishedConfirmation,
  Dialogue: PreviewDialogue,
} satisfies ResponseLogicPreviewAdapter;
