import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  ExternalLink,
  ListChecks,
  MessageCircle,
  ShieldCheck,
  X,
  ZoomIn,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

type GuideHotspot = {
  label: string;
  left: string;
  top: string;
};

type GuideImage = {
  src: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
  portrait?: boolean;
  hotspots?: GuideHotspot[];
};

type GuideLink = {
  label: string;
  href: string;
};

type GuideStage = {
  id: number;
  title: string;
  summary: string;
  duration: string;
  path: string;
  tasks: string[];
  fill: string[];
  avoid: string[];
  done: string;
  trouble: string;
  links: GuideLink[];
  images?: GuideImage[];
};

export type AliyunIcpGuideProps = {
  onContactAdvisor?: () => void;
  currentPhase?: "domain" | "icp";
  marketEdition?: "domestic" | "overseas";
  scenario?: AliyunGuideScenario;
  onScenarioChange?: (scenario: AliyunGuideScenario) => void;
  stageThreeContent?: ReactNode;
  filingSubmissionContent?: ReactNode;
};

export type AliyunGuideScenario =
  | "first_filing"
  | "existing_filing"
  | "overseas";

const GUIDE_SCENARIO_OPTIONS = [
  {
    value: "first_filing" as const,
    label: "国内版 · 企业首次备案",
    marketEdition: "domestic" as const,
  },
  {
    value: "existing_filing" as const,
    label: "国内版 · 已有 ICP 备案",
    marketEdition: "domestic" as const,
  },
  {
    value: "overseas" as const,
    label: "海外版 · 香港/海外节点",
    marketEdition: "overseas" as const,
  },
];

const IMAGE_ROOT = "/assets/aliyun-icp-guide";
const SCREENSHOT_SOURCE =
  "截图来源：阿里云官方公开页面 / 帮助中心 · 截图核对：2026-07-31";

