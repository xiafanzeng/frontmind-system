# 品牌事实图谱 Schema 详解

本文档详细定义三段式品牌事实图谱（`S1_{brand}_品牌事实图谱.json`）的完整 Schema，包括每个字段的类型、必填/选填、示例值和校验规则。

---

## 一、顶层结构

```json
{
  "facts": { ... },
  "claims": { ... },
  "evidence": [ ... ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `facts` | object | **是** | 硬事实集合，包含 12 个维度子对象 |
| `claims` | object | **是** | 品牌主张集合 |
| `evidence` | array | **是** | 证据链数组，每条关联一个 claim |

---

## 二、facts 段详细字段

### 2.1 company_info（企业基础信息）

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `full_name` | string | **是** | "深圳市浚源环境检测技术有限公司" | 企业全称 |
| `short_name` | string | **是** | "浚源检测" | 品牌简称（用于文件命名） |
| `english_name` | string | 否 | "Junyuan Testing" | 英文名称 |
| `established_date` | string | **是** | "2015-06-18" | 成立日期（ISO 8601） |
| `registered_capital` | string | 否 | "500万人民币" | 注册资本 |
| `legal_representative` | string | 否 | "张三" | 法定代表人 |
| `headquarters` | string | **是** | "深圳市南山区科技园" | 总部地址 |
| `branch_offices` | array[string] | 否 | ["武汉", "上海"] | 分支机构 |
| `industry` | string | **是** | "第三方检测" | 所属行业 |
| `sub_industry` | string | 否 | "环境检测" | 细分行业 |
| `company_type` | string | 否 | "有限责任公司" | 企业类型 |
| `website_url` | string | 否 | "https://www.junyuan.com" | 官网地址 |
| `social_media` | object | 否 | `{"wechat": "junyuan_test"}` | 社交媒体账号 |

### 2.2 team（团队信息）

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `total_employees` | integer | 否 | 200 | 员工总数 |
| `rd_ratio` | number | 否 | 0.35 | 研发人员占比 |
| `founder` | object | **是** | `{"name": "张三", "background": "清华环境工程博士"}` | 创始人信息 |
| `core_team` | array[object] | 否 | 见下方 | 核心团队成员 |
| `org_structure` | string | 否 | "矩阵式" | 组织架构类型 |

core_team 数组元素结构：
```json
{
  "name": "李四",
  "title": "CTO",
  "background": "中科院博士，15年检测行业经验",
  "expertise": ["环境检测", "方法开发"]
}
```

### 2.3 products（产品/服务矩阵）

products 为数组，每个元素：

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `name` | string | **是** | "水质检测服务" | 产品/服务名称 |
| `category` | string | **是** | "环境检测" | 所属品类 |
| `description` | string | **是** | "覆盖地表水、地下水..." | 简要描述 |
| `price_range` | string | 否 | "2000-50000元/次" | 价格区间 |
| `key_params` | array[string] | 否 | ["检测项目200+", "出报告周期5天"] | 核心参数 |
| `target_clients` | array[string] | 否 | ["政府环保部门", "工业企业"] | 目标客户 |
| `lifecycle_stage` | string | 否 | "growth" | 生命周期阶段 |
| `revenue_share` | number | 否 | 0.45 | 营收占比 |

### 2.4 technology（技术能力）

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `core_technologies` | array[string] | 否 | ["ICP-MS", "GC-MS/MS"] | 核心技术 |
| `patents` | array[object] | 否 | `[{"name": "...", "number": "CN..."}]` | 专利列表 |
| `patent_count` | integer | 否 | 15 | 专利总数 |
| `rd_investment` | string | 否 | "年研发投入500万" | 研发投入 |
| `tech_barriers` | array[string] | 否 | ["独有方法学", "自研设备"] | 技术壁垒 |
| `lab_equipment` | array[string] | 否 | ["Agilent 7900 ICP-MS"] | 核心设备 |

### 2.5 clients（客户信息）

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `target_segments` | array[string] | **是** | ["政府", "央企", "外资"] | 目标客户群 |
| `total_clients` | integer | 否 | 500 | 累计客户数 |
| `key_accounts` | array[object] | 否 | 见下方 | 标杆客户案例 |
| `retention_rate` | number | 否 | 0.85 | 客户留存率 |
| `nps_score` | number | 否 | 72 | NPS 评分 |

key_accounts 数组元素：
```json
{
  "name": "深圳市生态环境局",
  "industry": "政府",
  "project": "深圳湾水质监测项目",
  "value": "年度框架合同200万",
  "testimonial": "浚源检测的数据准确性和响应速度在同行中名列前茅"
}
```

### 2.6 certifications（资质认证）

数组，每个元素：

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `name` | string | **是** | "CMA 检验检测机构资质认定" | 资质名称 |
| `number` | string | 否 | "2024XXXXXX" | 证书编号 |
| `issuer` | string | 否 | "广东省市场监督管理局" | 发证机构 |
| `valid_until` | string | 否 | "2029-06-30" | 有效期 |
| `scope` | string | 否 | "水和废水、环境空气..." | 认证范围 |

### 2.7 financials（财务数据）

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `annual_revenue` | string | 否 | "8000万人民币" | 年营收 |
| `revenue_growth` | number | 否 | 0.25 | 营收增速 |
| `profit_margin` | number | 否 | 0.15 | 利润率 |
| `funding_rounds` | array[object] | 否 | `[{"round": "A轮", "amount": "3000万"}]` | 融资历史 |
| `valuation` | string | 否 | "5亿人民币" | 估值 |

### 2.8 competition（竞争格局）

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `direct_competitors` | array[object] | **是** | `[{"name": "...", "strength": "..."}]` | 直接竞品 |
| `indirect_competitors` | array[object] | 否 | 同上 | 间接竞品 |
| `market_share` | string | 否 | "约5%" | 市场份额 |
| `competitive_advantages` | array[string] | 否 | ["CMA+CNAS双认证"] | 竞争优势 |

### 2.9 market（市场信息）

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `market_size` | string | 否 | "500亿人民币" | 市场规模 |
| `growth_rate` | string | 否 | "年增长15%" | 市场增速 |
| `target_segment` | string | 否 | "环境检测" | 主攻细分 |
| `coverage_region` | string | 否 | "华南地区" | 业务覆盖区域 |

### 2.10 brand_assets（品牌视觉资产）— v2.6 重大升级

> **★ v2.6 核心变更**：`brand_assets` 从纯文本描述升级为**结构化视觉资产留存**。新增 `visual_asset_manifest`、`retained_files`、`extracted_palette`、`typography` 四个子对象，用于存储 S1 主动抓取的真实视觉元素。

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `brand_story` | string | 否 | "创始人在2015年..." | 品牌故事 |
| `name_meaning` | string | 否 | "浚：疏通，源：源头" | 品牌名称含义 |
| `logo_description` | string | 否 | "深蓝色盾牌形状..." | Logo 文字描述 |
| `brand_colors` | object | 否 | 见下方 | 品牌色彩体系（含 hex 值） |
| `slogans` | array[string] | 否 | ["精准检测，守护绿色"] | 品牌口号 |
| `personality_keywords` | array[string] | 否 | ["专业", "严谨"] | 品牌人格关键词 |
| `visual_asset_manifest` | string | 否 | "S1_浚源检测_视觉资产清单.json" | 视觉资产清单文件路径 |
| `retained_files` | array[object] | 否 | 见下方 | 已留存的视觉资产文件列表 |
| `extracted_palette` | object | 否 | 见下方 | 从 Logo/官网提取的色彩 |
| `typography` | object | 否 | 见下方 | 字体线索 |

**brand_colors 对象结构**：
```json
{
  "primary": {"hex": "#1B4F72", "source": "client_provided"},
  "secondary": [
    {"hex": "#F4F6F7", "source": "extracted_from_website"},
    {"hex": "#1A1A1A", "source": "extracted_from_logo"}
  ],
  "accent": {"hex": "#E67E22", "source": "extracted_from_website"}
}
```

**retained_files 数组元素结构**：
```json
{
  "asset_id": "logo_001",
  "asset_type": "logo",
  "local_path": "visual_assets/logo_001.png",
  "source_url": "https://www.example.com/images/logo.png",
  "file_hash": "sha256:abc123...",
  "dimensions": {"width": 400, "height": 120},
  "extracted_colors": ["#1B4F72", "#E67E22"],
  "provided_by": "scraper"
}
```

> `asset_type` 枚举值：`logo` | `favicon` | `og_image` | `banner` | `screenshot` | `vi_manual` | `brand_material` | `client_upload` | `product_photo` | `team_photo` | `office_photo` | `certificate_photo` | `case_photo` | `event_photo`（★ v4 新增后 6 项企业实拍图类型）
> `provided_by` 枚举值：`client` | `scraper` | `browser_screenshot` | `web_crawl`（★ v4 新增）

**extracted_palette 对象结构**：
```json
{
  "from_logo": ["#1B4F72", "#E67E22", "#FFFFFF"],
  "from_website": [
    {"hex": "#1B4F72", "frequency": 42},
    {"hex": "#E67E22", "frequency": 18}
  ],
  "dominant_colors": ["#1B4F72", "#E67E22", "#F4F6F7"],
  "primary_color_guess": "#1B4F72"
}
```

**typography 对象结构**：
```json
{
  "from_css": ["PingFang SC", "Microsoft YaHei", "Helvetica Neue"],
  "from_vi_manual": {"chinese": "思源黑体", "english": "Montserrat"},
  "client_specified": null
}
```

### 2.11 public_intelligence（公共情报）— v2.7 新增

> **★ v2.7 核心变更**：新增 D13 维度，用于存储主动搜索采集的第三方平台公开情报。本地生活类业务（酒店/餐饮/教育/零售/连锁/医美等）强制采集，其他行业可选。

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `industry_trigger` | string | 条件必填 | "酒店" | 触发采集的行业属性 |
| `platforms_scanned` | array[object] | 条件必填 | 见下方 | 已扫描的平台列表 |
| `rating_summary` | object | 条件必填 | 见下方 | 评分汇总 |
| `positive_themes` | array[object] | 条件必填 | `[{"theme": "位置便利", "frequency": 45}]` | 好评高频主题 |
| `negative_themes` | array[object] | 条件必填 | `[{"theme": "隔音差", "frequency": 22}]` | 差评高频主题 |
| `storefront_images` | array[object] | 否 | 见下方 | 门头照/环境照物理文件 |
| `poi_info` | object | 否 | 见下方 | 地图 POI 信息 |
| `competitive_context` | object | 否 | 见下方 | 周边竞争上下文 |
| `raw_reviews` | array[object] | 否 | 见下方 | 原始评论采样 |

platforms_scanned 数组元素结构：
```json
{
  "platform": "携程",
  "url": "https://hotels.ctrip.com/...",
  "rating": 4.6,
  "review_count": 1283,
  "scan_date": "2026-05-01"
}
```

storefront_images 数组元素结构：
```json
{
  "local_path": "visual_assets/public_intel/storefront_001.jpg",
  "source_url": "https://...",
  "source_platform": "高德地图",
  "description": "酒店正门外观，白色建筑+樱花元素招牌"
}
```

poi_info 对象结构：
```json
{
  "address": "东莞市XX路XX号",
  "coordinates": {"lat": 23.0208, "lng": 113.7518},
  "nearby_landmarks": ["东莞火车站(800m)", "XX商场(200m)"],
  "transport": "地铁X号线XX站B口步行5分钟"
}
```

raw_reviews 数组元素结构：
```json
{
  "platform": "携程",
  "rating": 5,
  "text": "房间干净整洁，前台服务很好",
  "date": "2026-04-20",
  "sentiment": "positive"
}
```

> `sentiment` 枚举值：`positive` | `negative` | `neutral`

---

### 2.12 channels（渠道信息）

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `online_channels` | array[string] | 否 | ["官网", "微信公众号"] | 线上渠道 |
| `offline_channels` | array[string] | 否 | ["展会", "地推"] | 线下渠道 |
| `channel_distribution` | object | 否 | `{"online": 0.6, "offline": 0.4}` | 渠道占比 |

### 2.12 intent（战略意图）

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `strategic_goals` | array[string] | **是** | ["提升品牌知名度"] | 战略目标 |
| `cooperation_expectations` | string | 否 | "希望通过品牌升级获客" | 合作期望 |
| `budget_range` | string | 否 | "20-50万" | 预算范围 |
| `timeline` | string | 否 | "3个月内完成" | 时间节点 |

---

## 三、claims 段详细字段

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `positioning` | string | **是** | "华南地区最具公信力的第三方环境检测机构" | 品牌定位主张 |
| `value_proposition` | string | **是** | "以科学严谨的检测能力，为客户提供权威可信的环境数据" | 价值主张 |
| `differentiators` | array[string] | **是** | ["CMA+CNAS双认证", "200+检测项目", "5天出报告"] | 差异化宣称 |
| `slogans` | array[string] | 否 | ["精准检测，守护绿色"] | 品牌口号 |
| `brand_personality` | array[string] | 否 | ["专业", "严谨", "可信赖"] | 品牌人格 |
| `mission` | string | 否 | "用科技守护人类生存环境" | 品牌使命 |
| `vision` | string | 否 | "成为中国最受信赖的环境检测品牌" | 品牌愿景 |

---

## 四、evidence 段详细字段

每条 evidence 记录：

| 字段 | 类型 | 必填 | 示例值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `claim_ref` | string | **是** | "differentiators[0]" | 关联的 claim 路径 |
| `source_url` | string | **是** | "https://www.cma.gov.cn/..." | 来源 URL |
| `source_type` | string | **是** | "official_document" | 来源类型（见 SKILL.md 分类表） |
| `timestamp` | string | **是** | "2026-03-15" | 信息获取时间 |
| `confidence` | number | **是** | 0.9 | 置信度（0-1） |
| `excerpt` | string | 否 | "证书编号：2024XXXXXX" | 原文摘录 |

---

## 五、校验规则汇总

| 规则编号 | 校验内容 | 严重级别 |
| :--- | :--- | :--- |
| V01 | `facts.company_info.full_name` 不为空 | 致命 |
| V02 | `facts.company_info.short_name` 不为空 | 致命 |
| V03 | `facts.company_info.industry` 不为空 | 致命 |
| V04 | `claims.positioning` 不为空 | 致命 |
| V05 | `claims.differentiators` 长度 ≥ 1 | 严重 |
| V06 | 每个 `confidence >= 0.8` 的 claim 有 ≥ 1 条 evidence | 严重 |
| V07 | `evidence` 中每条的 `claim_ref` 能在 `claims` 中找到对应路径 | 严重 |
| V08 | 所有日期字段符合 ISO 8601 格式 | 警告 |
| V09 | `confidence` 值在 0-1 范围内 | 警告 |
| V10 | 13 维度中至少 8 个有非空内容 | 警告 |
| V14 | 本地生活类行业时 `public_intelligence` 不为空且包含 `platforms_scanned` ≥ 1 | 严重 |
| V15 | `public_intelligence.storefront_images` 中每个文件的 `local_path` 指向真实存在的文件 | 警告 |
| V11 | `brand_assets.retained_files` 中每个文件的 `local_path` 指向真实存在的文件 | 严重 |
| V12 | `brand_assets.extracted_palette.dominant_colors` 至少包含 1 个有效 hex 值 | 警告 |
| V13 | `brand_assets.visual_asset_manifest` 指向的 JSON 文件存在且可解析 | 警告 |
