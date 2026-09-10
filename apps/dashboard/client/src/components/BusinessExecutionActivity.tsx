import type { GeneralExecutionDto } from "@shared/frontmind-general-execution";
import { GeneralExecutionActivity } from "./GeneralExecutionActivity";
/** Reuses the conversation execution renderer and its accessible disclosure. */
export function BusinessExecutionActivity({
  execution,
}: {
  execution: GeneralExecutionDto;
}) {
  const items = execution.timeline.filter((item) => item.kind !== "message");
  if (!items.length)
    return <p className="text-sm text-muted-foreground">过程记录暂不可用</p>;
  return (
    <details className="business-execution-disclosure" open>
      <summary>执行过程</summary>
      {execution.coverage !== "complete" && <p className="text-xs text-muted-foreground">部分历史过程未记录，仅展示已有活动。</p>}
      <GeneralExecutionActivity
        items={items.map((item) => ({
          ...item,
          animate: item.isCurrent === true,
        }))}
      />
    </details>
  );
}