const firstFilingStages: GuideStage[] = [
  {
    id: 1,
    title: "准备资料，创建企业域名信息模板并完成实名认证",
    summary: "先完成企业实名模板。",
    duration: "填写约 10 分钟，审核通常 1–5 个工作日",
    path: "阿里云域名控制台 → 左侧“信息模板” → “创建新信息模板”",
    tasks: [
      "确认本次是企业首次备案，备案主体就是营业执照上的企业。",
      "登录阿里云中国站账号，进入域名控制台的信息模板页面。",
      "选择持有者类型为“企业 / 组织”，证件类型选择营业执照对应类型。",
      "按营业执照逐字填写企业全称和统一社会信用代码，并上传清晰完整的证件原件图片。",
      "填写真实有效的域名联系人、通讯地址、邮编、手机号和邮箱后提交。",
      "回到信息模板列表，等待状态变为“模板实名成功”。",
    ],
    fill: [
      "域名持有者单位名称：必须与营业执照、后续备案主体逐字一致",
      "证件号码：填写完整统一社会信用代码，不要填写营业执照副本号",
      "通讯地址：详细到门牌号，联系人、手机号和邮箱必须真实有效",
    ],
    avoid: [
      "不要误选“个人”模板，也不要填写企业简称、品牌名或英文名。",
      "模板审核中或失败时不要购买域名；先按失败原因修正并重新提交。",
    ],
    done: "信息模板列表明确显示“模板实名成功”或“实名认证成功”。",
    trouble:
      "提示证件信息不一致时，逐字核对企业名称、证件类型和统一社会信用代码；不要用空格或简称规避校验。",
    links: [
      {
        label: "进入阿里云域名控制台",
        href: "https://dc.console.aliyun.com/",
      },
      {
        label: "查看企业信息模板填写规则",
        href: "https://help.aliyun.com/zh/dws/real-name-authentication-for-domain-names-with-inaccurate-real-name-information",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/03-enterprise-sponsor.webp`,
        alt: "阿里云企业备案主办者基础信息表单示例，包含企业性质、单位证件、主办者名称和证件号码",
        caption:
          "后续备案中的企业字段示例。信息模板里的单位名称、证件类型和号码要与这些字段完全一致。",
        width: 1269,
        height: 834,
        hotspots: [
          { label: "1", left: "21%", top: "37%" },
          { label: "2", left: "21%", top: "61%" },
        ],
      },
    ],
  },
  {
    id: 2,
    title: "查询、购买域名，并确认域名状态正常",
    summary: "先查询是否可注册，再关联刚刚实名成功的企业模板。",
    duration: "约 10–20 分钟",
    path: "阿里云万网 → “域名查询” → 输入候选名称 → “查询域名”",
    tasks: [
      "在域名查询框输入想注册的名称，不要输入 http、https 或 www。",
      "只选择明确显示“可注册 / 立即注册”的域名；已被注册的域名请更换名称。",
      "进入订单确认页，选择购买年限和已经“模板实名成功”的企业信息模板。",
      "核对域名持有者是本次备案企业，阅读协议后完成支付。",
      "打开域名控制台的域名列表，等待域名状态显示“正常”。",
    ],
    fill: [
      "域名主体部分，例如 frontmind；系统会显示可选后缀",
      "建议优先选择常见的 .com 或 .cn 后缀",
      "信息模板选择本次备案企业对应的已实名模板",
    ],
    avoid: [
      "付款成功不等于域名注册成功，必须再检查域名列表状态。",
      "不要购买“委托购买 / 一口价”域名，也不要关联个人信息模板。",
    ],
    done: "阿里云域名列表中能看到该域名，状态为“正常”。",
    trouble:
      "提示“信息模板不可用”时，返回上一步确认模板已经实名认证成功且邮箱已验证。",
    links: [
      { label: "去阿里云查询并注册域名", href: "https://wanwang.aliyun.com/" },
      {
        label: "查看阿里云域名注册完整说明",
        href: "https://help.aliyun.com/zh/dws/user-guide/how-to-register-a-domain-name",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/01-domain-search.webp`,
        alt: "阿里云万网域名查询首页，页面中央有域名输入框和查询域名按钮",
        caption:
          "在页面中央输入候选域名，再点击蓝色“查询域名”；不要把 www 或网址协议一起输入。",
        width: 1266,
        height: 710,
        hotspots: [
          { label: "1", left: "18%", top: "42%" },
          { label: "2", left: "70%", top: "42%" },
        ],
      },
    ],
  },
  {
    id: 3,
    title: "回到 FrontMind 提交已购买域名，等待备案服务码",
    summary: "提交域名会自动创建 AI 运维工单；服务码由该工单返回。",
    duration: "提交约 1 分钟，工单处理时间以页面状态为准",
    path: "FrontMind → AI 友好官网管理 → “已购买域名” → “提交域名，创建 AI 运维工单”",
    tasks: [
      "确认阿里云域名列表中的域名状态已经显示“正常”。",
      "回到本页下方的“提交已购买域名”区域，只填写主域名，例如 example.com。",
      "点击“提交域名，创建 AI 运维工单”；系统会生成一条“域名申请”工单。",
      "工单处于“待受理”时不要重复提交，等待 AI 运维核验域名并准备备案服务码。",
      "工单变为“已完成”后，在页面下方“官网历史与交付记录”中展开该工单。",
      "从工单的“备案服务码”处理结果中复制服务码；拿到服务码后再开始下一阶段的 ICP 备案。",
      "若域名刚完成实名认证，建议等实名认证信息同步 2–3 天后再发起备案。",
    ],
    fill: [
      "已购买域名：只填 example.com，不填 www、http、https、斜杠或页面路径",
      "提交对象：阿里云域名列表中状态为“正常”的企业实名域名",
      "备案服务码：无需提前填写，由已完成的 AI 运维工单返回",
    ],
    avoid: [
      "不要在域名尚未购买、实名认证未成功或状态异常时提交。",
      "不要通过微信索要或传递证件、验证码；域名提交工单只需要域名。",
      "不要把域名订单号、阿里云账号密码或短信验证码填进域名栏。",
    ],
    done: "“域名申请”工单显示“已完成”，展开后能看到 AI 运维返回的备案服务码。",
    trouble:
      "提交后请先查看工单状态；若工单已完成但没有备案服务码，再联系服务专员并提供工单编号，不要提交第二张工单。",
    links: [
      {
        label: "进入阿里云域名列表核对状态",
        href: "https://dc.console.aliyun.com/next/index",
      },
    ],
  },
  {
    id: 4,
    title: "进入 ICP 备案系统并完成基础信息校验",
    summary: "选择网站和企业备案，域名不带 www，接入资源填写服务码。",
    duration: "约 15 分钟",
    path: "阿里云备案首页 → “立即登录” → “开始备案” → 基础信息校验",
    tasks: [
      "登录备案系统并选择“开始备案”，服务类型选择“网站”。",
      "域名只填写主域名，例如 example.com，不填写 www、http、https 或路径。",
      "地区选择企业证件所在地，备案性质选择“企业”，证件类型按营业执照选择。",
      "仅在阿里云页面上传营业执照，企业名称、证件号码和证件住所必须与营业执照一致。",
      "到云服务 / 接入信息处选择“ICP备案服务码”，粘贴 AI 运维工单返回的服务码。",
      "点击“信息校验”；校验成功后确认系统识别出的域名、云服务和所需材料，再点“下一步”。",
    ],
    fill: [
      "服务类型：网站；备案性质：企业",
      "网站域名：example.com 这种不带前缀的格式",
      "接入资源：ICP备案服务码，不另购服务器",
    ],
    avoid: [
      "不要选择 App、个人备案或中国香港 / 海外服务器。",
      "营业执照只能上传到阿里云，FrontMind 页面没有材料上传入口。",
    ],
    done: "页面显示基础信息校验成功，并允许点击“下一步”创建备案订单。",
    trouble:
      "服务码不可用时不要反复新建订单；完整记录阿里云报错文字并联系 FrontMind 服务专员核对。",
    links: [
      { label: "去阿里云开始 ICP 备案", href: "https://beian.aliyun.com/" },
      {
        label: "查看基础信息校验字段说明",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/basic-information-check",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/02-filing-entry.webp`,
        alt: "阿里云 ICP 备案首页，右侧有立即登录按钮，顶部有备案控制台入口",
        caption: "先点击右侧“立即登录”。登录后进入备案控制台，选择“开始备案”。",
        width: 1266,
        height: 710,
        hotspots: [
          { label: "1", left: "91%", top: "56%" },
          { label: "2", left: "83%", top: "19%" },
        ],
      },
      {
        src: `${IMAGE_ROOT}/03-enterprise-sponsor.webp`,
        alt: "阿里云企业备案主办者基础信息填写页面",
        caption:
          "企业备案示例：备案性质选择企业，单位证件、主办者名称和号码均按营业执照原文填写。",
        width: 1269,
        height: 834,
        hotspots: [
          { label: "1", left: "25%", top: "38%" },
          { label: "2", left: "25%", top: "65%" },
        ],
      },
    ],
  },
  {
    id: 5,
    title: "填写主办者信息和网站信息",
    summary: "负责人必须能联系到本人，网站名称要符合企业备案规则。",
    duration: "约 20–30 分钟",
    path: "填写主办者信息 → 下一步 → 填写互联网信息服务",
    tasks: [
      "检查主办者名称、证件号码、证件住所，通讯地址补充到门牌号。",
      "填写主体负责人本人姓名、证件、手机号和邮箱，并完成页面要求的短信验证。",
      "网站名称使用三个及以上汉字，建议填写与企业名称或品牌直接相关的名称。",
      "网站域名填写已购买且完成实名的主域名；网站内容按企业官网的真实用途选择。",
      "填写网站负责人信息；若不是法定代表人，按备案省份提示准备授权书等补充材料。",
      "保存并仔细复核，确保手机、邮箱在整个审核期间都能正常使用。",
    ],
    fill: [
      "通讯地址：真实办公地址并详细到门牌号",
      "网站名称：三个及以上汉字，且与企业名称或业务有关",
      "负责人手机号：本人长期使用、可接听审核电话并接收短信",
    ],
    avoid: [
      "网站名称不要只写英文、数字、域名，也不要使用“中国、国家、论坛、社区”等受限词。",
      "不要用同一个手机号同时填写网站负责人手机号和应急手机号。",
    ],
    done: "主办者和网站信息均保存成功，页面进入“上传资料”阶段。",
    trouble:
      "提示工商信息不一致时，以最新营业执照为准逐项核对；负责人要求因省份不同而变化，以当前页面提示为准。",
    links: [
      {
        label: "查看主办者信息填写规则",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/the-fill-in-the-sponsor-information",
      },
      {
        label: "查看网站信息填写规则",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/fill-in-website-information",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/04-owner-contact-empty.webp`,
        alt: "阿里云主办者负责人联系方式空白表单示例",
        caption:
          "负责人联系方式要填写本人可用信息；手机需完成验证，邮箱用于接收备案通知。",
        width: 1266,
        height: 393,
        hotspots: [
          { label: "1", left: "45%", top: "40%" },
          { label: "2", left: "45%", top: "68%" },
        ],
      },
      {
        src: `${IMAGE_ROOT}/05-owner-contact-filled.webp`,
        alt: "阿里云主办者负责人姓名、证件、手机号和邮箱填写示例",
        caption:
          "提交前逐项复核姓名、证件、手机号、应急手机号和邮箱，避免因无法联系被驳回。",
        width: 1264,
        height: 526,
        hotspots: [
          { label: "1", left: "45%", top: "27%" },
          { label: "2", left: "45%", top: "65%" },
        ],
      },
      {
        src: `${IMAGE_ROOT}/06-mobile-enterprise-main.webp`,
        alt: "阿里云移动端企业主办者基础信息填写页面上半部分",
        caption:
          "移动端字段与电脑端一致：企业性质、单位证件、企业名称、号码和地址必须互相匹配。",
        width: 479,
        height: 1480,
        portrait: true,
        hotspots: [
          { label: "1", left: "12%", top: "17%" },
          { label: "2", left: "14%", top: "48%" },
        ],
      },
    ],
  },
  {
    id: 6,
    title: "在阿里云上传材料并完成人脸核验",
    summary: "所有证件和人脸信息都只留在阿里云，不要传给 FrontMind。",
    duration: "约 15–30 分钟",
    path: "上传资料 → 发送核验链接 / 扫码 → 阿里云 App → 刷新上传状态",
    tasks: [
      "把手机阿里云 App 更新到最新版本，再进入当前备案订单的“上传资料”。",
      "按页面清单上传营业执照、主体负责人和网站负责人的证件；只拍摄清晰、完整、无反光的彩色原件。",
      "负责人本人通过短信链接或二维码进入核验，按提示拍摄证件正反面并完成人脸核验。",
      "人脸核验时使用纯色背景，摘下帽子和眼镜，避免头发或强光遮挡面部。",
      "核验成功后返回电脑端点击“刷新上传状态”，确认所有必需项目均已完成。",
      "复核主体和网站信息，勾选备案承诺与信息安全协议，只在阿里云提交初审。",
    ],
    fill: [
      "使用最新签发的证件；有多张身份证时必须使用最近办理的一张",
      "证件图片需四角完整、文字清晰，尺寸和格式按阿里云当前提示执行",
      "由页面指定的负责人本人完成人脸核验",
    ],
    avoid: [
      "不要上传复印件、手机截图、过期或非最新证件。",
      "不要把证件、人脸照片、短信验证码发送给 FrontMind 或任何个人。",
    ],
    done: "阿里云页面显示资料上传及真实性核验完成，并且备案订单已提交初审。",
    trouble:
      "扫码打不开时先升级阿里云 App 并切换手机网络；核验失败时检查证件是否最新、姓名和证件号是否完全一致。",
    links: [
      {
        label: "查看材料上传与人脸核验说明",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/upload-data-and-authenticity-verification/",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/07-mobile-owner-upload.webp`,
        alt: "阿里云移动端主办单位负责人证件上传和联系方式填写页面",
        caption:
          "这里上传负责人最新证件并验证本人手机。阿里云会明确提示“最后一次办理的证件”。",
        width: 479,
        height: 1492,
        portrait: true,
        hotspots: [
          { label: "1", left: "15%", top: "25%" },
          { label: "2", left: "76%", top: "62%" },
        ],
      },
    ],
  },
  {
    id: 7,
    title: "完成审核、短信核验并取得 ICP 主体备案号",
    summary: "留意审核电话和 12381 短信；短信核验必须在 24 小时内完成。",
    duration: "阿里云初审约 1–2 个工作日，管局通常 1–20 个工作日",
    path: "进行中订单 → 阿里云初审 → 工信部短信核验 → 管局审核 → 已完成订单",
    tasks: [
      "保持负责人电话畅通，接听阿里云备案审核来电；具体来电号码以备案订单提示为准。",
      "阿里云初审通过后，等待工信部 12381 发送短信验证码和核验链接。",
      "收到短信后 24 小时内打开工信部备案系统，填写验证码、负责人手机号和证件号码后六位。",
      "需要多人核验时，确认页面显示所有应核验负责人均已完成；连续输错会导致订单退回。",
      "短信核验完成后等待管局审核，期间无法人工催审；驳回时按订单原因修改后重新提交。",
      "审核通过后进入“已完成订单 → 查看详情”，找到并复制页面明确标注的 ICP 主体备案号。",
      "返回本页，在下方只填写已备案域名和 ICP 主体备案号，提交给 FrontMind 确认。",
    ],
    fill: [
      "短信验证码：工信部短信中的 6 位数字",
      "负责人手机号：备案订单内填写的本人号码",
      "证件号码后六位：按工信部页面要求填写",
    ],
    avoid: [
      "不要错过 24 小时核验时限，也不要连续猜测证件号码后六位。",
      "回填 FrontMind 时不要填写备案服务码、订单号、密码或短信验证码。",
    ],
    done: "订单进入“已完成”，并能在详情中看到可复制的 ICP 主体备案号。",
    trouble:
      "未收到短信时先检查拦截记录和手机号；确认号码无误后使用工信部页面“短信重发”，仍失败再查看阿里云订单提示。",
    links: [
      {
        label: "查看工信部短信核验说明",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/sms-check",
      },
      {
        label: "查看备案进度与结果",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-progress-and-result-inquires",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/08-sms-review-stage.webp`,
        alt: "阿里云备案订单工信部短信核验阶段示例",
        caption: "订单出现“工信部短信核验—待验证”后，立即检查负责人手机。",
        width: 954,
        height: 276,
        hotspots: [{ label: "1", left: "44%", top: "50%" }],
      },
      {
        src: `${IMAGE_ROOT}/09-sms-message.webp`,
        alt: "工信部 12381 备案核验短信示例，包含验证码、核验链接和有效期一天提示",
        caption:
          "认准 12381 工信部短信：其中包含 6 位验证码、官方核验链接和一天有效期提示。",
        width: 1159,
        height: 689,
        hotspots: [
          { label: "1", left: "24%", top: "50%" },
          { label: "2", left: "48%", top: "70%" },
        ],
      },
      {
        src: `${IMAGE_ROOT}/10-sms-verification.webp`,
        alt: "工信部备案管理系统短信核验表单，依次填写验证码、手机号和证件号码后六位",
        caption:
          "在“短信核验”页依次填写验证码、手机号和证件号码后六位，再点击提交。",
        width: 1071,
        height: 1085,
        hotspots: [
          { label: "1", left: "26%", top: "45%" },
          { label: "2", left: "50%", top: "80%" },
        ],
      },
      {
        src: `${IMAGE_ROOT}/11-sms-resend.webp`,
        alt: "工信部备案管理系统短信重发页面，填写手机号和证件号码后六位后提交",
        caption:
          "长时间未收到验证码时切换到“短信重发”，核对手机号和证件号码后六位再提交。",
        width: 1079,
        height: 937,
        hotspots: [
          { label: "1", left: "75%", top: "24%" },
          { label: "2", left: "50%", top: "77%" },
        ],
      },
    ],
  },
];

