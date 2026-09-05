{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "E5 HarnessGEO Optimization Config",
  "type": "object",
  "required": ["brand", "articles"],
  "properties": {
    "brand": {
      "type": "string",
      "description": "Brand name used in E5 canonical metadata."
    },
    "dataset": {
      "type": "string",
      "default": "E-commerce",
      "enum": ["E-commerce", "Researchy-GEO"],
      "description": "HarnessGEO dataset/profile."
    },
    "engine_llm": {
      "type": "string",
      "default": "gpt",
      "description": "Target generation engine, e.g. gpt, gemini, claude."
    },
    "prefer_real_harnessgeo": {
      "type": "boolean",
      "default": true,
      "description": "Try real harnessgeo.rewriters.rewrite_document first; fallback is mandatory if unavailable."
    },
    "canonical_body_policy": {
      "type": "string",
      "const": "same_harnessgeo_body_across_channels"
    },
    "run_log": {
      "type": "string",
      "description": "Output path for E5_{brand}_harnessgeo_run_log.json."
    },
    "articles": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["article_id", "input_md", "output_md", "report_json"],
        "properties": {
          "article_id": {"type": "string"},
          "input_md": {"type": "string", "description": "E4 final.md input path."},
          "output_md": {"type": "string", "description": "E5 harnessgeo optimized.md output path."},
          "report_json": {"type": "string", "description": "E5 harnessgeo report.json output path."},
          "dataset": {"type": "string", "enum": ["E-commerce", "Researchy-GEO"]},
          "engine_llm": {"type": "string"}
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
