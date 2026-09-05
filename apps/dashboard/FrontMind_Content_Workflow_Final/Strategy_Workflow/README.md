# FrontMind 内容资料工作流（S1–S9）

策略层把用户已经提供的企业资料整理成可直接写作的轻量 Reference Pack。v2.3 运行契约以内容可用性和文章质量为先；Reference Pack 继续使用 v2.2 wire profile，现有 Pack 无需重建。

## 连续流程

`S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9`

| 阶段 | 职责 | 续跑行为 |
|---|---|---|
| S1 | 识别 Pack、KB、ZIP、目录和常用文档/图片 | 格式不同自动适配；单项不可读则跳过 |
| S2 | 一次生成 knowledge/source/claim/image Registries | 对象标为 `usable/qualified/excluded` |
| S3 | 补充确实影响文章的新鲜趋势 | 没有可靠信号时自动跳过 |
| S4 | 提炼已有定位、价值、事实边界与品牌优先角度 | 只生成真实存在的内容，不填充空洞结构 |
| S5 | 形成第三方客观报道＋品牌宣传稿的写作契约 | 缺少入口特例时使用默认文风 |
| S6 | 整理可安全使用的品牌视觉 | 无合规图片时继续纯文字 |
| S7 | 保存已有问题与 FAQ 参考 | 不凑数量；单篇 FAQ 由执行层完成 |
| S8 | 生成 Pack 确认摘要并检查内容可用性 | 新建或更新 Pack 时停在 `awaiting_pack_confirmation` |
| S9 | 生成轻量 Reference Pack v2.2 | 用户确认摘要后运行；不生成额外确认工件 |

S3 可以输出 `skipped_optional`；S4、S5 必须生成实际内容；S6、S7 即使没有资产也必须生成可空结果。缺少趋势、第三方资料、图片或历史状态文件均不是阻断条件。

## 统一生产接口

S1、S2 完成后，由一个内容生产器连续完成 S3–S8：

```bash
python3 -B Strategy_Workflow/scripts/produce_strategy_assets.py \
  --brand "品牌正式名称" \
  --work-dir "/path/to/work" \
  --pattern-registry "/path/to/shared/content-pattern-registry.json" \
  --through S8
```

`--pattern-registry` 默认读取包内 Registry；`--trend-signals` 可选。S8 输出 `S8_*_pack_summary.json` 和人类可读确认摘要。用户只确认品牌事实、宣传重点、禁写主张、文风和视觉；修正直接更新内容资产。

## 可接受输入

- FrontMind Reference Pack v2.1/v2.2 和旧 Pack；
- `dashboard-enterprise-v1` canonical KB v4；
- `frontmind.kb-working-set`，包括 Skill v5 输出；
- 普通 ZIP、目录、JSON、Markdown、TXT、HTML、CSV/TSV、PDF、DOCX、PPTX、XLSX；
- PNG、JPEG、WebP 和 SVG 图片。

旧 manifest、source index 与 knowledge tree 只作为可选加速索引。散乱资料可直接进入 S1，不需要先构造某个历史版本的企业归档。

## 内容状态

- `usable`：可直接支持本品牌普通事实；
- `qualified`：可使用，但正文需保留时间、条件、归因或其他限定；
- `excluded`：明确内部、保密、个人隐私、高风险操作指令、禁止公开声明或无权利视觉。

第一方资料可支持本品牌身份、产品、规格、流程、公开价格、政策、事件和限制；不能单独推出客观排名、市场口碑、竞品优劣、专家共识或行业领先。

## 真正阻断条件

只有全部输入不可安全读取、无法识别任何内容、核心身份事实存在无法调和的冲突，或排除风险内容后已没有可用/可限缩文本时，策略层才停止。路径逃逸、压缩炸弹等影响整个输入的安全问题同样停止处理。

Reference Pack v2.2 只携带写作所需的 Registry、写作资产和实际材料，不加入身份核对类工件。
