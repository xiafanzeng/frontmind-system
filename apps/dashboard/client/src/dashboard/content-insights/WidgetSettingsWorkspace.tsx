import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
} from "react";
import * as Switch from "@radix-ui/react-switch";
import * as Tabs from "@radix-ui/react-tabs";
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ImagePlus,
  MessageCircle,
  MessageSquare,
  Plus,
  Search,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import {
  HlButton,
  HlField,
  HlSelect,
  copyText,
  type SettingsTab,
} from "./shared";
import "./widget-settings.css";

type LocalImage = { name: string; dataUrl: string };
type SettingsDraft = {
  enabled: boolean;
  serviceDesk: boolean;
  chatbot: boolean;
  siteDisplay: boolean;
  icon: LocalImage | null;
  avatar: LocalImage | null;
  name: string;
  welcome: string;
  welcomeImage: LocalImage | null;
  showSources: boolean;
  position: "bottom-right" | "bottom-left";
  sidebar: boolean;
  theme: string;
  customPromptEnabled: boolean;
  customPrompt: string;
  leadName: boolean;
  leadPhone: boolean;
  leadEmail: boolean;
  leadNotification: boolean;
  forcedLead: boolean;
  leadDescription: string;
};

const INITIAL_DRAFT: SettingsDraft = {
  enabled: true,
  serviceDesk: true,
  chatbot: true,
  siteDisplay: false,
  icon: null,
  avatar: null,
  name: "Chatbot",
  welcome: "",
  welcomeImage: null,
  showSources: true,
  position: "bottom-right",
  sidebar: false,
  theme: "#0761e7",
  customPromptEnabled: false,
  customPrompt: "",
  leadName: false,
  leadPhone: false,
  leadEmail: false,
  leadNotification: false,
  forcedLead: false,
  leadDescription: "",
};

const SETTINGS_TABS: Array<{ value: SettingsTab; label: string }> = [
  { value: "basic", label: "基础配置" },
  { value: "leads", label: "留资配置" },
  { value: "install", label: "安装代码" },
  { value: "share", label: "分享地址" },
];

const LOCAL_INSTALL_CODE = `<!-- 本地预览示例：无需加载外部脚本 -->
<div id="frontmind-preview-widget"></div>
<script type="application/json" id="frontmind-preview-config">
  { "mode": "local-preview", "network": false }
</script>`;

const DEMO_ARTICLES = [
  {
    title: "如何开始使用帮助中心？",
    content:
      "在帮助中心中选择需要了解的主题，或在搜索框输入关键词，即可查找对应的使用说明。这里展示的是本地演示内容。",
  },
  {
    title: "如何配置问答小部件？",
    content:
      "您可以设置机器人名称、欢迎语和展示样式，并在右侧预览中查看效果。修改只保留在当前本地预览页面。",
  },
  {
    title: "如何联系服务台？",
    content:
      "在问答窗口中填写您的问题，也可以留下联系方式，方便服务团队了解您的需求。本地演示不会发送任何资料。",
  },
];

function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const hintId = useId();
  return (
    <div className="hl-widget-form-item hl-widget-toggle-field">
      <span className="hl-widget-label">{label}</span>
      {hint && (
        <span className="hl-widget-hint" id={hintId}>
          {hint}
        </span>
      )}
      <div className="hl-widget-switch-row">
        <Switch.Root
          className="hl-widget-switch"
          aria-label={label}
          aria-describedby={hint ? hintId : undefined}
          checked={checked}
          onCheckedChange={onChange}
        >
          <Switch.Thumb className="hl-widget-switch-thumb" />
        </Switch.Root>
      </div>
    </div>
  );
}

