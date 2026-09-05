import { inArray } from "drizzle-orm";

import { websiteStyleSampleBatches } from "../../drizzle/schema";

/**
 * A visual board remains customer-visible after the customer locks it. Keep
 * every reader of customer-owned preview bytes on this single predicate so a
 * lifecycle transition cannot leave observation URLs pointing at 404s.
 */
export const CUSTOMER_VISIBLE_STYLE_BATCH_STATUSES = [
  "published",
  "selected",
] as const;

export function customerVisibleStyleBatchStatusCondition() {
  return inArray(
    websiteStyleSampleBatches.status,
    CUSTOMER_VISIBLE_STYLE_BATCH_STATUSES,
  );
}
