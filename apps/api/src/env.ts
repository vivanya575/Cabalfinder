import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { v2Defaults } from "@cabalfinder/shared";

loadEnv({ path: new URL("../../../.env", import.meta.url).pathname });

const envSchema = z.object({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  HELIUS_API_KEY: z.string().default(""),
  HELIUS_HOLDER_PAGE_LIMIT: z.coerce.number().int().positive().default(1000),
  HELIUS_MAX_HOLDER_PAGES: z.coerce.number().int().positive().default(10),
  HELIUS_WALLET_PAGE_LIMIT: z.coerce.number().int().positive().default(100),
  HELIUS_MAX_WALLET_PAGES: z.coerce.number().int().positive().default(3),
  TRACKING_MARKET_CAP_MIN_USD: z.coerce.number().positive().default(v2Defaults.trackingMarketCapMinUsd),
  ACTIVE_SCAN_MARKET_CAP_MIN_USD: z.coerce.number().positive().default(v2Defaults.activeScanMarketCapMinUsd),
  TOP_HOLDER_LIMIT: z.coerce.number().int().positive().default(v2Defaults.topHolderLimit),
  ALERT_CONTROL_THRESHOLD: z.coerce.number().positive().default(v2Defaults.controlAlertThresholdPct),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
});

export const env = envSchema.parse(process.env);
