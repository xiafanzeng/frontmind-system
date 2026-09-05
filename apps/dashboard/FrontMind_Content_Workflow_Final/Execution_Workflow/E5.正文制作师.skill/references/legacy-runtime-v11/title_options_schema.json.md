{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "E2 title_options schema",
  "type": "object",
  "required": [
    "article_id",
    "article_type",
    "body_version",
    "title_generation_policy",
    "recommended_default_title_id",
    "title_options",
    "title_objective",
    "title_anchor"
  ],
  "properties": {
    "article_id": {
      "type": "string"
    },
    "body_version": {
      "type": "string"
    },
    "recommended_default_title_id": {
      "type": "string",
      "enum": [
        "T1",
        "T2",
        "T3",
        "T4",
        "T5"
      ]
    },
    "title_options": {
      "type": "array",
      "minItems": 5,
      "maxItems": 5,
      "items": {
        "type": "object",
        "required": [
          "title_id",
          "title",
          "angle",
          "best_for",
          "reason",
          "risk_level",
          "supported_by_body"
        ],
        "properties": {
          "title_id": {
            "type": "string",
            "enum": [
              "T1",
              "T2",
              "T3",
              "T4",
              "T5"
            ]
          },
          "title": {
            "type": "string",
            "minLength": 5
          },
          "angle": {
            "type": "string"
          },
          "best_for": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "reason": {
            "type": "string"
          },
          "risk_level": {
            "type": "string",
            "enum": [
              "low",
              "medium",
              "high"
            ]
          },
          "supported_by_body": {
            "type": "boolean",
            "const": true
          },
          "rewrite_style": {
            "type": "string",
            "description": "标题改写样式。C1b 应为权威通稿型/品牌实力型/发展路径型/服务模式型/媒体友好型之一。"
          },
          "same_topic_rewrite": {
            "type": "boolean",
            "description": "是否为同一主标题根的改写。C1b 必须为 true。"
          },
          "drift_check": {
            "type": "object",
            "description": "标题漂移自检。C1b 用于声明未改写成问答、指南、盘点、趋势或新选题。",
            "properties": {
              "brand_front_loaded": {
                "type": "boolean"
              },
              "no_question_or_guide_angle": {
                "type": "boolean"
              },
              "no_industry_macro_angle": {
                "type": "boolean"
              },
              "same_core_claim_as_root": {
                "type": "boolean"
              }
            }
          },
          "question_alignment": {
            "type": "object",
            "description": "A类标题必填：说明标题匹配的待优化 GEO 问题与子查询词。",
            "properties": {
              "matched_geo_question": {
                "type": "string"
              },
              "matched_terms": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "primary_geo_question_matched": {
                "type": "boolean"
              },
              "no_topic_drift": {
                "type": "boolean"
              }
            }
          },
          "purpose_alignment": {
            "type": "object",
            "description": "B/C/D 及 C1a/C2/C3/C4 类型标题必填：说明标题与本类型内容资产目的和 title_anchor 的对齐。",
            "properties": {
              "title_anchor_preserved": {
                "type": "boolean"
              },
              "objective_matched": {
                "type": "boolean"
              },
              "no_topic_drift": {
                "type": "boolean"
              },
              "no_wrong_policy_angle": {
                "type": "boolean"
              }
            }
          }
        }
      }
    },
    "article_type": {
      "type": "string",
      "description": "文章类型，如 A1、A3、C1b。C1b 会触发品牌品宣主标题同题改写规则。"
    },
    "brand_name": {
      "type": "string",
      "description": "品牌正式名称；C1b 标题必须包含并前置该品牌名。"
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
      "description": "标题生成策略。必须按文章类型与任务目的选择；旧 platform_functional_titles 已废弃。"
    },
    "title_family_root": {
      "type": "string",
      "description": "5 个标题共同改写的主标题根。C1b 必填，用于防止标题漂移成问答/指南/盘点/趋势等新选题。"
    },
    "brand_pr_core_headline": {
      "type": "string",
      "description": "C1b 品牌深度品宣主标题，可与 title_family_root 相同或更完整。"
    },
    "title_objective": {
      "type": "string",
      "minLength": 10,
      "description": "本篇标题承担的任务目的。"
    },
    "title_anchor": {
      "type": "string",
      "minLength": 5,
      "description": "所有 T1-T5 必须共同围绕的标题锚点。"
    },
    "primary_geo_question": {
      "type": "string",
      "description": "A类必填：待优化核心 GEO 问题。"
    },
    "target_geo_questions": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "A类必填：待优化 GEO 子问题列表。"
    },
    "geo_question_confirmation": {
      "type": "object",
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
          "type": "boolean"
        }
      }
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "article_type": {
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
          "title_options"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "geo_question_match_titles"
          },
          "target_geo_questions": {
            "minItems": 1
          }
        },
        "allOf": [
          {
            "properties": {
              "title_options": {
                "items": {
                  "required": [
                    "question_alignment"
                  ],
                  "properties": {
                    "question_alignment": {
                      "type": "object",
                      "required": [
                        "matched_geo_question",
                        "matched_terms",
                        "primary_geo_question_matched",
                        "no_topic_drift"
                      ],
                      "properties": {
                        "primary_geo_question_matched": {
                          "const": true
                        },
                        "no_topic_drift": {
                          "const": true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    },
    {
      "if": {
        "properties": {
          "article_type": {
            "const": "C1b"
          }
        }
      },
      "then": {
        "required": [
          "article_type",
          "title_generation_policy",
          "title_family_root",
          "brand_name",
          "title_options",
          "title_objective",
          "title_anchor"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "brand_pr_rewrite_family"
          }
        },
        "allOf": [
          {
            "properties": {
              "title_options": {
                "items": {
                  "required": [
                    "rewrite_style",
                    "same_topic_rewrite",
                    "drift_check"
                  ],
                  "properties": {
                    "angle": {
                      "enum": [
                        "权威通稿型",
                        "品牌实力型",
                        "发展路径型",
                        "服务模式型",
                        "媒体友好型"
                      ]
                    },
                    "same_topic_rewrite": {
                      "const": true
                    },
                    "rewrite_style": {
                      "enum": [
                        "权威通稿型",
                        "品牌实力型",
                        "发展路径型",
                        "服务模式型",
                        "媒体友好型"
                      ]
                    },
                    "drift_check": {
                      "type": "object",
                      "required": [
                        "brand_front_loaded",
                        "no_question_or_guide_angle",
                        "no_industry_macro_angle",
                        "same_core_claim_as_root"
                      ],
                      "properties": {
                        "brand_front_loaded": {
                          "const": true
                        },
                        "no_question_or_guide_angle": {
                          "const": true
                        },
                        "no_industry_macro_angle": {
                          "const": true
                        },
                        "same_core_claim_as_root": {
                          "const": true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    },
    {
      "if": {
        "properties": {
          "article_type": {
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
        "required": [
          "title_generation_policy",
          "title_objective",
          "title_anchor",
          "title_options"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "authority_asset_titles"
          }
        },
        "allOf": [
          {
            "properties": {
              "title_options": {
                "items": {
                  "required": [
                    "purpose_alignment"
                  ],
                  "properties": {
                    "purpose_alignment": {
                      "type": "object",
                      "required": [
                        "title_anchor_preserved",
                        "objective_matched",
                        "no_topic_drift",
                        "no_wrong_policy_angle"
                      ],
                      "properties": {
                        "title_anchor_preserved": {
                          "const": true
                        },
                        "objective_matched": {
                          "const": true
                        },
                        "no_topic_drift": {
                          "const": true
                        },
                        "no_wrong_policy_angle": {
                          "const": true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    },
    {
      "if": {
        "properties": {
          "article_type": {
            "const": "C1a"
          }
        }
      },
      "then": {
        "required": [
          "title_generation_policy",
          "title_objective",
          "title_anchor",
          "title_options"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "news_event_titles"
          }
        },
        "allOf": [
          {
            "properties": {
              "title_options": {
                "items": {
                  "required": [
                    "purpose_alignment"
                  ],
                  "properties": {
                    "purpose_alignment": {
                      "type": "object",
                      "required": [
                        "title_anchor_preserved",
                        "objective_matched",
                        "no_topic_drift",
                        "no_wrong_policy_angle"
                      ],
                      "properties": {
                        "title_anchor_preserved": {
                          "const": true
                        },
                        "objective_matched": {
                          "const": true
                        },
                        "no_topic_drift": {
                          "const": true
                        },
                        "no_wrong_policy_angle": {
                          "const": true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    },
    {
      "if": {
        "properties": {
          "article_type": {
            "const": "C2"
          }
        }
      },
      "then": {
        "required": [
          "title_generation_policy",
          "title_objective",
          "title_anchor",
          "title_options"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "media_endorsement_titles"
          }
        },
        "allOf": [
          {
            "properties": {
              "title_options": {
                "items": {
                  "required": [
                    "purpose_alignment"
                  ],
                  "properties": {
                    "purpose_alignment": {
                      "type": "object",
                      "required": [
                        "title_anchor_preserved",
                        "objective_matched",
                        "no_topic_drift",
                        "no_wrong_policy_angle"
                      ],
                      "properties": {
                        "title_anchor_preserved": {
                          "const": true
                        },
                        "objective_matched": {
                          "const": true
                        },
                        "no_topic_drift": {
                          "const": true
                        },
                        "no_wrong_policy_angle": {
                          "const": true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    },
    {
      "if": {
        "properties": {
          "article_type": {
            "const": "C3"
          }
        }
      },
      "then": {
        "required": [
          "title_generation_policy",
          "title_objective",
          "title_anchor",
          "title_options"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "thought_leadership_titles"
          }
        },
        "allOf": [
          {
            "properties": {
              "title_options": {
                "items": {
                  "required": [
                    "purpose_alignment"
                  ],
                  "properties": {
                    "purpose_alignment": {
                      "type": "object",
                      "required": [
                        "title_anchor_preserved",
                        "objective_matched",
                        "no_topic_drift",
                        "no_wrong_policy_angle"
                      ],
                      "properties": {
                        "title_anchor_preserved": {
                          "const": true
                        },
                        "objective_matched": {
                          "const": true
                        },
                        "no_topic_drift": {
                          "const": true
                        },
                        "no_wrong_policy_angle": {
                          "const": true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    },
    {
      "if": {
        "properties": {
          "article_type": {
            "const": "C4"
          }
        }
      },
      "then": {
        "required": [
          "title_generation_policy",
          "title_objective",
          "title_anchor",
          "title_options"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "crisis_response_titles"
          }
        },
        "allOf": [
          {
            "properties": {
              "title_options": {
                "items": {
                  "required": [
                    "purpose_alignment"
                  ],
                  "properties": {
                    "purpose_alignment": {
                      "type": "object",
                      "required": [
                        "title_anchor_preserved",
                        "objective_matched",
                        "no_topic_drift",
                        "no_wrong_policy_angle"
                      ],
                      "properties": {
                        "title_anchor_preserved": {
                          "const": true
                        },
                        "objective_matched": {
                          "const": true
                        },
                        "no_topic_drift": {
                          "const": true
                        },
                        "no_wrong_policy_angle": {
                          "const": true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    },
    {
      "if": {
        "properties": {
          "article_type": {
            "const": "D1"
          }
        }
      },
      "then": {
        "required": [
          "title_generation_policy",
          "title_objective",
          "title_anchor",
          "title_options"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "knowledge_entity_titles"
          }
        },
        "allOf": [
          {
            "properties": {
              "title_options": {
                "items": {
                  "required": [
                    "purpose_alignment"
                  ],
                  "properties": {
                    "purpose_alignment": {
                      "type": "object",
                      "required": [
                        "title_anchor_preserved",
                        "objective_matched",
                        "no_topic_drift",
                        "no_wrong_policy_angle"
                      ],
                      "properties": {
                        "title_anchor_preserved": {
                          "const": true
                        },
                        "objective_matched": {
                          "const": true
                        },
                        "no_topic_drift": {
                          "const": true
                        },
                        "no_wrong_policy_angle": {
                          "const": true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    },
    {
      "if": {
        "properties": {
          "article_type": {
            "const": "D2"
          }
        }
      },
      "then": {
        "required": [
          "title_generation_policy",
          "title_objective",
          "title_anchor",
          "title_options"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "knowledge_update_titles"
          }
        },
        "allOf": [
          {
            "properties": {
              "title_options": {
                "items": {
                  "required": [
                    "purpose_alignment"
                  ],
                  "properties": {
                    "purpose_alignment": {
                      "type": "object",
                      "required": [
                        "title_anchor_preserved",
                        "objective_matched",
                        "no_topic_drift",
                        "no_wrong_policy_angle"
                      ],
                      "properties": {
                        "title_anchor_preserved": {
                          "const": true
                        },
                        "objective_matched": {
                          "const": true
                        },
                        "no_topic_drift": {
                          "const": true
                        },
                        "no_wrong_policy_angle": {
                          "const": true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    },
    {
      "if": {
        "properties": {
          "article_type": {
            "const": "D3"
          }
        }
      },
      "then": {
        "required": [
          "title_generation_policy",
          "title_objective",
          "title_anchor",
          "title_options"
        ],
        "properties": {
          "title_generation_policy": {
            "const": "information_correction_titles"
          }
        },
        "allOf": [
          {
            "properties": {
              "title_options": {
                "items": {
                  "required": [
                    "purpose_alignment"
                  ],
                  "properties": {
                    "purpose_alignment": {
                      "type": "object",
                      "required": [
                        "title_anchor_preserved",
                        "objective_matched",
                        "no_topic_drift",
                        "no_wrong_policy_angle"
                      ],
                      "properties": {
                        "title_anchor_preserved": {
                          "const": true
                        },
                        "objective_matched": {
                          "const": true
                        },
                        "no_topic_drift": {
                          "const": true
                        },
                        "no_wrong_policy_angle": {
                          "const": true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    }
  ]
}
