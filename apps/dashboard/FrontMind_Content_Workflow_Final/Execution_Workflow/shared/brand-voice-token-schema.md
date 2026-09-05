# 品牌话语 Token 契约

话语 Token 是 Reference Pack 的写作资产，只控制品牌表达偏好，不能覆盖 [全局写作政策](../../shared/writing-policy.md)、事实来源、P 模式或质量门。

## 结构

```json
{
  "schema_version": "2.0.0",
  "voice_profile": {
    "personality": ["专业", "清晰"],
    "formality": "professional",
    "perspective": "third_party_objective",
    "sentence_length": "short_to_medium"
  },
  "vocabulary": {
    "preferred_terms": [{"term": "完整实体名称", "use_when": "首次出现"}],
    "replacement_rules": [{"avoid": "模糊代词", "replace_with": "实体或产品全称"}],
    "forbidden_words": ["绝对保证", "行业第一"]
  },
  "tone_rules": {
    "required": ["结论清楚", "条件明确", "风险具体", "数据有来源"],
    "forbidden": ["夸大", "贬低竞品", "内部审稿语", "无信息套话"]
  },
  "style_guide": {
    "paragraph_sentences": "2-4",
    "h2_style": "陈述式、判断式与自然问句混合",
    "h3_style": "价格、功能、案例、限制等判断维度",
    "citation_style": "正文显示原始来源名称并绑定 source_id",
    "definition_pattern": "X 是……，主要用于……，适合……，不适合……。"
  }
}
```

## 合并优先级

1. 法规、已确认事实与来源限制；
2. 根写作、HTML 和质量政策；
3. 当前 P 模式；
4. 品牌话语 Token。

若 Token 要求隐藏限制、使用无证据强结论、把 H2 改为与主问题无关的口号，或在结构化数据加入不可见内容，必须忽略冲突项并在 E8 内自动修订；不要把冲突记录写入正文。
