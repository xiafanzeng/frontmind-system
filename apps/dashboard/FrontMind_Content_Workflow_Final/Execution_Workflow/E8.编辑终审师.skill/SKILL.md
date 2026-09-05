---
name: frontmind-editorial-master-editor
description: >
  E8 编辑终审师。在当前阶段直接修正无标题正文的问题回答、比较公平、文风、FAQ、模式和可读性，
  输出唯一 editorial_master 与非门控 warnings；不生成十二门审计、质量收据或 SHA 文件。
---

# E8 编辑终审师

## 三轮出版编辑

读取 E7 Content Model、`editorial_context.json` 和 E4 Blueprint。规则层先整理编辑简报；E8 Skill 必须在同一上下文中对整篇文章依次完成：

1. **内容编辑**：核心问题、品牌优先、候选公平、读者取舍、必要安全内容和 FAQ 价值。
2. **行文编辑**：删除审稿腔、同构句、机械连接词和语义重复，调整段落节奏；未知信息直接省略或集中改成读者行动。
3. **事实回查**：重新核对实体、数字、日期、价格、能力、医疗信息及其 fact IDs，自动刷新实际使用来源。

正文不得出现资料状态、审批状态、证据缺口或 Workflow 思考过程。P02 缺同口径事实时不打印“待核验”标签；保留有事实支持的共同维度，其余转为一次性的面诊或咨询问题。

发现问题直接由 E8 编辑模型重写当前整篇稿件，不要求回到 E4/E5/E6。图片问题可丢图；E8 始终独立形成完整安全正本，再交给 E9 的正式 HarnessGEO 调用。确定性代码只生成编辑反馈、检查事实绑定、刷新来源和清理标点空格；不得替换语义词、删除句子或删改段落。

## 输出

- `E8_{job_id}_editorial_master.json`：唯一无标题安全正本；
- `E8_{job_id}_editorial_summary.json`：自动修订和 warnings，不作为下游输入。

先生成内部编辑简报，不产生用户暂停：

```bash
python scripts/editorial_audit.py \
  --model E7_content_model.json \
  --working-context editorial_context.json \
  --blueprint article_blueprint.json \
  --editing-brief E8_editing_brief.json \
  --brief-only \
  --job-state job_state.json
```

总控读取简报后整篇编辑，生成 `E8_edited_model.json`，再执行正式终检：

```bash
python scripts/editorial_audit.py \
  --model E7_content_model.json \
  --working-context editorial_context.json \
  --blueprint article_blueprint.json \
  --editing-brief E8_editing_brief.json \
  --edited-model E8_edited_model.json \
  --output E8_editorial_master.json \
  --summary E8_editorial_summary.json \
  --job-state job_state.json
```

没有 `--edited-model` 时正式路径明确失败；`--allow-development-fallback` 仅供单元测试或灾难诊断，产物保持 `fact_checked` 并由 E9 明确拒绝。

统一 Runner 以 `frontmind-controller-provider/v1`、`action=edit_article`、`user_pause=false` 交给总控。总控必须在同一回合完成三轮整篇编辑并立即续跑；若最终校验仍返回具体性或事实绑定反馈，则吸收反馈重编，不新增用户确认点。

只有正文完全不可读、品牌/主题无法识别或核心问题无法诚实回答才允许阻断。模板数量和措辞问题一律自动修订或记录 warning 后继续。
