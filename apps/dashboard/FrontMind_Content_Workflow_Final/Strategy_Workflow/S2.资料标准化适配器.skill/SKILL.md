---
name: frontmind-reference-material-adapter
description: S2 资料标准化适配器。一次读取 S1 已识别的 Pack、KB、ZIP、目录或企业文档，生成轻量 v2.2 knowledge/source/claim/image Registries，并以 usable、qualified、excluded 表示内容可用性；不要求第二次运行。
---

# S2 资料标准化适配器

## 目标

把现有内容整理成后续阶段可引用的稳定对象，并保持来源与声明之间的真实关系。

## 执行

先读 `references/registry-contract.md`，运行一次：

```bash
python3 -B scripts/kb_v4_adapter.py \
  --brand "品牌正式名称" \
  --input "/path/to/the-same-material-used-by-S1" \
  --s1-intake "/path/to/project/S1/S1_brand_label_intake.json" \
  --gallery "/optional/client-gallery" \
  --output-dir "/path/to/project/S2"
```

`--gallery` 与 `--s1-intake` 可省略。v2.1 Pack 的现有 Registry 自动升级使用状态；working-set 的 leaves、nodes 与 evidence ledger 直接转换；普通文档使用内置提取器读取可用文本并保留原文件。

## 输出

- `S2_{brand_label}_knowledge_registry.json`
- `S2_{brand_label}_source_registry.json`
- `S2_{brand_label}_claim_registry.json`
- `S2_{brand_label}_image_registry.json`
- `S2_{brand_label}_adapter_report.json`
- `sources/` 与 `assets/`

所有新 Registry 使用 `schema_version=2.2.0`。对象只增加可执行的 `usage_status`：

- `usable`：普通用户上传事实或可靠公开材料，可直接使用；
- `qualified`：时效、条件、抽取完整度或证据强度需要限定；
- `excluded`：明确内部/保密、个人信息、高风险操作指令、禁止公开声明或权利不清图片。

## 事实与视觉边界

用户上传并要求制作内容，视为授权工作流处理其中的普通企业事实；不需要为每个来源再次填写审核人、时间或依据。第一方资料可以支持本品牌事实，但不能单独推出排名、口碑、竞品优劣或领先结论。

客户图片在没有明确权利状态时保留于 Image Registry，但标为 `excluded`，不影响文本流转。真实 Logo 只能以后作为原文件叠加，不能生成或重绘。

单项 `qualified/excluded` 只进入报告和对象状态，不导致整批失败。只有全部文档均无法正规化或输入路径不安全时停止。
