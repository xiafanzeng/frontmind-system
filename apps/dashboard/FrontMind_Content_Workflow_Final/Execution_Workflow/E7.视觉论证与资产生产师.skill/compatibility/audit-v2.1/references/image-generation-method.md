# 生成式视觉制作方法（v2.1 非活动归档）

> 仅供迁移查阅；其 Registry/SHA 绑定不属于 v2.2 运行链。

本方法只适用于“解释”和“导航”视觉，以及有来源数据可复算的图形化表达。企业现场、团队、客户、证书、产品界面、真实事件和项目结果必须使用已授权的 canonical `image_registry` 原图，缺失就进入 `missing_assets`，不得生成替代物。

## 单一 Prompt Plan

归档计划当时使用 `../../../templates/prompt_plan_schema.json` 的 `images[]`。每项用 `visual_pattern_id` 读取 S7 `visual_patterns[].prompt_scaffold`；不读取旧 `visual_motifs/motif_id/positive_prompt`。文字策略只有：

- `no_text`：模型生成无文字底图；
- `no_aigc`：使用已批准的既有资产，不调用生成模型。

模型 Prompt 必须明确：不画 Logo、不写品牌名、不生成水印或近似标志，并为后续原件叠加留出干净区域。

## Logo 原件叠加

Logo 只能来自根 `image_registry.images[]` 中已批准、哈希一致且被 S7 声明为 Logo 的资产。Logo 不作为 img2img 参考，也不能由模型重绘。底图通过尺寸/清晰度检查后，`aigc_invoker.py` 从 `--base-package-root` 按 Pack 根相对路径读取签名原始 Logo，做确定性叠加，再计算最终 SHA256。

## 事实约束

- `generated_explanatory` 不能充当真实事实证明；
- `generated_data_chart` 必须绑定来源和正文已核验 claim；
- 图中每个数字、对象、顺序和条件均须能回溯到正文 claim；
- 比较图对象使用相同维度，不使用无依据总分、星级或“最佳”徽章；
- Prompt、模型可用性、底图和叠加结果分别记录，只有 Prompt 不等于成图。

## 技术检查

文件必须可打开、满足交付尺寸、无乱码/伪文字，SHA256 与 Registry 一致；感知相似度达到阈值时拒绝重复图。签名 base Registry 的 `file_path` 以 `--base-package-root` 解析，job-local runtime Registry 以 `--job-package-root` 解析；禁止绝对路径和 `..`。运行时感知哈希只写入去重报告，不写回签名 Registry。
