import { runtimeErrorForLog } from "./_core/runtime-error-log";
import { runBrandQuestionUniverseWorkerSweep } from "./brand-question-universe-service";

let scheduler: NodeJS.Timeout | null = null;
let sweep: Promise<unknown> | null = null;

export function startBrandQuestionUniverseWorkerScheduler(options?: {
  intervalMs?: number;
}) {
  if (scheduler) return;
  const run = () => {
    if (sweep) return;
    sweep = runBrandQuestionUniverseWorkerSweep()
      .catch((error) => {
        console.error(
          "[BrandQuestionUniverseWorker] sweep_failed",
          runtimeErrorForLog(error),
        );
      })
      .finally(() => {
        sweep = null;
      });
  };
  run();
  scheduler = setInterval(run, Math.max(10_000, options?.intervalMs ?? 30_000));
  scheduler.unref?.();
}

export async function stopBrandQuestionUniverseWorkerScheduler() {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
  await sweep;
}
