export const SITE_TABS = [
  "站点信息",
  "SEO配置",
  "自定义域名",
  "多语言配置",
  "嵌入代码",
  "文章",
  "栏目",
  "搜索",
  "通知",
] as const;
export type SiteTab = (typeof SITE_TABS)[number];
export type PortalSection =
  | "站点设置"
  | "导航栏"
  | "主页"
  | "页脚"
  | "AI友好官网";
export type PortalDraft = {
  version: 1;
  name: string;
  language: string;
  editor: string;
  theme: string;
  defaultTheme: string;
  template: string;
  layout: string;
  icon: string;
  logo: string;
  darkLogo: string;
  heroBackground: string;
  sloganColor: string;
  title: string;
  keywords: string;
  description: string;
  domain: string;
  filing: string;
  path: string;
  languages: string[];
  headCode: string;
  navCode: string;
  footerBackground: string;
  footerColor: string;
  cssCode: string;
  anchor: string;
  categoryView: string;
  searchStyle: string;
  prompt: string;
  email: string;
  feedbackEmail: string;
  navMode: string;
  navBackground: string;
  navText: string;
  accent: string;
  logoLink: string;
  slogan: string;
  footerText: string;
  footerCopyright: string;
  navigation: { id: string; title: string; url: string }[];
  flags: Record<string, boolean>;
};
export function createPortalDraft(): PortalDraft {
  return {
    version: 1,
    name: "品牌知识中心",
    language: "中文-ZH",
    editor: "富文本编辑器",
    theme: "浅色或深色",
    defaultTheme: "浅色",
    template: "InfoHub",
    layout: "居中",
    icon: "",
    logo: "",
    darkLogo: "",
    heroBackground: "",
    sloganColor: "#ffffff",
    title: "品牌知识中心",
    keywords: "",
    description: "",
    domain: "",
    filing: "阿里云备案",
    path: "",
    languages: ["中文-ZH"],
    headCode: "",
    navCode: "",
    footerBackground: "#f8faff",
    footerColor: "#8d96a7",
    cssCode: "",
    anchor: "随机数",
    categoryView: "卡片视图",
    searchStyle: "默认样式",
    prompt: "",
    email: "",
    feedbackEmail: "",
    navMode: "表单配置",
    navBackground: "#ffffff",
    navText: "#303133",
    accent: "#2563eb",
    logoLink: "",
    slogan: "探索知识，找到答案",
    footerText: "",
    footerCopyright: "",
    navigation: [
      { id: "home", title: "首页", url: "/" },
      { id: "articles", title: "知识文章", url: "/articles" },
    ],
    flags: {
      indexing: true,
      quickPage: true,
      slug: true,
      feedback: true,
      tags: true,
      aiSearch: true,
      manualAI: true,
      weeklyReport: true,
      feedbackNotify: true,
      footer: false,
    },
  };
}
export const portalDraftKey = (ownerId: string | number, projectId: string) =>
  `frontmind.portal.v1:${ownerId}:${projectId}`;
export function readPortalDraft(key: string): PortalDraft {
  const defaults = createPortalDraft();
  try {
    const input: unknown = JSON.parse(localStorage.getItem(key) || "null");
    if (
      !input ||
      typeof input !== "object" ||
      (input as PortalDraft).version !== 1
    )
      return defaults;
    const value = input as Partial<PortalDraft>;
    for (const name of Object.keys(defaults) as Array<keyof PortalDraft>) {
      if (
        typeof defaults[name] === "string" &&
        typeof value[name] === "string" &&
        (value[name] as string).length <
          (["icon", "logo", "darkLogo", "heroBackground"].includes(name)
            ? 1400000
            : 200000)
      ) {
        (defaults as unknown as Record<string, unknown>)[name] = value[name];
      }
    }
    if (value.flags && typeof value.flags === "object")
      defaults.flags = Object.fromEntries(
        Object.entries(value.flags).filter(([, v]) => typeof v === "boolean"),
      );
    if (Array.isArray(value.languages))
      defaults.languages = value.languages
        .filter((v) => typeof v === "string")
        .slice(0, 20);
    if (Array.isArray(value.navigation))
      defaults.navigation = value.navigation
        .filter(
          (v) =>
            v &&
            typeof v.id === "string" &&
            typeof v.title === "string" &&
            typeof v.url === "string",
        )
        .slice(0, 20);
  } catch {
    /* Corrupt or unavailable local storage starts an empty project draft. */
  }
  for (const name of ["icon", "logo", "darkLogo", "heroBackground"] as const) {
    if (
      !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(
        defaults[name],
      )
    )
      defaults[name] = "";
  }
  return defaults;
}
export function portalDraftErrors(value: PortalDraft): string[] {
  const errors: string[] = [];
  if (!value.name.trim()) errors.push("请填写站点名称");
  if (!value.title.trim()) errors.push("请填写网站标题");
  if (
    value.domain.trim() &&
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
      value.domain.trim(),
    )
  )
    errors.push("域名仅填写主机名，例如 docs.example.com");
  for (const email of [value.email, value.feedbackEmail])
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      errors.push("请填写有效的接收邮箱");
  if (value.logoLink && !safePortalLink(value.logoLink))
    errors.push("Logo跳转地址需为站内路径或 http(s) 地址");
  if (value.navigation.some((v) => !v.title.trim() || !safePortalLink(v.url)))
    errors.push("导航名称不能为空，链接需为站内路径或 http(s) 地址");
  return [...new Set(errors)];
}
export function safePortalLink(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\"))
    return true;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
