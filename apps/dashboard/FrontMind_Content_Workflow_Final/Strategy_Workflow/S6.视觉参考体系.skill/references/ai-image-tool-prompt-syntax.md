# AI 绘画工具 Prompt 语法对照

本文档对比主流 AI 绘画工具的 Prompt 语法，供 S6 `prompt_scaffold` 在执行层按需适配。工具功能与参数可能变化，实际生成前应核对当前官方文档；本文不授权素材，也不允许模型重绘 Logo、认证标识或产品界面文字。

---

## 一、语法总览对比

| 特性 | Midjourney | DALL-E 3 | Stable Diffusion | Lovart |
| :--- | :--- | :--- | :--- | :--- |
| Prompt 语言 | 英文为主 | 英文/中文 | 英文为主 | 英文/中文 |
| 最大长度 | ~6000 字符 | ~4000 字符 | ~75 tokens | ~2000 字符 |
| 负面词语法 | `--no keyword` | 自然语言描述 | 独立 negative prompt 框 | 独立 negative prompt 框 |
| 宽高比 | `--ar 16:9` | 预设尺寸选择 | `--W 1920 --H 1080` | 预设 + 自定义 |
| 风格控制 | `--style raw` | 自然语言 | LoRA / 风格模型 | 风格预设 |
| 权重语法 | `keyword::2` | 不支持 | `(keyword:1.5)` | `(keyword:1.5)` |
| 种子控制 | `--seed 12345` | 不支持 | `--seed 12345` | `--seed 12345` |
| 图片参考 | `--iw 0.5` + URL | 上传参考图 | img2img | 上传参考图 |

---

## 二、Midjourney 语法详解

### 2.1 基础结构

```
/imagine prompt: [主体描述], [环境], [风格], [光线], [色彩] --ar 16:9 --style raw --no [负面词]
```

### 2.2 常用参数

| 参数 | 用途 | 示例 |
| :--- | :--- | :--- |
| `--ar` | 宽高比 | `--ar 16:9` |
| `--style raw` | 减少 MJ 默认美化 | 更贴近 prompt 描述 |
| `--no` | 负面词 | `--no text, watermark` |
| `--q` | 质量 | `--q 2`（高质量） |
| `--s` | 风格化程度 | `--s 100`（0-1000） |
| `--v` | 版本 | `--v 6.1` |
| `::` | 权重 | `purple::2 blue::1` |

### 2.3 品牌 Prompt 适配示例

```
/imagine prompt: A modern minimalist office space with deep purple accent lighting, 
clean geometric furniture, professionals collaborating around holographic displays, 
premium tech aesthetic, soft ambient lighting, color palette dominated by #6B21A8 
and #1A1A1A with white accents --ar 16:9 --style raw --no blurry, text, watermark, 
cluttered, cheap
```

---

## 三、DALL-E 3 语法详解

### 3.1 基础结构

DALL-E 3 使用自然语言描述，不支持参数标记：

```
Create a [风格] image of [主体描述] in [环境]. 
The color palette should be [色彩描述]. 
The composition should be [构图描述]. 
The image should NOT contain [负面描述].
```

### 3.2 最佳实践

| 技巧 | 说明 | 示例 |
| :--- | :--- | :--- |
| 明确尺寸 | 在描述中指定 | "wide landscape format" |
| 色彩控制 | 用自然语言描述色彩 | "dominated by deep purple (#6B21A8)" |
| 风格控制 | 参考艺术家/风格 | "in the style of minimalist corporate photography" |
| 负面控制 | 用 "should NOT" | "should NOT contain any text or watermarks" |

### 3.3 品牌 Prompt 适配示例

```
Create a wide-format minimalist corporate photograph of a modern office space. 
The scene features professionals collaborating in a clean, geometric environment 
with deep purple (#6B21A8) accent lighting against a predominantly black (#1A1A1A) 
and white backdrop. The composition follows the rule of thirds with generous 
whitespace. The image should convey professionalism, innovation, and premium quality. 
It should NOT contain any text, watermarks, or cluttered elements.
```

