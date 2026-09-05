{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "FrontMind Strategy Pack",
  "type": "object",
  "required": [
    "meta",
    "artifacts",
    "recommended_business_actions",
    "s7_branch",
    "pause_log"
  ],
  "properties": {
    "meta": {
      "type": "object",
      "required": [
        "brand",
        "version",
        "created_at",
        "created_by",
        "strategy_nodes_completed"
      ],
      "properties": {
        "brand": {
          "type": "string",
          "description": "品牌中文简称，如'浚源检测'"
        },
        "version": {
          "type": "integer",
          "minimum": 1,
          "description": "策略包版本号，初始为 1，每次回流重算递增"
        },
        "created_at": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 格式的创建时间"
        },
        "created_by": {
          "type": "string",
          "const": "S0_strategy_orchestrator"
        },
        "strategy_nodes_completed": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "S1",
              "S2",
              "S3",
              "S4",
              "S5",
              "S6",
              "S7",
              "S8",
              "S9"
            ]
          },
          "minItems": 9
        }
      }
    },
    "artifacts": {
      "type": "object",
      "description": "各策略节点的产出文件路径与校验哈希",
      "required": [
        "S1_brand_facts",
        "S2_marketing_atlas",
        "S3_category_trend",
        "S4_positioning",
        "S5_diagnosis",
        "S6_verbal_identity",
        "S7_supersign",
        "S8_question_qa",
        "S9_enablement"
      ],
      "properties": {
        "S1_brand_facts": {
          "type": "object",
          "required": [
            "json",
            "md",
            "pdf",
            "sha256"
          ],
          "properties": {
            "json": {
              "type": "string",
              "description": "品牌事实图谱 JSON 文件路径"
            },
            "md": {
              "type": "string",
              "description": "品牌知识库 MD 文件路径"
            },
            "pdf": {
              "type": "string",
              "description": "品牌知识库 PDF 文件路径"
            },
            "gap_report": {
              "type": "string",
              "description": "缺口报告 MD 文件路径"
            },
            "sha256": {
              "type": "string",
              "description": "主文件 SHA256 哈希"
            }
          }
        },
        "S2_marketing_atlas": {
          "type": "object",
          "required": [
            "json",
            "md",
            "pdf",
            "sha256"
          ],
          "properties": {
            "json": {
              "type": "string"
            },
            "md": {
              "type": "string"
            },
            "pdf": {
              "type": "string"
            },
            "sha256": {
              "type": "string"
            }
          }
        },
        "S3_category_trend": {
          "type": "object",
          "required": [
            "md",
            "pdf",
            "json",
            "sha256"
          ],
          "properties": {
            "md": {
              "type": "string"
            },
            "pdf": {
              "type": "string"
            },
            "json": {
              "type": "string",
              "description": "趋势打分卡 JSON"
            },
            "sha256": {
              "type": "string"
            }
          }
        },
        "S4_positioning": {
          "type": "object",
          "required": [
            "md",
            "pdf",
            "json",
            "sha256"
          ],
          "properties": {
            "md": {
              "type": "string",
              "description": "品牌定位声明 MD"
            },
            "pdf": {
              "type": "string"
            },
            "json": {
              "type": "string",
              "description": "定位声明结构化 JSON"
            },
            "report_md": {
              "type": "string",
              "description": "定位分析报告 MD"
            },
            "report_pdf": {
              "type": "string"
            },
            "sha256": {
              "type": "string"
            }
          }
        },
        "S5_diagnosis": {
          "type": "object",
          "required": [
            "json",
            "html",
            "md",
            "pdf",
            "gap_md",
            "sha256"
          ],
          "properties": {
            "json": {
              "type": "string",
              "description": "诊断数据 JSON（E0 在步骤 0.1.3 从此文件提取 s5_execution_snapshot）"
            },
            "html": {
              "type": "string"
            },
            "md": {
              "type": "string"
            },
            "pdf": {
              "type": "string"
            },
            "gap_md": {
              "type": "string",
              "description": "Gap 报告 MD"
            },
            "sha256": {
              "type": "string"
            }
          },
          "x-execution-layer-note": "★ v4 新增：E0 在步骤 0.1.3 从 json 文件提取 s5_execution_snapshot，包含 core_metrics、seven_dimensions、gap_analysis、competitor_gap_matrix 等字段，传递给 E1（品牌位置感知选题）和 E2（差异化写作策略）。详见 E0 SKILL.md 步骤 0.1.3。"
        },
        "S5.5_semantic_audit": {
          "type": "object",
          "required": [
            "json",
            "md",
            "pdf",
            "sha256"
          ],
          "properties": {
            "json": {
              "type": "string",
              "description": "语义资产评分卡 JSON"
            },
            "md": {
              "type": "string",
              "description": "语义资产审计报告 MD"
            },
            "pdf": {
              "type": "string"
            },
            "sha256": {
              "type": "string"
            }
          },
          "x-execution-layer-note": "E0 可从此文件提取 BSAS 总分和各维度分数，传递给 E1（语义资产补强选题）和 E5（分发优先级）。"
        },
        "S6_verbal_identity": {
          "type": "object",
          "required": [
            "md",
            "pdf",
            "token_json",
            "sha256"
          ],
          "properties": {
            "md": {
              "type": "string"
            },
            "pdf": {
              "type": "string"
            },
            "token_json": {
              "type": "string",
              "description": "话语 Token JSON"
            },
            "sha256": {
              "type": "string"
            }
          }
        },
        "S7_supersign": {
          "type": "object",
          "required": [
            "prompt_json",
            "md",
            "pdf",
            "sha256"
          ],
          "properties": {
            "prompt_json": {
              "type": "string",
              "description": "视觉 Prompt 包 JSON"
            },
            "md": {
              "type": "string"
            },
            "pdf": {
              "type": "string"
            },
            "sha256": {
              "type": "string"
            }
          }
        },
        "S8_question_qa": {
          "type": "object",
          "required": [
            "json",
            "matrix_json",
            "calendar_json",
            "md",
            "pdf",
            "sha256"
          ],
          "properties": {
            "json": {
              "type": "string",
              "description": "问答树 JSON"
            },
            "matrix_json": {
              "type": "string",
              "description": "问答矩阵 JSON（≥ 30 条）"
            },
            "calendar_json": {
              "type": "string",
              "description": "内容日历 JSON（12 周）"
            },
            "md": {
              "type": "string"
            },
            "pdf": {
              "type": "string"
            },
            "blueprint_md": {
              "type": "string",
              "description": "落地页蓝图 MD"
            },
            "sha256": {
              "type": "string"
            }
          }
        },
        "S9_enablement": {
          "type": "object",
          "required": [
            "md",
            "pdf",
            "completeness_md",
            "sha256"
          ],
          "properties": {
            "md": {
              "type": "string"
            },
            "pdf": {
              "type": "string"
            },
            "completeness_md": {
              "type": "string",
              "description": "策略完整性检查 MD"
            },
            "sha256": {
              "type": "string"
            }
          }
        }
      }
    },
    "recommended_business_actions": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": [
          "action_id",
          "priority",
          "problem_source",
          "reason",
          "expected_business_effect"
        ],
        "properties": {
          "action_id": {
            "type": "string",
            "description": "GEO 业务行动 ID，例如 GEO_A1_entity_facts"
          },
          "priority": {
            "type": "string",
            "enum": [
              "P0",
              "P1",
              "P2"
            ],
            "description": "行动优先级"
          },
          "problem_source": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "问题来源策略节点，例如 S1、S4、S5、S8"
          },
          "reason": {
            "type": "string",
            "description": "从 S1-S8 发现的问题与业务影响"
          },
          "expected_business_effect": {
            "type": "string",
            "description": "该行动预期带来的 GEO 业务效果"
          }
        }
      },
      "description": "S9 基于 S1-S8 问题总结后推荐的 GEO 业务行动清单"
    },
    "s7_branch": {
      "type": "string",
      "enum": [
        "A",
        "B"
      ],
      "description": "S7 执行的分支（A=已有VI, B=无VI）"
    },
    "pause_log": {
      "type": "object",
      "required": [
        "pause_1",
        "pause_2",
        "pause_3",
        "pause_4"
      ],
      "properties": {
        "pause_1": {
          "type": "object",
          "description": "策略层：品牌事实图谱确认",
          "properties": {
            "status": {
              "type": "string",
              "enum": [
                "confirmed",
                "modified"
              ]
            },
            "user_feedback": {
              "type": "string"
            }
          }
        },
        "pause_2": {
          "type": "object",
          "required": [
            "status",
            "uploaded_file"
          ],
          "properties": {
            "status": {
              "type": "string",
              "enum": [
                "completed",
                "pending_upload"
              ],
              "description": "AI 可见性监测数据上传状态。S4 完成后必须由客户自行确认 AI 监控问题、监测地域/平台并上传监测 JSON；不复用 S2 问题。"
            },
            "region": {
              "type": "string",
              "enum": [
                "海外",
                "国内",
                "全球",
                ""
              ],
              "description": "客户确认的 AI 监测地域范围。"
            },
            "uploaded_file": {
              "type": [
                "string",
                "null"
              ],
              "description": "AI 可见性监测数据 JSON。"
            }
          },
          "description": "策略层暂停 2：S4 完成后、S5 启动前的 AI 监测问题/地域/数据确认。"
        },
        "pause_3": {
          "type": "object",
          "required": [
            "status"
          ],
          "properties": {
            "status": {
              "type": "string",
              "enum": [
                "completed",
                "pending_generation",
                "pending_client_confirmation"
              ],
              "description": "暂停3 应答逻辑确认表回填状态：completed 表示企业已回填；pending_generation 表示 S9 完成但尚未生成确认表；pending_client_confirmation 表示确认表已生成待企业回填。"
            },
            "generated_file": {
              "type": [
                "string",
                "null"
              ],
              "description": "S9 完成后生成、交企业回填的《应答逻辑确认表》Excel。"
            },
            "uploaded_file": {
              "type": [
                "string",
                "null"
              ],
              "description": "企业现场讨论回填后的《应答逻辑确认表》Excel，作为 S10 子表2 数据源。"
            },
            "confirmation_record": {
              "type": [
                "string",
                "null"
              ],
              "description": "企业直接回复确认无误时生成的确认记录 JSON。"
            }
          },
          "description": "策略层暂停 3：S9 全部执行完后、S10 和执行层启动前，生成《应答逻辑确认表》交企业现场讨论回填。"
        },
        "pause_4": {
          "type": "object",
          "description": "执行层：核心素材清单方案审批",
          "properties": {
            "status": {
              "type": "string",
              "enum": [
                "pending",
                "approved",
                "partially_approved",
                "modified"
              ]
            },
            "approved_article_ids": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "user_modifications": {
              "type": "string"
            }
          }
        }
      },
      "description": "全局暂停/确认记录：pause_1=事实确认，pause_2=AI监测问题/地域/数据确认，pause_3=应答逻辑确认表回填，pause_4=执行层内容审批。"
    },
    "client_deliverables": {
      "type": "object",
      "properties": {
        "brand_info_confirmation_sheet": {
          "type": [
            "string",
            "null"
          ],
          "description": "S10 输出的《品牌信息确认表》XLSX（双子表）。"
        },
        "answer_logic_confirmation_form": {
          "type": [
            "string",
            "null"
          ],
          "description": "暂停3 生成、交企业回填的《应答逻辑确认表》Excel。"
        },
        "answer_logic_confirmation_form_confirmed": {
          "type": [
            "string",
            "null"
          ],
          "description": "企业现场讨论回填后的《应答逻辑确认表》Excel，作为 S10 子表2 数据源。"
        }
      }
    }
  }
}