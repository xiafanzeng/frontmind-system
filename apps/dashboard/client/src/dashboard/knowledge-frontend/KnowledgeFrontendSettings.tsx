import { useWorkspaceDraftGuard } from "@/lib/workspace-navigation-guard";
import {
  useBusinessWorkspace,
  useBusinessWorkspaceSummary,
} from "../BusinessWorkspaceContext";
import { useRef, useState, type ReactNode } from "react";
import {
  useBusinessFlowState,
  readFlowString,
  readFlowBoolean,
} from "../useBusinessFlowState";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Code2,
  ExternalLink,
  FileText,
  Globe2,
  Home,
  ImagePlus,
  LayoutTemplate,
  Monitor,
  PanelTop,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  portalDraftErrors,
  portalDraftKey,
  readPortalDraft,
  parsePortalDraft,
  SITE_TABS,
  type PortalDraft,
  type PortalSection,
  type SiteTab,
} from "./settings-state";
import "./knowledge-frontend.css";

const languages = [
  "中文-ZH",
  "英文-EN",
  "繁体-TW",
  "葡萄牙语-PT",
  "俄语-RU",
  "越南语-VI",
  "德语-DE",
  "法语-FR",
  "西班牙语-ES",
  "日语-JA",
  "韩语-KO",
];
const templates = [
  "InfoHub",
  "GuideMe",
  "产品说明书",
  "名词术语",
  "企业博客-1",
  "企业博客-2",
  "企业博客3",
  "个人博客",
];
const articleFlags = [
  ["quickPage", "快捷翻页"],
  ["author", "显示作者"],
  ["toc", "客户端目录默认展开"],
  ["breadcrumbs", "文章显示面包屑导航"],
  ["slug", "文章地址根据标题生成"],
  ["privateShare", "文章私密分享"],
  ["share", "显示分享按钮"],
  ["qr", "扫码查看"],
  ["feedback", "文章帮助反馈"],
  ["watermark", "文章水印"],
  ["noCopy", "文章禁止复制"],
  ["tags", "显示文章标签"],
  ["download", "支持用户下载文章"],
] as const;

