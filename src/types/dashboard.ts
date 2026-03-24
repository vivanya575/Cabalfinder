import type { AlertEvent, ControlRow, HolderSnapshot, TokenConfig } from "../types.js";

export interface DashboardState {
  tokens: TokenConfig[];
  recentAlerts: AlertEvent[];
  recentControlRows: ControlRow[];
  lastSnapshots: HolderSnapshot[];
  threshold: number;
  scanHolderLimit: number;
  warnings: string[];
}
