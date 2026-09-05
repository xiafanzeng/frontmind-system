# HTML、DOCX 与结构化数据政策 v2.3

## 同源正文

E10 选中的同一个无标题 `final_content_model.json` 同时渲染 HTML 和 DOCX。渲染器只改变呈现，不改写 Lead、章节、FAQ、结论、来源或视觉含义。`delivery_index.json` 只列公开文件名、用途和媒体类型。

## HTML 与 DOCX

- `article_body.html` 是 `<article>` 正文片段，不含 `html/head/title/h1/script/table`。
- DOCX 不含 Title 或 Heading 1，从 Lead 自然段开始。
- H2 可为陈述式、判断式或自然问句；H3 只在确有子层级时使用。
- 正文不使用可见表格。候选、价格和规格以平行小节或自然列表表达。
- 实际使用图片在两种格式中的顺序、说明和含义一致。
- 可见来源使用可读名称和可点击链接；不能只藏在结构化数据中。
- 高保真 DOCX 渲染必须保留中文字体、超链接和图片；不能降级为丢失这些能力的简易文件。

## 结构化数据

结构化数据只输出正文已经满足的类型；条件不足时省略，不为填 Schema 编造内容。

| 类型 | 使用条件 |
|---|---|
| `Article` | 输出含 `{{TITLE}}` 与 `{{META_DESCRIPTION}}` 的发布模板；发布端从同一 Title Map 条目注入 |
| `FAQPage` | 页面有可见 FAQ，问题与答案和正文逐项一致 |
| `ItemList` | 仅 P02；候选完整可见，必须为 `ItemListUnordered`，无 position、score 或名次 |
| `HowTo` | P08 或具备真实连续步骤的 P11，步骤均在正文可见 |
| `Product` | 名称、品牌、型号、版本等字段在正文可见 |
| `Review` | 有真实评价主体、方法与可复核结论，不能把企业宣传稿伪装成独立评测 |

## E10 发布检查

1. HTML 和 DOCX 均无标题/H1，标题只在独立 Title Map 和发布元数据中；
2. 两种格式的正文段落、FAQ、引用和视觉顺序一致；
3. 结构化实体、日期、价格、版本和结论均可在最终正文定位；
4. P02 ItemList 不表达客观排名；
5. DOCX 的中文、链接和图片经实际渲染验证可读。

不一致时回到同一个无标题 Content Model 自动修复并重新渲染；发布端选择标题时不得改写正文。
