---
name: frontmind-reference-pack-assembler
description: S9 Reference Pack 装配师。在 S8 内容摘要被用户确认后，把四类 Registry、S3–S7 写作资产和物理材料装入兼容的轻量 FrontMind Reference Pack v2.2；只检查实际内容和路径安全，不重跑上游审计。
---

# S9 Reference Pack 装配师

## 目标

生成执行层可直接读取的轻量 Pack。S9 要求 S3–S7 都已运行：S3 可以明确跳过，S6/S7 内容可以为空，但 S4 信息证据架构和 S5 话语契约必须存在。Pack 只携带写作需要的内容。

## 状态检查

```bash
python3 -B scripts/state_detector.py --work-dir "/path/to/project"
```

S1、四类 S2 Registry、S4–S8 是核心阶段；S3 无趋势时产物状态为 `skipped_optional`。状态工具不对对象重新审查。

## 构包

```bash
python3 -B scripts/pack_builder.py \
  --brand "品牌正式名称" \
  --work-dir "/path/to/project" \
  --version 1 \
  --output "/path/to/project/ReferencePack/S9_brand_label_reference_pack_v1.zip"
```

`reference_pack.json` 使用：

- `schema_version=2.2.0`；
- `profile=frontmind-content-reference-pack-v2.2`；
- `brand.canonical_name/aliases`；
- `material_index_path`；
- 四个 Registry 相对路径；
- `information_architecture_path/trend_viewpoints_path/voice_path/visual_rules_path/question_library_path`；每项都必须指向真实 S3–S7 产物；
- 非阻断 warnings。

Pattern Registry 和模板研究索引由 Workflow 自身读取，不复制到每个企业 Pack。S2 `sources/` 与 `assets/` 中的实际材料随包携带。

只有核心 Registry、S4/S5 内容、S3/S6/S7 状态产物缺失/不可读取或包路径不安全时停止。S8 是否已获用户确认由总控状态控制。完成后用包根轻量 validator 检查：

```bash
python3 -B ../../shared/scripts/validate_package.py S9_brand_label_reference_pack_v1.zip
```
