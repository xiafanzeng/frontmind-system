/**
 * A single out-of-order task is not a safe pagination sentinel. A complete
 * page whose every dated task is before the window is the minimum safe signal
 * that the descending scan has crossed the rolling-window boundary.
 */
export function usagePageReachedCutoff(input: {
  complete: boolean;
  datedTaskCount: number;
  expiredTaskCount: number;
}) {
  return (
    input.complete &&
    input.datedTaskCount > 0 &&
    input.expiredTaskCount === input.datedTaskCount
  );
}
