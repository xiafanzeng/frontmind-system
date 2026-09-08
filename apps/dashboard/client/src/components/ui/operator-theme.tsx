import { createContext, useContext, type ReactNode } from "react";

const OperatorThemeContext = createContext(false);

/** React context crosses Radix portals without moving their fixed-position DOM. */
export function OperatorThemeProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  return <OperatorThemeContext.Provider value={enabled}>{children}</OperatorThemeContext.Provider>;
}

export function useOperatorPortalClassName() {
  return useContext(OperatorThemeContext) ? "operator-theme operator-portal" : undefined;
}
