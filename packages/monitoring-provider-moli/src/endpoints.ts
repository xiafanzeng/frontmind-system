/** Official paths are centralized so contract drift is reviewed in one place. */
export const MOLI_API_PATHS = {
  models: "/api/business/system/models",
  domesticRegions: "/api/business/eip-edge/ports/city-info",
  overseasRegions: "/api/business/eip-edge/regions/overseas",
  submitTask: "/api/business/monitor/task/batch/shared",
  taskStatus: (taskId: string) =>
    `/api/business/monitor/task/status/${encodeURIComponent(taskId)}`,
  taskResult: (taskId: string) =>
    `/api/business/monitor/task/result/${encodeURIComponent(taskId)}`,
  subTaskResult: (taskId: string, subTaskId: string) =>
    `/api/business/monitor/task/result/${encodeURIComponent(taskId)}/${encodeURIComponent(subTaskId)}`,
  stopTask: (taskId: string) =>
    `/api/business/monitor/task/${encodeURIComponent(taskId)}/stop`,
  billingBalance: "/api/reconciliation/balance",
  billingSummary: "/api/reconciliation/summary",
  billingRecords: "/api/reconciliation/records",
} as const;
