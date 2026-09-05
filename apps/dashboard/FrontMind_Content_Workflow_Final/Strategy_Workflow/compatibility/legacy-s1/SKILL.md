---
name: frontmind-brand-knowledge-base
description: >
  S1 品牌资产知识库（策略层第 1 位 / 事实底稿中心）。从散乱企业资料构建结构化品牌事实图谱，
  并主动抓取与留存企业视觉资产（Logo/Favicon/配色/字体/截图），
  作为全工作流的事实底稿与视觉约束源。
  输出三段式 JSON 事实图谱 + 人类可读知识库 + 缺口报告 + 视觉资产清单。
  适用场景：当用户提供品牌/企业资料并要求构建品牌知识库或事实图谱时触发。
---

# 品牌资产知识库 (Brand Knowledge Base)

从散乱企业资料中提取、验证、结构化品牌信息，构建全工作流共享的**品牌事实图谱**。

> **★ v2.6 核心升级**：新增 **Stage A-2 视觉资产抓取与留存**流程。S1 不再仅依赖客户口头描述品牌视觉元素，而是**主动抓取企业官网的 Logo、Favicon、OG 图片、配色、字体等视觉资产**，以物理文件形式留存，并将结构化元数据写入事实图谱的 `brand_assets` 字段。这些真实视觉资产将作为 S7 视觉符号体系和 E3 视觉资产生成师的**刚性约束输入**，从根本上解决"纯文本盲绘"导致的品牌视觉失真问题。

**上游**：客户原始资料（散乱文件 / 信息收集模板 / 口头描述）
**下游**：
- `S1_{brand}_品牌事实图谱.json` + `S1_{brand}_品牌知识库.md` （PDF 由 S0 统一生成） → S2/S3/S4/S5/S6/S8/S9
- `S1_{brand}_视觉资产清单.json` + `visual_assets/` 目录 → **S7 视觉符号体系**（视觉约束源）
- `S1_{brand}_知识库缺口报告.md` → S0 编排师

---

## 标准输入输出文件

**输入文件**：

| 输入项 | 文件名规范 | 来源 | 必要性 |
| :--- | :--- | :--- | :--- |
| 客户原始资料 | 任意格式（PDF/PPT/Word/Excel/图片/链接等） | 用户上传 | **必须**（至少提供品牌名） |
| 信息收集模板填写结果 | `{brand}_信息收集表.md` 或口头描述 | 用户提供 | 建议（参见 `references/info-collection-template.md`） |
| 客户访谈录音转写 | `.txt` / `.md` | 用户提供 | 可选 |
| 历史 deck / 财报 / 媒体稿 | 任意格式 | 用户提供 | 可选 |
| **客户提供的 Logo/VI 文件** | **AI/EPS/SVG/PNG 等** | **用户上传** | **强烈建议** |
| 外部监测层事实修正建议 | `external_feedback_to_S1.json` | 外部投放/监测层 | 可选（迭代轮次） |

**输出文件**：

| 输出物 | 文件名规范 | 格式 | 下游消费者 |
| :--- | :--- | :--- | :--- |
| 品牌事实图谱 | `S1_{brand}_品牌事实图谱.json` | JSON | S2/S3/S4/S5/S6/S7/S8/S9（全链路） |
| 品牌知识库 | `S1_{brand}_品牌知识库.md` | Markdown | S2/S3/S4（人类可读版） |
| 品牌知识库（PDF） | `S1_{brand}_品牌知识库.pdf` | PDF | 操作者、客户 |
| 知识库缺口报告 | `S1_{brand}_知识库缺口报告.md` | Markdown | S0 编排师（暂停1展示给用户） |
| **视觉资产清单** | **`S1_{brand}_视觉资产清单.json`** | **JSON** | **S7 视觉符号体系、E3 视觉资产生成师** |
| **视觉资产文件目录** | **`visual_assets/`** | **PNG/SVG/ICO 等** | **S7/E3（物理图片文件）** |

> ```bash
> ```

---

## 核心升级：三段式品牌事实图谱

与原 Agent 0 的简单知识库不同，S1 输出的事实图谱采用**三段式结构**，将品牌信息分为事实、主张和证据三个层次：

### 三段式 Schema 概览

```json
{
  "facts": {
    "company_info": { "... 硬事实 ..." },
    "team": { "... 团队信息 ..." },
    "products": [ "... 产品线 ..." ],
    "technology": { "... 技术能力 ..." },
    "clients": [ "... 客户案例 ..." ],
    "certifications": [ "... 资质认证 ..." ],
    "financials": { "... 财务数据 ..." },
    "channels": { "... 渠道信息 ..." },
    "market": { "... 市场信息 ..." },
    "competition": { "... 竞争格局 ..." },
    "brand_assets": {
      "brand_story": "...",
      "logo_description": "...",
      "brand_colors": { "primary": {"hex": "#1B4F72", "source": "extracted_from_logo"} },
      "slogans": ["..."],
      "personality_keywords": ["..."],
      "visual_asset_manifest": "S1_{brand}_视觉资产清单.json",
      "retained_files": [
        {
          "asset_id": "logo_001",
          "asset_type": "logo",
          "local_path": "visual_assets/logo_001.png",
          "source_url": "https://...",
          "file_hash": "sha256:...",
          "dimensions": {"width": 400, "height": 120},
          "extracted_colors": ["#1B4F72", "#E67E22"],
          "provided_by": "scraper"
        }
      ],
      "extracted_palette": {
        "from_logo": ["#1B4F72"],
        "from_website": [{"hex": "#1B4F72", "frequency": 42}],
        "dominant_colors": ["#1B4F72", "#E67E22"],
        "primary_color_guess": "#1B4F72"
      },
      "typography": {
        "from_css": ["PingFang SC", "Helvetica Neue"],
        "from_vi_manual": null,
        "client_specified": null
      }
    },
    "intent": { "... 战略意图 ..." }
  },
  "claims": { "..." },
  "evidence": [ "..." ]
}
```

