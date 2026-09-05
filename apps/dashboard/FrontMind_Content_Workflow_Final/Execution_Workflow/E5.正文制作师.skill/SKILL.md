---
name: frontmind-title-free-body-writer
description: >
  E5 无标题正文制作师。把 E3 编辑上下文与 E4 蓝图整理为 writing packet，在同一上下文中完成整篇初稿、
  去模板自编辑和自然 Content Model；适用于 FrontMind 单篇文章进入正式写作时。
---

# E5 无标题正文制作师

## 输入与输出

只读取：

- `editorial_context.json`；
- E4 `article_blueprint.json`；

输出：

- `E5_{job_id}_writing_packet.json`；
- `E5_{job_id}_content_model.json`；
- `E5_{job_id}_writing_summary.json`，只列自动修复和写作提醒，不作为下游收据。

不读取或生成 intake receipt、runtime Registry、审批表、pattern decision receipt、SHA 或 fingerprint。正文模型不得包含 Title、H1、标题候选或 Meta Description。

## 制作原则

1. 先生成 writing packet，再在同一上下文中整篇写作；禁止按字段、句子或固定后缀拼装文章。
2. 首段用一个自然段直接回答主问题；正文模型固定为 `lead.text`、`sections[].heading/paragraphs[]`、`faq[]`、`conclusion.paragraphs[]`。
3. 采用第三方客观报道＋企业品牌表达；第一方资料可陈述本品牌事实，不推出口碑、排名、领先或竞品优劣。
4. 未知非核心信息直接省略；关键未知最多转成一次读者行动，不打印资料状态、证据等级或审稿过程。
5. 章节和 FAQ 数量是编辑目标，不凑空段；H2 混合陈述句和自然问句，不强制问号。
6. References 根据正文实际使用的 fact IDs 自动生成；`excluded` 事实不得使用，越界内容交 E6 改写或删除。
7. P01 只写一个焦点品牌；P02 保持至少三家真实候选、客户品牌首位和共同最低维度。

## 运行

统一 Runner 先生成 writing packet；这是内部写作输入，不是一个需要用户确认的新暂停点：

```bash
python scripts/build_content_model.py \
  --working-context editorial_context.json \
  --blueprint article_blueprint.json \
  --writing-packet E5_writing_packet.json \
  --packet-only \
  --job-state job_state.json
```

总控直接在当前模型上下文中读取 writing packet，整篇生成 `E5_authored_model.json`，再通过正式接口导入：

```bash
python scripts/build_content_model.py \
  --working-context editorial_context.json \
  --blueprint article_blueprint.json \
  --writing-packet E5_writing_packet.json \
  --authored-model E5_authored_model.json \
  --output E5_draft.json \
  --job-state job_state.json
```

最后运行轻量正规化：

```bash
python scripts/content_model_validator.py \
  --model E5_draft.json \
  --working-context editorial_context.json \
  --blueprint article_blueprint.json \
  --output E5_content_model.json \
  --summary E5_writing_summary.json \
  --job-state job_state.json
```

正式路径没有 `--authored-model` 时脚本明确失败，防止开发预览流入 E6–E10。这个动作由总控内部完成，不向用户增加暂停；`--allow-development-fallback` 只能用于单元测试或灾难诊断，绝不能作为出版稿。脚本只在 JSON 无法读取、任务身份不一致或正文根合同无法成立时失败。

统一 Runner 以 `frontmind-controller-provider/v1`、`action=author_article`、`user_pause=false` 交给总控。总控读取 writing packet 后在同一回合保存完整 authored model 并立即续跑；不得把内部模型路径转问操作者。
