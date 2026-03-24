import type { FastifyInstance } from "fastify";
import { launchProtocols, liquidityProtocols, providerNames, queueNames, v2Defaults } from "@cabalfinder/shared";
import { env } from "../env.js";

export async function registerStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => ({
    ok: true,
    service: "@cabalfinder/api",
    now: new Date().toISOString()
  }));

  app.get("/v1/system/status", async () => ({
    ok: true,
    product: "cabalfinder-v2",
    mode: "helius-first-holder-intelligence",
    thresholds: {
      trackingMarketCapMinUsd: env.TRACKING_MARKET_CAP_MIN_USD,
      activeScanMarketCapMinUsd: env.ACTIVE_SCAN_MARKET_CAP_MIN_USD,
      alertControlThreshold: env.ALERT_CONTROL_THRESHOLD,
      topHolderLimit: env.TOP_HOLDER_LIMIT
    },
    defaults: v2Defaults,
    providers: {
      [providerNames.helius]: Boolean(env.HELIUS_API_KEY),
      [providerNames.heliusWallet]: Boolean(env.HELIUS_API_KEY),
      [providerNames.postgres]: Boolean(env.DATABASE_URL),
      [providerNames.redis]: Boolean(env.REDIS_URL)
    },
    heliusTuning: {
      holderPageLimit: env.HELIUS_HOLDER_PAGE_LIMIT,
      maxHolderPages: env.HELIUS_MAX_HOLDER_PAGES,
      walletPageLimit: env.HELIUS_WALLET_PAGE_LIMIT,
      maxWalletPages: env.HELIUS_MAX_WALLET_PAGES
    },
    protocolContext: {
      launchProtocols,
      liquidityProtocols
    },
    queues: queueNames
  }));
}