---

## 四、Stable Diffusion 语法详解

### 4.1 基础结构

```
Positive: [主体描述], [环境], [风格关键词], [色彩], [质量标签]
Negative: [负面词列表]
```

### 4.2 权重语法

| 语法 | 效果 | 示例 |
| :--- | :--- | :--- |
| `(keyword:1.5)` | 增强权重 | `(purple lighting:1.5)` |
| `(keyword:0.5)` | 降低权重 | `(background:0.5)` |
| `[keyword]` | 轻微降低 | `[trees]` |
| `{keyword}` | 轻微增强 | `{professional}` |

### 4.3 品牌 Prompt 适配示例

```
Positive: modern minimalist office space, (deep purple accent lighting:1.5), 
clean geometric furniture, professionals collaborating, (premium tech aesthetic:1.3), 
soft ambient lighting, (color palette #6B21A8 and #1A1A1A:1.4), white accents, 
masterpiece, best quality, 8k, photorealistic

Negative: blurry, low quality, low resolution, watermark, text overlay, 
distorted, deformed, ugly, duplicate, cluttered, cheap looking, 
poorly drawn, bad anatomy
```

---

## 五、Lovart 语法详解

### 5.1 基础结构

Lovart 支持类似 Stable Diffusion 的语法，同时提供风格预设：

```
Positive: [主体描述], [环境], [风格], [色彩]
Negative: [负面词]
Style Preset: [预设名称]
```

### 5.2 风格预设

| 预设名称 | 效果 | 适合场景 |
| :--- | :--- | :--- |
| Corporate | 商务专业风格 | 品牌主视觉、团队照 |
| Minimalist | 极简风格 | 产品展示、图标 |
| Tech | 科技感风格 | 科技品牌、数据可视化 |
| Lifestyle | 生活方式风格 | 社交媒体、品牌故事 |
| Editorial | 编辑风格 | 文章配图、杂志风 |

### 5.3 品牌 Prompt 适配示例

```
Positive: modern minimalist office, (deep purple #6B21A8 accent lighting:1.5), 
clean geometric design, professional atmosphere, premium quality
Negative: blurry, low quality, text, watermark, cluttered
Style Preset: Corporate
Aspect Ratio: 16:9
```

---

## 六、跨工具 Prompt 转换规则

### 6.1 从 S6 prompt scaffold 到各工具的转换

S6 输出的结构化 prompt scaffold 可按以下规则转换；品牌 Logo 始终留作后期真实文件 overlay：

| JSON 字段 | Midjourney | DALL-E | SD/Lovart |
| :--- | :--- | :--- | :--- |
| `positive_prompt` | 直接使用 | 融入自然语言 | 直接使用 |
| `style_keywords` | 追加到 prompt | 融入描述 | 追加到 prompt |
| `color_hex` | 写入 prompt | "dominated by {hex}" | `({hex}:1.4)` |
| `composition` | 写入 prompt | "composition should be" | 写入 prompt |
| `negative_prompt` | `--no` 参数 | "should NOT" | Negative 框 |
| `aspect_ratio` | `--ar` 参数 | 选择预设尺寸 | 宽高设置 |

### 6.2 转换示例脚本

```python
def to_midjourney(prompt_item: dict) -> str:
    """将标准 Prompt JSON 转换为 Midjourney 格式。"""
    parts = [prompt_item["positive_prompt"]]
    parts.extend(prompt_item.get("style_keywords", []))
    colors = prompt_item.get("color_hex", [])
    if colors:
        parts.append(f"color palette {', '.join(colors)}")
    parts.append(prompt_item.get("composition", ""))
    
    mj = f"/imagine prompt: {', '.join(filter(None, parts))}"
    
    ar = prompt_item.get("aspect_ratio", "16:9")
    mj += f" --ar {ar} --style raw"
    
    neg = prompt_item.get("negative_prompt", "")
    if neg:
        mj += f" --no {neg}"
    
    return mj
```
