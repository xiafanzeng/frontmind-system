/**
 * Product-level delivery catalog. It is returned by the server workspace
 * endpoint and never embedded in tenant-facing components or tenant payloads.
 * Tenant-specific availability is still determined by service entitlement.
 */
export const CONTENT_ASSET_CATALOG = Object.freeze([
  {
    id: "A1",
    code: "A1",
    group: "A",
    type: "品牌事实内容",
    label: "企业资料与品牌事实",
    description: "整理企业简介、发展历程、资质荣誉等可核验的品牌事实。",
  },
  {
    id: "A2",
    code: "A2",
    group: "A",
    type: "案例内容",
    label: "用户案例与成功故事",
    description: "将项目背景、解决方案与量化成果整理为可信客户案例。",
  },
  {
    id: "B1",
    code: "B1",
    group: "B",
    type: "行业内容",
    label: "行业观点与趋势观察",
    description: "围绕行业变化、关键议题和专业判断形成深度观点内容。",
  },
  {
    id: "B2",
    code: "B2",
    group: "B",
    type: "产品内容",
    label: "产品能力与应用场景",
    description: "清晰说明产品能力、适用场景、使用方式与选择依据。",
  },
  {
    id: "C1",
    code: "C1",
    group: "C",
    type: "新闻内容",
    label: "企业新闻与动态",
    description: "发布企业进展、合作动态、活动信息与重要里程碑。",
  },
  {
    id: "D1",
    code: "D1",
    group: "D",
    type: "问答内容",
    label: "知乎问答",
    description: "围绕用户真实问题输出专业、自然且有事实支撑的回答。",
  },
] as const);

export const WEBSITE_CONTENT_CATALOG = Object.freeze([
  { value: "company_facts", label: "企业资料与品牌事实" },
  { value: "product_case_docs", label: "产品案例与文档" },
  { value: "industry_news", label: "行业新闻与观察" },
  { value: "company_news", label: "企业新闻与动态" },
  { value: "faq_content", label: "FAQ 与问答页面" },
] as const);

export const DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS = Object.freeze([
  "今日头条",
  "搜狐",
  "网易",
  "腾讯",
  "新浪",
  "百度",
  "中华网",
  "凤凰网",
  "微博",
] as const);

export const OVERSEAS_CONTENT_ASSET_MEDIA_OPTIONS = Object.freeze([
  "美联社",
  "今日美国",
  "雅虎",
  "Business Insider",
  "Barchart",
] as const);

export const ALL_CONTENT_ASSET_MEDIA_OPTIONS = Object.freeze([
  ...DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS,
  ...OVERSEAS_CONTENT_ASSET_MEDIA_OPTIONS,
] as const);

/** Backward-compatible alias for existing domestic-edition callers. */
export const CONTENT_ASSET_MEDIA_OPTIONS = DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS;

export function contentAssetMediaOptionsForMarketEdition(
  marketEdition: "domestic" | "overseas",
) {
  return marketEdition === "overseas"
    ? OVERSEAS_CONTENT_ASSET_MEDIA_OPTIONS
    : DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS;
}

export const ICP_PROVINCES = Object.freeze([
  "北京",
  "天津",
  "河北",
  "山西",
  "内蒙古",
  "辽宁",
  "吉林",
  "黑龙江",
  "上海",
  "江苏",
  "浙江",
  "安徽",
  "福建",
  "江西",
  "山东",
  "河南",
  "湖北",
  "湖南",
  "广东",
  "广西",
  "海南",
  "重庆",
  "四川",
  "贵州",
  "云南",
  "西藏",
  "陕西",
  "甘肃",
  "青海",
  "宁夏",
  "新疆",
] as const);
