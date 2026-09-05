# 企业提交图片库 Manifest / Auto-Manifest Schema

> 定义执行层启动输入：`Client_Submitted_Image_Library.zip` 或 `client_submitted_image_library/`。v9 起，用户不再需要提交或确认 `image_library_manifest.json`；E0 会自动扫描图片库并生成标准化 manifest。

---

## 一、强制要求

1. 执行层启动输入 = `strategy_pack_v{N}.json` + 企业提交图片库。
2. 图片库可以是 ZIP 或目录；必须包含至少 1 张 png/jpg/jpeg/webp 图片。
3. `image_library_manifest.json` 为可选文件：存在则补充元数据，缺失不阻断。
4. 上传图片库即视为本项目可用素材提交；不再要求额外确认步骤。
5. 显式标记为 restricted、restricted_not_allowed、no_permission、copyright_blocked 的素材不得进入 E1-E5。

---

## 二、E0 自动生成 Manifest 示例

```json
{
  "brand": "品牌名",
  "library_id": "brand_submitted_image_library",
  "library_version": "v1-auto",
  "manifest_source": "auto_generated_from_submitted_library",
  "library_submission": {
    "submitted_library_is_accepted_as_project_approved": true,
    "submission_source": "user_uploaded_zip_or_folder",
    "usage_scope": ["article", "docx", "media_submission", "social_distribution"],
    "rights_statement": "素材来自用户提交图片库；无需额外 image_library_manifest.json 确认步骤。"
  },
  "assets": [
    {
      "asset_id": "team_photo_001",
      "file_path": "images/team/team_photo_001.jpg",
      "absolute_path": "/workspace/.../images/team/team_photo_001.jpg",
      "asset_type": "team_photo",
      "description": "用户提交图片库素材：team_photo_001.jpg",
      "scene_keywords": ["team", "team_photo_001"],
      "quality_grade": "high",
      "client_approved": true,
      "client_submitted": true,
      "submission_basis": "implicit_by_submitted_image_library",
      "rights_status": "client_submitted_for_project",
      "allowed_usage": ["article", "docx", "media_submission", "social_distribution"],
      "restricted_contexts": [],
      "people_release_status": "not_applicable",
      "recommended_article_types": ["A", "B", "C", "D"],
      "visual_roles": ["team", "body"],
      "file_hash": "sha256:..."
    }
  ]
}
```

---

## 三、E0 校验产物

| 文件 | 用途 |
|---|---|
| `E0_{brand}_submitted_image_library_manifest.json` | 标准化后的企业提交图片库 Manifest；供 E1-E5 统一引用 |
| `E0_{brand}_image_library_validation_report.md` | 校验报告：素材数量、类型统计、过小/重复/受限素材提醒 |
| `E0_{brand}_image_library_index.json` | 检索索引：按 asset_type、visual_roles、keywords、article_type 建立反查 |

---

## 四、可选输入 Manifest 字段

如果客户愿意提供 `image_library_manifest.json`，可包含：

```json
{
  "brand": "品牌名",
  "assets": [
    {
      "file_path": "images/case/case_001.jpg",
      "asset_id": "case_001",
      "asset_type": "case_photo",
      "description": "客户案例现场图",
      "scene_keywords": ["案例", "现场"],
      "rights_status": "client_owned_or_authorized",
      "allowed_usage": ["article", "docx", "media_submission"],
      "recommended_article_types": ["A", "B", "C"],
      "visual_roles": ["case_proof", "body"]
    }
  ]
}
```

该文件仅用于提升素材检索准确度，不再是执行层启动的确认条件。