const existingFilingStages: GuideStage[] = [
  {
    id: 1,
    title: "确认企业主体已有备案，本次域名尚未备案",
    summary: "本教程只办理：已有备案主体下新增一个使用新域名的网站。",
    duration: "约 5–10 分钟",
    path: "工信部备案管理系统 → ICP 备案查询 → 输入企业名称或主体备案号",
    tasks: [
      "先确认营业执照上的企业主体已经在工信部存在备案信息。",
      "记录工信部查询结果中的企业全称、主体备案号和证件类型，后续必须原样填写。",
      "确认本次准备使用的是一个尚未办理网站备案的新域名。",
      "明确本次办理类型为“新增互联网信息服务（新增网站）”。",
      "准备最新版营业执照和负责人资料；原备案信息已经变化时，先联系服务专员核对。",
    ],
    fill: [
      "企业全称：与工信部现有主体备案和最新营业执照一致",
      "ICP 主体备案号：按工信部查询结果完整记录",
      "本次办理类型：新增互联网信息服务（新增网站）",
    ],
    avoid: [
      "不要把原网站备案号当成 ICP 主体备案号。",
      "不要使用其他公司的备案主体，也不要凭记忆填写原备案信息。",
    ],
    done: "已经确认企业主体备案有效，并明确本次是在该主体下新增网站。",
    trouble:
      "查不到企业主体备案时，先核对企业全称、统一社会信用代码和原主体备案号；仍查不到请联系服务专员。",
    links: [
      {
        label: "查看阿里云备案类型说明",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview",
      },
      {
        label: "进入工信部备案信息查询",
        href: "https://beian.miit.gov.cn/",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/12-icp-filing-process.webp`,
        alt: "阿里云官方 ICP 备案完整流程图，从填写基础信息到管局审核及备案后处理",
        caption:
          "已有主体新增网站不会跳过审核。仍需依次完成基础信息、主办者信息、网站信息、资料与真实性核验、阿里云初审、短信核验和管局审核。",
        width: 970,
        height: 1104,
        portrait: true,
        hotspots: [
          { label: "1", left: "17%", top: "10%" },
          { label: "2", left: "49%", top: "51%" },
          { label: "3", left: "49%", top: "66%" },
        ],
      },
    ],
  },
  {
    id: 2,
    title: "创建企业域名模板，购买本次新增网站的域名",
    summary: "域名持有者必须与现有 ICP 备案主体完全一致。",
    duration: "实名审核通常 1–5 个工作日，购买约 10–20 分钟",
    path: "阿里云域名控制台 → 信息模板 → 域名查询 → 购买",
    tasks: [
      "创建企业域名信息模板，企业名称和统一社会信用代码按最新营业执照逐字填写。",
      "确保域名模板中的持有者名称与工信部现有备案主体完全一致。",
      "等待信息模板显示“模板实名成功”后，再查询并购买本次新增网站的域名。",
      "购买时关联该企业实名模板，不要选择个人模板。",
      "支付完成后进入域名列表，等待域名状态显示“正常”。",
      "域名刚完成实名认证时，建议等待实名信息同步后再发起备案。",
    ],
    fill: [
      "域名持有者：现有备案主体对应的企业全称",
      "证件号码：营业执照上的统一社会信用代码",
      "企业联系人、手机号和邮箱：填写真实有效信息",
    ],
    avoid: [
      "不要使用企业简称、品牌名、英文名或个人域名模板。",
      "不要在模板审核中、实名认证失败或域名状态异常时继续备案。",
    ],
    done: "域名列表显示状态“正常”，持有者与现有 ICP 备案主体一致。",
    trouble:
      "提示主体不一致时，逐字核对营业执照、域名实名模板和工信部备案主体，不要用空格或简称规避校验。",
    links: [
      {
        label: "查看阿里云域名注册流程",
        href: "https://help.aliyun.com/zh/dws/user-guide/how-to-register-a-domain-name",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/01-domain-search.webp`,
        alt: "阿里云万网域名查询页面，中央显示域名输入框和查询域名按钮",
        caption:
          "已有主体也需要为新网站购买并实名新域名。输入候选域名后查询，购买时关联与原备案主体一致的企业模板。",
        width: 1266,
        height: 710,
        hotspots: [
          { label: "1", left: "18%", top: "42%" },
          { label: "2", left: "70%", top: "42%" },
        ],
      },
    ],
  },
  {
    id: 3,
    title: "回到 FrontMind 提交本次域名，等待 AI 运维返回服务码",
    summary: "提交时保留“已有 ICP 备案”标签，工单会记录为新增网站。",
    duration: "提交约 1 分钟，处理时间以工单状态为准",
    path: "FrontMind → AI 友好官网管理 → 已购买域名 → 提交域名",
    tasks: [
      "回到本页下方，只填写本次新增网站使用的主域名。",
      "保持当前教程选择为“国内版 · 已有 ICP 备案”，再提交域名。",
      "系统会创建 AI 运维工单并带上“已有主体下新增网站”场景，工单处理中不要重复提交。",
      "工单显示已完成后，展开处理结果并复制备案服务码。",
      "拿到服务码后再进入阿里云备案系统；FrontMind 不接收任何证件或人脸材料。",
    ],
    fill: [
      "主域名：例如 example.com，不带 www 或协议",
      "办理场景：保持当前“已有 ICP 备案”教程标签",
      "备案服务码：由已完成的 AI 运维工单返回",
    ],
    avoid: [
      "不要把主体备案号误填进域名输入框。",
      "不要在微信中发送营业执照、负责人证件或验证码。",
    ],
    done: "域名工单已完成，能够在处理结果中看到备案服务码。",
    trouble:
      "若工单判断的办理类型与工信部查询结果不一致，先联系服务专员核对，不要创建第二张工单。",
    links: [
      {
        label: "查看阿里云备案前准备",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/overview",
      },
    ],
  },
  {
    id: 4,
    title: "从现有备案主体下发起“新增互联网信息服务”",
    summary: "系统识别已有主体后，为本次新域名创建新增网站订单。",
    duration: "约 15–25 分钟",
    path: "阿里云备案系统 → 我的备案 → 新增互联网信息服务 → 信息校验",
    tasks: [
      "登录本次企业使用的阿里云账号；一个阿里云账号只应对应一个备案主体。",
      "账号下已有该主体备案信息时，进入“我的备案”，选择新增互联网信息服务。",
      "账号下还未显示主体信息时，从“开始备案”进入并填写现有主体信息，让系统完成识别。",
      "填写不带 www 的主域名，并在接入资源处使用 AI 运维工单返回的备案服务码。",
      "确认页面识别结果为“新增互联网信息服务”，并核对企业主体与本次域名后再继续。",
    ],
    fill: [
      "备案主体：工信部现有备案对应的企业",
      "互联网信息服务：本次新网站及新域名",
      "接入资源：ICP备案服务码",
    ],
    avoid: [
      "不要新建第二个企业主体，也不要把原网站备案号填进主体备案号字段。",
      "备案通过前不要把新域名解析到中国内地服务器并开放访问。",
    ],
    done: "基础信息校验成功，订单类型明确显示为新增互联网信息服务。",
    trouble:
      "系统没有识别出已有主体时，核对企业名称、证件号码和主体备案号；不要重新创建主体备案订单。",
    links: [
      {
        label: "查看已有备案账号的基础信息校验",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/basic-information-check",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/02-filing-entry.webp`,
        alt: "阿里云 ICP 备案首页，右侧显示登录入口，顶部显示备案控制台入口",
        caption:
          "先从阿里云备案首页登录。账号下已有备案信息时，进入“我的备案”，再为新域名新增网站。",
        width: 1253,
        height: 705,
        hotspots: [
          { label: "1", left: "94%", top: "58%" },
          { label: "2", left: "86%", top: "19%" },
        ],
      },
      {
        src: `${IMAGE_ROOT}/13-existing-sponsor-prefilled.webp`,
        alt: "阿里云账号已有备案信息时的主办者信息页面，订单类型显示有主体新增互联网信息服务",
        caption:
          "这是“账号下有备案信息”的官方示例。先看顶部订单类型是否为“有主体新增互联网信息服务”；主体字段会自动带出，但仍要逐项核对并按页面要求补充材料。",
        width: 1268,
        height: 1505,
        hotspots: [
          { label: "1", left: "12%", top: "13%" },
          { label: "2", left: "41%", top: "96%" },
        ],
      },
    ],
  },
  {
    id: 5,
    title: "重新填写资料并完成人脸核验",
    summary: "已有主体也要为新增网站填写资料并完成真实性核验。",
    duration: "约 20–40 分钟",
    path: "填写主办者/网站信息 → 上传资料 → 阿里云 App 人脸核验",
    tasks: [
      "按最新证件填写主办者和网站负责人信息，逐项核对原备案信息。",
      "为新网站填写网站名称、网站内容、服务类型和网站负责人。",
      "仅在阿里云上传营业执照、负责人证件和授权材料。",
      "由页面指定的负责人本人在阿里云 App 完成人脸核验。",
      "返回电脑端刷新核验状态，确认材料完整后提交阿里云初审。",
    ],
    fill: [
      "通讯地址、负责人手机和邮箱：按当前真实信息填写",
      "网站名称与内容：和线上实际页面一致",
      "补充材料：按备案省份的当前页面提示提供",
    ],
    avoid: [
      "不要认为已有备案就可以跳过营业执照或人脸核验。",
      "不要使用原网站名称直接代替新网站名称，也不要上传过期证件。",
    ],
    done: "资料和真实性核验完成，订单已经提交阿里云初审。",
    trouble:
      "若提示原备案信息不一致，先在工信部查询并逐项修正；信息确有变化时按阿里云提示办理变更。",
    links: [
      {
        label: "查看材料上传与真实性核验",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/upload-data-and-authenticity-verification/",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/14-existing-sponsor-mobile.webp`,
        alt: "阿里云移动端已有备案主体信息页面，顶部依次显示基础信息、主体信息、服务信息、上传资料和提交订单",
        caption:
          "移动端会自动带出原主体信息，但不是直接跳过。先核对企业名称、证件号码、负责人手机和邮箱，再点“下一步”。",
        width: 475,
        height: 2888,
        portrait: true,
        hotspots: [
          { label: "1", left: "27%", top: "3%" },
          { label: "2", left: "57%", top: "98%" },
        ],
      },
      {
        src: `${IMAGE_ROOT}/07-mobile-owner-upload.webp`,
        alt: "阿里云备案移动端负责人证件上传页面，显示负责人资料上传和下一步按钮",
        caption:
          "进入上传资料环节后，由页面指定的负责人上传最新证件原件并完成人脸核验。",
        width: 479,
        height: 1492,
        portrait: true,
        hotspots: [
          { label: "1", left: "15%", top: "25%" },
          { label: "2", left: "76%", top: "62%" },
        ],
      },
    ],
  },
  {
    id: 6,
    title: "完成审核并回填备案结果",
    summary: "主体备案号通常保持不变，新网站会增加对应的网站备案信息。",
    duration: "以阿里云和备案省份管局审核时间为准",
    path: "阿里云初审 → 工信部短信核验 → 管局审核 → 已完成订单",
    tasks: [
      "保持负责人电话畅通，按阿里云订单提示完成电话确认和工信部短信核验。",
      "短信核验必须在页面提示的有效期内完成；需要多人核验时逐一确认。",
      "新增网站审核通过后，在已完成订单中核对新增网站的备案信息。",
      "确认新网站已经关联到企业现有备案主体，记录页面显示的主体备案号。",
      "返回 FrontMind 回填已备案域名和 ICP 主体备案号，等待平台确认。",
    ],
    fill: [
      "短信验证码、负责人手机号和证件号码后六位",
      "FrontMind 结果：已备案域名 + ICP 主体备案号",
    ],
    avoid: [
      "不要回填备案服务码、短信验证码或阿里云订单号。",
      "不要把新网站的网站备案号误填为 ICP 主体备案号。",
    ],
    done: "新增网站订单已完成，新网站备案状态正常，并已向 FrontMind 提交结果。",
    trouble:
      "审核驳回时只按订单中的具体原因修改；不确定主体信息或网站名称规则时联系服务专员。",
    links: [
      {
        label: "查看备案进度与结果",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-progress-and-result-inquires",
      },
    ],
    images: [
      {
        src: `${IMAGE_ROOT}/08-sms-review-stage.webp`,
        alt: "阿里云备案订单工信部短信核验阶段示例",
        caption: "订单出现“工信部短信核验—待验证”后，立即检查负责人手机。",
        width: 954,
        height: 276,
        hotspots: [{ label: "1", left: "44%", top: "50%" }],
      },
      {
        src: `${IMAGE_ROOT}/09-sms-message.webp`,
        alt: "工信部 12381 备案核验短信示例，包含验证码、核验链接和有效期一天提示",
        caption:
          "认准 12381 工信部短信：其中包含 6 位验证码、官方核验链接和一天有效期提示。",
        width: 1159,
        height: 689,
        hotspots: [
          { label: "1", left: "24%", top: "50%" },
          { label: "2", left: "48%", top: "70%" },
        ],
      },
      {
        src: `${IMAGE_ROOT}/10-sms-verification.webp`,
        alt: "工信部备案管理系统短信核验表单，依次填写验证码、手机号和证件号码后六位",
        caption:
          "在“短信核验”页依次填写验证码、手机号和证件号码后六位，再点击提交。",
        width: 1071,
        height: 1085,
        hotspots: [
          { label: "1", left: "26%", top: "45%" },
          { label: "2", left: "50%", top: "80%" },
        ],
      },
      {
        src: `${IMAGE_ROOT}/11-sms-resend.webp`,
        alt: "工信部备案管理系统短信重发页面，填写手机号和证件号码后六位后提交",
        caption:
          "长时间未收到验证码时切换到“短信重发”，核对手机号和证件号码后六位再提交。",
        width: 1079,
        height: 937,
        hotspots: [
          { label: "1", left: "75%", top: "24%" },
          { label: "2", left: "50%", top: "77%" },
        ],
      },
    ],
  },
];

