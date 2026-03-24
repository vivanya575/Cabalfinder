import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import type { PoolConfig, TokenConfig } from "./types.js";

dotenv.config();

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric env var ${name}: ${raw}`);
  }
  return value;
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const value = getNumberEnv(name, fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid positive integer env var ${name}: ${value}`);
  }
  return value;
}

export interface AppConfig {
  rpcUrl: string;
  rpcTimeoutMs: number;
  rpcConcurrency: number;
  scanHolderLimit: number;
  priceCacheTtlMs: number;
  telegramBotToken?: string;
  telegramChatIds: string[];
  alertThreshold: number;
  minSupply: number;
  minMarketLiquidityUsd: number;
  tokenListPath: string;
  poolListPath: string;
  dataDir: string;
  stableMints: Set<string>;
  wsolMint: string;
  solUsdReferencePoolId: string;
}

export function loadConfig(): AppConfig {
  const rpcUrl = getEnv("RPC_URL", "https://api.mainnet-beta.solana.com");
  const isPublicMainnetRpc = /api\.mainnet(-beta)?\.solana\.com/.test(rpcUrl);
  const chatRaw = process.env.TELEGRAM_CHAT_IDS ?? "";
  const telegramChatIds = chatRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    rpcUrl,
    rpcTimeoutMs: getPositiveIntegerEnv("RPC_TIMEOUT_MS", 20_000),
    rpcConcurrency: getPositiveIntegerEnv("RPC_CONCURRENCY", isPublicMainnetRpc ? 2 : 4),
    scanHolderLimit: getPositiveIntegerEnv("SCAN_HOLDER_LIMIT", isPublicMainnetRpc ? 20 : 50),
    priceCacheTtlMs: getPositiveIntegerEnv("PRICE_CACHE_TTL_MS", 15_000),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatIds,
    alertThreshold: getNumberEnv("ALERT_THRESHOLD", 0.2),
    minSupply: getNumberEnv("MIN_SUPPLY", 10_000),
    minMarketLiquidityUsd: getNumberEnv("MIN_MARKET_LIQUIDITY_USD", 5_000),
    tokenListPath: getEnv("TOKEN_LIST_PATH", "./config/tokens.json"),
    poolListPath: getEnv("POOL_LIST_PATH", "./config/pools.json"),
    dataDir: getEnv("DATA_DIR", "./data"),
    wsolMint: getEnv("WSOL_MINT", "So11111111111111111111111111111111111111112"),
    stableMints: new Set([
      getEnv("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      getEnv("USDT_MINT", "Es9vMFrzaCERmJfrF4H2Q8f4Jm4cM7kwh28ykVfoWHz")
    ]),
    solUsdReferencePoolId: getEnv("SOL_USD_REFERENCE_POOL_ID", "sol-usdc-ref")
  };
}

export async function loadTokenList(tokenPath: string): Promise<TokenConfig[]> {
  const absPath = path.resolve(tokenPath);
  const raw = await fs.readFile(absPath, "utf8");
  const parsed = JSON.parse(raw) as TokenConfig[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${absPath}`);
  }
  return parsed;
}

export async function loadPoolList(poolPath: string): Promise<PoolConfig[]> {
  const absPath = path.resolve(poolPath);
  const raw = await fs.readFile(absPath, "utf8");
  const parsed = JSON.parse(raw) as PoolConfig[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${absPath}`);
  }
  return parsed;
}
