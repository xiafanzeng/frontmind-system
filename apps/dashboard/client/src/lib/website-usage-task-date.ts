export function formatWebsiteUsageTaskDate(
  createdAt: number,
  businessOwnerName: string | null,
) {
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(createdAt));
  return businessOwnerName ? `${date}（${businessOwnerName}）` : date;
}