function ImagePicker({
  label,
  value,
  onChange,
  welcome = false,
}: {
  label: string;
  value: LocalImage | null;
  onChange: (image: LocalImage | null) => void;
  welcome?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  useEffect(
    () => () => {
      readVersion.current += 1;
    },
    [],
  );

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const version = ++readVersion.current;
    setReading(false);
    if (
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        file.type,
      )
    ) {
      setError("请选择 PNG、JPG、WebP 或 GIF 图片");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("图片不能超过 5MB");
      return;
    }
    setError("");
    setReading(true);
    const reader = new FileReader();
    reader.onload = () => {
      if (version !== readVersion.current) return;
      setReading(false);
      if (typeof reader.result !== "string") {
        setError("图片读取失败，请重新选择");
        return;
      }
      onChange({ name: file.name, dataUrl: reader.result });
    };
    reader.onerror = () => {
      if (version !== readVersion.current) return;
      setReading(false);
      setError("图片读取失败，请重新选择");
    };
    reader.readAsDataURL(file);
  };

  return (
    <div
      className={`hl-widget-image-picker${welcome ? " hl-widget-image-picker--welcome" : ""}`}
    >
      <input
        ref={inputRef}
        className="hl-widget-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label={`选择${label}文件`}
        onChange={pick}
      />
      <button
        type="button"
        className={`hl-widget-upload${welcome && !value ? " hl-widget-upload--text" : ""}`}
        aria-label={`${value ? "更换" : "上传"}${label}`}
        disabled={reading}
        onClick={() => inputRef.current?.click()}
      >
        {value ? (
          <img src={value.dataUrl} alt={label} />
        ) : welcome ? (
          <>
            <ImagePlus size={15} />
            上传图片
          </>
        ) : (
          <Plus size={24} strokeWidth={1} />
        )}
        {reading && <span className="hl-widget-upload-status">读取中</span>}
      </button>
      {value && (
        <div className="hl-widget-upload-actions">
          <HlButton variant="link" onClick={() => inputRef.current?.click()}>
            更换
          </HlButton>
          <HlButton
            variant="link"
            aria-label={`删除${label}`}
            onClick={() => {
              readVersion.current += 1;
              setReading(false);
              setError("");
              onChange(null);
            }}
          >
            删除
          </HlButton>
        </div>
      )}
      {error && (
        <span className="hl-widget-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

type LeadValues = { name: string; phone: string; email: string };
type LeadErrors = Partial<Record<keyof LeadValues, string>>;
type ChatMessage = { id: number; role: "user" | "assistant"; text: string };

function validateLead(draft: SettingsDraft, values: LeadValues): LeadErrors {
  const errors: LeadErrors = {};
  if (draft.leadName && !values.name.trim()) errors.name = "请输入名称";
  if (
    draft.leadPhone &&
    !/^\+?\d{6,15}$/.test(values.phone.replace(/[\s()-]/g, ""))
  )
    errors.phone = "请输入有效手机号";
  if (
    draft.leadEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())
  )
    errors.email = "请输入有效邮箱";
  return errors;
}

function WidgetPreview({
  draft,
  previewOpen,
  onPreviewOpenChange,
}: {
  draft: SettingsDraft;
  previewOpen: boolean;
  onPreviewOpenChange: (open: boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<"chat" | "desk">("chat");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [leadValues, setLeadValues] = useState<LeadValues>({
    name: "",
    phone: "",
    email: "",
  });
  const [leadErrors, setLeadErrors] = useState<LeadErrors>({});
  const [completedLeadKey, setCompletedLeadKey] = useState("");
  const [deskSearch, setDeskSearch] = useState("");
  const [article, setArticle] = useState<number | null>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const messageId = useRef(0);
  const leadKey = `${draft.leadName}:${draft.leadPhone}:${draft.leadEmail}:${draft.forcedLead}`;
  const hasLeadFields = draft.leadName || draft.leadPhone || draft.leadEmail;
  const leadCompleted = completedLeadKey === leadKey;
  const leadBlocked = draft.forcedLead && (!hasLeadFields || !leadCompleted);
  const available = draft.enabled && (draft.chatbot || draft.serviceDesk);
  const shownTab =
    activeTab === "chat" && draft.chatbot
      ? "chat"
      : activeTab === "desk" && draft.serviceDesk
        ? "desk"
        : draft.chatbot
          ? "chat"
          : "desk";

  useEffect(() => {
    if (messageListRef.current)
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [messages.length]);

  const send = (text: string) => {
    const value = text.trim();
    if (!value || !available || !draft.chatbot || leadBlocked) return;
    const reply =
      draft.customPromptEnabled && draft.customPrompt.trim()
        ? "已参考当前自定义 Prompt 配置。您可以查看帮助中心的使用指南，或在服务台查找更多说明。这是本地演示回答。"
        : "您好！您可以通过帮助中心查看使用指南、配置小部件，或在服务台查找更多说明。这是本地演示回答。";
    setMessages((current) => [
      ...current,
      { id: ++messageId.current, role: "user", text: value },
      { id: ++messageId.current, role: "assistant", text: reply },
    ]);
    setInput("");
  };

  const newConversation = () => {
    setMessages([]);
    setInput("");
    setLeadValues({ name: "", phone: "", email: "" });
    setCompletedLeadKey("");
    setLeadErrors({});
    setArticle(null);
    setDeskSearch("");
  };

  const submitLead = (event: FormEvent) => {
    event.preventDefault();
    const errors = validateLead(draft, leadValues);
    setLeadErrors(errors);
    if (Object.keys(errors).length || !hasLeadFields) return;
    setCompletedLeadKey(leadKey);
    toast.success(
      draft.leadNotification
        ? "联系方式已保存在本地，已模拟留资通知"
        : "联系方式已保存在本地预览",
    );
  };

  const leadForm =
    hasLeadFields && !leadCompleted ? (
      <form
        className="hl-widget-lead-form"
        aria-label="预览留资表单"
        onSubmit={submitLead}
        noValidate
      >
        <strong>
          {draft.forcedLead ? "请先留下您的联系方式" : "留下联系方式"}
        </strong>
        {draft.leadDescription && <p>{draft.leadDescription}</p>}
        {(
          [
            {
              key: "name",
              enabled: draft.leadName,
              label: "名称",
              type: "text",
            },
            {
              key: "phone",
              enabled: draft.leadPhone,
              label: "手机号",
              type: "tel",
            },
            {
              key: "email",
              enabled: draft.leadEmail,
              label: "邮箱",
              type: "email",
            },
          ] as const
        )
          .filter((field) => field.enabled)
          .map((field) => (
            <label key={field.key} className="hl-widget-lead-input">
              <span>
                {field.label}
                <i aria-hidden="true">*</i>
              </span>
              <input
                className="hl-input"
                aria-label={`预览${field.label}`}
                aria-invalid={Boolean(leadErrors[field.key])}
                type={field.type}
                value={leadValues[field.key]}
                autoComplete="off"
                placeholder={`请输入${field.label}`}
                onChange={(event) => {
                  setLeadValues((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }));
                  setLeadErrors((current) => ({
                    ...current,
                    [field.key]: undefined,
                  }));
                }}
              />
              {leadErrors[field.key] && (
                <span role="alert" className="hl-widget-error">
                  {leadErrors[field.key]}
                </span>
              )}
            </label>
          ))}
        <button className="hl-widget-lead-submit" type="submit">
          提交
        </button>
      </form>
    ) : null;

  return (
    <aside className="hl-widget-preview-column" aria-label="小部件实时预览">
      <h3 className="hl-widget-preview-title">AI 小部件</h3>
      <div
        className="hl-widget-preview-stage"
        data-position={draft.position}
        data-site-display={draft.siteDisplay}
        style={{ "--hl-widget-theme": draft.theme } as CSSProperties}
      >
        {draft.siteDisplay && (
          <span className="hl-widget-site-label">站点内已显示</span>
        )}
        {!available ? (
          <div className="hl-widget-unavailable" role="status">
            <MessageCircle size={34} strokeWidth={1.2} />
            <strong>
              {draft.enabled ? "请开启服务台或问答机器人" : "小部件已关闭"}
            </strong>
            <span>
              {draft.enabled
                ? "开启后即可在此预览"
                : "开启小部件开关后恢复预览"}
            </span>
          </div>
        ) : (
          <>
            {previewOpen && (
              <section className="hl-widget-chat-card" aria-label="聊天小部件">
                <header className="hl-widget-chat-header">
                  <div
                    className="hl-widget-chat-tabs"
                    role="tablist"
                    aria-label="小部件功能"
                  >
                    {draft.chatbot && (
                      <button
                        role="tab"
                        aria-selected={shownTab === "chat"}
                        type="button"
                        onClick={() => setActiveTab("chat")}
                      >
                        <MessageSquare size={16} />
                        问答
                      </button>
                    )}
                    {draft.serviceDesk && (
                      <button
                        role="tab"
                        aria-selected={shownTab === "desk"}
                        type="button"
                        onClick={() => setActiveTab("desk")}
                      >
                        <BookOpen size={16} />
                        服务台
                      </button>
                    )}
                  </div>
                  <div className="hl-widget-chat-title">
                    <span>
                      {draft.avatar && (
                        <img src={draft.avatar.dataUrl} alt="预览机器人头像" />
                      )}
                      <strong>{draft.name.trim() || "Chatbot"}</strong>
                    </span>
                    <button
                      type="button"
                      aria-label="新对话"
                      title="新对话"
                      onClick={newConversation}
                    >
                      <Plus size={23} strokeWidth={1.4} />
                    </button>
                  </div>
                </header>
                <div className="hl-widget-chat-body" ref={messageListRef}>
                  {shownTab === "chat" ? (
                    <>
                      <div className="hl-widget-message hl-widget-message--assistant">
                        <p>
                          {draft.welcome.trim() ||
                            "欢迎咨询，请输入您想查询的问题~"}
                        </p>
                        {draft.welcomeImage && (
                          <img
                            className="hl-widget-welcome-image"
                            src={draft.welcomeImage.dataUrl}
                            alt="预览欢迎图片"
                          />
                        )}
                      </div>
                      {leadForm}
                      {draft.forcedLead && !hasLeadFields && (
                        <p className="hl-widget-gate-notice" role="status">
                          请先在留资配置中开启一个留资字段。
                        </p>
                      )}
                      <div
                        className="hl-widget-messages"
                        role="log"
                        aria-label="问答消息"
                        aria-live="polite"
                      >
                        {messages.map((message) => (
                          <div
                            className={`hl-widget-message hl-widget-message--${message.role}`}
                            key={message.id}
                          >
                            <p>{message.text}</p>
                            {message.role === "assistant" &&
                              draft.showSources && (
                                <button
                                  className="hl-widget-source"
                                  type="button"
                                  onClick={() => {
                                    if (draft.serviceDesk) {
                                      setActiveTab("desk");
                                      setArticle(0);
                                    } else
                                      toast.info(
                                        "来源：本地演示帮助中心 · 使用指南",
                                      );
                                  }}
                                >
                                  <BookOpen size={12} />
                                  来源：帮助中心 · 使用指南
                                </button>
                              )}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      {leadForm}
                      {leadBlocked ? (
                        <p className="hl-widget-gate-notice">
                          提交联系方式后即可查看帮助内容。
                        </p>
                      ) : article !== null ? (
                        <div className="hl-widget-desk-article">
                          <button
                            type="button"
                            onClick={() => setArticle(null)}
                          >
                            <ChevronLeft size={14} />
                            返回服务台
                          </button>
                          <h4>{DEMO_ARTICLES[article].title}</h4>
                          <p>{DEMO_ARTICLES[article].content}</p>
                        </div>
                      ) : (
                        <div className="hl-widget-desk">
                          <h4>您好，需要什么帮助？</h4>
                          <div className="hl-widget-desk-search">
                            <Search size={15} />
                            <input
                              aria-label="搜索帮助内容"
                              placeholder="搜索帮助内容"
                              value={deskSearch}
                              onChange={(event) =>
                                setDeskSearch(event.target.value)
                              }
                            />
                          </div>
                          <span>常见问题</span>
                          {DEMO_ARTICLES.map((item, index) => ({
                            ...item,
                            index,
                          }))
                            .filter((item) =>
                              item.title.includes(deskSearch.trim()),
                            )
                            .map((item) => (
                              <button
                                type="button"
                                key={item.title}
                                onClick={() => setArticle(item.index)}
                              >
                                <BookOpen size={15} />
                                {item.title}
                                <ChevronRight size={14} />
                              </button>
                            ))}
                          {!DEMO_ARTICLES.some((item) =>
                            item.title.includes(deskSearch.trim()),
                          ) && (
                            <p className="hl-widget-no-results">
                              没有找到相关内容
                            </p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {shownTab === "chat" && (
                  <form
                    className="hl-widget-composer"
                    aria-label="发送预览消息"
                    onSubmit={(event) => {
                      event.preventDefault();
                      send(input);
                    }}
                  >
                    <textarea
                      aria-label="请输入信息"
                      placeholder={
                        leadBlocked ? "请先提交联系方式" : "请输入信息..."
                      }
                      value={input}
                      disabled={leadBlocked}
                      rows={2}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          send(input);
                        }
                      }}
                    />
                    <button
                      type="submit"
                      aria-label="发送"
                      disabled={!input.trim() || leadBlocked}
                    >
                      <Send size={20} strokeWidth={1.4} />
                    </button>
                  </form>
                )}
                <div className="hl-widget-powered">
                  <span>Powered by</span>
                  <span className="hl-widget-brand-mark" aria-hidden="true">
                    <i />
                    <i />
                  </span>
                  <span>FrontMind</span>
                </div>
              </section>
            )}
            <button
              className={`hl-widget-launcher${draft.sidebar && !previewOpen ? " hl-widget-launcher--sidebar" : ""}`}
              type="button"
              aria-label={previewOpen ? "收起小部件" : "打开小部件"}
              aria-expanded={previewOpen}
              onClick={() => onPreviewOpenChange(!previewOpen)}
            >
              {draft.sidebar && !previewOpen ? (
                <>
                  <MessageCircle size={18} />
                  <span>帮助</span>
                </>
              ) : draft.icon ? (
                <img src={draft.icon.dataUrl} alt="预览机器人图标" />
              ) : previewOpen ? (
                <ChevronDown size={29} strokeWidth={1.6} />
              ) : (
                <MessageCircle size={25} strokeWidth={1.5} />
              )}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

export default function WidgetSettingsWorkspace({
  tab,
  onTabChange,
  active = true,
}: {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  active?: boolean;
}) {
  const [draft, setDraft] = useState<SettingsDraft>(() => ({
    ...INITIAL_DRAFT,
  }));
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [errors, setErrors] = useState<{
    name?: string;
    customPrompt?: string;
    leads?: string;
  }>({});
  const [previewOpen, setPreviewOpen] = useState(true);
  const settingsFormRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !Object.values(errors).some(Boolean)) return;
    const invalidField = settingsFormRef.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"], .hl-widget-error[role="alert"]',
    );
    invalidField?.scrollIntoView?.({ block: "nearest" });
    if (invalidField?.matches("input, textarea"))
      invalidField.focus({ preventScroll: true });
  }, [active, errors, tab]);
  const localShareAddress =
    typeof window === "undefined"
      ? "/?view=content-insights&contentModule=settings&contentTab=basic"
      : `${window.location.origin}/?view=content-insights&contentModule=settings&contentTab=basic`;

  const patch = <Key extends keyof SettingsDraft>(
    key: Key,
    value: SettingsDraft[Key],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (key === "name" || key === "customPrompt")
      setErrors((current) => ({ ...current, [key]: undefined }));
    if (key.startsWith("lead") || key === "forcedLead")
      setErrors((current) => ({ ...current, leads: undefined }));
    if (key === "sidebar") setPreviewOpen(!value);
  };

  const save = () => {
    const nextErrors: typeof errors = {};
    if (!draft.name.trim()) nextErrors.name = "请输入机器人名称";
    if (draft.customPromptEnabled && !draft.customPrompt.trim())
      nextErrors.customPrompt = "请输入自定义 Prompt";
    if (
      (draft.forcedLead || draft.leadNotification) &&
      !(draft.leadName || draft.leadPhone || draft.leadEmail)
    )
      nextErrors.leads = "请至少开启名称、手机号或邮箱中的一个留资字段";
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.customPrompt) {
      onTabChange("basic");
      toast.error("请完善基础配置后保存");
      return;
    }
    if (nextErrors.leads) {
      onTabChange("leads");
      toast.error("请完善留资配置后保存");
      return;
    }
    setSavedSnapshot(JSON.stringify(draft));
    toast.success("小部件设置已保留在本次预览");
  };

  return (
    <section className="hl-widget-settings" aria-label="AI 小部件设置">
      <div className="hl-widget-settings-panel">
        <div className="hl-widget-settings-form" ref={settingsFormRef}>
          <h2 className="hl-widget-settings-title">
            配置小部件 - 您的应用内帮助助手
          </h2>
          <p className="hl-widget-settings-subtitle">
            使用帮助助手提供即时支持，还可以允许用户进行搜索快速查找
          </p>
          <ToggleField
            label="小部件开关"
            hint="关闭后，所有形式分享的小部件都将失效"
            checked={draft.enabled}
            onChange={(value) => patch("enabled", value)}
          />
          <Tabs.Root
            value={tab}
            onValueChange={(value) => onTabChange(value as SettingsTab)}
            className="hl-widget-settings-tabs"
          >
            <Tabs.List className="hl-widget-tab-list" aria-label="小部件设置">
              {SETTINGS_TABS.map((item) => (
                <Tabs.Trigger
                  key={item.value}
                  value={item.value}
                  className="hl-widget-tab"
                >
                  {item.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <Tabs.Content value="basic" className="hl-widget-tab-content">
              <div
                className="hl-widget-form-scroll"
                aria-label="基础配置表单"
                tabIndex={0}
              >
                <ToggleField
                  label="服务台"
                  hint="显示知识库内容，支持用户自助查询"
                  checked={draft.serviceDesk}
                  onChange={(value) => patch("serviceDesk", value)}
                />
                <ToggleField
                  label="问答机器人"
                  hint="基于知识库内容的实时问答，提供客户支持"
                  checked={draft.chatbot}
                  onChange={(value) => patch("chatbot", value)}
                />
                <ToggleField
                  label="站点内显示"
                  hint="开启后，小部件在站点前台显示"
                  checked={draft.siteDisplay}
                  onChange={(value) => patch("siteDisplay", value)}
                />
                <div className="hl-widget-image-columns hl-widget-form-item">
                  <HlField label="机器人图标" hint="建议尺寸为100 * 100">
                    <ImagePicker
                      label="机器人图标"
                      value={draft.icon}
                      onChange={(value) => patch("icon", value)}
                    />
                  </HlField>
                  <HlField label="机器人头像" hint="建议尺寸为100 * 100">
                    <ImagePicker
                      label="机器人头像"
                      value={draft.avatar}
                      onChange={(value) => patch("avatar", value)}
                    />
                  </HlField>
                </div>
                <div className="hl-widget-form-item">
                  <HlField label="机器人名称">
                    <input
                      className="hl-input"
                      aria-label="机器人名称"
                      aria-invalid={Boolean(errors.name)}
                      placeholder="请输入机器人名称"
                      value={draft.name}
                      onChange={(event) => patch("name", event.target.value)}
                    />
                    {errors.name && (
                      <span role="alert" className="hl-widget-error">
                        {errors.name}
                      </span>
                    )}
                  </HlField>
                </div>
                <div className="hl-widget-form-item">
                  <HlField label="欢迎语">
                    <textarea
                      className="hl-input hl-widget-welcome-input"
                      aria-label="欢迎语"
                      placeholder="请输入欢迎语"
                      value={draft.welcome}
                      onChange={(event) => patch("welcome", event.target.value)}
                    />
                    <ImagePicker
                      label="欢迎图片"
                      value={draft.welcomeImage}
                      onChange={(value) => patch("welcomeImage", value)}
                      welcome
                    />
                  </HlField>
                </div>
                <ToggleField
                  label="回答是否显示来源"
                  checked={draft.showSources}
                  onChange={(value) => patch("showSources", value)}
                />
                <div className="hl-widget-form-item">
                  <HlField label="小部件位置">
                    <HlSelect
                      key={active ? "active-position" : "inactive-position"}
                      label="小部件位置"
                      value={draft.position}
                      options={[
                        { value: "bottom-right", label: "右下方" },
                        { value: "bottom-left", label: "左下方" },
                      ]}
                      onChange={(value) =>
                        patch("position", value as SettingsDraft["position"])
                      }
                    />
                  </HlField>
                </div>
                <ToggleField
                  label="收起为侧边栏"
                  checked={draft.sidebar}
                  onChange={(value) => patch("sidebar", value)}
                />
                <div className="hl-widget-form-item">
                  <HlField label="主题颜色">
                    <input
                      className="hl-widget-color"
                      type="color"
                      aria-label="主题颜色"
                      value={draft.theme}
                      onChange={(event) => patch("theme", event.target.value)}
                    />
                  </HlField>
                </div>
                <ToggleField
                  label="自定义Prompt"
                  checked={draft.customPromptEnabled}
                  onChange={(value) => patch("customPromptEnabled", value)}
                />
                {draft.customPromptEnabled && (
                  <div className="hl-widget-form-item">
                    <HlField label="自定义 Prompt 内容">
                      <textarea
                        className="hl-input"
                        aria-label="自定义 Prompt 内容"
                        placeholder="请输入机器人的回答要求"
                        value={draft.customPrompt}
                        aria-invalid={Boolean(errors.customPrompt)}
                        onChange={(event) =>
                          patch("customPrompt", event.target.value)
                        }
                      />
                      {errors.customPrompt && (
                        <span className="hl-widget-error" role="alert">
                          {errors.customPrompt}
                        </span>
                      )}
                      <span className="hl-widget-hint">
                        在当前预览中模拟应用回答要求
                      </span>
                    </HlField>
                  </div>
                )}
              </div>
            </Tabs.Content>
            <Tabs.Content value="leads" className="hl-widget-tab-content">
              <div
                className="hl-widget-form-scroll"
                aria-label="留资配置表单"
                tabIndex={0}
              >
                <ToggleField
                  label="名称"
                  checked={draft.leadName}
                  onChange={(value) => patch("leadName", value)}
                />
                <ToggleField
                  label="手机号"
                  checked={draft.leadPhone}
                  onChange={(value) => patch("leadPhone", value)}
                />
                <ToggleField
                  label="邮箱"
                  checked={draft.leadEmail}
                  onChange={(value) => patch("leadEmail", value)}
                />
                <ToggleField
                  label="留资通知"
                  checked={draft.leadNotification}
                  onChange={(value) => patch("leadNotification", value)}
                />
                <ToggleField
                  label="强制留资"
                  hint="仅公开访问下可开启，开启后需要用户留资后方可使用小部件"
                  checked={draft.forcedLead}
                  onChange={(value) => patch("forcedLead", value)}
                />
                {errors.leads && (
                  <p
                    className="hl-widget-error hl-widget-form-item"
                    role="alert"
                  >
                    {errors.leads}
                  </p>
                )}
                <div className="hl-widget-form-item">
                  <HlField label="留资说明">
                    <textarea
                      className="hl-input hl-widget-lead-description"
                      aria-label="留资说明"
                      placeholder="请输入留资说明"
                      value={draft.leadDescription}
                      onChange={(event) =>
                        patch("leadDescription", event.target.value)
                      }
                    />
                  </HlField>
                </div>
              </div>
            </Tabs.Content>
            <Tabs.Content value="install" className="hl-widget-tab-content">
              <div
                className="hl-widget-form-scroll hl-widget-install"
                aria-label="安装代码示例"
                tabIndex={0}
              >
                <p>安装代码样式示例，正式接入后提供可用代码</p>
                <div className="hl-widget-code-wrap">
                  <pre>
                    <code>{LOCAL_INSTALL_CODE}</code>
                  </pre>
                  <HlButton
                    className="hl-widget-code-copy"
                    aria-label="复制安装代码"
                    onClick={() => void copyText(LOCAL_INSTALL_CODE)}
                  >
                    <Copy size={14} />
                    复制
                  </HlButton>
                </div>
                <h4>使用代码直接控制插件</h4>
                <div className="hl-widget-code-wrap">
                  <pre>
                    <code>
                      {
                        "FrontMindPreview.switchState(1) // 打开插件\nFrontMindPreview.switchState(0) // 关闭插件"
                      }
                    </code>
                  </pre>
                </div>
                <div className="hl-widget-code-actions">
                  <HlButton
                    onClick={() => setPreviewOpen(true)}
                    disabled={
                      !draft.enabled || !(draft.chatbot || draft.serviceDesk)
                    }
                  >
                    打开插件
                  </HlButton>
                  <HlButton onClick={() => setPreviewOpen(false)}>
                    关闭插件
                  </HlButton>
                </div>
                <p className="hl-widget-hint">
                  以上代码仅为本地展示示例。按钮只控制右侧预览。
                </p>
              </div>
            </Tabs.Content>
            <Tabs.Content value="share" className="hl-widget-tab-content">
              <div
                className="hl-widget-form-scroll"
                aria-label="分享地址"
                tabIndex={0}
              >
                <div className="hl-widget-share">
                  <input
                    className="hl-input"
                    aria-label="预览地址"
                    disabled
                    value={localShareAddress}
                  />
                  <HlButton
                    variant="primary"
                    onClick={() => void copyText(localShareAddress)}
                  >
                    复制
                  </HlButton>
                </div>
              </div>
            </Tabs.Content>
          </Tabs.Root>
          {(tab === "basic" || tab === "leads") && (
            <footer className="hl-widget-save-footer">
              {savedSnapshot && (
                <span role="status">
                  {savedSnapshot === JSON.stringify(draft)
                    ? "已保留在本次预览"
                    : "有未保存的修改"}
                </span>
              )}
              <HlButton variant="primary" onClick={save}>
                保存
              </HlButton>
            </footer>
          )}
        </div>
        <WidgetPreview
          draft={draft}
          previewOpen={previewOpen}
          onPreviewOpenChange={setPreviewOpen}
        />
      </div>
    </section>
  );
}
