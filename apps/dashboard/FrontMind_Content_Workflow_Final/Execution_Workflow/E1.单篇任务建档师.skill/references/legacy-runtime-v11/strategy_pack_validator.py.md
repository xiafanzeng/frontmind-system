#!/usr/bin/env python3
"""
FrontMind 策略包 (strategy_pack) 校验器
用途：在 E0 启动前或 S0 移交前，深度验证 strategy_pack 的存在性、格式合规性和引用文件真实性。

用法：
  python3 strategy_pack_validator.py --pack <path_to_pack.json> --workspace <dir> [--ai-feedback]
"""

import os
import sys
import json
import argparse
from typing import Dict, List, Tuple

REQUIRED_ARTIFACT_NODES = [
    "S1_brand_facts", "S2_marketing_atlas", "S3_category_trend",
    "S4_positioning", "S5_diagnosis", "S5.5_semantic_audit",
    "S6_verbal_identity", "S7_supersign", "S8_question_qa", "S9_enablement"
]

def validate_pack(pack_path: str, workspace: str) -> Tuple[bool, List[Dict]]:
    issues = []
    
    # 1. 存在性校验
    if not os.path.exists(pack_path):
        issues.append({"severity": "fatal", "issue": f"策略包文件不存在: {pack_path}"})
        return False, issues

    # 2. JSON 解析校验
    try:
        with open(pack_path, 'r', encoding='utf-8') as f:
            pack = json.load(f)
    except json.JSONDecodeError as e:
        issues.append({"severity": "fatal", "issue": f"策略包 JSON 格式错误: {e}"})
        return False, issues
    except Exception as e:
        issues.append({"severity": "fatal", "issue": f"无法读取策略包: {e}"})
        return False, issues

    # 3. 顶层 Schema 校验
    required_top_keys = ["meta", "artifacts", "recommended_business_actions", "s7_branch", "pause_log"]
    for key in required_top_keys:
        if key not in pack:
            issues.append({"severity": "error", "issue": f"缺失顶层必填字段: {key}"})
    
    if issues and any(i["severity"] in ["fatal", "error"] for i in issues):
        return False, issues

    # 4. Meta 字段校验
    meta = pack.get("meta", {})
    if "brand" not in meta:
        issues.append({"severity": "error", "issue": "meta 缺失 brand 字段"})
    if "strategy_nodes_completed" not in meta:
        issues.append({"severity": "error", "issue": "meta 缺失 strategy_nodes_completed 字段"})
    elif len(meta["strategy_nodes_completed"]) < 10:
        issues.append({"severity": "error", "issue": f"已完成策略资产节点不足 10 个（S1-S9 + S5.5）: {meta['strategy_nodes_completed']}"})

    # 5. Artifacts 节点完整性校验
    artifacts = pack.get("artifacts", {})
    for node in REQUIRED_ARTIFACT_NODES:
        if node not in artifacts:
            issues.append({"severity": "error", "issue": f"artifacts 缺失节点: {node}"})
            continue
        
        node_data = artifacts[node]
        # 提取该节点下所有的文件路径（排除 sha256 等非文件字段）
        file_fields = [k for k in node_data.keys() if k != "sha256"]
        
        if not file_fields:
            issues.append({"severity": "error", "issue": f"节点 {node} 未声明任何产出文件"})
            continue

        # 6. 引用文件真实性校验
        for field in file_fields:
            filename = node_data[field]
            filepath = os.path.join(workspace, filename)
            if not os.path.exists(filepath):
                issues.append({"severity": "error", "issue": f"节点 {node} 引用的文件不存在: {filename}"})
            else:
                size = os.path.getsize(filepath)
                if size == 0:
                    issues.append({"severity": "error", "issue": f"节点 {node} 引用的文件大小为 0: {filename}"})
                elif filename.endswith('.json') and size < 10:
                    issues.append({"severity": "warning", "issue": f"节点 {node} 引用的 JSON 文件可能为空对象: {filename}"})


    # 8. 可选客户交付物只做提示，不作为执行层启动阻断条件。值可能为字符串（如品牌信息确认表）或嵌套对象。
    client_deliverables = pack.get("client_deliverables", {})

    def _check_optional(label: str, filename):
        if not filename:
            return
        filepath = os.path.join(workspace, filename)
        if not os.path.exists(filepath):
            issues.append({"severity": "warning", "issue": f"可选客户交付物 {label} 不存在，不影响执行层启动: {filename}"})

    for group, files in client_deliverables.items():
        if isinstance(files, dict):
            for field, filename in files.items():
                _check_optional(f"{group}.{field}", filename)
        elif isinstance(files, str):
            _check_optional(group, files)

    # 7. 业务逻辑一致性校验
    recommended_actions = pack.get("recommended_business_actions", [])
    if not isinstance(recommended_actions, list) or not recommended_actions:
        issues.append({"severity": "error", "issue": "recommended_business_actions 必须是非空行动清单"})
    else:
        for idx, action in enumerate(recommended_actions, start=1):
            if not isinstance(action, dict):
                issues.append({"severity": "error", "issue": f"recommended_business_actions[{idx}] 必须是对象"})
                continue
            for field in ["action_id", "priority", "reason", "expected_business_effect"]:
                if not action.get(field):
                    issues.append({"severity": "error", "issue": f"recommended_business_actions[{idx}] 缺失字段: {field}"})

    has_fatal_or_error = any(i["severity"] in ["fatal", "error"] for i in issues)
    return not has_fatal_or_error, issues

def main():
    parser = argparse.ArgumentParser(description="策略包深度校验器")
    parser.add_argument("--pack", required=True, help="策略包 JSON 文件路径")
    parser.add_argument("--workspace", required=True, help="工作目录路径（用于校验引用文件）")
    parser.add_argument("--ai-feedback", action="store_true", help="输出 AI 友好的 JSON 格式反馈")
    args = parser.parse_args()

    passed, issues = validate_pack(args.pack, args.workspace)

    if args.ai_feedback:
        print(json.dumps({
            "passed": passed,
            "issues": issues
        }, ensure_ascii=False, indent=2))
        sys.exit(0 if passed else 1)

    print("=" * 60)
    print(f"📦 FrontMind 策略包校验报告")
    print(f"📄 目标包: {args.pack}")
    print(f"📂 工作区: {args.workspace}")
    print("=" * 60)

    if not issues:
        print("\n✅ 校验通过！策略包格式正确，所有引用文件真实存在。")
    else:
        print(f"\n❌ 校验失败，发现 {len(issues)} 个问题：\n")
        for issue in issues:
            icon = "🛑" if issue["severity"] == "fatal" else "🔴" if issue["severity"] == "error" else "🟡"
            print(f"{icon} [{issue['severity'].upper()}] {issue['issue']}")
            
        if passed:
            print("\n⚠️ 仅存在警告，不阻断执行。")
        else:
            print("\n🚨 存在致命错误或结构错误，必须修复后才能启动执行层！")

    sys.exit(0 if passed else 1)

if __name__ == "__main__":
    main()