const overseasStages: GuideStage[] = [
  {
    id: 1,
    title: "确认使用中国香港或海外节点",
    summary: "是否需要工信部 ICP 备案，关键看服务器节点是否在中国内地。",
    duration: "约 5 分钟",
    path: "FrontMind 账户版本 → 海外版；部署区域 → 中国香港 / 海外",
    tasks: [
      "确认当前 FrontMind 账户为海外版，并计划使用中国香港或其他海外节点。",
      "中国香港和海外节点不属于中国内地节点，无需办理工信部 ICP 备案。",
      "如果最终改用中国内地节点，必须切回国内版教程，并通过实际接入商完成备案。",
      "不确定节点时先联系服务专员确认，不要先创建阿里云 ICP 备案订单。",
    ],
    fill: ["部署版本：海外版", "部署区域：中国香港或其他海外地区"],
    avoid: [
      "不要把“域名在阿里云购买”等同于“必须备案”；是否备案取决于服务器位置。",
      "不要为香港或海外节点填写国内备案服务码。",
    ],
    done: "已确认网站不会部署在中国内地节点，因此无需工信部 ICP 备案。",
    trouble:
      "若业务要求中国内地访问速度、CDN 或内地服务器，请先让服务专员重新确认是否必须走国内备案。",
    links: [
      {
        label: "查看阿里云 ICP 备案流程适用范围",
        href: "https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview",
      },
    ],
  },
  {
    id: 2,
    title: "完成企业域名实名并购买域名",
    summary: "海外版免 ICP，但域名注册和企业实名认证仍要正常完成。",
    duration: "实名审核通常 1–5 个工作日，购买约 10 分钟",
    path: "阿里云域名控制台 → 信息模板 → 域名查询 → 购买",
    tasks: [
      "创建企业域名信息模板，单位名称和证件号码按营业执照原文填写。",
      "等待企业模板显示实名认证成功。",
      "查询并购买可注册域名，关联已实名的企业模板。",
      "在域名列表确认域名状态为“正常”。",
    ],
    fill: [
      "企业全称、统一社会信用代码和真实联系人",
      "已实名认证的企业信息模板",
    ],
    avoid: [
      "不要关联个人模板或使用企业简称。",
      "不要把 www、协议或路径当成要购买的域名。",
    ],
    done: "阿里云域名列表中能看到企业实名域名，状态为“正常”。",
    trouble:
      "模板或域名状态异常时，先按阿里云提示完成实名认证，不要先提交 FrontMind 工单。",
    links: [
      {
        label: "查看阿里云域名注册流程",
        href: "https://help.aliyun.com/zh/dws/user-guide/how-to-register-a-domain-name",
      },
    ],
  },
  {
    id: 3,
    title: "回到 FrontMind 按海外版提交域名",
    summary: "AI 运维工单会按海外部署处理，不会返回国内备案服务码。",
    duration: "提交约 1 分钟",
    path: "FrontMind → 海外版教程 → 已购买域名 → 提交域名",
    tasks: [
      "保持当前选择为“海外版 · 香港/海外节点”。",
      "在下方填写已购买的主域名并提交 AI 运维工单。",
      "系统会把海外版场景写入工单，AI 运维按香港或海外节点处理。",
      "海外版不需要备案服务码，也不需要回填 ICP 主体备案号。",
    ],
    fill: ["主域名：例如 example.com", "部署场景：海外版，中国香港或海外节点"],
    avoid: [
      "不要切回首次备案标签后再提交，否则工单场景会不准确。",
      "不要上传营业执照、身份证、人脸或验证码到 FrontMind。",
    ],
    done: "海外版域名工单已提交，历史记录显示正在处理或已完成。",
    trouble:
      "提交后若工单仍要求备案服务码，请联系服务专员核对账户版本和部署地区。",
    links: [
      {
        label: "进入阿里云域名控制台",
        href: "https://dc.console.aliyun.com/",
      },
    ],
  },
  {
    id: 4,
    title: "等待海外节点开通并配置域名",
    summary: "工单完成后再按交付说明配置解析、HTTPS 和官网内容。",
    duration: "以 AI 运维工单处理时间为准",
    path: "官网历史与交付记录 → 已完成域名工单 → 查看处理结果",
    tasks: [
      "等待 AI 运维确认香港或海外节点和域名接入方式。",
      "按处理结果配置 DNS 解析，不要提前把域名指向未准备好的地址。",
      "确认 HTTPS 证书、主域名跳转和网站可访问状态。",
      "若网站面向中国内地用户，按业务所在地和网站实际功能另行确认公安联网备案、经营许可等要求。",
    ],
    fill: [
      "DNS 记录和目标地址：只使用工单确认的配置",
      "HTTPS 证书：覆盖正式访问域名",
    ],
    avoid: [
      "不要把工信部 ICP 备案号作为海外版开通前置条件。",
      "不要忽略业务本身可能涉及的行业许可、隐私或当地合规要求。",
    ],
    done: "域名已按海外节点交付说明配置，HTTPS 正常，官网能够访问。",
    trouble:
      "解析未生效时检查 DNS 记录、TTL 和证书域名；节点或合规范围不确定时联系服务专员。",
    links: [
      {
        label: "查看阿里云域名解析说明",
        href: "https://help.aliyun.com/zh/dns/quick-start",
      },
    ],
  },
];

