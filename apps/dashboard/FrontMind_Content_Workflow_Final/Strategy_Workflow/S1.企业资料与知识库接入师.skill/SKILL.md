---
name: frontmind-enterprise-material-intake
description: S1 企业资料与知识库接入师。宽容识别 FrontMind v2.1/v2.2 Pack、canonical KB v4、frontmind.kb-working-set v5、旧 Pack、普通 ZIP/目录和常用企业文档或图片；在保留压缩包路径安全的前提下，让已有内容直接进入 S2。
---

# S1 企业资料与知识库接入师

## 目标

判断现有输入“能否提供可读企业内容”，而不是要求它先符合某个历史封装。不要重建用户已经提交的知识库，不要因缺少 manifest、source index、knowledge tree 或版本标签而停止。

## 执行

```bash
python3 -B scripts/canonical_kb_intake.py \
  --brand "品牌正式名称" \
  --input "/path/to/reference-pack-kb-zip-directory-or-document" \
  --intake-route auto \
  --output "/path/to/project/S1/S1_brand_label_intake.json"
```

脚本自动检测：

- `frontmind-content-reference-pack-v2.1/v2.2`；
- `schemaVersion=4/profile=dashboard-enterprise-v1`；
- `kind=frontmind.kb-working-set`，包括 Skill v5；
- 其他安全 ZIP、目录和支持的文档/图片。

`auto/direct` 直接进入 S2。只有散乱资料确实需要深度知识库补全时才使用 `--intake-route legacy_enrichment`。统一 Runner 会以内部 `frontmind-controller-provider/v1` 动作 `legacy_enrich_materials` 同时传入：

- `compatibility/legacy-s1/SKILL.md` 中保持字节不变的旧 S1；
- 部署随 FrontMind 提供的 Socratic KB Builder；
- 当前可读原材料及目标品牌。

控制器必须实际读取并执行这两个 Skill，把 canonical KB、working-set 或其他 S2 可安全读取的材料 ZIP 写回当前工作目录；Runner 会重新执行 S1 安全读取检查，再让 S2 消费增强产物。该动作是内部内容转换，不是用户暂停，也不生成 receipt、审批表或哈希门。

若固定 provider、KB Builder 或增强产物不可用，而原始材料仍可读取，S1 写入 `legacy_enrichment_unavailable` 或 `legacy_enrichment_failed` warning，并立即让 S2 消费原始材料；不得为了可选增强阻断 Pack。`FRONTMIND_KB_BUILDER_SKILL` 仅是部署级定位覆盖，普通操作者不填写。

历史索引存在时记录为 `optional_indexes`；不存在时直接按实际文件读取。输出只记录输入名称、识别类型、所选路径、相对成员路径、可用项、跳过项和警告，不记录本机绝对路径。

## 处理原则

- 单个不支持的文件标记 `skipped_files`，其余内容继续；
- 目录中的符号链接跳过；
- ZIP 中重复路径、绝对路径、`..` 路径逃逸或危险压缩比影响整个包安全时停止；
- 输入至少包含一项支持的文档或图片即可完成 S1；
- S1 不验证每份内容的发布强度，具体可用性由 S2/S8 处理。

输出满足 `templates/canonical_kb_intake.schema.json`，状态为 `completed` 或 `completed_with_limits`。完成后直接进入 S2。