> **详细 Schema 说明**：参见 `references/brand-facts-schema.md`，包含每个字段的类型、必填/选填、示例值和校验规则。

### 三段之间的关系

| 段 | 名称 | 内容 | 特征 |
| :--- | :--- | :--- | :--- |
| `facts` | 硬事实 | 可验证的客观信息（团队规模、产品参数、资质编号等） | 不含主观判断 |
| `claims` | 品牌主张 | 品牌自己声称的定位、价值、差异化 | 需要证据支撑 |
| `evidence` | 证据链 | 每条 claim 的来源、时间戳、置信度 | 连接 facts 和 claims |

---

## 绝对禁止事项

1. **禁止编造事实**：所有 `facts` 段的信息必须来自客户提供的资料或公开可验证的来源。如果信息不确定，必须在 `evidence` 中标注 `confidence < 0.5`。
2. **禁止遗漏证据**：每条 `claims` 中的主张必须在 `evidence` 中有至少一条对应记录。无证据的主张必须标注为"待验证"。
3. **禁止跳过缺口报告**：即使客户资料非常完整，也必须生成缺口报告（可标注"无重大缺口"）。
4. **禁止跳过视觉资产抓取**：即使客户已提供 Logo 文件，也必须执行官网视觉资产抓取流程（Stage A-2），以获取完整的配色、字体和截图信息。客户提供的文件优先级高于抓取结果，但两者均需留存。

---

## 核心要求：思维链（CoT）与垂直行业适配

在执行信息提取时，必须在思考过程中显式输出以下思维链（CoT）：
1. **行业属性识别**：判断品牌所属的垂直行业（如 SaaS、电商、大健康、ToB 制造等）。
2. **垂直知识映射**：根据行业属性，激活特定的提取逻辑（见下表）。
3. **交叉验证**：对比不同资料来源中的冲突信息，说明采信理由。

**垂直行业特定提取逻辑（示例）**：
| 行业类型 | 重点提取维度 | 必须包含的特定指标 |
| :--- | :--- | :--- |
| **SaaS / 软件** | `products`, `clients` | 部署方式（SaaS/私有化）、核心功能模块、API 开放性、标杆客户行业分布 |
| **电商 / 消费品** | `products`, `channels` | 核心 SKU、价格带、核心成分/材质、主要销售渠道（天猫/京东/独立站） |
| **大健康 / 医疗** | `certifications`, `technology` | 医疗器械注册证、临床数据、核心专利、适用适应症、禁忌症 |
| **ToB 制造 / 服务** | `technology`, `clients` | 产能/交付周期、核心工艺、资质认证（如 ISO/CMA）、大客户复购率 |
| **酒店 / 餐饮 / 本地生活** | `products`, `clients`, `public_intelligence` | 门店地址/门头外观、OTA 平台评分（携程/美团/大众点评）、好评高频词、差评痛点、房型/菜品结构、地图 POI 信息、周边配套、价格带 |
| **教育 / 培训** | `products`, `clients`, `public_intelligence` | 课程体系、师资背景、学员评价（知乎/小红书/大众点评）、校区分布、价格体系、升学/就业率 |
| **零售 / 连锁** | `products`, `channels`, `public_intelligence` | 门店数量与分布、大众点评/美团评分、客单价、会员体系、外卖平台表现 |

---

## 工作流程

### Stage A-1：输入分诊

**目标**：对客户提供的资料进行分类和质量评估。

**Step 1：资料接收与格式识别**

接收客户上传的全部资料，按文件类型进行分类：

