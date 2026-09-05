const AUDIT_ACTION_LABELS: Record<string, string> = {
  "account.created": "创建账号",
  "account.password_reset": "重置账号密码",
  "account.status_updated": "更新账号状态",
  "account.deleted": "删除账号",
  "account.deactivated_for_history": "停用并保留历史账号",
  "account.admin_access_level_updated": "调整管理员权限",
  "account.provisioning_completed": "完成客户开通",
  "workspace.assignments.updated": "更新负责管理员",
  "workspace.credential.replaced": "更新客户 API Key",
  "workspace.credential.deleted": "删除客户 API Key",
  "workspace.dashboard.updated": "更新客户看板",
  "workspace.dashboard.rolled_back": "回滚客户看板",
  "workspace.dashboard.module_imported": "导入看板模块",
  "workspace.service.updated": "更新服务版本",
  "workspace.question.updated": "更新候选问题",
  "workspace.question.selection_confirmed": "确认启动问题",
  "workspace.questions.template_imported": "导入问题模板",
  "workspace.response_logic.imported": "导入应答逻辑",
  "workspace.monitoring.template_imported": "导入监控模板",
  "workspace.monitoring.imported": "导入监控数据",
  "workspace.monitoring_batch.replaced": "替换监控批次",
  "workspace.knowledge.published": "发布企业知识库",
  "workspace.progress_report.screenshot_uploaded": "上传进度报告截图",
  "workspace.site_profile.updated": "更新官网资料",
  "workspace.site_check.updated": "更新官网检查",
  "workspace.website_content.template_published": "发布官网内容模板",
  "delivery_ticket.status_updated": "更新交付需求状态",
  "delivery_ticket.operation_recorded": "记录交付操作",
  "delivery_ticket.redirects_applied": "应用跳转配置",
  "delivery_ticket.public_summary_updated": "更新需求公开摘要",
  "service_quota_period.delivery_limits_adjusted": "调整交付额度",
  "service_quota_period.question_limits_adjusted": "调整问题额度",
  "presales.credential.replaced": "更新官网 API Key",
  "presales.credential.deleted": "删除官网 API Key",
  "delivery.engineer_credential.replaced": "更新工程师 API Key",
  "delivery.engineer_credential.revoked": "撤销工程师 API Key",
  "icp_material.uploaded": "上传备案材料",
  "icp_material.downloaded": "下载备案材料",
  "icp_material.withdrawn": "撤回备案材料",
};

const AUDIT_TARGET_LABELS: Record<string, string> = {
  user: "用户账号",
  workspace: "客户工作区",
  dashboard: "客户看板",
  service_contract: "服务版本",
  service_quota_period: "服务额度周期",
  workspace_question: "客户问题",
  monitoring_batch: "监控批次",
  knowledge_snapshot: "企业知识库",
  response_logic: "应答逻辑",
  api_credential: "客户 API Key",
  presales_api_credential: "官网 API Key",
  delivery_ticket: "交付需求",
  workspace_site_profile: "官网资料",
  workspace_site_check: "官网检查",
  website_content_template: "官网内容模板",
  icp_sensitive_material: "备案材料",
};

export function auditActionLabel(action: unknown): string {
  return typeof action === "string" && AUDIT_ACTION_LABELS[action]
    ? AUDIT_ACTION_LABELS[action]
    : "其他系统操作";
}

export function auditEventDetail(
  event: {
    reason?: unknown;
    targetType?: unknown;
  },
  workspaceLabel?: string | null,
): string {
  if (typeof event.reason === "string" && event.reason.trim()) {
    return event.reason.trim();
  }
  const targetLabel =
    typeof event.targetType === "string"
      ? AUDIT_TARGET_LABELS[event.targetType]
      : undefined;
  const normalizedWorkspaceLabel = workspaceLabel?.trim();
  if (targetLabel && normalizedWorkspaceLabel) {
    return `${targetLabel} · ${normalizedWorkspaceLabel}`;
  }
  return targetLabel ?? normalizedWorkspaceLabel ?? "其他对象";
}