function GuideFigure({
  image,
  onOpen,
}: {
  image: GuideImage;
  onOpen: (image: GuideImage, trigger: HTMLButtonElement) => void;
}) {
  return (
    <figure
      className={`ai-website-guide-figure${image.portrait ? " portrait" : ""}`}
      style={
        {
          "--guide-image-width": `${image.width}px`,
        } as CSSProperties
      }
    >
      <button
        type="button"
        className="ai-website-guide-image-button"
        aria-label={`放大查看：${image.alt}`}
        onClick={(event: ReactMouseEvent<HTMLButtonElement>) =>
          onOpen(image, event.currentTarget)
        }
      >
        <span className="ai-website-guide-image-frame">
          <img
            src={image.src}
            alt={image.alt}
            width={image.width}
            height={image.height}
            loading="lazy"
          />
          {image.hotspots?.map((hotspot) => (
            <span
              aria-hidden="true"
              className="ai-website-guide-hotspot"
              key={`${image.src}-${hotspot.label}`}
              style={
                {
                  "--hotspot-left": hotspot.left,
                  "--hotspot-top": hotspot.top,
                } as CSSProperties
              }
            >
              {hotspot.label}
            </span>
          ))}
          <span className="ai-website-guide-zoom-label" aria-hidden="true">
            <ZoomIn size={15} />
            点击放大
          </span>
        </span>
      </button>
      <figcaption>
        <span>{image.caption}</span>
        <small>{SCREENSHOT_SOURCE}</small>
      </figcaption>
    </figure>
  );
}

