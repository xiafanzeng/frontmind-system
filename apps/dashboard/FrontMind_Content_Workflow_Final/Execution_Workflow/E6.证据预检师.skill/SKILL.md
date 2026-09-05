---
name: frontmind-fact-revision-editor
description: >
  E6 事实修订师。根据 working_context 对 E5 无标题正文执行 keep、qualify、rewrite、remove，
  直接产出可继续的修订正文；不要求语义复核回执、Registry 哈希链或人工审批账本。
---

# E6 事实修订师

## 目标

把证据检查变成正文修订，而不是停工门。逐个实质性表述采用以下动作：

- `keep`：现有可用事实足以支持；
- `qualify`：把具体时间、地区、版本或使用条件自然并入原句；
- `rewrite`：把越界结论改成现有资料能够支持的事实或条件式建议；
- `remove`：删除无法支持且不影响核心答案的数字、排名、口碑、竞品判断或案例结论。

用户上传并要求用于制作的普通企业资料可以支持本品牌身份、产品、流程、公开价格和已确认限制。仅凭第一方资料不得推出市场口碑、行业认可、独立排名、领先或竞品缺点。

## 自动续跑规则

- `excluded`、内部、保密、个人隐私和高风险医疗操作不得出现在修订正文。
- `qualified` 事实只使用事实卡中具体、可公开的限定；不得追加“以审核为准”“以实际核验结果为准”等通用免责声明。
- P02/P03 的公平比较可使用阶段内临时工作表；工作表不进入下游合同。
- 某条事实不足时优先限缩、重写或删除，继续 E7。
- 仅当核心问题在删除受限内容后完全无法诚实回答时，才以 `unanswerable_core_question` 阻断。

## 输入与输出

只读取 E5 正文、E6 已修订正文和 `editorial_context.json`，输出：

- `E6_{job_id}_revised_content_model.json`；
- `E6_{job_id}_revision_summary.json`，记录动作和 warnings，不是 receipt。

```bash
python scripts/evidence_preflight.py \
  --draft E5_content_model.json \
  --working-context editorial_context.json \
  --output E6_revised_content_model.json \
  --summary E6_revision_summary.json \
  --job-state job_state.json
```

默认由脚本删除不可用绑定、自然并入具体限定、删除空段并限缩强主张；证据状态和修改动作不得进入正文。Skill 有更自然的整篇修订稿时才传 `--revised E6_revised_draft.json`。若 E6 判断核心问题确实无法回答，追加 `--core-unanswerable-reason "具体原因"`，不得用该参数代替局部自动修订。
