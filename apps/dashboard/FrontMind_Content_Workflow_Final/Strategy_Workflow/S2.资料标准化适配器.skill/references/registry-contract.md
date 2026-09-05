# 四类 Registry v2.2 适配说明

唯一结构以包根 `shared/registries.schema.json` 为准。Registry 只用于组织可写作内容。

## 公共状态

每个对象使用 `usage_status`：

| 状态 | 含义 | 下游行为 |
|---|---|---|
| `usable` | 普通企业事实或可公开材料 | 可直接进入写作上下文 |
| `qualified` | 有时效、条件、归因或抽取限制 | 保留限定后使用 |
| `excluded` | 内部/保密、隐私、高风险操作、禁止声明或无权利视觉 | 不进入公开正文/视觉 |

对象级状态互不连坐。一个对象被排除不改变其他对象。

## Knowledge Registry

`knowledge_registry/knowledge_units` 保存 `kn_` ID、标题、正文、包内材料路径、来源和图片引用。内容可来自 working-set leaf、canonical 文档或普通上传文件。缺少历史树节点 ID 不影响建立知识单元。

## Source Registry

`source_registry/sources` 保存 `src_` ID、标题、URL或包内文件路径、来源类型和 `usage_status`。用户上传且没有内部/隐私标记的企业资料默认可用；明确内部内容标为 excluded。

第一方来源可支持本品牌事实，但不能独立推出排名、市场口碑、竞品优劣、专家共识或行业领先。

## Claim Registry

`claim_registry/claims` 保存 `clm_` ID、声明文本、涉及实体、source IDs 和可用状态。为兼容执行层，可继续保存：

| `usage_status` | `verification_status` | `allowed_usage` |
|---|---|---|
| usable | verified | public_fact |
| qualified | verified_with_limits | public_with_qualification |
| excluded | disallowed | do_not_use |

Statement 与 source 的语义是否吻合仍需在 E6 检查；S2 不要求每段材料拆成完备 claim graph。

## Image Registry

`image_registry/images` 使用 `image_id=img_*`，保存相对文件路径、资产类型、权利状态、允许作用和使用状态。无明确权利的用户图片保留但 excluded，不阻断文本 Pack。

实际使用视觉的功能为 `brand_editorial/navigate/explain/prove/entity_proof`。Logo 必须是真实文件，不得由生成模型重绘；证明型视觉只能连接正文可用事实。

## 稳定 ID 与材料文件

- ID 使用 `kn_/src_/clm_/img_`；
- 路径必须是安全相对路径；
- 内容摘要与原文件同时保留，抽取失败时原文件仍可作为 qualified 来源；
- 稳定 ID 只用于引用和去重，不构成跨阶段继续条件。

## 兼容输入

Reference Pack v2.1、canonical KB v4、frontmind.kb-working-set、旧 Pack、普通 ZIP/目录和支持的单文件均走同一适配器。manifest、source index、knowledge tree 和历史 Registry 存在时复用；不存在时直接从实际材料建索引。
