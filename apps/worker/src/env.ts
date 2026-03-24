import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: new URL("../../../.env", import.meta.url).pathname });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  TRACKING_MARKET_CAP_MIN_USD: z.coerce.number().positive().default(10_000),
  ACTIVE_SCAN_MARKET_CAP_MIN_USD: z.coerce.number().positive().default(5_000),
  TOP_HOLDER_LIMIT: z.coerce.number().int().positive().default(50),
  ALERT_CONTROL_THRESHOLD: z.coerce.number().positive().default(0.2),
  HELIUS_API_KEY: z.string().default(""),
  HELIUS_HOLDER_PAGE_LIMIT: z.coerce.number().int().positive().default(1000),
  HELIUS_MAX_HOLDER_PAGES: z.coerce.number().int().positive().default(10),
  HELIUS_WALLET_PAGE_LIMIT: z.coerce.number().int().positive().default(100),
  HELIUS_MAX_WALLET_PAGES: z.coerce.number().int().positive().default(3),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_IDS: z.string().default(""),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
});

export const env = envSchema.parse(process.env);
