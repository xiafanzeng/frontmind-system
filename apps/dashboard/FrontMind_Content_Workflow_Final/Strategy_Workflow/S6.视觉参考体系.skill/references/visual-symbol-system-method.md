# 文章视觉参考体系方法

本方法保留文化母体、表达系统与视觉文法的价值，并把它们收敛到文章封面和正文解释图。视觉的任务是提高识别、理解、证据透明度与阅读节奏，不是单独做一套品牌重塑。

## 1. 三层视觉语法

### 核心识别层

真实 Logo、标准色、字体、品牌形状与产品/环境实拍。直接或覆盖使用只选择 S2 中 `rights_status=approved/approved_with_credit` 的资产。缺少正式 VI 时可形成 `inferred_reference`，但不得称为官方规范。

### 叙事符号层

将品牌与品类中的熟悉文化母体、空间关系、动作或机制转成反复使用的视觉隐喻。选择时检查：目标受众能否理解、联想是否正面、是否与竞品混淆、能否承载具体信息、是否存在文化/地域风险。

### 应用层

把前两层映射到：封面、定义图、流程图、机制图、比较表、数据图、案例图、风险/边界提示与图注。每个槽位说明目的、信息源、尺寸、资产和验收规则。

## 2. 表达系统

可从五类规则组织视觉，但按文章需要选择：

1. 标志：Logo、标准字、认证标识；
2. 色彩：主色、辅色、强调色、背景与对比；
3. 版式：网格、层级、留白、标题与标注；
4. 图像：摄影、插画、信息图、图标；
5. 动态线索：仅在后续视频/动图需要时记录，不进入静态文章硬门槛。

色彩比例不能机械套 60/30/10；应按信息层级、可访问性与实际品牌资产决定。每个色值记录来源资产、角色和允许背景。

## 3. Visual Grammar

像语言一样定义可组合部件：

- **名词**：Logo、产品、人物、场景、实体图标；
- **动词**：连接、流动、聚合、分解、比较、保护；
- **形容词**：颜色、材质、光线、质感；
- **语法**：主体位置、视线方向、留白、比例、层级与标注。

每个 visual pattern 固定关键语法、开放少量变量，保证文章间一致但不机械重复。

## 4. 资产锚定模式

| 条件 | 模式 | 做法 |
|---|---|---|
| 有正式 Logo/VI/图库 | constrained | 严格使用真实色值、字体与独立 overlay 资产 |
| 只有部分配色或照片 | semi_constrained | 已知部分固定，未知部分标 inferred 并限制用途 |
| 无品牌资产 | inference_reference | 只提供中性信息图和场景参考，不发明官方视觉 |

过去把 Logo 当 img2img 参考会导致形变、错字和商标风险。新规则是：生成画面预留 Logo 区域，最终叠加 registry 中的真实文件；认证标识、产品 UI 与关键文字同理。

## 5. 真实照片优先级

当文章涉及团队、工厂、门店、产品形态、实际使用环境或客户案例时，合规真实照片优先于 AI 合成。AI 图适合抽象机制、不可摄影的概念和风格化封面；不得伪装成真实案例证据。

直接使用前检查：权利、人物肖像/隐私、客户授权、版本时效、地理/场景真实性、裁剪范围与图注准确性。

## 6. Prompt Scaffold

Prompt 不写死一段漂亮描述，而是结构化变量：

```text
purpose + subject + action/relationship + environment + composition
+ palette_refs + typography_slot + factual_constraints
+ negative_constraints + output_ratio + overlay_reservations
```

`palette_refs/asset_refs/message_refs/proof_refs/pattern_refs` 使用稳定 ID。工具专用参数参考 `ai-image-tool-prompt-syntax.md`，但工具语法不是视觉策略本身。

## 7. 文章视觉模式最低字段

- `visual_pattern_id` 与 purpose；
- message/problem refs；
- 共享内容 pattern refs；
- cover/inline slots；
- direct asset refs 与生成部分；
- prompt scaffold 与 negative constraints；
- logo overlay reservation；
- alt/caption/contrast；
- 人工验收门。

## 8. 验收

- 一眼能看出文章在解释什么，而非只有抽象装饰；
- 品牌识别来自真实资产和一致语法；
- 数据图能回到数据来源，示意图明确标示意；
- 无不可读文字、伪 Logo、错误产品界面或权利不明素材；
- 移除品牌色后仍有清晰信息层级；
- 视觉 pattern 能被不同文章复用且保留必要变量。