function Field({
  label,
  hint,
  children,
  required = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <div className="kf-field">
      <span className="kf-label">
        {required && <i>*</i>}
        {label}
      </span>
      {hint && <small>{hint}</small>}
      {children}
    </div>
  );
}
function Choices({
  label,
  values,
  value,
  onChange,
}: {
  label: string;
  values: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="kf-choices" role="radiogroup" aria-label={label}>
      {values.map((v) => (
        <label key={v} className={value === v ? "is-selected" : ""}>
          <input
            type="radio"
            name={label}
            checked={value === v}
            onChange={() => onChange(v)}
          />
          {v}
        </label>
      ))}
    </div>
  );
}
function TemplateMiniature({ variant = 0 }: { variant?: number }) {
  return (
    <div
      className={`kf-miniature kf-miniature-${variant % 4}`}
      aria-hidden="true"
    >
      <div className="kf-mini-nav">
        <span />
        <i />
        <i />
        <i />
      </div>
      <div className="kf-mini-hero">
        <b />
        <span />
      </div>
      <div className="kf-mini-columns">
        {[0, 1, 2].map((v) => (
          <div key={v}>
            <i />
            <b />
            <span />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}
function PortalPreview({ draft }: { draft: PortalDraft }) {
  return (
    <div
      className={`kf-preview ${draft.defaultTheme === "深色" ? "is-dark" : ""} ${draft.layout === "居中" ? "is-centered" : ""} kf-preview-template-${templates.indexOf(draft.template) % 4}`}
      style={{ "--portal-accent": draft.accent } as React.CSSProperties}
    >
      <header style={{ background: draft.navBackground, color: draft.navText }}>
        <strong>
          {(
            draft.defaultTheme === "深色"
              ? draft.darkLogo || draft.logo
              : draft.logo
          ) ? (
            <img
              src={
                draft.defaultTheme === "深色"
                  ? draft.darkLogo || draft.logo
                  : draft.logo
              }
              alt="草稿Logo"
            />
          ) : (
            <BookOpen size={22} />
          )}{" "}
          {draft.name}
        </strong>
        <nav>
          {draft.navigation.map((item) => (
            <span key={item.id}>{item.title}</span>
          ))}
        </nav>
      </header>
      <div
        className="kf-preview-hero"
        style={{
          backgroundColor: draft.accent,
          color: draft.sloganColor,
          ...(draft.heroBackground
            ? {
                backgroundImage: `url(${draft.heroBackground})`,
                backgroundSize: "cover",
              }
            : {}),
        }}
      >
        <span>KNOWLEDGE CENTER</span>
        <h2>{draft.slogan || draft.name}</h2>
        <div>
          <Search size={17} />
          搜索文章，发现答案 <kbd>⌘ K</kbd>
        </div>
      </div>
      <div className="kf-preview-articles">
        {["开始使用", "产品与服务", "常见问题"].map((title, i) => (
          <article key={title}>
            <span>
              <BookOpen size={24} />
            </span>
            <h3>{title}</h3>
            <p>
              {
                [
                  "了解品牌与产品，快速开始",
                  "探索功能介绍与使用指南",
                  "查找常见问题的解答",
                ][i]
              }
            </p>
            <small>本地预览 · 示例栏目</small>
          </article>
        ))}
      </div>
      {draft.flags.footer && (
        <footer
          style={{
            background: draft.footerBackground,
            color: draft.footerColor,
          }}
        >
          <b>{draft.footerText || draft.name}</b>
          <span>{draft.footerCopyright || "本地预览页脚"}</span>
        </footer>
      )}
    </div>
  );
}
export type KnowledgeFrontendSettingsProps = {
  ownerId?: string | number;
  projectId?: string;
  legacyWorkflow?: ReactNode;
  publishedContent?: ReactNode;
  demo?: boolean;
};
export default function KnowledgeFrontendSettings(
  props: KnowledgeFrontendSettingsProps,
) {
  const scope = portalDraftKey(
    props.ownerId ?? "demo",
    props.projectId ?? "demo",
  );
  return <SettingsWorkspace key={scope} {...props} scope={scope} />;
}
function portalDraftFingerprint(draft: PortalDraft) {
  const copy = { ...draft };
  for (const field of ["icon", "logo", "darkLogo", "heroBackground"] as const) {
    let hash = 2166136261;
    for (let i = 0; i < draft[field].length; i++)
      hash = Math.imul(hash ^ draft[field].charCodeAt(i), 16777619);
    copy[field] = `${draft[field].length}:${hash >>> 0}`;
  }
  return JSON.stringify(copy);
}
function SettingsWorkspace({
  scope,
  legacyWorkflow,
  publishedContent,
  demo = false,
}: KnowledgeFrontendSettingsProps & { scope: string }) {
  const { isWorkbench, taskId } = useBusinessWorkspace();
  const [initialDraft] = useState(() => readPortalDraft(scope));
  const imageNamespace = useRef(crypto.randomUUID());
  const serializeDraft = (value: PortalDraft) => {
    const compact = { ...value };
    for (const field of [
      "icon",
      "logo",
      "darkLogo",
      "heroBackground",
    ] as const) {
      if (!value[field]) continue;
      const key = `${scope}:task-image:${taskId ?? imageNamespace.current}:${field}`;
      try {
        localStorage.setItem(key, value[field]);
        compact[field] = `local-image:${key}`;
      } catch {
        compact[field] = "";
        setMessage(
          "图片仍保留在当前页面，本地空间不足，刷新后需要重新添加图片。",
        );
      }
    }
    return compact;
  };
  const restoreDraft = (value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      (value as PortalDraft).version !== 1
    )
      return undefined;
    const restored = { ...value } as PortalDraft;
    for (const field of [
      "icon",
      "logo",
      "darkLogo",
      "heroBackground",
    ] as const) {
      const source = restored[field];
      if (typeof source === "string" && source.startsWith("local-image:")) {
        try {
          restored[field] = localStorage.getItem(source.slice(12)) || "";
        } catch {
          restored[field] = "";
        }
      }
    }
    return parsePortalDraft(restored);
  };
  const [entry, setEntry] = useBusinessFlowState<
    "build" | "settings" | "published"
  >("websiteEntry", "build", (value) =>
    value === "build" || value === "settings" || value === "published"
      ? value
      : undefined,
  );
  const [draft, setDraft] = useBusinessFlowState(
    "websiteDraft",
    initialDraft,
    restoreDraft,
    serializeDraft,
  );
  const [savedSnapshot, setSavedSnapshot] = useBusinessFlowState(
    "websiteSavedSnapshot",
    portalDraftFingerprint(initialDraft),
    readFlowString,
  );
  const [section, setSection] = useBusinessFlowState<PortalSection>(
    "websiteSection",
    "站点设置",
    (value) =>
      ["站点设置", "导航栏", "主页", "页脚", "AI友好官网"].includes(
        String(value),
      )
        ? (value as PortalSection)
        : undefined,
  );
  const [tab, setTab] = useBusinessFlowState<SiteTab>(
    "websiteTab",
    "站点信息",
    (value) =>
      SITE_TABS.includes(value as SiteTab) ? (value as SiteTab) : undefined,
  );
  const [websiteTab, setWebsiteTab] = useBusinessFlowState(
    "websiteBuildTab",
    "模板配置",
    readFlowString,
  );
  const [preview, setPreview] = useBusinessFlowState(
    "websitePreview",
    false,
    readFlowBoolean,
  );
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(true);
  const patch = <K extends keyof PortalDraft>(
    key: K,
    value: PortalDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
    setMessage("");
  };
  const textField = (
    key: keyof PortalDraft,
    label: string,
    placeholder = "",
    required = false,
  ) => (
    <Field label={label} required={required}>
      <input
        aria-label={label}
        value={String(draft[key])}
        onChange={(event) => patch(key, event.target.value as never)}
        placeholder={placeholder}
      />
    </Field>
  );
  const flag = (
    key: string,
    label: string,
    hint?: string,
    disabled = false,
  ) => (
    <div className="kf-toggle-field" key={key}>
      <div>
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={Boolean(draft.flags[key])}
        disabled={disabled}
        onClick={() =>
          patch("flags", { ...draft.flags, [key]: !draft.flags[key] })
        }
      >
        <span />
      </button>
    </div>
  );
  const color = (
    key:
      | "accent"
      | "navBackground"
      | "navText"
      | "footerBackground"
      | "footerColor"
      | "sloganColor",
    label: string,
  ) => (
    <Field label={label}>
      <div className="kf-color">
        <input
          type="color"
          aria-label={label}
          value={/^#[0-9a-f]{6}$/i.test(draft[key]) ? draft[key] : "#ffffff"}
          onChange={(e) => patch(key, e.target.value)}
        />
        <code>{draft[key]}</code>
      </div>
    </Field>
  );
  const imageUpload = (
    key: "icon" | "logo" | "darkLogo" | "heroBackground",
    label: string,
    hint: string,
  ) => (
    <Field label={label} hint={hint}>
      <label className="kf-upload">
        {draft[key] ? (
          <img src={draft[key]} alt={label} />
        ) : (
          <ImagePlus size={27} />
        )}
        <input
          type="file"
          aria-label={`上传${label}`}
          accept="image/png,image/jpeg,image/webp"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (
              !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
              file.size > 1024 * 1024
            ) {
              setMessage("请选择不超过1MB的PNG、JPEG或WebP图片");
              return;
            }
            const reader = new FileReader();
            reader.onload = () => patch(key, String(reader.result));
            reader.onerror = () => setMessage("图片读取失败");
            reader.readAsDataURL(file);
          }}
        />
        <span>{draft[key] ? "更换" : "上传"}</span>
      </label>
      {draft[key] && (
        <button
          type="button"
          className="kf-text-button"
          onClick={() => patch(key, "")}
        >
          移除图片
        </button>
      )}
    </Field>
  );
  const save = () => {
    const next = portalDraftErrors(draft);
    setErrors(next);
    if (next.length) {
      setMessage("请修正表单后保存");
      return false;
    }
    try {
      localStorage.setItem(scope, JSON.stringify(draft));
      setSaved(true);
      setSavedSnapshot(portalDraftFingerprint(draft));
      setMessage("当前项目的本地草稿已保存");
      return true;
    } catch {
      setMessage("本地空间不足或不可用，草稿尚未保存");
      return false;
    }
  };
  useWorkspaceDraftGuard({
    dirty: isWorkbench && portalDraftFingerprint(draft) !== savedSnapshot,
    label: "网站内容展示配置",
    save: async () => save(),
    discard: async () => {
      const restored = readPortalDraft(scope);
      setDraft(restored);
      setSavedSnapshot(portalDraftFingerprint(restored));
      return true;
    },
  });
  const templateGrid = (
    <div className="kf-template-grid">
      {templates.map((name, i) => (
        <button
          type="button"
          key={name}
          className={draft.template === name ? "is-selected" : ""}
          aria-pressed={draft.template === name}
          onClick={() => patch("template", name)}
        >
          <span>
            {name}
            {draft.template === name && <Check size={15} />}
          </span>
          <TemplateMiniature variant={i} />
          <small>
            模板示意 <span>选择模板</span>
          </small>
        </button>
      ))}
    </div>
  );
  const changeSection = (value: PortalSection) => {
    setSection(value);
    setErrors([]);
  };
  const entryNav = (
    <nav className="kf-workbench-entries" aria-label="网站管理任务入口">
      {(
        [
          ["build", "建站与部署"],
          ["settings", "配置内容展示"],
          ["published", "查看已发布内容"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={entry === value}
          onClick={() => setEntry(value)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
  if (isWorkbench && entry !== "settings")
    return (
      <section
        className="knowledge-frontend kf-conversation-flow"
        aria-label="网站管理"
      >
        {entryNav}
        {entry === "build" ? (
          legacyWorkflow || (
            <p className="kf-draft-notice">
              {demo
                ? "本地演示不连接真实建站服务。"
                : "当前项目暂无可用的官网工作流。"}
            </p>
          )
        ) : (
          <>
            <WebsiteConfigurationSummary
              title="已发布内容"
              status="真实内容记录"
            />
            <p className="kf-draft-notice">
              这里展示当前项目已有的发布内容；建站与部署使用独立的真实发布流程。
            </p>
            {publishedContent || <p>当前项目暂无已发布内容。</p>}
          </>
        )}
      </section>
    );
  return (
    <section
      className={`knowledge-frontend ${isWorkbench ? "kf-conversation-flow" : ""}`}
      aria-label="知识库前台设置"
    >
      {isWorkbench && (
        <>
          {entryNav}
          <WebsiteConfigurationSummary
            title={draft.name || "内容展示"}
            status={saved ? "本地草稿已保存" : "本地配置草稿"}
          />
        </>
      )}
      <header className="kf-topbar">
        {!isWorkbench && (
          <div>
            <Settings2 size={21} />
            <strong>知识库前台</strong>
            <span>站点与内容展示</span>
          </div>
        )}
        <button
          type="button"
          className="kf-button"
          onClick={() => setPreview(true)}
        >
          <ExternalLink size={15} />
          预览站点
        </button>
      </header>
      <div className="kf-draft-notice">
        {demo ? "本地演示" : "界面预览"} ·
        设置仅保存为当前项目本地草稿，发布流程待配置。
      </div>
      <div className="kf-shell">
        <aside className="kf-sidebar">
          <button
            className="kf-sidebar-heading"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            知识库前台{" "}
            <ChevronDown
              size={16}
              style={{ transform: expanded ? "" : "rotate(-90deg)" }}
            />
          </button>
          {expanded && (
            <>
              <button
                className={section === "站点设置" ? "is-active" : ""}
                onClick={() => changeSection("站点设置")}
              >
                <Settings2 size={17} />
                站点设置
              </button>
              <small>个性化配置</small>
              {(["导航栏", "主页", "页脚"] as const).map((item, i) => (
                <button
                  key={item}
                  className={section === item ? "is-active" : ""}
                  onClick={() => changeSection(item)}
                >
                  {i === 0 ? (
                    <PanelTop size={17} />
                  ) : i === 1 ? (
                    <Home size={17} />
                  ) : (
                    <LayoutTemplate size={17} />
                  )}{" "}
                  {item}
                </button>
              ))}
            </>
          )}
          <div className="kf-sidebar-divider" />
          <button
            className={section === "AI友好官网" ? "is-active" : ""}
            onClick={() => changeSection("AI友好官网")}
          >
            <Globe2 size={17} />
            AI友好官网
          </button>
          <div className="kf-sidebar-note">
            <BookOpen size={24} />
            <p>让知识成为你的品牌前台</p>
            <span>模板、内容与站点配置</span>
          </div>
        </aside>
        <div className="kf-main">
          {section === "站点设置" ? (
            <nav className="kf-tabs" role="tablist" aria-label="站点设置标签">
              {SITE_TABS.map((item) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === item}
                  aria-controls="kf-settings-panel"
                  tabIndex={tab === item ? 0 : -1}
                  onKeyDown={(event) => {
                    const index = SITE_TABS.indexOf(item);
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % SITE_TABS.length
                        : event.key === "ArrowLeft"
                          ? (index + SITE_TABS.length - 1) % SITE_TABS.length
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? SITE_TABS.length - 1
                              : -1;
                    if (next < 0) return;
                    event.preventDefault();
                    setTab(SITE_TABS[next]);
                    (
                      event.currentTarget.parentElement?.children[
                        next
                      ] as HTMLElement
                    )?.focus();
                  }}
                  key={item}
                  onClick={() => setTab(item)}
                >
                  {item}
                </button>
              ))}
            </nav>
          ) : (
            <header className="kf-section-heading">
              <h2>{section}</h2>
              <span>
                {section === "AI友好官网"
                  ? "从品牌知识库到可访问的官网"
                  : "个性化配置"}
              </span>
            </header>
          )}
          <div
            className="kf-scroll"
            id="kf-settings-panel"
            role="tabpanel"
            aria-label={section === "站点设置" ? tab : section}
          >
            {errors.length > 0 && (
              <div className="kf-errors" role="alert">
                {errors.map((error) => (
                  <p key={error}>{error}</p>
                ))}
              </div>
            )}
            {section === "站点设置" && tab === "站点信息" && (
              <>
                {imageUpload("icon", "站点icon", "建议尺寸为100 × 100")}
                {imageUpload("logo", "站点Logo", "导航栏的logo，建议比例8:3")}
                {textField("name", "站点名称", "请输入站点名称", true)}
                <Field label="站点语言" required>
                  <select
                    aria-label="站点语言"
                    value={draft.language}
                    onChange={(e) => patch("language", e.target.value)}
                  >
                    {languages.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </Field>
                <Field label="默认编辑器" required>
                  <Choices
                    label="默认编辑器"
                    values={["富文本编辑器", "Markdown编辑器"]}
                    value={draft.editor}
                    onChange={(value) => patch("editor", value)}
                  />
                </Field>
                <Field label="网站主题">
                  <Choices
                    label="网站主题"
                    values={["浅色或深色", "仅浅色", "仅深色"]}
                    value={draft.theme}
                    onChange={(value) => {
                      patch("theme", value);
                      if (value !== "浅色或深色")
                        patch("defaultTheme", value.slice(1));
                    }}
                  />
                </Field>
                {draft.theme === "浅色或深色" && (
                  <Field label="默认主题">
                    <Choices
                      label="默认主题"
                      values={["浅色", "深色"]}
                      value={draft.defaultTheme}
                      onChange={(value) => patch("defaultTheme", value)}
                    />
                  </Field>
                )}
                <Field label="站点模板" required>
                  {templateGrid}
                </Field>
                {flag("hideLogo", "隐藏技术支持Logo")}
                <Field label="网站布局">
                  <div className="kf-layout-options">
                    {["宽松", "居中"].map((value) => (
                      <button
                        type="button"
                        key={value}
                        className={draft.layout === value ? "is-selected" : ""}
                        aria-pressed={draft.layout === value}
                        onClick={() => patch("layout", value)}
                      >
                        <strong>{value}</strong>
                        <small>
                          {value === "宽松"
                            ? "布局宽松铺满屏幕，自适应用户分辨率"
                            : "布局紧凑且内容居中"}
                        </small>
                        <TemplateMiniature variant={value === "宽松" ? 0 : 1} />
                      </button>
                    ))}
                  </div>
                </Field>
              </>
            )}
            {section === "站点设置" && tab === "SEO配置" && (
              <>
                <p className="kf-info">
                  配置网站在搜索结果中的标题和介绍，帮助读者与AI了解你的品牌。
                </p>
                {flag("indexing", "搜索引擎收录")}
                <Field label="站点地图">
                  <input disabled value="配置发布流程后生成" />
                </Field>
                {textField(
                  "title",
                  "网站标题（标签页标题）",
                  "请输入网站标题",
                  true,
                )}
                {textField("keywords", "网站关键词", "多个关键词请用逗号隔开")}
                <Field label="网站描述">
                  <textarea
                    aria-label="网站描述"
                    rows={5}
                    value={draft.description}
                    onChange={(e) => patch("description", e.target.value)}
                  />
                </Field>
                <Field
                  label="百度站点验证Key"
                  hint="绑定域名并定义部署流程后配置"
                >
                  <input disabled placeholder="暂未接入" />
                </Field>
              </>
            )}
            {section === "站点设置" && tab === "自定义域名" && (
              <>
                <div className="kf-connection-state">
                  <Globe2 />
                  <div>
                    <strong>域名尚未连接</strong>
                    <p>先填写站点域名草稿，阿里云连接与发布流程待后续定义。</p>
                  </div>
                  <span>待接入</span>
                </div>
                <Field label="是否备案">
                  <Choices
                    label="是否备案"
                    values={["阿里云备案", "腾讯云备案", "未备案"]}
                    value={draft.filing}
                    onChange={(value) => patch("filing", value)}
                  />
                </Field>
                {textField("domain", "域名", "docs.example.com")}
                {textField("path", "访问路径", "例如 blog，可留空")}
                <button className="kf-button" disabled>
                  一键连接阿里云（待接入）
                </button>
              </>
            )}
            {section === "站点设置" && tab === "多语言配置" && (
              <>
                <p className="kf-info">为站点配置语言展示草稿。</p>
                {draft.languages.map((language, i) => (
                  <div className="kf-language-row" key={i}>
                    <span>{i === 0 ? "默认" : "语言"}</span>
                    <select
                      aria-label={`语言${i + 1}`}
                      value={language}
                      onChange={(e) =>
                        patch(
                          "languages",
                          draft.languages.map((v, n) =>
                            n === i ? e.target.value : v,
                          ),
                        )
                      }
                    >
                      {languages.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                    <input
                      value={draft.name}
                      readOnly
                      aria-label={`语言${i + 1}站点`}
                    />
                    <button
                      aria-label={`删除语言${i + 1}`}
                      className="kf-icon-button"
                      disabled={i === 0}
                      onClick={() =>
                        patch(
                          "languages",
                          draft.languages.filter((_, n) => n !== i),
                        )
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <button
                  className="kf-button"
                  disabled={draft.languages.length >= languages.length}
                  onClick={() =>
                    patch("languages", [
                      ...draft.languages,
                      languages.find((v) => !draft.languages.includes(v)) ||
                        "英文-EN",
                    ])
                  }
                >
                  <Plus size={15} />
                  添加语言
                </button>
              </>
            )}
            {section === "站点设置" && tab === "嵌入代码" && (
              <>
                <p className="kf-info">
                  为后续客服插件、访问统计和样式配置保存代码草稿。预览不会执行代码。
                </p>
                <Field label="Head头部代码">
                  <textarea
                    aria-label="Head头部代码"
                    className="kf-code"
                    rows={9}
                    value={draft.headCode}
                    onChange={(e) => patch("headCode", e.target.value)}
                    placeholder="输入代码草稿"
                  />
                </Field>
                <Field label="CSS代码">
                  <textarea
                    aria-label="CSS代码"
                    className="kf-code"
                    rows={9}
                    value={draft.cssCode}
                    onChange={(e) => patch("cssCode", e.target.value)}
                    placeholder="输入CSS代码"
                  />
                </Field>
              </>
            )}
            {section === "站点设置" && tab === "文章" && (
              <>
                {articleFlags.map(([key, label]) => flag(key, label))}
                <Field label="锚点名称">
                  <Choices
                    label="锚点名称"
                    values={["随机数", "按标题生成"]}
                    value={draft.anchor}
                    onChange={(value) => patch("anchor", value)}
                  />
                </Field>
                {flag("readers", "显示阅读者", "授权访问流程待接入", true)}
                {flag(
                  "articleNotification",
                  "文章发布通知",
                  "消息通知流程待接入",
                  true,
                )}
              </>
            )}
            {section === "站点设置" && tab === "栏目" && (
              <>
                <Field label="视图">
                  <Choices
                    label="栏目视图"
                    values={["卡片视图", "列表视图"]}
                    value={draft.categoryView}
                    onChange={(value) => patch("categoryView", value)}
                  />
                </Field>
                {flag("cover", "显示封面")}
              </>
            )}
            {section === "站点设置" && tab === "搜索" && (
              <>
                <Field label="搜索样式">
                  <Choices
                    label="搜索样式"
                    values={["默认样式", "当前位置展开"]}
                    value={draft.searchStyle}
                    onChange={(value) => patch("searchStyle", value)}
                  />
                </Field>
                {flag("titlesOnly", "仅搜索标题")}
                {flag("advancedSearch", "高级搜索")}
                <hr />
                {flag("aiSearch", "AI搜索")}
                {flag("aiFirst", "优先展示AI搜索")}
                {flag("manualAI", "AI搜索手动触发")}
                {flag("customPrompt", "自定义Prompt")}
                {draft.flags.customPrompt && (
                  <Field label="搜索Prompt">
                    <textarea
                      aria-label="搜索Prompt"
                      value={draft.prompt}
                      onChange={(e) => patch("prompt", e.target.value)}
                      rows={5}
                    />
                  </Field>
                )}
              </>
            )}
            {section === "站点设置" && tab === "通知" && (
              <>
                {flag("weeklyReport", "数据周报")}
                {textField("email", "数据周报接收邮箱", "name@example.com")}
                {flag("feedbackNotify", "文章反馈")}
                {textField(
                  "feedbackEmail",
                  "文章反馈接收邮箱",
                  "name@example.com",
                )}
                <p className="kf-info">当前保存通知偏好草稿，暂不发送邮件。</p>
              </>
            )}
            {section === "导航栏" && (
              <>
                <div className="kf-mode-row">
                  <Choices
                    label="导航配置方式"
                    values={["表单配置", "代码块配置"]}
                    value={draft.navMode}
                    onChange={(v) => patch("navMode", v)}
                  />
                </div>
                {draft.navMode === "代码块配置" ? (
                  <Field label="导航栏代码草稿">
                    <textarea
                      className="kf-code"
                      aria-label="导航栏代码草稿"
                      value={draft.navCode}
                      rows={12}
                      onChange={(e) => patch("navCode", e.target.value)}
                    />
                  </Field>
                ) : (
                  <div className="kf-personal-grid">
                    <div>
                      {imageUpload(
                        "logo",
                        "浅色模式Logo",
                        "导航栏logo，建议比例8:3",
                      )}
                      {imageUpload(
                        "darkLogo",
                        "深色模式Logo",
                        "导航栏logo，建议比例8:3",
                      )}
                      {color("navBackground", "导航栏背景色")}
                      {color("navText", "文本颜色")}
                      {color("accent", "文本选中颜色")}
                      {textField(
                        "logoLink",
                        "Logo跳转地址",
                        "输入http地址，为空跳转站点首页",
                      )}
                    </div>
                    <div className="kf-navigation-editor">
                      <h3>导航菜单</h3>
                      {draft.navigation.map((item, i) => (
                        <div key={item.id}>
                          <input
                            aria-label={`菜单${i + 1}名称`}
                            value={item.title}
                            onChange={(e) =>
                              patch(
                                "navigation",
                                draft.navigation.map((v) =>
                                  v.id === item.id
                                    ? { ...v, title: e.target.value }
                                    : v,
                                ),
                              )
                            }
                          />
                          <input
                            aria-label={`菜单${i + 1}链接`}
                            value={item.url}
                            onChange={(e) =>
                              patch(
                                "navigation",
                                draft.navigation.map((v) =>
                                  v.id === item.id
                                    ? { ...v, url: e.target.value }
                                    : v,
                                ),
                              )
                            }
                          />
                          <span>
                            {[
                              [-1, ArrowUp],
                              [1, ArrowDown],
                            ].map(([delta, Icon]) => {
                              const n = delta as number;
                              const I = Icon as typeof ArrowUp;
                              return (
                                <button
                                  type="button"
                                  key={n}
                                  className="kf-icon-button"
                                  disabled={
                                    i + n < 0 ||
                                    i + n >= draft.navigation.length
                                  }
                                  aria-label={`${n < 0 ? "上移" : "下移"}菜单${i + 1}`}
                                  onClick={() => {
                                    const next = [...draft.navigation];
                                    [next[i], next[i + n]] = [
                                      next[i + n],
                                      next[i],
                                    ];
                                    patch("navigation", next);
                                  }}
                                >
                                  <I size={14} />
                                </button>
                              );
                            })}
                            <button
                              className="kf-icon-button"
                              aria-label={`删除菜单${i + 1}`}
                              onClick={() =>
                                patch(
                                  "navigation",
                                  draft.navigation.filter(
                                    (v) => v.id !== item.id,
                                  ),
                                )
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </span>
                        </div>
                      ))}
                      <button
                        className="kf-button"
                        onClick={() =>
                          patch("navigation", [
                            ...draft.navigation,
                            {
                              id: crypto.randomUUID(),
                              title: "新菜单",
                              url: "/",
                            },
                          ])
                        }
                      >
                        <Plus size={15} />
                        新增菜单
                      </button>
                    </div>
                  </div>
                )}
                <PortalPreview draft={draft} />
              </>
            )}
            {section === "主页" && (
              <>
                <div className="kf-personal-grid kf-home-grid">
                  <div className="kf-home-options">
                    <details open>
                      <summary>主页设置</summary>
                      <div>
                        {color("accent", "主题色")}
                        {textField("slogan", "主页标语", "自定义主页标语")}
                        {color("sloganColor", "标语颜色")}
                        {imageUpload(
                          "heroBackground",
                          "背景图片",
                          "用于主页标语区域，PNG、JPEG或WebP",
                        )}
                      </div>
                    </details>
                    <details>
                      <summary>快速入门</summary>
                      <div>{flag("quickStart", "开启快速入门")}</div>
                    </details>
                    <details>
                      <summary>推荐文章</summary>
                      <div>{flag("recommendedArticles", "开启推荐文章")}</div>
                    </details>
                    <details>
                      <summary>热门搜索</summary>
                      <div>{flag("hotSearch", "开启热门搜索")}</div>
                    </details>
                  </div>
                  <div className="kf-preview-frame">
                    <Monitor size={16} /> 桌面预览
                    <PortalPreview draft={draft} />
                  </div>
                </div>
              </>
            )}
            {section === "页脚" && (
              <>
                {flag("footer", "启用页脚")}
                <fieldset disabled={!draft.flags.footer}>
                  {textField("footerText", "页脚标语", "请输入页脚标语")}
                  {textField("footerCopyright", "版权说明", "请输入版权说明")}
                  {color("footerBackground", "页脚背景色")}
                  {color("footerColor", "页脚文本颜色")}
                </fieldset>
                <PortalPreview draft={draft} />
              </>
            )}
            {section === "AI友好官网" && (
              <>
                <div className="kf-website-intro">
                  <span>
                    <Globe2 size={30} />
                  </span>
                  <div>
                    <h2>用品牌知识搭建你的官网</h2>
                    <p>选择模板、整理文章，再连接域名。</p>
                  </div>
                  <span className="kf-status-pill">流程待定义</span>
                </div>
                <nav className="kf-inner-tabs" aria-label="官网管理标签">
                  {["模板配置", "文章管理", "域名与部署", "现有工作流"].map(
                    (v) => (
                      <button
                        aria-pressed={websiteTab === v}
                        key={v}
                        onClick={() => setWebsiteTab(v)}
                      >
                        {v}
                      </button>
                    ),
                  )}
                </nav>
                {websiteTab === "模板配置" && (
                  <>
                    <div className="kf-stepper">
                      {["模板与品牌", "文章与栏目", "域名与访问"].map(
                        (v, i) => (
                          <div key={v}>
                            <b>{i + 1}</b>
                            <span>{v}</span>
                          </div>
                        ),
                      )}
                    </div>
                    <p className="kf-info">
                      以下为模板配置预览。自建WordPress模板及发布方式将在流程确定后接入。
                    </p>
                    {templateGrid}
                    <button
                      className="kf-button"
                      onClick={() => setPreview(true)}
                    >
                      <ExternalLink size={15} />
                      预览所选模板
                    </button>
                  </>
                )}
                {websiteTab === "文章管理" && (
                  <>
                    <div className="kf-content-heading">
                      <h3>官网文章</h3>
                      <button className="kf-button" disabled>
                        <Plus size={15} />
                        更新文章（待接入）
                      </button>
                    </div>
                    {publishedContent || (
                      <div className="kf-empty">
                        <FileText size={35} />
                        <h3>准备你的品牌文章</h3>
                        <p>
                          后续可从知识库与内容制作选择文章，并更新到WordPress站点。
                        </p>
                      </div>
                    )}
                  </>
                )}
                {websiteTab === "域名与部署" && (
                  <>
                    <div className="kf-connection-state">
                      <Globe2 />
                      <div>
                        <strong>{draft.domain || "尚未设置域名"}</strong>
                        <p>阿里云连接、域名验证与正式发布尚未接入。</p>
                      </div>
                      <span>待接入</span>
                    </div>
                    <button
                      className="kf-button"
                      onClick={() => {
                        setSection("站点设置");
                        setTab("自定义域名");
                      }}
                    >
                      填写域名草稿
                    </button>
                    <button className="kf-button" disabled>
                      连接阿里云
                    </button>
                  </>
                )}
                {websiteTab === "现有工作流" &&
                  (legacyWorkflow || (
                    <div className="kf-empty">
                      <Code2 size={30} />
                      <p>
                        {demo
                          ? "本地演示不连接现有官网工作流"
                          : "当前项目暂无可用的官网工作流"}
                      </p>
                    </div>
                  ))}
              </>
            )}
          </div>
          <footer className="kf-savebar">
            <span role="status">
              {message || (saved ? "本地草稿已保存" : "草稿与当前企业项目绑定")}
            </span>
            <button
              type="button"
              className="kf-button"
              onClick={() => {
                setDraft(readPortalDraft(scope));
                setErrors([]);
                setMessage("已恢复到上次保存的草稿");
              }}
            >
              还原草稿
            </button>
            <button
              type="button"
              className="kf-button kf-primary"
              onClick={save}
            >
              {saved ? <Check size={15} /> : null}保存草稿
            </button>
          </footer>
        </div>
      </div>
      {isWorkbench && preview && (
        <section className="kf-inline-preview" aria-label="站点配置预览">
          <h3>站点预览 · {draft.template}</h3>
          <p>使用本地示例栏目预览布局，设置尚未发布到域名。</p>
          <button
            type="button"
            className="kf-button"
            onClick={() => setPreview(false)}
          >
            收起预览
          </button>
          <PortalPreview draft={draft} />
        </section>
      )}
      <Dialog open={!isWorkbench && preview} onOpenChange={setPreview}>
        <DialogContent className="kf-preview-dialog">
          <DialogTitle>站点预览 · {draft.template}</DialogTitle>
          <DialogDescription>
            使用本地示例栏目预览布局；设置尚未发布到域名。
          </DialogDescription>
          <PortalPreview draft={draft} />
        </DialogContent>
      </Dialog>
    </section>
  );
}

function WebsiteConfigurationSummary({
  title,
  status,
}: {
  title: string;
  status: string;
}) {
  useBusinessWorkspaceSummary({
    items: [
      { label: "当前站点", value: title },
      { label: "保存状态", value: status },
      { label: "部署状态", value: "本地展示配置与建站部署分别管理" },
    ],
  });
  return null;
}
