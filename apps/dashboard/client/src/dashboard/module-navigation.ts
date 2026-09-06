export const customerMonitoringPages = [
  { id: "/monitoring-system", label: "监控工作台" },
  { id: "/monitoring-system/settings", label: "账户余额" },
];

export const customerPublishingPages = [
  { id: "/publishing", label: "发布工作台" },
  { id: "/publishing/articles", label: "稿件" },
  { id: "/publishing/media", label: "媒体库" },
  { id: "/publishing/publications", label: "发布记录" },
];

export function dashboardModuleRoute(pathname: string) {
  for (const [section, pages] of [
    ["monitoring-module", customerMonitoringPages],
    ["publishing-module", customerPublishingPages],
  ] as const) {
    const matched = [...pages]
      .sort((left, right) => right.id.length - left.id.length)
      .find(
        (page) => pathname === page.id || pathname.startsWith(`${page.id}/`),
      );
    if (matched) return { section, sub: matched.id };
  }
  return null;
}
