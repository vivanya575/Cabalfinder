export const launchProtocols = [
  "pump",
  "letsbonk",
  "launchlab",
  "believe",
  "moonshot",
  "meteora_dbc",
  "jupiter_studio",
  "unknown"
] as const;

export type TokenLaunchProtocol = (typeof launchProtocols)[number];

export const liquidityProtocols = [
  "pump_amm",
  "raydium",
  "meteora_amm",
  "meteora_damm_v2",
  "orca",
  "jupiter_routed",
  "multi",
  "unknown"
] as const;

export type LiquidityProtocol = (typeof liquidityProtocols)[number];

export const migrationStates = ["bonding_curve", "final_stretch", "migrated", "unknown"] as const;
export type MigrationState = (typeof migrationStates)[number];

export const jobStatuses = ["pending", "running", "succeeded", "failed"] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const queueNames = {
  tokenUniverseRefresh: "token-universe-refresh",
  holderSnapshot: "holder-snapshot",
  controlComputation: "control-computation",
  activeScan: "active-scan",
  alertDelivery: "alert-delivery"
} as const;

export const v2Defaults = {
  trackingMarketCapMinUsd: 10_000,
  activeScanMarketCapMinUsd: 5_000,
  controlAlertThresholdPct: 0.2,
  topHolderLimit: 50,
  activeScanWeights: {
    controlPct: 0.4,
    usdHeld: 0.35,
    overlapCount: 0.25
  }
} as const;

export interface ActiveScanScoreInput {
  controlPct: number;
  totalUsdHeld: number;
  overlapCount: number;
  maxControlPct: number;
  maxTotalUsdHeld: number;
  maxOverlapCount: number;
}

export interface ActiveScanScoreBreakdown {
  normalizedControlPct: number;
  normalizedTotalUsdHeld: number;
  normalizedOverlapCount: number;
  finalScore: number;
}

export interface RankedCoHeldToken {
  mint: string;
  symbol?: string;
  name?: string;
  marketCapUsd: number;
  athUsd?: number | null;
  overlapHolderCount: number;
  totalUsdHeld: number;
  controlPct: number;
  score: number;
}

export interface ActiveScanResult {
  mint: string;
  ca: string;
  symbol?: string;
  name?: string;
  marketCapUsd: number;
  athUsd?: number | null;
  overlapHolderCount: number;
  totalUsdHeld: number;
  controlPct: number;
  score: number;
  scoreBreakdown: ActiveScanScoreBreakdown;
}

export interface ActiveScanResponse {
  sourceToken: {
    mint: string;
    symbol?: string;
    name?: string;
    marketCapUsd?: number | null;
    athUsd?: number | null;
  };
  results: ActiveScanResult[];
  summary: {
    scannedHolderCount: number;
    returnedResultCount: number;
    eligibleResultCount: number;
    topHolderLimit: number;
    marketCapFloorUsd: number;
    copyCAs: string;
  };
  warnings: string[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function normalize(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return clamp01(value / max);
}

export function calculateActiveScanScore(input: ActiveScanScoreInput): ActiveScanScoreBreakdown {
  const normalizedControlPct = normalize(input.controlPct, input.maxControlPct);
  const normalizedTotalUsdHeld = normalize(input.totalUsdHeld, input.maxTotalUsdHeld);
  const normalizedOverlapCount = normalize(input.overlapCount, input.maxOverlapCount);

  const finalScore =
    normalizedControlPct * v2Defaults.activeScanWeights.controlPct +
    normalizedTotalUsdHeld * v2Defaults.activeScanWeights.usdHeld +
    normalizedOverlapCount * v2Defaults.activeScanWeights.overlapCount;

  return {
    normalizedControlPct,
    normalizedTotalUsdHeld,
    normalizedOverlapCount,
    finalScore: Number(finalScore.toFixed(6))
  };
}

export const providerNames = {
  helius: "Helius DAS + RPC",
  heliusWallet: "Helius Wallet API",
  heliusMcp: "Helius MCP",
  telegram: "Telegram Bot API",
  postgres: "PostgreSQL + TimescaleDB",
  redis: "Redis"
} as const;
