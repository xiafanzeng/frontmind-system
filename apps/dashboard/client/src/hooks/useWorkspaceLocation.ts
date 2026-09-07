import { useCallback } from "react";
import { useBrowserLocation, type BrowserLocationHook } from "wouter/use-browser-location";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";

/** Keep project identity on links and redirects issued by embedded modules. */
export const useWorkspaceLocation: BrowserLocationHook = options => {
  const [pathname, navigate] = useBrowserLocation(options);
  const navigateWorkspace = useCallback<typeof navigate>((destination, settings) => {
    navigate(projectWorkspaceUrl(String(destination)), settings);
  }, [navigate]);
  return [pathname, navigateWorkspace];
};
