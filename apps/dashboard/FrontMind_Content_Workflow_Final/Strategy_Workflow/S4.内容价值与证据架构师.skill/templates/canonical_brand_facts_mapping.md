# Canonical Brand Facts 映射清单

结构只以包根 `shared/brand_facts.schema.json` 为准。本清单帮助从 S2/S4 映射，不能替代根 schema。

| 根字段 | 主要来源 | 最低门槛 |
|---|---|---|
| brand_identity | S2 identity knowledge/claims | canonical name + 至少一个 src_ |
| positioning | S4 positioning + S2 claims | 品类框架、品牌角色、差异化价值和 RTB 来自真实事实 |
| offerings | S2 product knowledge/claims | 事实陈述、claim IDs、source IDs 和使用状态 |
| capabilities | S2 capability claims | 事实陈述、claim IDs 和 source IDs |
| proof_points | S4 proof bundles | 主张、clm_/src_、可用措辞和必要限定 |
| limitations | S4 publication/comparison boundary + S2 | 只保存实际存在的限制事实 |

不得使用 `TBD/待确认/unknown` 填满结构。缺少某项事实时省略该项或标记为可选研究缺口；只要仍有足够品牌身份与正文事实，就继续下游内容制作。
