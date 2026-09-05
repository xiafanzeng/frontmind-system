---
name: frontmind-article-visual-reference-system
description: S6 视觉参考体系。整理现有 Logo、品牌色、企业实图和可选解释性视觉规则；只检查最终可使用资产的权利与真实性，无合规图片时自动跳过并让文章以纯文字继续。
---

# S6 视觉参考体系

## 目标

让真实品牌资产可被单篇文章安全调用，同时保留品牌封面、编辑视觉、导航图、解释图和证明图四类作用。视觉是增强项，不是正文生成的前置条件。

## 输入

- S2 Image Registry 与已保留的物理图片；
- 可选 S4 信息架构、S5 话语契约和内容模式 Registry。

## 工作步骤

1. 只把 `usage_status=usable` 且权利为 `approved/approved_with_credit` 的图片列入可直接使用资产。
2. `qualified/excluded` 图片保留状态但不用于成稿；单图无权利不影响其他视觉和正文。
3. 记录颜色、字体回退、Logo 安全区、摄影/插画倾向和禁用风格；没有正式 VI 时标为推断参考。
4. 视觉功能使用 `brand_editorial/navigate/explain/prove`：前两类不算证据，`explain` 可只绑定章节概念，`prove` 必须连接可用事实。
5. 每个 P 模式可有自己的视觉配方，不设置全局固定图片数，也不删除纯装饰/编辑视觉。
6. Logo 永远使用真实原文件 overlay；不得生成、猜测或重绘。
7. 企业产品、团队、客户、证书、病例和项目现场不得由 AIGC 冒充。

没有合规图片时仍输出最小 visual reference，状态为 `completed_with_limits`，执行层继续纯文字。

## 输出与校验

- `S6_{brand_label}_visual_reference.json`
- `S6_{brand_label}_视觉参考体系.md`

```bash
python3 -B ../scripts/produce_strategy_assets.py \
  --brand "品牌正式名称" \
  --work-dir /path/to/project \
  --pattern-registry /path/to/package/shared/content-pattern-registry.json \
  --through S6
```

没有可用图片时仍生成 `text_first_no_approved_asset` 视觉合同，供 E7 明确采用纯文字路径。单项权利问题只排除该图。