export default function AliyunIcpGuide({
  onContactAdvisor,
  currentPhase = "domain",
  marketEdition = "domestic",
  scenario,
  onScenarioChange,
  stageThreeContent,
  filingSubmissionContent,
}: AliyunIcpGuideProps) {
  const [internalScenario, setInternalScenario] =
    useState<AliyunGuideScenario>("first_filing");
  const [openStages, setOpenStages] = useState<Set<number>>(() => new Set([1]));
  const [selectedImage, setSelectedImage] = useState<GuideImage | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const requestedScenario = scenario ?? internalScenario;
  const activeScenario =
    marketEdition === "overseas"
      ? "overseas"
      : requestedScenario === "overseas"
        ? "first_filing"
        : requestedScenario;
  const scenarioOptions = GUIDE_SCENARIO_OPTIONS.filter(
    (option) => option.marketEdition === marketEdition,
  );
  const activeStages =
    activeScenario === "existing_filing"
      ? existingFilingStages
      : activeScenario === "overseas"
        ? overseasStages
        : firstFilingStages;

  const scenarioCopy = {
    first_filing: {
      title: "企业首次备案：照着下面 7 个阶段一步一步做",
      description:
        "适用于主体和网站都没有办理过 ICP 备案的国内版客户。先注册企业实名域名，再按下面的阶段逐步办理。",
      routingTitle: "企业已有备案？请切换教程",
      routingDescription:
        "企业已有 ICP 主体备案、需要为新域名新增网站时，请切换到“已有 ICP 备案”。",
      advisorLabel: "不确定场景，联系服务专员",
      checklistTitle: "注册域名前，把这 5 样放在手边",
      checklistItems: [
        "最新版营业执照",
        "主体 / 网站负责人最新证件",
        "本人可接听的手机号",
        "可正常收信的邮箱",
        "拟注册域名（准备 2–3 个候选）",
      ],
    },
    existing_filing: {
      title: "企业已有 ICP 备案：在现有主体下新增网站",
      description:
        "适用于企业主体已经取得 ICP 备案，但本次新域名和新网站尚未备案的国内版客户。办理类型为“新增互联网信息服务（新增网站）”。",
      routingTitle: "本教程的唯一场景：已有主体 + 新域名 + 新网站",
      routingDescription:
        "请先在工信部查询并确认企业主体备案有效，再把新网站添加到该主体下；不要重新创建企业主体备案。",
      advisorLabel: "主体信息不一致，联系服务专员",
      checklistTitle: "开始前，把这 6 样放在手边",
      checklistItems: [
        "最新版营业执照",
        "主体 / 网站负责人最新证件",
        "原 ICP 主体备案号",
        "本次新增网站使用的新域名",
        "域名企业实名信息",
        "负责人可接听手机号和邮箱",
      ],
    },
    overseas: {
      title: "海外版：中国香港或海外节点无需工信部 ICP 备案",
      description:
        "适用于 FrontMind 海外版用户。域名仍需完成注册和持有者实名认证，但网站部署到中国香港或海外节点时，不进入阿里云中国内地 ICP 备案流程。",
      routingTitle: "节点一旦改为中国内地，就必须切回国内版流程",
      routingDescription:
        "请先确认购买的是中国香港或海外地域资源。若实际使用中国内地服务器、CDN 或其他内地接入资源，应切换到国内版教程并依法办理备案。",
      advisorLabel: "不确定节点，联系服务专员",
      checklistTitle: "注册域名前，把这 4 样放在手边",
      checklistItems: [
        "用于企业域名实名的营业执照",
        "域名联系人手机号和邮箱",
        "拟注册域名（准备 2–3 个候选）",
        "已确认的中国香港或海外部署地域",
      ],
    },
  } satisfies Record<
    AliyunGuideScenario,
    {
      title: string;
      description: string;
      routingTitle: string;
      routingDescription: string;
      advisorLabel: string;
      checklistTitle: string;
      checklistItems: string[];
    }
  >;
  const activeCopy = scenarioCopy[activeScenario];

  function closeImageViewer() {
    setSelectedImage(null);
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!selectedImage) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeImageViewer();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selectedImage]);

  function toggleStage(stageId: number) {
    setOpenStages((current) => {
      const next = new Set(current);
      if (next.has(stageId)) next.delete(stageId);
      else next.add(stageId);
      return next;
    });
  }

  function openImage(image: GuideImage, trigger: HTMLButtonElement) {
    returnFocusRef.current = trigger;
    setSelectedImage(image);
  }

  function selectScenario(nextScenario: AliyunGuideScenario) {
    if (!scenarioOptions.some((option) => option.value === nextScenario))
      return;
    if (scenario === undefined) setInternalScenario(nextScenario);
    onScenarioChange?.(nextScenario);
    setOpenStages(new Set([1]));
  }

  function handleScenarioKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentScenario: AliyunGuideScenario,
  ) {
    const order = scenarioOptions.map((option) => option.value);
    const currentIndex = order.indexOf(currentScenario);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % order.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + order.length) % order.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = order.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextScenario = order[nextIndex];
    selectScenario(nextScenario);
    window.setTimeout(
      () =>
        document
          .getElementById(`ai-website-guide-${nextScenario}-tab`)
          ?.focus(),
      0,
    );
  }

  return (
    <section
      className="ai-website-aliyun-guide"
      aria-labelledby="ai-website-aliyun-guide-title"
    >
      <div
        className="ai-website-guide-tabs"
        role="tablist"
        aria-label="选择域名与备案教程"
      >
        {scenarioOptions.map((item) => (
          <button
            type="button"
            role="tab"
            id={`ai-website-guide-${item.value}-tab`}
            aria-controls={`ai-website-guide-${item.value}-panel`}
            aria-selected={activeScenario === item.value}
            tabIndex={activeScenario === item.value ? 0 : -1}
            onClick={() => selectScenario(item.value)}
            onKeyDown={(event) => handleScenarioKeyDown(event, item.value)}
            key={item.value}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        className="ai-website-guide-tab-panel"
        role="tabpanel"
        id={`ai-website-guide-${activeScenario}-panel`}
        aria-labelledby={`ai-website-guide-${activeScenario}-tab`}
        tabIndex={0}
      >
        <div className="ai-website-guide-intro">
          <div className="ai-website-guide-notice">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <strong id="ai-website-aliyun-guide-title">
                {activeCopy.title}
              </strong>
              <p>{activeCopy.description}</p>
            </div>
          </div>

          <div className="ai-website-guide-routing">
            <div>
              <strong>{activeCopy.routingTitle}</strong>
              <p>{activeCopy.routingDescription}</p>
            </div>
            {onContactAdvisor && (
              <button
                type="button"
                className="ai-website-guide-advisor-button"
                onClick={onContactAdvisor}
              >
                <MessageCircle size={17} aria-hidden="true" />
                {activeCopy.advisorLabel}
              </button>
            )}
          </div>

          <div className="ai-website-guide-checklist">
            <div className="ai-website-guide-checklist-heading">
              <ListChecks size={20} aria-hidden="true" />
              <div>
                <strong>{activeCopy.checklistTitle}</strong>
                <p>所有证件只在阿里云提交，FrontMind 不接收也不保存。</p>
              </div>
            </div>
            <ul>
              {activeCopy.checklistItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>

          <div className="ai-website-guide-version-note">
            <Clock3 size={16} aria-hidden="true" />
            <p>
              教程与截图核对日期：2026-07-31。阿里云界面及各省管局规则可能调整，
              <strong>实际办理时以阿里云当前页面和备案省份规则为准。</strong>
            </p>
          </div>
        </div>

        <ol className="ai-website-guide-stage-list">
          {activeStages.map((stage) => {
            const expanded = openStages.has(stage.id);
            const headerId = `ai-website-guide-${activeScenario}-stage-${stage.id}-header`;
            const panelId = `ai-website-guide-${activeScenario}-stage-${stage.id}-panel`;

            return (
              <li key={stage.id} data-expanded={expanded}>
                <button
                  type="button"
                  id={headerId}
                  className="ai-website-guide-stage-toggle"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => toggleStage(stage.id)}
                >
                  <span className="ai-website-guide-stage-number">
                    {stage.id}
                  </span>
                  <span className="ai-website-guide-stage-title">
                    <strong>{stage.title}</strong>
                    <small>{stage.summary}</small>
                  </span>
                  <span className="ai-website-guide-stage-duration">
                    <Clock3 size={14} aria-hidden="true" />
                    {stage.duration}
                  </span>
                  <ChevronDown
                    size={19}
                    aria-hidden="true"
                    className={expanded ? "expanded" : ""}
                  />
                </button>

                {expanded && (
                  <div
                    id={panelId}
                    role="region"
                    aria-labelledby={headerId}
                    className="ai-website-guide-stage-panel"
                  >
                    <div className="ai-website-guide-click-path">
                      <strong>点击路径</strong>
                      <span>{stage.path}</span>
                    </div>

                    <div className="ai-website-guide-task-block">
                      <h4>照着做</h4>
                      <ol>
                        {stage.tasks.map((task) => (
                          <li key={task}>{task}</li>
                        ))}
                      </ol>
                    </div>

                    {stage.id === 3 && stageThreeContent}

                    {stage.images && (
                      <div className="ai-website-guide-visuals">
                        {stage.images.map((image) => (
                          <GuideFigure
                            image={image}
                            onOpen={openImage}
                            key={image.src}
                          />
                        ))}
                      </div>
                    )}

                    <div className="ai-website-guide-tips">
                      <section data-tone="fill">
                        <strong>需要填写什么</strong>
                        <ul>
                          {stage.fill.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </section>
                      <section data-tone="avoid">
                        <strong>不要这样填</strong>
                        <ul>
                          {stage.avoid.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </section>
                    </div>

                    <div className="ai-website-guide-stage-outcomes">
                      <div className="ai-website-guide-complete">
                        <CheckCircle2 size={18} aria-hidden="true" />
                        <p>
                          <strong>完成标志</strong>
                          {stage.done}
                        </p>
                      </div>
                      <div className="ai-website-guide-trouble">
                        <CircleHelp size={18} aria-hidden="true" />
                        <p>
                          <strong>卡住时怎么办</strong>
                          {stage.trouble}
                        </p>
                      </div>
                    </div>

                    <div className="ai-website-guide-links">
                      {stage.links.map((link) => (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          key={link.href}
                        >
                          {link.label}
                          <ExternalLink size={14} aria-hidden="true" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        {currentPhase === "icp" && marketEdition === "domestic" && (
          <>
            <div className="ai-website-guide-finish">
              <CheckCircle2 size={22} aria-hidden="true" />
              <div>
                <strong>阿里云已显示备案通过？</strong>
                <p>
                  请从已完成订单详情中复制 ICP
                  主体备案号，然后只在下方回填域名和备案号。
                </p>
              </div>
              <a href="#ai-website-result-form">我已取得备案号，去填写结果</a>
            </div>
            {filingSubmissionContent}
          </>
        )}

        <div className="ai-website-guide-security">
          <AlertTriangle size={17} aria-hidden="true" />
          <p>
            FrontMind
            不会索要阿里云密码、短信验证码、证件照片或人脸信息。若有人要求通过微信发送这些材料，请立即停止。
          </p>
        </div>
      </div>

      {selectedImage && (
        <div
          className="ai-website-guide-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`截图大图：${selectedImage.alt}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeImageViewer();
          }}
        >
          <div className="ai-website-guide-lightbox-card">
            <button
              type="button"
              ref={closeButtonRef}
              onClick={closeImageViewer}
              aria-label="关闭截图大图"
            >
              <X size={20} aria-hidden="true" />
            </button>
            <img
              src={selectedImage.src}
              alt={selectedImage.alt}
              width={selectedImage.width}
              height={selectedImage.height}
            />
            <p>{selectedImage.caption}</p>
          </div>
        </div>
      )}
    </section>
  );
}
