import { registerAliyunSiteOpsProviders } from "./aliyun-provider";
import { registerEsaSiteOpsProvider } from "./esa-provider";
import { registerManusSiteOpsProvider } from "./manus-provider";
import { registerTwentyFirstSiteOpsProvider } from "./twenty-first-provider";

let registered = false;
let unregisterAll: (() => void) | null = null;

/**
 * Registers the narrow runtime adapters exactly once before the SiteOps worker
 * starts. Registration itself performs no network or provider side effect.
 */
export function registerSiteOpsRuntimeProviders() {
  if (registered) return unregisterAll ?? (() => undefined);
  const unregister = [
    registerTwentyFirstSiteOpsProvider(),
    registerManusSiteOpsProvider(),
    registerEsaSiteOpsProvider(),
    registerAliyunSiteOpsProviders(),
  ];
  registered = true;
  unregisterAll = () => {
    for (const dispose of [...unregister].reverse()) dispose();
    registered = false;
    unregisterAll = null;
  };
  return unregisterAll;
}
