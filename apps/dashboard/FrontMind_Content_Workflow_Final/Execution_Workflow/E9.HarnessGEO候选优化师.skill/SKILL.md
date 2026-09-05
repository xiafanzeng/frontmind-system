---
name: frontmind-harnessgeo-candidate-editor
description: >
  E9 HarnessGEO 候选优化师。把 E8 editorial master 序列化为一篇完整无标题 Markdown，通过部署环境中的
  HarnessGEO OpenAI-compatible HTTPS 服务整篇调用一次生成独立候选；适用于 FrontMind 正文完成出版编辑后、E10 回归选稿前。
---

# E9 HarnessGEO 候选优化师

E8 始终是完整安全正本。E9 只生成独立候选，不决定交付正文，不处理标题，也不覆盖 E8。

## 调用合同

- 对用户和操作员统一称为 HarnessGEO；底层通过固定 HTTPS 地址 `https://api.xty.app/v1/chat/completions` 调用 OpenAI-compatible Chat Completions。
- 模型固定为 `gpt-5.6-luna`，不接受每篇文章覆盖、自动回退或替代模型；API 响应中的模型 ID 不一致即失败。
- 正式凭证只使用 `FRONTMIND_HARNESSGEO_API_KEY`，或由 `FRONTMIND_HARNESSGEO_KEYS_FILE` 指向只含该字段的受控 `keys.env`。进程环境中的 `XTY_API_KEY` 仅作旧部署的内存兼容输入，不写回环境或产物。普通文章命令不接受密钥参数。
- 将完整无标题 Markdown 放入一个请求；禁止逐字段、逐段或逐句调用。
- Prompt 完整固化在 `scripts/harnessgeo_candidate_optimizer.py`；每次请求同时注入正式问题、P 模式、候选顺序、H2/H3/FAQ/段落结构锁和整篇 Markdown，要求保持事实、限制、安全内容与结构，并以 JSON mode 的唯一 `markdown` 字段返回。
- 固定 `response_format={"type":"json_object"}`、`temperature=0.2`、`max_tokens=16384`、`stream=false`；180 秒超时，只有网络错误和 408/409/425/429/5xx 执行最多三次有限重试。
- 不导入 `autogeo`，不加载或下载本地模型，不接受 model path、dataset、engine 或本地 Python runtime 设置。
- 不提供 `--skip`、模拟改写或本地规则替代。
- 缺凭证、API 返回空内容或调用异常属于部署错误，显式失败；不得伪造 HarnessGEO 成功结果。
- API 返回后只把整篇 Markdown解析为独立候选；结构无法映射时保留原始返回和 issue，交 E10 整篇沿用 E8。
- 医疗品类术语被替换、监管地域变更、中英泰等语言脚本混杂或新增高风险操作步骤时，把相应语义漂移写入 candidate `issues`，但保留可解析的完整候选并以 `completed_with_limits` 完成 E9；不得在 E9 阻断或覆盖 E8。

运行：

```bash
python scripts/harnessgeo_candidate_optimizer.py \
  --editorial-master E8_editorial_master.json \
  --output E9_harnessgeo_candidate.json \
  --summary E9_optimization_summary.json \
  --job-state job_state.json
```

输出 envelope 通过本地 `harnessgeo_candidate.schema.json` 校验，包含 `source=harnessgeo_api`、`adapter=xty_openai_chat_completions`、`model=gpt-5.6-luna`、一次远程 API 返回的 `raw_markdown`、可解析时的 `candidate_model` 和简短 issues。它只保存正文候选所需字段，不保存 API Key、完整网关响应或其他运行治理材料。E10 负责比较实体、候选顺序、数字、日期、价格、来源、适用条件、FAQ 和医疗安全语义，并且只能整篇选用候选或整篇沿用 E8。
