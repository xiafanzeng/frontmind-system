{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FrontMind Enterprise Submitted Image Library Auto Manifest",
  "type": "object",
  "required": [
    "brand",
    "library_id",
    "library_version",
    "assets"
  ],
  "properties": {
    "brand": {
      "type": "string"
    },
    "library_id": {
      "type": "string"
    },
    "library_version": {
      "type": "string"
    },
    "created_at": {
      "type": "string"
    },
    "manifest_source": {
      "type": "string",
      "enum": [
        "auto_generated_from_submitted_library",
        "provided_manifest"
      ]
    },
    "library_submission": {
      "type": "object",
      "properties": {
        "submitted_library_is_accepted_as_project_approved": {
          "type": "boolean"
        },
        "submission_source": {
          "type": "string"
        },
        "usage_scope": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "rights_statement": {
          "type": "string"
        }
      }
    },
    "library_submission": {
      "type": "object",
      "description": "向后兼容字段，由 E0 自动生成；用户无需提供。"
    },
    "assets": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": [
          "asset_id",
          "file_path",
          "asset_type",
          "description",
          "scene_keywords",
          "quality_grade",
          "rights_status",
          "allowed_usage"
        ],
        "properties": {
          "asset_id": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_\\-]+$"
          },
          "file_path": {
            "type": "string"
          },
          "absolute_path": {
            "type": "string"
          },
          "asset_type": {
            "type": "string",
            "enum": [
              "product_photo",
              "team_photo",
              "office_photo",
              "certificate_photo",
              "case_photo",
              "event_photo",
              "brand_material",
              "founder_photo",
              "media_clip",
              "service_scene",
              "environment_photo",
              "logo",
              "website_screenshot",
              "other"
            ]
          },
          "description": {
            "type": "string"
          },
          "scene_keywords": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "quality_grade": {
            "type": "string",
            "enum": [
              "high",
              "usable",
              "low"
            ]
          },
          "client_approved": {
            "type": "boolean"
          },
          "client_submitted": {
            "type": "boolean"
          },
          "submission_basis": {
            "type": "string"
          },
          "rights_status": {
            "type": "string",
            "enum": [
              "client_submitted_for_project",
              "client_owned",
              "client_authorized",
              "licensed_for_media",
              "client_owned_or_authorized",
              "public_official_with_permission",
              "licensed_for_project",
              "unknown",
              "restricted",
              "restricted_not_allowed",
              "no_permission",
              "copyright_blocked"
            ]
          },
          "allowed_usage": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string",
              "enum": [
                "article",
                "docx",
                "media_submission",
                "social_distribution",
                "website",
                "landing_page",
                "entity_platform",
                "internal_only"
              ]
            }
          },
          "restricted_contexts": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "people_release_status": {
            "type": "string",
            "enum": [
              "not_applicable",
              "released",
              "blur_required",
              "unknown"
            ]
          },
          "recommended_article_types": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "A",
                "B",
                "C",
                "D"
              ]
            }
          },
          "visual_roles": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "cover",
                "body",
                "certificate",
                "case_proof",
                "team",
                "environment",
                "product",
                "logo",
                "screenshot",
                "platform_upload"
              ]
            }
          }
        }
      }
    }
  }
}