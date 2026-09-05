# 文章话语契约方法

本方法保留品牌语言考古、Tone of Voice、Messaging House 与证据砖的核心价值，并把输出收敛为可执行、可验证的文章规则。

## 1. 三层结构

| 层 | 回答 | 文章输出 |
|---|---|---|
| 品牌人格 | 我们以什么关系面对读者 | 稳定语气原则 |
| 话语风格 | 句子听起来怎样 | 可观察的句式、节奏、术语规则 |
| 信息表达 | 具体说什么、凭什么 | message + proof refs + allowed wording |

人格不能用“专业、创新、可信”三个泛词结束。将其转成可观察行为，例如“先说限制再说优势”“每个技术术语首次出现用一句白话解释”“避免制造紧迫感”。

## 2. 语言考古

### 样本

- S1 中客户确认的品牌文案、产品命名、口号；
- knowledge registry 中官网、产品文档、创始人/专家原话；
- 真实销售/客服/培训材料；
- 已批准的高质量内容。

### 记录

每个样本标来源 ID、原句、使用场景、受众、日期、是否仍有效。识别：高频但有意义的品牌词、固定术语、句长、主动/被动、解释方式、承诺强度、读者称谓与 CTA。

不要把通用行业写作风格冒充品牌原生话语。样本不足时输出中性契约并标 `language_sample_gap`。

## 3. Tone of Voice

用连续维度而非形容词堆砌：

- 正式 ↔ 口语；
- 权威陈述 ↔ 协作解释；
- 克制 ↔ 热烈；
- 高密度 ↔ 易读拆解；
- 品牌中心 ↔ 用户任务中心；
- 直接建议 ↔ 条件化建议。

每个维度写默认位置、何时偏移、正例和反例。医疗、金融、法律、性能承诺等高风险内容默认更克制、更条件化。

## 4. 术语系统

### Preferred Terms

每项包含：canonical term、允许变体、首次解释、不可混淆对象、source refs、适用 `entry_category` 或 publication form。

### Avoid Terms

只禁用有明确风险的词：绝对化、虚假比较、陈词滥调、行业误用、与品牌人格冲突或可能造成法律/合规风险。每项必须写理由和替代表达；不追求固定数量。

### 命名一致性

品牌名、产品名、功能名、缩写、大小写、版本与单位必须跟 S2 registries 一致。不同来源冲突时进入修改项，不由写作者自行选择。

## 5. Messaging House

```text
core message
├── pillar 1 → proof bundle(s) → allowed wording → caveat
├── pillar 2 → proof bundle(s) → allowed wording → caveat
└── pillar 3 → proof bundle(s) → allowed wording → caveat
```

核心 message 是写作方向，不自动成为可客观断言的句子。实际进入成稿的重要事实连接 S4 proof 或 S2 claim/source；没有支持时降为愿景表达、研究缺口或禁用，不必为未使用的 pillar 构造对象。

## 6. 证据措辞

### public_fact

可以陈述，但保留对象、时间、地域、版本、量级和方法限定。不得把“某次/某客户/某样本”推广为全部。

### public_with_qualification

用“官方资料显示”“品牌表示”“产品文档说明”等明确来源主语。后续编辑不得删除归因。

### internal_only

不进入成品正文。可以在 brief 的待核验项出现，并指定需要的来源类型。

### do_not_use

不得出现在标题、正文、FAQ、图注、alt、CTA 或视觉文字中。

## 7. 句式与解释

- 一段只推进一个主要判断；
- 先结论方向，再讲条件、机制与证据；
- 因果关系必须有因果证据，否则写关联/同时发生；
- 技术机制用实体与动作解释，避免只换同义术语；
- 列表项使用同一语法层级；
- 风险与限制放在读者做决定前，而非尾注隐藏。

固定句式只作为 scaffold，不能让每篇文章机械同声。

## 8. 竞品比较

点名不是一律禁止。满足 S4 comparison boundary、同维度、同时点、同口径且有 source/proof refs 时可以比较；否则解释选择标准或分别归因，不判整体胜负。

禁止用“碾压、吊打、唯一、最强”等词替代证据。引用竞品官方信息时同样保留归因和版本日期。

## 9. 入口口吻、文体与内容模式

五个 `entry_category` 可以覆盖决策口吻、解释深度、CTA 强度、术语密度与 proof minimum。publication form（objective article/news/technical 等）只调整文体，不构成另一层运行时分类。文章结构来自包根共享 registry 中执行层为单篇选择的一个 `pattern_id`；S5 不复制模式字段，任何 override 都不能放宽证据边界。

## 10. Prompt 注入

推荐注入顺序：claim policy → default voice → terminology → messaging house → comparison rules → entry tone → optional publication form → selected pattern → brief。只注入规则和对象 ID，正文需要事实时从 Reference Pack 按 ID 读取，避免在 prompt 中复制一套过期事实。
