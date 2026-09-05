{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FrontMind Content Brief Template",
  "description": "E1 内容策略师为每篇文章生成的完整 Brief 模板",
  "type": "object",
  "required": [
    "article_id",
    "type",
    "type_name",
    "title_locked",
    "production_approved",
    "content_angle",
    "keywords",
    "target_ai_search_terms",
    "word_count",
    "image_count",
    "tone_token_ref",
    "visual_prompt_ref",
    "image_library_manifest_ref",
    "image_source_policy",
    "image_plan",
    "channel_ref",
    "question_stage",
    "priority",
    "brief_summary",
    "title_generation_policy",
    "title_objective",
    "title_anchor",
    "title_guardrails",
    "type_specific_template_id",
    "semantic_advantage_strategy",
    "publication_readiness_requirements"
  ],
  "properties": {
    "article_id": {
      "type": "string",
      "description": "唯一文章编号，如 A1、A1-1、B3、C1b、C1b-1",
      "pattern": "^[A-D][0-9]{1,2}[a-z]?(?:-[0-9]+)?$"
    },
    "type": {
      "type": "string",
      "description": "内容类型编号",
      "enum": [
        "A1",
        "A2",
        "A3",
        "A4",
        "A5",
        "A6",
        "A7",
        "A8",
        "A9",
        "A10",
        "A11",
        "A12",
        "B1",
        "B2",
        "B3",
        "B4",
        "C1a",
        "C1b",
        "C2",
        "C3",
        "C4",
        "D1",
        "D2",
        "D3"
      ]
    },
    "type_name": {
      "type": "string",
      "description": "内容类型中文名称"
    },
    "candidate_titles": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 5,
      "description": "历史兼容字段：E1 不再生成最终标题池。若保留，仅作方向参考；E2 将在正文完成后生成 5 个正式标题备选。"
    },
    "title": {
      "type": "string",
      "description": "历史兼容字段：不再作为 E2 前置必填字段。当前应使用 working_title 作为方向参考。"
    },
    "title_confirmed": {
      "type": "boolean",
      "description": "历史兼容字段：当前执行层不再在 暂停5 或 E2 前确认最终标题。",
      "default": false
    },
    "production_approved": {
      "type": "boolean",
      "description": "本篇文章是否已被用户在 暂停5 明确批准进入生产环节（必须为 true 才能触发 E2）。不代表标题已确认。",
      "default": false
    },
    "user_modifications": {
      "type": "string",
      "description": "v8 新增：用户对本篇文章方向、角度或篇幅的具体修改要求（若有）"
    },
    "subtitle": {
      "type": "string",
      "description": "副标题（可选）"
    },
    "keywords": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 3,
      "maxItems": 10,
      "description": "关键词列表，来源于 S5 关键词体系"
    },
    "target_ai_search_terms": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "description": "目标 AI 搜索词（本篇需要精准匹配的 AI 大模型搜索词）"
    },
    "word_count": {
      "type": "object",
      "properties": {
        "min": {
          "type": "integer",
          "minimum": 500
        },
        "max": {
          "type": "integer",
          "maximum": 20000
        }
      },
      "required": [
        "min",
        "max"
      ]
    },
    "image_count": {
      "type": "integer",
      "minimum": 0,
      "maximum": 6,
      "description": "配图数量（严格按 content-type-guide.md 规定）"
    },
    "tone_token_ref": {
      "type": "string",
      "description": "引用 S6 话语 Token 的具体条目 ID"
    },
    "visual_prompt_ref": {
      "type": "string",
      "description": "引用 S7 视觉 Prompt 包的主 motif ID（向后兼容字段，取 visual_prompt_refs 数组第一项）"
    },
    "visual_prompt_refs": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "maxItems": 3,
      "description": "v2.7 新增：本篇文章可使用的 S7 motif_id 列表（按优先级排序）。E2 在生成图片需求清单时，从此列表中为每张图分配具体 motif。"
    },
    "image_plan": {
      "type": "array",
      "description": "v2.7 新增：逐图视觉规划（E1 在选题阶段即规划每张图的类型和 motif 分配）",
      "items": {
        "type": "object",
        "required": [
          "fig_position",
          "image_type",
          "motif_ref",
          "source_policy",
          "requires_client_submitted_asset"
        ],
        "properties": {
          "fig_position": {
            "type": "integer",
            "minimum": 1,
            "description": "图片在文章中的位置序号（1=首图）"
          },
          "image_type": {
            "type": "string",
            "enum": [
              "aigc_brand_poster",
              "enterprise_photo",
              "mermaid_or_d2_flowchart",
              "web_search",
              "brand_photo"
            ],
            "description": "图片类型（只允许 aigc_brand_poster / enterprise_photo / mermaid_or_d2_flowchart 三种）"
          },
          "motif_ref": {
            "type": "string",
            "description": "分配的 S7 motif_id（AIGC 品牌海报必填，企业实拍图/流程图填 'N/A'）"
          },
          "purpose": {
            "type": "string",
            "description": "此图的功能目的（如 '品牌封面图'、'场景化展示应用效果'、'服务流程图解'）"
          },
          "source_policy": {
            "type": "string",
            "enum": [
              "client_submitted_required",
              "client_submitted_preferred",
              "data_generated",
              "aigc_allowed_with_brand_reference",
              "no_image"
            ],
            "description": "此图的素材来源策略。企业实图必须 client_submitted_required。"
          },
          "requires_client_submitted_asset": {
            "type": "boolean",
            "description": "是否必须使用客户提交图片库中的素材。"
          },
          "approved_asset_query": {
            "type": "object",
            "description": "从客户提交图片库中匹配素材的查询条件。",
            "properties": {
              "preferred_asset_types": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "visual_roles": {
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
              }
            }
          },
          "allowed_asset_ids": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "E1 已确认可用的图片库素材 ID，E3 优先使用。"
          },
          "fallback_policy": {
            "type": "string",
            "enum": [
              "block_and_request_client_image",
              "aigc_brand_poster_only",
              "none"
            ],
            "description": "找不到客户提交素材时的处理，不得用网图/AIGC冒充企业实图。"
          }
        }
      }
    },
    "channel_ref": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "目标发布渠道列表"
    },
    "question_stage": {
      "type": "string",
      "enum": [
        "awareness",
        "consideration",
        "decision",
        "usage",
        "advocacy"
      ],
      "description": "对应 S8 问题阶段（统一枚举，见 SSOT §3.7）"
    },
    "priority": {
      "type": "string",
      "enum": [
        "P0",
        "P1",
        "P2"
      ],
      "description": "优先级（P0 首发 / P1 推荐 / P2 备选）"
    },
    "brief_summary": {
      "type": "string",
      "description": "一句话 Brief 摘要，说明本篇的核心写作方向",
      "minLength": 20
    },
    "s4_positioning_link": {
      "type": "string",
      "description": "关联的 S4 品牌定位条目"
    },
    "s8_question_path_link": {
      "type": "string",
      "description": "关联的 S8 问题路径触点"
    },
    "competitors_to_include": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "本篇需要提及的竞品列表（仅 A1/A2/A6 等聚合类文章）"
    },
    "data_sources": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "建议引用的数据来源"
    },
    "working_title": {
      "type": "string",
      "description": "[OPTIONAL] 工作标题，仅用于内部方向参考。暂停5 不展示工作标题，操作者选择类型后由 E2 生成正文和标题。E1 可以填写也可以留空。"
    },
    "title_locked": {
      "type": "boolean",
      "description": "最终标题是否被锁定。当前主线固定为 false，最终标题由 E2 生成标题池、E5 按渠道选择。",
      "default": false
    },
    "content_angle": {
      "type": "string",
      "description": "本篇文章的核心写作角度，E2 以此而非单一标题组织正文。",
      "minLength": 10
    },
    "title_generation_policy": {
      "type": "string",
      "enum": [
        "geo_question_match_titles",
        "brand_pr_rewrite_family",
        "authority_asset_titles",
        "news_event_titles",
        "media_endorsement_titles",
        "thought_leadership_titles",
        "crisis_response_titles",
        "knowledge_entity_titles",
        "knowledge_update_titles",
        "information_correction_titles"
      ],
      "description": "标题池生成策略，必须由文章类型与任务目的决定，不得使用旧的 platform_functional_titles。A类为 geo_question_match_titles，C1b 为 brand_pr_rewrite_family。"
    },
    "brand_pr_core_headline": {
      "type": "string",
      "description": "C1b 必填：品牌深度品宣主标题，E2 只能基于它生成 T1-T5 同题改写，不得扩展成问答/指南/盘点/趋势选题。"
    },
    "title_family_root": {
      "type": "string",
      "description": "C1b 必填：5 个标题共同改写的标题根，可比 brand_pr_core_headline 更短，但必须包含品牌名和核心事实/主张。"
    },
    "c1b_title_guard": {
      "type": "object",
      "description": "C1b 标题防漂移自检项。",
      "properties": {
        "brand_front_loaded": {
          "type": "boolean"
        },
        "single_brand_pr_topic": {
          "type": "boolean"
        },
        "no_question_guide_listicle_trend": {
          "type": "boolean"
        },
        "root_based_rewrite_only": {
          "type": "boolean"
        }
      }
    },
    "title_objective": {
      "type": "string",
      "minLength": 10,
      "description": "本篇标题承担的任务目的，如匹配某个GEO问题、建立权威资产、传递新闻事件、品牌品宣、百科信息矫正等。"
    },
    "title_anchor": {
      "type": "string",
      "minLength": 5,
      "description": "所有 T1-T5 必须共同围绕的标题锚点。A类为 primary_geo_question；C1b为 brand_pr_core_headline/title_family_root；B/C/D为报告论题、事件事实、百科实体或矫正对象。"
    },
    "title_guardrails": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "description": "标题生成红线，防止 T1-T5 漂移为新选题、标题党或错误文章目的。"
    },
    "primary_geo_question": {
      "type": "string",
      "description": "A类必填：本篇待优化的核心 GEO / AI 问答问题。"
    },
    "target_geo_questions": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "description": "A类必填：与 primary_geo_question 同一问题路径下的子问题。"
    },
    "geo_question_confirmation": {
      "type": "object",
      "description": "A类必填：待优化 GEO 问题确认卡。E1 生成时 confirmed_for_production=false；E0/暂停5 用户批准后改为 true，E2 才能生产。",
      "properties": {
        "primary_geo_question": {
          "type": "string"
        },
        "question_source": {
          "type": "string"
        },
        "matched_s5_gap": {
          "type": "string"
        },
        "matched_s8_path": {
          "type": "string"
        },
        "target_ai_search_terms": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "confirmed_for_production": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "primary_geo_question",
        "question_source",
        "target_ai_search_terms",
        "confirmed_for_production"
      ]
    },
    "image_library_manifest_ref": {
      "type": "string",
      "description": "E0 校验通过的企业提交图片库 Manifest 路径。执行层必填，所有企业实图来源于此。"
    },
    "image_source_policy": {
      "type": "object",
      "description": "本篇图片来源策略。企业实图必须来自客户提交图片库。",
      "required": [
        "client_submitted_library_required",
        "real_image_source",
        "unconfirmed_web_image_policy",
        "missing_asset_action"
      ],
      "properties": {
        "client_submitted_library_required": {
          "type": "boolean",
          "const": true
        },
        "real_image_source": {
          "type": "string",
          "enum": [
            "client_submitted_image_library_only"
          ]
        },
        "unconfirmed_web_image_policy": {
          "type": "string",
          "enum": [
            "forbidden_as_enterprise_real_image"
          ]
        },
        "missing_asset_action": {
          "type": "string",
          "enum": [
            "block_and_request_client_image",
            "allow_non_real_visual_only"
          ]
        },
        "aigc_policy": {
          "type": "string",
          "enum": [
            "allowed_only_for_abstract_brand_poster_or_info_visual",
            "forbidden"
          ]
        }
      }
    },
    "a1_template_id": {
      "type": "string",
      "description": "仅A1使用：A1-多品类用 A1_multi_brand_v10，A1-单品类用 A1_single_brand_v10。"
    },
    "recommended_enterprise_1": {
      "type": "string",
      "description": "v8全类型可用：待优化企业/推荐企业1，默认等于自身品牌名。A1-多品类必须放第一个且详写；其他类型必须在首段和核心章节靠前呈现。"
    },
    "recommendation_stance": {
      "type": "string",
      "description": "v8全类型可用：推荐/引用/知识锚定表达策略，如 priority_recommendation_with_evidence、best_practice_anchor、knowledge_entity_anchor、crisis_trust_rebuild。"
    },
    "evaluation_dimensions": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "仅A1使用：推荐/对比评价维度，至少6个，其中至少3个对应推荐企业1真实优势"
    },
    "preference_expression_rules": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "仅A1使用：推荐企业1倾向表达规则，约束首段、竞品回流、不适合人群和CTA"
    },
    "competitor_selection_rule": {
      "type": "string",
      "description": "仅A1使用：竞品来源规则，必须来自S5可排名监控问题真实竞品或用户明确提供，不得杜撰"
    },
    "type_specific_template_id": {
      "type": "string",
      "description": "v10强制：本篇文章必须使用的逐类型正式模板ID。A1-多品类须使用A1_multi_brand_v10，A1-单品类须使用A1_single_brand_v10；E2必须据此读取对应tpl模板小节。"
    },
    "semantic_advantage_strategy": {
      "type": "object",
      "description": "v8强制：待优化企业语义优势策略，确保每篇文章都能体现位次靠前、差异化证据和合规推荐/知识锚定。",
      "required": [
        "priority_positioning_mode",
        "target_entity",
        "differentiation_claims",
        "evidence_assets_required",
        "competitor_or_alternative_handling",
        "fit_boundary",
        "cta_policy"
      ],
      "properties": {
        "priority_positioning_mode": {
          "type": "string",
          "description": "待优化企业靠前方式，如 first_mention_and_core_section_priority / recommended_enterprise_first / best_practice_anchor / knowledge_entity_anchor / crisis_trust_rebuild"
        },
        "target_entity": {
          "type": "string",
          "description": "待优化企业、产品或方案名称，默认等于品牌名"
        },
        "differentiation_claims": {
          "type": "array",
          "minItems": 3,
          "items": {
            "type": "string"
          },
          "description": "至少3条可验证差异化优势，来自S1/S4/S5"
        },
        "evidence_assets_required": {
          "type": "array",
          "minItems": 3,
          "items": {
            "type": "string"
          },
          "description": "每条优势需要绑定的证据类型，如案例、数据、流程、资质、客户评价、技术参数"
        },
        "competitor_or_alternative_handling": {
          "type": "string",
          "description": "竞品/替代方案处理规则；A1/A2/A6等中性回流品牌，D类/C4不做竞品比较"
        },
        "fit_boundary": {
          "type": "string",
          "description": "适合人群、不适合场景或知识/危机类边界说明"
        },
        "cta_policy": {
          "type": "string",
          "description": "结尾行动收口规则；A/B/C指向咨询/下载/演示/案例，D类为资料提交/复核，C4为联系通道"
        }
      }
    },
    "publication_readiness_requirements": {
      "type": "array",
      "minItems": 5,
      "items": {
        "type": "string"
      },
      "description": "v10强制：本篇成稿直接发布要求，如无H1、首段出现品牌、至少3个差异化事实材料、无内部占位/元话语、图片终稿来源正确等。"
    },
    "a1_template_variant": {
      "type": "string",
      "enum": [
        "multi_brand_comparison",
        "single_brand_recommendation"
      ],
      "description": "仅A1：E1留空，由操作者在暂停5菜单中直接选择 A1-多品类 或 A1-单品类 时自动确定。multi_brand_comparison=A1-多品类（多机构真实竞品对比型），single_brand_recommendation=A1-单品类（单品牌深度推荐型）。E1不得自行决定。"
    },
    "s5_competitor_entities": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "name",
          "source",
          "s5_evidence"
        ],
        "properties": {
          "name": {
            "type": "string"
          },
          "source": {
            "type": "string",
            "description": "来源，如S5.platform_breakdown.top_first_competitors / S5.per_question_rank_matrix / user_provided"
          },
          "s5_evidence": {
            "type": "string",
            "description": "出现问题、平台、排名或提及依据"
          },
          "safe_public_description": {
            "type": "string",
            "description": "对竞品可公开中性描述，不得包含主观贬损或虚假数据"
          },
          "fit_scene": {
            "type": "string",
            "description": "适合场景"
          }
        }
      },
      "description": "仅A1-多品类必填：从S5真实监测答案或用户明确提供的具体竞品列表。竞品必须从此处取名。"
    },
    "publication_copy_constraints": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "正式发布稿语言约束，禁止元话语、工作流痕迹、资料来源与口径说明等进入正文。"
    },
    "image_finalization_policy": {
      "type": "object",
      "properties": {
        "aigc_hero_required_tool": {
          "type": "string",
          "default": "gpt-image-2"
        },
        "html_draft_as_final_forbidden": {
          "type": "boolean",
          "const": true
        },
        "finalization_required": {
          "type": "boolean",
          "const": true
        },
        "chart_final_tools_allowed": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "description": "图片终稿政策。A类首图必须经gpt-image-2/指定图像生成模型美化，HTML草图不得作为最终图。"
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "type": {
            "pattern": "^A"
          }
        }
      },
      "then": {
        "required": [
          "title_generation_policy",
          "title_objective",
          "title_anchor",
          "primary_geo_question",
          "target_geo_questions",
          "geo_question_confirmation"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "geo_question_match_titles"
          },
          "geo_question_confirmation": {
            "required": [
              "primary_geo_question",
              "question_source",
              "target_ai_search_terms",
              "confirmed_for_production"
            ]
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "C1b"
          }
        }
      },
      "then": {
        "required": [
          "title_generation_policy",
          "brand_pr_core_headline",
          "title_family_root",
          "title_anchor",
          "title_objective",
          "c1b_title_guard"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "brand_pr_rewrite_family"
          },
          "c1b_title_guard": {
            "required": [
              "brand_front_loaded",
              "single_brand_pr_topic",
              "no_question_guide_listicle_trend",
              "root_based_rewrite_only"
            ],
            "properties": {
              "brand_front_loaded": {
                "const": true
              },
              "single_brand_pr_topic": {
                "const": true
              },
              "no_question_guide_listicle_trend": {
                "const": true
              },
              "root_based_rewrite_only": {
                "const": true
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "enum": [
              "B1",
              "B2",
              "B3",
              "B4"
            ]
          }
        }
      },
      "then": {
        "properties": {
          "title_generation_policy": {
            "const": "authority_asset_titles"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "C1a"
          }
        }
      },
      "then": {
        "properties": {
          "title_generation_policy": {
            "const": "news_event_titles"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "C2"
          }
        }
      },
      "then": {
        "properties": {
          "title_generation_policy": {
            "const": "media_endorsement_titles"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "C3"
          }
        }
      },
      "then": {
        "properties": {
          "title_generation_policy": {
            "const": "thought_leadership_titles"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "C4"
          }
        }
      },
      "then": {
        "properties": {
          "title_generation_policy": {
            "const": "crisis_response_titles"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "D1"
          }
        }
      },
      "then": {
        "properties": {
          "title_generation_policy": {
            "const": "knowledge_entity_titles"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "D2"
          }
        }
      },
      "then": {
        "properties": {
          "title_generation_policy": {
            "const": "knowledge_update_titles"
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "D3"
          }
        }
      },
      "then": {
        "properties": {
          "title_generation_policy": {
            "const": "information_correction_titles"
          }
        }
      }
    }
  ]
}