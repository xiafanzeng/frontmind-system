{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FrontMind Image Requirements Schema",
  "description": "E2 文字内容生成师为每篇文章生成的图片需求清单 JSON Schema（v5：强制绑定企业提交图片库；正文文件不写入文章标题，article_title 仅作为视觉主题参考）",
  "type": "object",
  "required": [
    "brand",
    "article_id",
    "article_title",
    "article_type",
    "image_library_manifest_path",
    "image_library_required",
    "real_image_source_policy",
    "images"
  ],
  "properties": {
    "brand": {
      "type": "string",
      "description": "品牌名称"
    },
    "article_id": {
      "type": "string",
      "description": "文章编号（如 A1、B3、C1b）"
    },
    "article_title": {
      "type": "string",
      "description": "视觉主题参考标题；不得写入正文 MD/DOCX，正文标题只通过 title_options.json 和对话打印展示"
    },
    "article_type": {
      "type": "string",
      "enum": [
        "A",
        "B",
        "C",
        "D"
      ],
      "description": "文章大类"
    },
    "enterprise_photo_availability": {
      "type": "string",
      "enum": [
        "A_sufficient",
        "B_basic",
        "C_insufficient",
        "D_missing"
      ],
      "description": "兼容旧字段；不得作为真实图片来源依据。真实图片以 E0 企业提交图片库 Manifest 为准。"
    },
    "images": {
      "type": "array",
      "description": "图片需求列表",
      "items": {
        "type": "object",
        "required": [
          "fig_id",
          "type",
          "generation_method",
          "caption",
          "context",
          "aigc_text_policy",
          "source_policy",
          "requires_client_submitted_asset",
          "fallback_policy"
        ],
        "properties": {
          "fig_id": {
            "type": "string",
            "pattern": "^fig[0-9]+$",
            "description": "图片唯一标识，与 Markdown 中的 IMAGE_SLOT 对应"
          },
          "type": {
            "type": "string",
            "enum": [
              "aigc_brand_poster",
              "enterprise_photo",
              "mermaid_or_d2_flowchart"
            ],
            "description": "图片类型。只允许三种：aigc_brand_poster（AIGC品牌海报）、enterprise_photo（企业提交实图）、mermaid_or_d2_flowchart（流程图，仅A4/A6/A11可用）"
          },
          "source_priority": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "client_submitted_image_library",
                "aigc_cover"
              ]
            },
            "description": "图片来源优先级；企业真实图片位必须以 client_submitted_image_library 为唯一真实图片来源。"
          },
          "enterprise_photo_hint": {
            "type": "object",
            "description": "兼容旧字段；不得作为真实图片来源依据。真实企业图片必须通过 approved_asset_query / allowed_asset_ids 从企业提交图片库匹配。",
            "properties": {
              "preferred_asset_types": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "product_photo",
                    "team_photo",
                    "office_photo",
                    "certificate_photo",
                    "case_photo",
                    "event_photo",
                    "brand_material"
                  ]
                },
                "description": "首选的企业实拍图类别（按优先级排序）"
              },
              "scene_keywords": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "场景关键词，用于从企业实拍图库中语义匹配（如 ['产品实拍', '实验室', '检测设备']）"
              },
              "quality_requirement": {
                "type": "string",
                "enum": [
                  "high_only",
                  "usable_ok"
                ],
                "description": "图片质量要求（首图必须 high_only，其他可 usable_ok）"
              }
            }
          },
          "generation_method": {
            "type": "string",
            "enum": [
              "ai_generate_brand_poster",
              "client_submitted_image_library",
              "mermaid_d2"
            ],
            "description": "图片生成方法。只允许三种：ai_generate_brand_poster、client_submitted_image_library、mermaid_d2"
          },
          "caption": {
            "type": "string",
            "description": "图片标题/图说（语义丰富的 Alt-text）"
          },
          "context": {
            "type": "string",
            "description": "图片所在段落的上下文描述，用于语义匹配审核"
          },
          "prompt_guidance": {
            "type": "string",
            "description": "AIGC 品牌海报的 Prompt 指导（仅 ai_generate_brand_poster 方式需要）"
          },
          "style_notes": {
            "type": "string",
            "description": "风格说明"
          },
          "aigc_text_policy": {
            "type": "string",
            "enum": [
              "brand_poster_full_text",
              "no_aigc"
            ],
            "description": "AIGC 文字控制策略（★ v4：A 类首图用 brand_poster_full_text 生成含品牌名+Slogan+卖点的精美海报，场景图默认 no_aigc）"
          },
          "s7_prompt_ref": {
            "type": "string",
            "description": "引用的 S7 视觉 Prompt 包条目 ID（仅 AIGC 品牌海报需要）"
          },
          "prompt_layers": {
            "type": "object",
            "description": "Prompt 分层预规划（仅 generation_method=ai_generate_brand_poster 时必填）。使 Prompt 在 E2 阶段即可预审，E3 执行时拼装，E4 审查时回溯。",
            "required": [
              "scene_overlay",
              "text_policy_suffix",
              "expected_strategy"
            ],
            "properties": {
              "s7_base": {
                "type": "string",
                "description": "S7 视觉 Prompt 包中的 positive_prompt 基底（E2 填占位说明，E3 执行时填充实际值）"
              },
              "scene_overlay": {
                "type": "string",
                "description": "E2 提供的场景描述层，叠加在 s7_base 之上"
              },
              "text_policy_suffix": {
                "type": "string",
                "description": "根据 aigc_text_policy 推导的文字控制后缀（如 'no text, no words, no letters, no labels, no watermarks'）"
              },
              "negative_prompt_hint": {
                "type": "string",
                "description": "期望的负面提示词提示（如 'golden seal, wax seal, Western office'）"
              },
              "reference_asset_hint": {
                "type": "string",
                "description": "期望使用的企业提交图片库品牌素材说明（如 Logo asset_id）；不得用 S1 抓取图替代客户提交图片。"
              },
              "expected_strategy": {
                "type": "string",
                "enum": [
                  "text2img",
                  "img2img",
                  "auto"
                ],
                "description": "预期的生成策略"
              },
              "localization_tags": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "本地化标签（如 ['Chinese engineers', 'in China', 'Chinese industrial park']）"
              }
            }
          },

          "compliance_notes": {
            "type": "string",
            "description": "合规注意事项"
          },
          "dimensions": {
            "type": "object",
            "properties": {
              "width": {
                "type": "integer",
                "minimum": 400
              },
              "height": {
                "type": "integer",
                "minimum": 300
              }
            },
            "description": "建议图片尺寸（像素）"
          },
          "source_policy": {
            "type": "string",
            "enum": [
              "aigc_abstract_only",
              "client_submitted_image_library_only",
              "mermaid_or_d2_render"
            ],
            "description": "图片来源策略"
          },
          "requires_client_submitted_asset": {
            "type": "boolean",
            "description": "是否必须使用客户提交图片库素材。企业真实画面必须为 true。"
          },
          "approved_asset_query": {
            "type": "object",
            "description": "用于从企业提交图片库匹配素材的查询条件。",
            "properties": {
              "asset_types": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "scene_keywords": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "quality_requirement": {
                "type": "string",
                "enum": [
                  "high_only",
                  "usable_ok"
                ]
              },
              "recommended_visual_role": {
                "type": "string"
              }
            }
          },
          "allowed_asset_ids": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "可直接使用的企业提交图片库 asset_id；为空时 E3 按 approved_asset_query 匹配。"
          },
          "fallback_policy": {
            "type": "string",
            "enum": [
              "block_and_request_client_image",
              "use_chart_or_diagram",
              "use_aigc_abstract_poster",
              "omit_image_slot_with_e0_approval"
            ],
            "description": "缺图处理。企业真实图缺失时必须 block_and_request_client_image。"
          },
          "reference_asset_ids": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "用于 AIGC 抽象海报风格参考的品牌素材 asset_id；不得用来伪造企业实拍。"
          },
          "rights_requirement": {
            "type": "string",
            "enum": [
              "media_distribution_allowed",
              "owned_media_only",
              "internal_reference_only",
              "not_allowed"
            ],
            "description": "该图在后续渠道分发中的最低授权要求。"
          },
          "required_generation_tool": {
            "type": "string",
            "description": "当 generation_method=ai_generate_brand_poster 时必填，默认 gpt-image-2；HTML/CSS渲染不得满足此字段。"
          },
          "finalization_required": {
            "type": "boolean",
            "description": "是否需要进入终稿视觉美化流程。A类首图必须为 true。"
          },
          "html_draft_allowed": {
            "type": "boolean",
            "description": "HTML/CSS 是否只允许作为草图。A类首图必须为 false。"
          },
          "final_asset_origin_required": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "gpt-image-2",
                "approved_image_generation_model",
                "mermaid_d2",
                "client_submitted_image_library"
              ]
            },
            "description": "允许成为最终图的来源。AIGC品牌海报必须为 gpt-image-2 或 approved_image_generation_model；流程图可为 mermaid_d2；企业实图为 client_submitted_image_library。"
          }
        },
        "if": {
          "properties": {
            "generation_method": {
              "const": "ai_generate_brand_poster"
            }
          }
        },
        "then": {
          "required": [
            "prompt_layers",
            "s7_prompt_ref",
            "required_generation_tool",
            "finalization_required",
            "html_draft_allowed",
            "final_asset_origin_required"
          ]
        },
        "allOf": [
          {
            "if": {
              "properties": {
                "requires_client_submitted_asset": {
                  "const": true
                }
              }
            },
            "then": {
              "properties": {
                "source_policy": {
                  "const": "client_submitted_image_library_only"
                },
                "fallback_policy": {
                  "const": "block_and_request_client_image"
                },
                "generation_method": {
                  "enum": [
                    "client_submitted_image_library",
                    "brand_knowledge_base"
                  ]
                }
              },
              "anyOf": [
                {
                  "required": [
                    "approved_asset_query"
                  ]
                },
                {
                  "required": [
                    "allowed_asset_ids"
                  ]
                }
              ]
            }
          }
        ]
      }
    },
    "image_library_manifest_path": {
      "type": "string",
      "description": "E0 输出的企业提交图片库 Manifest 路径，真实企业图片只能从该 Manifest 对应素材库中引用。"
    },
    "image_library_required": {
      "type": "boolean",
      "const": true,
      "description": "执行层文章生产必须启用企业提交图片库。"
    },
    "real_image_source_policy": {
      "type": "string",
      "enum": [
        "client_submitted_image_library_only"
      ],
      "description": "企业真实图片来源策略：只能使用客户提交并经 E0 校验通过的图片库。"
    },
    "image_finalization_policy": {
      "type": "object",
      "description": "全篇图片终稿政策，E3/E4必须执行。",
      "properties": {
        "aigc_hero_required_tool": {
          "type": "string",
          "default": "gpt-image-2"
        },
        "html_draft_as_final_forbidden": {
          "type": "boolean",
          "const": true
        },
        "aigc_hero_must_be_finalized": {
          "type": "boolean",
          "const": true
        }
      }
    }
  }
}