| 文件类型 | 解析策略 | 信息密度 |
| :--- | :--- | :--- |
| PDF（BP/宣传册） | 全文提取 + 表格识别 + 图片 OCR | 高 |
| PPT/PPTX | 逐页提取文本 + 备注栏 + 图表数据 | 高 |
| Word/DOCX | 全文提取 + 表格 + 页眉页脚 | 中-高 |
| Excel/CSV | 结构化数据直接解析 | 高（结构化） |
| 图片（Logo/产品图/资质证书） | OCR + 视觉描述 + **物理文件留存到 visual_assets/** | 低-中 |
| 网页链接 | 抓取正文 + Meta 信息 + Schema 标记 | 中 |
| **企业官网** | **必须使用 `browser` 或 `search` 工具强制抓取官网内容** | **高（强制）** |
| **客户提供的 Logo/VI 文件** | **直接复制到 visual_assets/ 目录，标记 provided_by: client** | **高（视觉约束源）** |
| 口头描述/文字消息 | 直接提取关键信息 | 低 |

**Step 2：资料质量评估**

对每份资料进行质量评估，输出分诊结果：

```
资料分诊结果：
├── 高价值资料（直接提取）：BP.pdf, 产品手册.pdf
├── 中价值资料（需要交叉验证）：宣传册.pdf
├── **高价值必查资料**：必须主动搜索并抓取企业官网（若用户未提供链接，需自行搜索）
├── **视觉资产文件**：Logo.png → 复制到 visual_assets/client_logo_001.png
├── 低价值资料（仅作参考）：口头描述
└── 无法解析资料：损坏文件.pdf
```

### Stage A-2：视觉资产抓取与留存（v2.6 新增）

> **★ 强制执行**：无论客户是否提供了 Logo/VI 文件，本阶段都必须执行。这是确保 S7 视觉符号体系能够基于真实视觉元素工作的前提条件。

**目标**：主动抓取企业官网及公开渠道的视觉元素，以物理文件形式留存，并提取配色与字体线索。

**Step 2.1：客户提供的视觉文件留存**

如果客户上传了 Logo/VI 文件：
1. 将文件复制到 `visual_assets/` 目录，命名为 `client_{type}_{NNN}.{ext}`
2. 计算文件 SHA256 哈希
3. 使用 Pillow 提取图片尺寸
4. 使用 ColorThief 提取主色调
5. 记录到 `retained_files` 数组，`provided_by` 标记为 `client`

```python
# 示例：留存客户提供的 Logo
import shutil
from PIL import Image

src = "用户上传的Logo.png"
dst = "visual_assets/client_logo_001.png"
shutil.copy2(src, dst)

img = Image.open(dst)
width, height = img.size
# → retained_files 追加条目
```

**Step 2.2：官网视觉资产自动抓取**

使用 `scripts/visual_scraper.py` 或手动执行以下抓取流程：

```bash
python3 S1.品牌资产知识库.skill/scripts/visual_scraper.py \
  --url "https://www.example.com" \
  --brand "{brand}" \
  --output-dir "./visual_assets/" \
  --manifest "S1_{brand}_视觉资产清单.json"
```

抓取范围：

| 抓取目标 | 方法 | 优先级 |
| :--- | :--- | :--- |
| Logo 图片 | 解析 `<img>` 标签中含 `logo/brand/emblem` 关键词的元素 | **最高** |
| Favicon | 解析 `<link rel="icon/shortcut icon/apple-touch-icon">` | 高 |
| OG 社交分享图 | 解析 `<meta property="og:image">` | 高 |
| 首屏 Banner | 解析首屏大图（hero image） | 中 |
| CSS 配色 | 从 `<style>` 和内联 style 中提取高频 hex 色值 | 高 |
| 字体线索 | 从 CSS `font-family` 声明中提取 | 中 |

**Step 2.3：官网首屏截图**

使用 `browser` 工具对官网首页进行全屏截图：

1. 导航到企业官网首页
2. 等待页面完全加载
3. 截取全屏截图，保存为 `visual_assets/screenshot_homepage.png`
4. 如有重要子页面（如"关于我们"、"产品中心"），也进行截图留存

```
截图留存清单：
├── visual_assets/screenshot_homepage.png    （首页全屏）
├── visual_assets/screenshot_about.png       （关于我们，如有）
└── visual_assets/screenshot_product.png     （产品页，如有）
```

**Step 2.4：视觉资产汇总与色彩提取**

1. 合并客户提供的文件和自动抓取的文件
2. 对所有 Logo 文件执行色彩提取（ColorThief）
3. 合并 CSS 提取的色值和 Logo 提取的色值
4. 推测品牌主色、辅色、强调色
5. 汇总字体线索
6. 输出 `S1_{brand}_视觉资产清单.json`

**视觉资产清单 JSON 结构**：

```json
{
  "meta": {
    "brand": "品牌名",
    "source_url": "https://www.example.com",
    "scraped_at": "2026-04-28T10:00:00Z",
    "scraper_version": "1.0.0"
  },
  "assets": {
    "logos": [
      {
        "asset_id": "logo_001",
        "source_url": "https://www.example.com/images/logo.png",
        "local_path": "visual_assets/logo_001.png",
        "file_hash": "sha256:abc...",
        "dimensions": {"width": 400, "height": 120},
        "alt_text": "品牌Logo",
        "extracted_colors": ["#1B4F72", "#E67E22"]
      }
    ],
    "favicons": [ "..." ],
    "og_images": [ "..." ],
    "banners": [ "..." ],
    "screenshots": [ "..." ]
  },
  "extracted_palette": {
    "from_logo": ["#1B4F72", "#E67E22"],
    "from_website": [{"hex": "#1B4F72", "frequency": 42}],
    "dominant_colors": ["#1B4F72", "#E67E22", "#F4F6F7"],
    "primary_color_guess": "#1B4F72"
  },
  "typography_hints": ["PingFang SC", "Microsoft YaHei", "Helvetica Neue"],
  "scrape_status": "success",
  "summary": {
    "total_assets_downloaded": 5,
    "has_logo": true,
    "has_favicon": true,
    "has_og_image": true,
    "primary_color_guess": "#1B4F72"
  }
}
```

### Stage A-2.5：企业实拍图收集与留存（v4 新增）

> **★ 核心新增 v4**：执行层内容生产需要大量企业真实图片作为文章配图（产品实拍、团队照、工厂/办公环境、服务现场、资质证书、客户案例现场等）。S1 必须在本阶段尽可能充分地收集企业实拍图片，作为 E1/E2/E3 的图片素材库。实拍图片的优先级高于 AIGC 生成图和网络素材图。

**目标**：构建企业实拍图片资产库（`visual_assets/enterprise_photos/`），为执行层内容配图提供真实、高质量的图片素材。

**Step 2.4.1：客户主动提供的企业实拍图（优先级最高）**

向客户明确请求提供以下类别的企业实拍图片：

| 图片类别 | 对应 `asset_type` | 说明 | 优先级 | 典型用途（执行层） |
|:---|:---|:---|:---|:---|
| 产品/服务实拍 | `product_photo` | 核心产品实物图、服务现场图、设备图 | **最高** | A 类场景图、B3 案例图 |
| 团队/人物照 | `team_photo` | 团队合影、创始人照、工作场景 | 高 | A5 品牌故事、C1b 新闻稿 |
| 办公/工厂环境 | `office_photo` | 办公室、工厂、实验室、门店外观 | 高 | C1b 企业形象图、D1 百科 |
| 资质证书 | `certificate_photo` | 营业执照、行业资质、奖项证书 | 高 | D1 百科、A1 品牌背书 |
| 客户案例现场 | `case_photo` | 项目实施现场、客户现场、交付成果 | 中 | A8 用户案例、B3 Case Study |
| 活动/展会照 | `event_photo` | 行业展会、发布会、签约仪式 | 中 | C1a 事件新闻稿 |
| 品牌物料 | `brand_material` | 宣传册封面、展架、包装设计 | 低 | 备用素材 |

> **★ 提醒规则**：如客户未主动提供企业实拍图，必须使用 `message(type="ask")` 明确提醒客户上传：
>
> *"为了确保内容配图的真实性和专业性，请提供以下企业实拍图片（高清优先）：① 产品/服务实拍图 2-5 张；② 团队/办公环境照 1-3 张；③ 资质证书扫描件；④ 客户案例现场照（如有）。这些图片将直接用于文章配图，比 AI 生成图更能建立信任感。"*

如客户提供了实拍图：
1. 将文件复制到 `visual_assets/enterprise_photos/` 目录，命名为 `{asset_type}_{NNN}.{ext}`
2. 计算文件 SHA256 哈希
3. 使用 Pillow 提取图片尺寸，评估质量（宽度 ≥ 800px 为高质量，400-800px 为可用，< 400px 为低质量）
4. 记录到 `retained_files` 数组，`provided_by` 标记为 `client`

**Step 2.4.2：网络抓取企业相关高质量图片（客户未提供时强制执行）**

当客户未提供充分的企业实拍图时，S1 必须主动从网络抓取企业相关的高质量图片：

| 抓取源 | 搜索策略 | 目标图片 | 优先级 |
|:---|:---|:---|:---|
| 企业官网 | 浏览“关于我们”“产品中心”“案例展示”“荣誉资质”等页面 | 产品图、团队图、环境图、证书图 | **最高** |
| 百度图片搜索 | `"{brand_name}" + 产品/团队/办公环境/资质` | 企业相关高清图片 | 高 |
| 行业媒体报道 | 搜索品牌名称相关新闻报道 | 报道配图（通常含企业现场图） | 中 |
| 招聘平台 | 搜索企业名称 | 办公环境图、团队图 | 中 |
| 大众点评/美团/携程 | 搜索品牌名称（C1 集群） | 门店环境图、产品图 | 中 |
| 天眼查/企查查 | 搜索企业名称 | 营业执照截图 | 低 |

抓取规则：
1. 优先抓取宽度 ≥ 800px 的高清图片
2. 严格筛选：只保留与该企业直接相关的图片，排除广告图、水印图、低质量图
3. 保存到 `visual_assets/enterprise_photos/` 目录，`provided_by` 标记为 `web_crawl`
4. 记录来源 URL、来源平台、图片描述

**Step 2.4.3：企业实拍图资产汇总**

将客户提供的和网络抓取的企业实拍图统一汇总，输出到视觉资产清单 JSON 的 `enterprise_photos` 字段：

```json
{
  "enterprise_photos": {
    "total_count": 8,
    "by_category": {
      "product_photo": 3,
      "team_photo": 1,
      "office_photo": 2,
      "certificate_photo": 1,
      "case_photo": 1
    },
    "quality_summary": {
      "high_quality": 5,
      "usable": 2,
      "low_quality": 1
    },
    "source_summary": {
      "client_provided": 4,
      "web_crawl": 4
    },
    "photos": [
      {
        "asset_id": "product_photo_001",
        "asset_type": "product_photo",
        "local_path": "visual_assets/enterprise_photos/product_photo_001.jpg",
        "source_url": "https://www.example.com/products/main.jpg",
        "provided_by": "web_crawl",
        "source_platform": "企业官网",
        "description": "核心产品XX的正面实拍图，白底高清",
        "dimensions": {"width": 1200, "height": 800},
        "quality_grade": "high",
        "suitable_for": ["A类场景图", "B3案例图", "D1百科配图"]
      }
    ]
  }
}
```

**企业实拍图充足度评估**：

| 等级 | 标准 | 对执行层的影响 | 处理方式 |
|:---|:---|:---|:---|
| A 级（充足） | ≥ 6 张高质量，覆盖 ≥ 3 个类别 | 执行层可完全使用实拍图，无需 AIGC 场景图 | 直接继续 |
| B 级（基本） | 3-5 张可用，覆盖 ≥ 2 个类别 | 执行层以实拍图为主，少量网络图补充 | 继续但标注补充建议 |
| C 级（不足） | 1-2 张或质量低 | 执行层需大量依赖网络抓取图 | 在缺口报告中标注为高优先级缺口 |
| D 级（缺失） | 0 张 | 执行层仅能使用网络图 + 封面 AIGC | 强烈建议客户补充，在缺口报告中标红 |

### Stage A-3：全网公共情报研究（v2.8 全面升级）

> **★ 核心升级 v2.8**：Stage A-3 不再仅限于"本地生活类"的被动触发。**所有品牌均需执行本阶段**，区别仅在于采集深度和路径因行业集群不同而异。本阶段同时前置嵌入了 S3 品类趋势研判师的"全网信号源清单"和"PEST/波特五力预扫描"方法论，确保 S1 一次性完成全面的公共情报采集，S3 可直接消费而无需重复搜索。
>
> 详细的行业集群定义、平台矩阵、信号源清单和采集规范，参见 **`references/industry-intel-playbook.md`**。

**目标**：主动搜索并采集品牌在第三方平台、搜索引擎、社交媒体、行业数据库上的公开情报，形成结构化的**公共情报图谱** + **原始信号快照**（供 S3 直接消费）。

---

**Step 2.5：行业集群识别与采集路径路由**

根据 Step 1 中识别的行业属性，将品牌映射到 **6 大行业集群**（一个品牌可匹配多个集群，取并集执行）：

| 集群 ID | 集群名称 | 触发条件 | 采集深度 |
| :--- | :--- | :--- | :--- |
| **C1** | 本地生活服务 | 有门店 / 有线下体验 / 有 OTA/点评平台可查 | **深度采集**（强制） |
| **C2** | 消费品与零售 | 销售实物商品 / 有电商店铺 / 有社交种草 | **深度采集**（强制） |
| **C3** | B2B 与企业服务 | 客户为企业 / 决策链长 / 重案例与资质 | **中度采集**（强制） |
| **C4** | 医疗与健康 | 属于消费医疗或重度医疗行业 | **深度采集**（强制，合规优先） |
| **C5** | 文化教育与内容 | 核心业务为内容生产/教育/文化/娱乐 | **中度采集**（强制） |
| **C6** | 专业服务与特殊行业 | 强监管 / 政策敏感型行业 | **基础采集**（强制） |

> **★ 路由规则**：
> - 每个品牌**至少匹配 1 个集群**，按 `industry-intel-playbook.md` 中对应集群的"必采信息矩阵"执行
> - 如匹配多个集群（如"连锁药店"= C1 + C4），则取所有匹配集群的**采集任务并集**
> - 如无法明确判断集群归属，默认执行 C3（B2B）路径 + 需求侧信号源
> - 集群判定结果记录到 `public_intelligence.cluster_ids` 字段

**Step 2.6：执行行业集群专属采集**

按 `references/industry-intel-playbook.md` 第二章中对应集群的"必采信息矩阵"和"行业细分补充规则"逐一执行搜索采集。

**通用搜索策略**（所有集群共用）：

```
搜索策略（按优先级执行）：

1️⃣ 品牌名 + 平台名（如"东莞樱花酒店 携程""东莞樱花酒店 大众点评"）
2️⃣ 品牌名 + "评价"/"口碑"/"怎么样"
3️⃣ 品牌名 + 地图（获取 POI 信息、周边配套）→ C1 集群
4️⃣ 品牌名 + "门头"/"外观"/"环境"（图片搜索）→ C1 集群
5️⃣ 品牌名 + "差评"/"投诉"/"避雷"（负面情报）→ 所有集群
6️⃣ 品牌名 + "测评"/"对比"/"推荐"（种草/评测）→ C2 集群
7️⃣ 公司全称 + 天眼查/企查查（工商+风险）→ C3/C6 集群
8️⃣ 品牌名 + "资质"/"许可"/"牌照"（合规验证）→ C4/C6 集群
9️⃣ 品牌名 + 电商平台（天猫/京东/拼多多）→ C2 集群
🔟 品牌名 + 行业媒体（36氪/虎嗅/钛媒体）→ C3/C5 集群
```

> **★ 重要规则**：
> - 每个必查平台至少访问 1 个结果页面，提取结构化信息
> - 图片搜索结果中的门头照/环境照/产品照必须下载到 `visual_assets/public_intel/` 目录
> - 评论采集时取最新 20 条代表性评论（好评/差评各半）
> - 如搜索工具受限无法访问某平台，使用 `message(type="ask")` 请求用户提供截图或链接
> - **C4 医疗集群合规红线**：严禁采集患者隐私信息，仅采集公开的机构评价和医师公开信息

**Step 2.7：全网信号源采集（前置 S3 方法论）**

> 本步骤前置嵌入了 S3 品类趋势研判师的方法论。S1 只负责**采集原始信号**（数值+截图+摘要+URL），**不做趋势评分和推导**（那是 S3 的专属职责）。

按 `references/industry-intel-playbook.md` 第三章"全网信号源清单"和第四章"PEST 预扫描框架"执行：

**A. 需求侧信号采集**（P1 优先级，所有品牌建议执行）：

| 信号源 | 搜索方法 | 采集目标 |
| :--- | :--- | :--- |
| 百度指数 | `{品牌名}` + `{品类关键词}` | 搜索指数数值、趋势截图 |
| 小红书 | `{品牌名}` | 笔记总数、近 30 天新增、互动中位数 |
| 知乎 | `{品牌名} 怎么样` | 相关问题数、关注人数 |
| 抖音/巨量算数 | `{品牌名}` | 话题播放量、相关视频数 |
| Google Trends | `{品牌名}` (英文品牌) | 搜索量趋势 |

**B. 供给侧信号采集**（P2 优先级，C3/C4/C6 集群强制）：

| 信号源 | 搜索方法 | 采集目标 |
| :--- | :--- | :--- |
| 天眼查/企查查 | `{品牌名/公司全称}` | 工商信息、融资、风险 |
| IT 桔子 | `{品类} 融资` | 近 12 月融资事件 |
| 36氪/虎嗅 | `{品牌名}` | 媒体报道摘要 |
| 国家知识产权局 | `{公司全称}` | 专利数量、方向 |
| 艾瑞/易观 | `{品类} 报告` | 报告标题、核心数据摘要 |

**C. 文化侧信号采集**（P3 优先级，面向年轻用户的品牌建议执行）：

| 信号源 | 搜索方法 | 采集目标 |
| :--- | :--- | :--- |
| 微博 | `{品牌名}` | 话题阅读量、舆情方向 |
| B 站 | `{品牌名}` | 相关视频数、弹幕情绪 |
| 豆瓣 | `{品牌名}` | 小组讨论、评分 |

**D. PEST 预扫描**（P4 优先级，所有品牌如时间允许）：

| PEST 维度 | 搜索策略 | 采集目标 |
| :--- | :--- | :--- |
| P（政策） | `{行业} 政策 2025 2026` / `{行业} 新规` | 最新 3 条政策标题+摘要 |
| E（经济） | `{行业} 市场规模` / `{品类} 增速` | 市场规模、增速数据 |
| S（社会） | `{品类} 消费趋势` / `{品类} 年轻人` | 消费习惯变化信号 |
| T（技术） | `{行业} 技术突破` / `{品类} AI` | 技术变革信号 |

**E. 波特五力预扫描**（P4 优先级，与 PEST 同步执行）：

| 五力维度 | 搜索策略 | 采集目标 |
| :--- | :--- | :--- |
| 现有竞争者 | `{品类} 品牌排名` / `{品类} 市场份额` | 头部品牌列表、CR5 数据 |
| 新进入者 | `{品类} 新品牌` / IT桔子融资 | 近 12 月新进入者列表 |
| 替代品 | `{品类} 替代` / `{需求} 解决方案` | 替代方案列表 |
| 买方议价力 | 电商评论中的价格敏感度 | 用户对价格的态度 |
| 供方议价力 | `{品类} 原材料 涨价` | 供应链变化信号 |

> **★ S1 vs S3 职责边界**：
> - **S1 输出**：`signal_snapshot`（原始信号集合：数值+截图+摘要+URL+时间戳）
> - **S3 消费**：从 S1 的 `signal_snapshot` 中读取原始信号，执行 PEST 深度分析、波特五力评分、品类生命周期定位和文化弱信号识别
> - **S3 增量**：S3 可在 S1 数据基础上进行增量搜索（如 S1 未覆盖的文化弱信号源或国际信号源）
> - **禁止重复**：如 S1 已完成某信号源的采集，S3 不得重复搜索同一信号源

**Step 2.8：公共情报结构化录入**

将采集到的信息填充到 `facts.public_intelligence` 字段（D13 维度）：

```json
{
  "public_intelligence": {
    "industry_trigger": "酒店",
    "cluster_ids": ["C1"],
    "platforms_scanned": [
      {
        "platform": "携程",
        "url": "https://...",
        "rating": 4.6,
        "review_count": 1283,
        "scan_date": "2026-05-01"
      }
    ],
    "rating_summary": {
      "average_score": 4.5,
      "total_reviews": 3500,
      "score_distribution": {"5星": 60, "4星": 25, "3星": 10, "2星": 3, "1星": 2}
    },
    "positive_themes": [
      {"theme": "位置便利", "frequency": 45, "sample_quote": "离地铁口步行5分钟"},
      {"theme": "服务态度好", "frequency": 38, "sample_quote": "前台小姐姐很热情"}
    ],
    "negative_themes": [
      {"theme": "隔音差", "frequency": 22, "sample_quote": "晚上能听到走廊声音"},
      {"theme": "设施老旧", "frequency": 15, "sample_quote": "空调制冷效果一般"}
    ],
    "storefront_images": [
      {
        "local_path": "visual_assets/public_intel/storefront_001.jpg",
        "source_url": "https://...",
        "source_platform": "高德地图",
        "description": "酒店正门外观，白色建筑+樱花元素招牌"
      }
    ],
    "poi_info": {
      "address": "东莞市XX路XX号",
      "coordinates": {"lat": 23.0208, "lng": 113.7518},
      "nearby_landmarks": ["东莞火车站(800m)", "XX商场(200m)"],
      "transport": "地铁X号线XX站B口步行5分钟"
    },
    "competitive_context": {
      "nearby_competitors": ["全季酒店", "如家酒店"],
      "price_positioning": "中端偏上（周边同类酒店均价200-400，本店350-500）"
    },
    "raw_reviews": [
      {"platform": "携程", "rating": 5, "text": "...", "date": "2026-04-20", "sentiment": "positive"},
      {"platform": "美团", "rating": 2, "text": "...", "date": "2026-04-15", "sentiment": "negative"}
    ],
    "signal_snapshot": {
      "demand_signals": [
        {
          "source": "百度指数",
          "url": "https://index.baidu.com/...",
          "timestamp": "2026-05-01",
          "description": "品牌词日均搜索指数 850，近30天环比+12%",
          "screenshot_path": "visual_assets/public_intel/baidu_index_trend.png"
        }
      ],
      "supply_signals": [
        {
          "source": "天眼查",
          "url": "https://www.tianyancha.com/...",
          "timestamp": "2026-05-01",
          "description": "注册资本500万，成立2018年，无风险信息"
        }
      ],
      "culture_signals": [],
      "pest_signals": {
        "political": [{"title": "...", "source_url": "...", "summary": "...", "timestamp": "..."}],
        "economic": [{"title": "...", "source_url": "...", "summary": "...", "timestamp": "..."}],
        "social": [],
        "technological": []
      },
      "porter_signals": {
        "existing_competitors": "品类内CR5约40%，头部品牌为...",
        "new_entrants": "近12月新增品牌3家...",
        "substitutes": "...",
        "buyer_power": "...",
        "supplier_power": "..."
      }
    }
  }
}
```

> **★ 图片留存规则**：门头照/环境照/产品照等图片下载后存入 `visual_assets/public_intel/` 子目录，并在 `storefront_images` 数组中记录元数据。这些图片将供 S7 视觉符号体系和 E3 视觉资产生成师作为环境参考。

> **★ signal_snapshot 与 S3 的对接**：`signal_snapshot` 中每条信号的结构（`source` + `url` + `timestamp` + `description`）与 S3 趋势打分卡中 `signals[]` 的结构完全对齐，S3 可直接引用而无需格式转换。

**Step 2.9：情报质量自检**

完成采集后，输出情报质量自检表：

```
公共情报采集自检（v2.8）：
├── 集群识别：已匹配 [C1/C2/...] ✅
├── 平台覆盖：X/Y 个必查平台已完成 ✅/⚠️
├── 评分数据：已获取 X 个平台评分 ✅/⚠️
├── 评论采样：已采集 X 条评论（好评 X / 差评 X） ✅/⚠️
├── 视觉资产：已下载 X 张图片 ✅/⚠️
├── POI 信息：地址/坐标/周边已获取 ✅/⚠️（C1 集群）
├── 竞争上下文：周边竞品/价格带已获取 ✅/⚠️
├── 需求侧信号：X/5 个信号源已采集 ✅/⚠️
├── 供给侧信号：X/5 个信号源已采集 ✅/⚠️（C3/C4/C6）
├── PEST 预扫描：X/4 个维度已完成 ✅/⚠️/⏭️（可选）
└── 总评分：XX/100（及格线 70 分，详见 playbook 第七章）
```

> 如总评分低于 70 分或任何必查项未完成，必须使用 `message(type="ask")` 告知用户并请求协助（如提供平台链接或截图）。

---

### Stage B：提取与填充

**目标**：从分诊后的资料中提取信息，填充三段式事实图谱。

**Step 3：13 维度信息提取（结合垂直行业逻辑）**

按照 `references/info-collection-template.md` 中定义的 13 个维度，并**结合上述垂直行业特定提取逻辑**，逐一从资料中提取信息：

| 维度编号 | 维度名称 | 提取目标 | 对应 facts 字段 |
| :--- | :--- | :--- | :--- |
| D01 | 企业基础 | 全称/简称/注册时间/注册资本/法人/地址 | `company_info` |
| D02 | 团队 | 创始人背景/核心团队/人员规模/组织架构 | `team` |
| D03 | 产品 | 产品线/SKU/价格带/核心参数/生命周期 | `products` |
| D04 | 技术 | 核心技术/专利/研发投入/技术壁垒 | `technology` |
| D05 | 客户 | 目标客户/标杆案例/客户规模/复购率 | `clients` |
| D06 | 资质 | 认证/许可/奖项/行业排名 | `certifications` |
| D07 | 财务 | 营收/利润/增速/融资轮次/估值 | `financials` |
| D08 | 竞争 | 直接竞品/间接竞品/市场份额/竞争优势 | `competition` |
| D09 | 市场 | 市场规模/增速/细分市场/区域分布 | `market` |
| D10 | **品牌视觉资产** | **Logo 文件/配色/字体/截图/VI + Stage A-2 抓取结果** | `brand_assets` |
| D11 | 渠道 | 线上渠道/线下渠道/分销体系/合作伙伴 | `channels` |
| D12 | 意图 | 战略目标/短期目标/品牌愿景/本次合作期望 | `intent` |
| D13 | **公共情报** | **第三方平台评分/评论/门头照/POI/竞争上下文 + Stage A-3 采集结果** | `public_intelligence` |

> **★ D10 特殊处理**：D10 维度的填充不再仅依赖客户口头描述。必须将 Stage A-2 抓取的视觉资产清单数据直接写入 `brand_assets` 字段，包括 `visual_asset_manifest`、`retained_files`、`extracted_palette`、`typography` 四个结构化子对象。

> **★ D13 特殊处理**：D13 维度的填充完全依赖 Stage A-3 的主动搜索结果。如行业属性触发了 Stage A-3，则将采集结果直接写入 `public_intelligence` 字段；如未触发，该字段留空或设为 `null`。该维度的数据将直接影响 S4 定位（口碑差异化）、S8 问答架构（真实用户关切点）、E1 选题（基于差评痛点生成内容）、E5 分发（平台特征适配）。

**Step 4：事实与主张分离**

提取过程中，严格区分"事实"和"主张"：

| 类型 | 判断标准 | 处理方式 | 示例 |
| :--- | :--- | :--- | :--- |
| 硬事实 | 可验证、有数据支撑 | 直接写入 `facts` | "团队 200 人"、"CMA 认证编号 XXX" |
| 品牌主张 | 主观判断、自我宣称 | 写入 `claims`，并在 `evidence` 中记录来源 | "行业领先"、"最具性价比" |
| 推测信息 | 资料中未明确，由 AI 推断 | 写入 `facts` 但标注 `confidence: 0.3-0.5` | "估计年营收 5000 万-1 亿" |
| **视觉事实** | **物理文件存在、色值可验证** | **写入 `facts.brand_assets.retained_files`** | **"Logo 主色 #1B4F72（从文件提取）"** |

**Step 5：证据链构建**

为每条 `claims` 中的主张构建证据链：

```json
{
  "claim_ref": "differentiators[0]",
  "source_url": "https://www.example.com/about",
  "source_type": "official_website",
  "timestamp": "2026-03-15",
  "confidence": 0.85,
  "excerpt": "公司拥有国内首台XXX设备，检测精度达到0.01μm"
}
```

证据来源类型分类：

| source_type | 置信度范围 | 说明 |
| :--- | :--- | :--- |
| `official_document` | 0.8-1.0 | 营业执照、资质证书、财报等官方文件 |
| `official_website` | 0.7-0.9 | 企业官网信息 |
| `media_report` | 0.6-0.8 | 权威媒体报道 |
| `client_statement` | 0.5-0.7 | 客户口头描述或非正式文件 |
| `ai_inference` | 0.2-0.5 | AI 根据上下文推断 |
| `visual_asset_extraction` | 0.9-1.0 | 从物理文件中提取的视觉数据（色值/尺寸/字体） |

### Stage C：确认与输出

**目标**：校验、格式化并输出全部产出物。

**Step 6：JSON Schema 校验**

使用 `scripts/json_schema_validator.py` 校验事实图谱 JSON：

```bash
python3 S1.品牌资产知识库.skill/scripts/json_schema_validator.py \
  S1_{brand}_品牌事实图谱.json \
  shared/brand_facts_schema.json
```

**Step 7：缺口报告生成**

使用 `scripts/gap_reporter.py` 扫描 13 维度的填充情况，生成缺口报告：

```bash
python3 S1.品牌资产知识库.skill/scripts/gap_reporter.py \
  S1_{brand}_品牌事实图谱.json \
  S1_{brand}_知识库缺口报告.md
```

缺口报告格式（v2.6 新增视觉资产缺口项）：

```markdown
# {brand} 知识库缺口报告

## 总体评估
- 13 维度覆盖率：11/13（85%）
- 必填字段缺失数：3
- 建议补充优先级：高

## 视觉资产留存评估（v2.6 新增）
- Logo 文件留存：✅ / ❌
- 品牌配色提取：✅ / ❌（提取到 N 个色值）
- 官网截图留存：✅ / ❌
- 视觉资产清单完整性：✅ / ❌

## 企业实拍图评估（★ v4 新增）
- 企业实拍图总数：N 张（客户提供 X 张 + 网络抓取 Y 张）
- 类别覆盖：产品图 ✅/❌、团队图 ✅/❌、环境图 ✅/❌、证书图 ✅/❌、案例图 ✅/❌
- 高质量图片数：N 张（宽度 ≥ 800px）
- 充足度等级：A/B/C/D（详见 Stage A-2.5 评估标准）
- ℹ️ 对执行层影响：实拍图充足度直接决定文章配图质量，不足时执行层将降级为网络图 + 封面 AIGC

## 缺口详情

| 维度 | 状态 | 缺失字段 | 优先级 | 影响范围 |
| :--- | :--- | :--- | :--- | :--- |
| D01 企业基础 | ✅ 完整 | — | — | — |
| D07 财务 | ❌ 缺失 | 营收/利润/增速 | 高 | S5 诊断、S9 赋能 |
| D10 品牌视觉 | ⚠️ 部分 | 客户未提供 Logo 源文件（已从官网抓取） | 中 | S7 视觉符号体系 |
```

**Step 8：知识库 MD 渲染**

按照 `templates/brand_knowledge_md_template.md` 的模板结构，将事实图谱渲染为人类可读的 Markdown 文档。

> **★ v2.6 注意**：MD 模板中新增了"十、品牌视觉资产"章节的"10.2 视觉资产留存清单"和"10.3 提取的品牌色彩体系"子节，必须完整渲染。

**Step 9：源文件提交与统一 PDF 等待**

S1 节点内只提交 `S1_{brand}_品牌事实图谱.json`、`S1_{brand}_品牌知识库.md`、`S1_{brand}_知识库缺口报告.md`、视觉资产清单与 `visual_assets/` 目录。`S1_{brand}_品牌知识库.pdf` 不在 S1 内生成；S10 品牌信息确认表完成后由 S0 先询问用户是否需要生成各阶段 PDF，只有用户明确确认后，才在统一 PDF 阶段基于最终 Markdown 生成。

---

## 迭代更新机制

当 外部投放/监测层产生 `external_feedback_to_S1.json` 回流信号时，S1 需要执行增量更新：

| 回流类型 | 处理方式 |
| :--- | :--- |
| 事实修正 | 更新 `facts` 中对应字段，更新 `evidence` 中的时间戳 |
| 新增信息 | 追加到对应维度，标注来源为 `e6_feedback` |
| 主张失效 | 将对应 `claims` 标记为 `deprecated`，保留历史记录 |
| **视觉资产更新** | **客户提供新 Logo/VI 文件时，追加到 visual_assets/ 并更新 retained_files** |

增量更新后，S0 会生成新版本的 `strategy_pack_v{N+1}.json`。

---


---

## 产出交付规则（v2.6.2 新增）

**必须执行**：本节点的所有源文件（JSON/MD/Prompt 包/图片资产等）生成并校验通过后，**必须立即使用 `message` 工具（type="info" 或 type="result"）将源文件作为附件发送给用户**。PDF 不在本节点内生成，统一由 S0 在 S10 品牌信息确认表完成后按用户确认生成。
**禁止暂停**：发送产出后，**禁止**等待用户确认（除非遇到硬性错误或到达预设的全局暂停点），必须立即通知 S0 编排师继续执行下一个节点。

## 校验闸门

| 序号 | 校验条件 | 不达标动作 |
| :--- | :--- | :--- |
| 1 | JSON 通过 `shared/brand_facts_schema.json` 校验 | 打回修复 JSON 格式 |
| 2 | 每个 `confidence >= 0.8` 的事实必须有 ≥ 1 条 evidence | 补充证据链 |
| 3 | 缺口报告中"必填"缺失数 ≤ 5 | 请求用户补充资料 |
| 4 | **`S1_{brand}_品牌知识库.md` 存在且非空；PDF 不作为 S1 完成条件** | **强制打回，禁止进入暂停 1** |
| 5 | `claims` 中每条主张在 `evidence` 中有对应记录 | 补充或标注"待验证" |
| 6 | **`visual_assets/` 目录存在且至少包含 1 个 Logo 文件（客户提供或抓取获得）** | **若无资产，在缺口报告中标注为高优先级缺口，提示用户提供（不阻断流程，允许降级为 inference_only）** |
| 7 | **`S1_{brand}_视觉资产清单.json` 存在且 `summary.total_assets_downloaded >= 1`** | **警告但不阻断（部分企业可能无官网）** |
| 8 | **`S1_{brand}_视觉资产清单.json` 中 `scrape_status` 为 `success` 或 `partial`** | **若为 `failed`，在缺口报告中标注并建议用户手动提供 Logo** |
| 9 | **★ v4：`visual_assets/enterprise_photos/` 目录存在且至少包含 1 张企业实拍图** | **若无企业实拍图，在缺口报告中标注为高优先级缺口，提醒客户上传（不阻断流程，执行层降级为网络图 + 封面 AIGC）** |

---

## 子文件引用

| 文件路径 | 用途 | 引用时机 |
| :--- | :--- | :--- |
| `references/brand-facts-schema.md` | 三段式 Schema 详细说明（每个字段的类型、必填/选填、示例值） | Stage B Step 3-5 |
| `references/info-collection-template.md` | 13 维度信息收集模板（每个维度下 5-10 个具体问题，v2.8 新增 D13） | Stage A-1 Step 1-2 |
| **`references/industry-intel-playbook.md`** | **行业情报获取手册（6 大行业集群×差异化搜索策略，v2.8 新增）** | **Stage A-3** |
| `templates/brand_knowledge_md_template.md` | 品牌知识库 MD 输出模板（章节标题、表格骨架、填充说明） | Stage C Step 8 |
| `scripts/json_schema_validator.py` | JSON Schema 校验器 | Stage C Step 6 |
| `scripts/gap_reporter.py` | 缺口报告生成器（v2.6 新增视觉资产缺口检查） | Stage C Step 7 |
| **`scripts/visual_scraper.py`** | **视觉资产抓取与留存工具（v2.6 新增）** | **Stage A-2 Step 2.2** |
| `shared/brand_facts_schema.json` | 品牌事实图谱 JSON Schema（全局共享，v2.6 新增视觉资产字段） | Stage C Step 6 |

---

## 知识库完整度与下游质量的关系

| 知识库等级 | 13 维度覆盖率 | 视觉资产留存 | 下游影响 | 建议 |
| :--- | :--- | :--- | :--- | :--- |
| A 级（优秀） | ≥ 90% | Logo + 配色 + 截图齐全 | 企业实拍图 ≥ 6 张，覆盖 ≥ 3 类 | S2-S9 全部可高质量执行，执行层可完全使用实拍图 | 直接继续 |
| B 级（良好） | 70%-89% | 至少有 Logo 文件 | 企业实拍图 3-5 张，覆盖 ≥ 2 类 | 核心维度完整，执行层以实拍图为主、网络图补充 | 继续但标注补充建议 |
| C 级（基础） | 50%-69% | 仅有抓取的 Favicon | 企业实拍图 1-2 张或质量低 | 多个维度需补充，执行层需大量网络图 | 建议用户补充 Logo + 实拍图 |
| D 级（不足） | < 50% | 无任何视觉资产 | 无企业实拍图 | 下游产出质量无法保证，执行层仅能用网络图 + 封面 AIGC | 强烈建议用户补充 |
