import { createContext, useContext } from "react";

export type MonitoringDemoActions = {
  trackedSources: Set<string>;
  toggleSource: (id: string) => void;
  correctAnswer: (
    id: string,
    correction: { brandMentioned: boolean; mentionPosition: number | null },
  ) => void;
};

export const MonitoringDemoContext =
  createContext<MonitoringDemoActions | null>(null);
export const useMonitoringDemo = () => useContext(MonitoringDemoContext);
