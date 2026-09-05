# 跨文章图片注册表 Schema (Image Registry Schema)

> 本文档定义 `E0_{brand}_image_registry.json` 的完整 JSON Schema，供 E0 维护跨文章图片注册表使用。

---

## 一、设计目标

跨文章图片注册表的核心目标是**绝对杜绝跨文章图片复用**，并记录企业提交图片库素材在不同文章中的使用与授权链路。在同一工作流中，多篇文章的配图不允许出现任何形式的重复，包括但不限于：

1. **完全相同的图片文件**（file_hash 相同）
2. **相同 Prompt 生成的 AIGC 图片**（prompt_hash 相同）
3. **相同 URL 的网络搜索图片**（source_url 相同）
4. **相同图表类型 + 数据维度的 Python 数据图表**（chart_type + data_dimension 组合相同）

---

## 二、顶层结构

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "FrontMind Image Registry",
  "type": "object",
  "required": ["brand", "created_at", "updated_at", "total_images", "entries"],
  "properties": {
    "brand": {
      "type": "string",
      "description": "品牌名称"
    },
    "created_at": {
      "type": "string",
      "format": "date-time",
      "description": "注册表创建时间（ISO 8601）"
    },
    "updated_at": {
      "type": "string",
      "format": "date-time",
      "description": "注册表最后更新时间（ISO 8601）"
    },
    "total_images": {
      "type": "integer",
      "minimum": 0,
      "description": "注册表中图片总数"
    },
    "entries": {
      "type": "array",
      "items": { "$ref": "#/definitions/ImageEntry" },
      "description": "图片条目列表"
    }
  }
}
```

---

## 三、ImageEntry 定义

```json
{
  "definitions": {
    "ImageEntry": {
      "type": "object",
      "required": [
        "article_id", "image_id", "image_type", "generation_method",
        "caption_summary", "file_hash", "file_path", "file_size_kb", "created_at"
      ],
      "properties": {
        "article_id": {
          "type": "string",
          "pattern": "^[ABC]\\d+[a-b]?-\\d{3}$",
          "description": "所属文章编号，如 A1-001、C1b-002"
        },
        "image_id": {
          "type": "string",
          "description": "图片唯一标识，格式为 {article_id}_fig{N}"
        },
        "image_type": {
          "type": "string",
          "enum": ["aigc_brand_poster", "enterprise_photo", "mermaid_or_d2_flowchart", "brand_photo", "certificate_photo", "team_photo", "case_photo", "service_scene", "environment_photo"],
          "description": "图片类型（★ v4：A 类首图用 aigc_brand_poster，场景图用 enterprise_photo，删除 aigc_scene）"
        },
        "generation_method": {
          "type": "string",
          "enum": ["ai_generate_brand_poster", "client_submitted_image_library", "mermaid_d2", "web_search", "brand_knowledge_base"],
          "description": "生成方式（★ v5：A 类首图用 ai_generate_brand_poster，企业真实图片用 client_submitted_image_library）"
        },
        "caption_summary": {
          "type": "string",
          "maxLength": 200,
          "description": "图片说明摘要（≤200字符）"
        },
        "prompt_hash": {
          "type": "string",
          "description": "AIGC 图片的 Prompt 文本 SHA256 哈希（仅 aigc_brand_poster 类型必填）"
        },
        "file_hash": {
          "type": "string",
          "description": "图片文件的 SHA256 哈希"
        },
        "s7_prompt_id": {
          "type": "string",
          "description": "引用的 S7 视觉 Prompt 模板 ID（仅 aigc_brand_poster 类型必填）"
        },
        "source_url": {
          "type": "string",
          "format": "uri",
          "description": "网络搜索图片的原始 URL（仅 web_search 类型必填）"
        },
        "source_asset_id": {
          "type": "string",
          "description": "企业提交图片库中的 asset_id（企业真实图片必填）"
        },
        "client_submitted": {
          "type": "boolean",
          "description": "是否来自客户提交图片库"
        },
        "rights_status": {
          "type": "string",
          "enum": ["client_owned", "client_authorized", "licensed_for_media", "restricted", "unknown"],
          "description": "图片授权状态"
        },
        "allowed_usage": {
          "type": "array",
          "items": {"type": "string"},
          "description": "允许使用范围，如 owned_media/news_distribution/social_media/internal_only"
        },
        "library_manifest_sha256": {
          "type": "string",
          "description": "企业提交图片库 Manifest 哈希，用于追溯"
        },

        "file_path": {
          "type": "string",
          "description": "图片文件相对路径"
        },
        "file_size_kb": {
          "type": "number",
          "minimum": 10,
          "description": "图片文件大小（KB），最低 10KB"
        },
        "created_at": {
          "type": "string",
          "format": "date-time",
          "description": "图片创建时间（ISO 8601）"
        }
      }
    }
  }
}
```

---

## 四、去重比对规则

| 图片类型 | 去重字段 | 判定标准 | 冲突处理 |
| :--- | :--- | :--- | :--- |
| `aigc_brand_poster` | `prompt_hash` | SHA256 哈希完全相同即判定重复 | 修改 Prompt 关键词或场景 |
| `enterprise_photo` / `brand_photo` / `certificate_photo` / `team_photo` / `case_photo` | `source_asset_id` | 同一篇或同一批次中重复使用同一企业提交素材需显式说明；不得把非提交库图片注册为企业实图 | 优先选择不同的客户提交图片；若必须复用 Logo/证书，需在 asset_manifest 中标注理由 |
| `web_search` | `source_url` | URL 完全相同即判定重复 | 搜索替代图片 |
| 所有类型 | `file_hash` | SHA256 哈希完全相同即判定重复 | 重新生成或搜索 |

---

## 五、注册表操作 API

### 5.1 追加图片

```bash
python3 scripts/registry_manager.py append \
  --registry "E0_{brand}_image_registry.json" \
  --article-id "A1-001" \
  --images-dir "images/"
```

### 5.2 去重检查

```bash
python3 scripts/registry_manager.py check-dup \
  --registry "E0_{brand}_image_registry.json" \
  --new-image "images/A3-001_fig1_hero.png" \
  --image-type "enterprise_photo" \
  --prompt-hash "sha256:abc123..."
```

### 5.3 完整性验证

```bash
python3 scripts/registry_manager.py validate \
  --registry "E0_{brand}_image_registry.json"
```

返回值：`0` 表示通过，`1` 表示存在重复或缺失字段。
