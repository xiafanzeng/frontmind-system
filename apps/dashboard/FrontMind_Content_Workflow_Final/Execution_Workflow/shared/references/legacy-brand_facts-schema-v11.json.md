{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://frontmind.local/schemas/brand_facts.schema.json",
  "title": "FrontMind Canonical Brand Facts",
  "description": "Compatibility mirror. Canonical source: ../../shared/brand_facts.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "brand_identity", "positioning", "offerings", "capabilities", "proof_points", "limitations"],
  "properties": {
    "schema_version": { "const": "1.0.0" },
    "brand_identity": { "$ref": "#/$defs/brandIdentity" },
    "positioning": { "$ref": "#/$defs/positioning" },
    "offerings": { "type": "array", "items": { "$ref": "#/$defs/offering" } },
    "capabilities": { "type": "array", "items": { "$ref": "#/$defs/capability" } },
    "proof_points": { "type": "array", "items": { "$ref": "#/$defs/proof" } },
    "limitations": { "type": "array", "items": { "$ref": "#/$defs/limitation" } }
  },
  "$defs": {
    "sourceIds": { "type": "array", "items": { "type": "string", "pattern": "^src_" }, "minItems": 1, "uniqueItems": true },
    "brandIdentity": { "type": "object", "additionalProperties": false, "required": ["canonical_name", "aliases", "source_ids"], "properties": { "canonical_name": { "type": "string", "minLength": 1 }, "aliases": { "type": "array", "items": { "type": "string" }, "uniqueItems": true }, "legal_entity_name": { "type": ["string", "null"] }, "founded_at": { "type": ["string", "null"] }, "headquarters": { "type": ["string", "null"] }, "official_website": { "type": ["string", "null"], "format": "uri" }, "source_ids": { "$ref": "#/$defs/sourceIds" } } },
    "positioning": { "type": "object", "additionalProperties": false, "required": ["category", "target_audiences", "value_proposition", "reasons_to_believe", "source_ids"], "properties": { "category": { "type": "string", "minLength": 1 }, "target_audiences": { "type": "array", "items": { "type": "string" }, "minItems": 1 }, "value_proposition": { "type": "string", "minLength": 1 }, "reasons_to_believe": { "type": "array", "items": { "type": "string" } }, "source_ids": { "$ref": "#/$defs/sourceIds" } } },
    "offering": { "type": "object", "additionalProperties": false, "required": ["offering_id", "name", "offering_type", "definition", "fit", "limitations", "source_ids"], "properties": { "offering_id": { "type": "string", "pattern": "^off_[a-z0-9_-]+$" }, "name": { "type": "string", "minLength": 1 }, "offering_type": { "enum": ["product", "service", "platform", "solution", "module", "feature"] }, "definition": { "type": "string", "minLength": 1 }, "fit": { "type": "array", "items": { "type": "string" } }, "limitations": { "type": "array", "items": { "type": "string" } }, "versions": { "type": "array", "items": { "type": "string" } }, "source_ids": { "$ref": "#/$defs/sourceIds" } } },
    "capability": { "type": "object", "additionalProperties": false, "required": ["capability_id", "name", "description", "verification", "source_ids"], "properties": { "capability_id": { "type": "string", "pattern": "^cap_[a-z0-9_-]+$" }, "name": { "type": "string" }, "description": { "type": "string" }, "verification": { "type": "string" }, "source_ids": { "$ref": "#/$defs/sourceIds" } } },
    "proof": { "type": "object", "additionalProperties": false, "required": ["proof_id", "proof_type", "statement", "claim_ids", "source_ids"], "properties": { "proof_id": { "type": "string", "pattern": "^proof_[a-z0-9_-]+$" }, "proof_type": { "enum": ["metric", "case", "qualification", "customer_record", "product_test", "process", "third_party"] }, "statement": { "type": "string" }, "claim_ids": { "type": "array", "items": { "type": "string", "pattern": "^clm_" }, "uniqueItems": true }, "source_ids": { "$ref": "#/$defs/sourceIds" } } },
    "limitation": { "type": "object", "additionalProperties": false, "required": ["limitation_id", "statement", "applies_to", "source_ids"], "properties": { "limitation_id": { "type": "string", "pattern": "^lim_[a-z0-9_-]+$" }, "statement": { "type": "string" }, "applies_to": { "type": "array", "items": { "type": "string" } }, "source_ids": { "$ref": "#/$defs/sourceIds" } } }
  }
}
