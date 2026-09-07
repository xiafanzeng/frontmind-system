export type AgentCost = { costCny?: string | null; costStatus?: "complete" | "partial" | "unknown" };
export function agentCostDisplay(value: AgentCost | undefined): string {
  if (!value || value.costCny == null || !/^\d+(\.\d+)?$/.test(value.costCny)) return "待核算";
  const amount = Number(value.costCny);
  if (!Number.isFinite(amount)) return "待核算";
  return `¥${amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}${value.costStatus === "partial" ? "（部分）" : ""}`;
}
