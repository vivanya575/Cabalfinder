import { Worker, Queue } from "bullmq";
import pino from "pino";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { queueNames, calculateActiveScanScore } from "@cabalfinder/shared";
import {
  alerts,
  controlEdges,
  holderSnapshots,
  scanResults,
  scanRuns,
  tokens,
  walletPositions,
  wallets
} from "@cabalfinder/db";
import { env } from "./env.js";
import { db } from "./db.js";
import { HeliusWorkerClient } from "./helius.js";
import { broadcastTelegramMessage, formatAlertMessage } from "./telegram.js";

const logger = pino({ level: env.LOG_LEVEL });

const helius = new HeliusWorkerClient(env.HELIUS_API_KEY);

function createConnectionOptions() {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || "6379"),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function isLikelyInfrastructureWallet(address: string): boolean {
  return [
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "Vote111111111111111111111111111111111111111",
    "Sysvar1111111111111111111111111111111111111"
  ].includes(address);
}

async function upsertToken(token: {
  mint: string;
  symbol?: string;
  name?: string;
  marketCapUsd?: number | null;
  athUsd?: number | null;
  circulatingSupply?: number | null;
  totalSupply?: number | null;
}): Promise<{ id: string; mint: string }> {
  const [row] = await db
    .insert(tokens)
    .values({
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      currentMarketCapUsd: token.marketCapUsd ?? null,
      athUsd: token.athUsd ?? null,
      circulatingSupply: token.circulatingSupply ?? null,
      totalSupply: token.totalSupply ?? null,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: tokens.mint,
      set: {
        symbol: token.symbol,
        name: token.name,
        currentMarketCapUsd: token.marketCapUsd ?? null,
        athUsd: token.athUsd ?? null,
        circulatingSupply: token.circulatingSupply ?? null,
        totalSupply: token.totalSupply ?? null,
        updatedAt: new Date()
      }
    })
    .returning({ id: tokens.id, mint: tokens.mint });

  return row;
}

async function upsertWallet(address: string): Promise<{ id: string; address: string }> {
  const [row] = await db
    .insert(wallets)
    .values({ address, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: wallets.address, set: { lastSeenAt: new Date() } })
    .returning({ id: wallets.id, address: wallets.address });

  return row;
}

// ─── Job: token-universe-refresh ─────────────────────────────────────────────
// Job data: { mints: string[] }  — list of token mints to check and upsert
async function handleTokenUniverseRefresh(jobData: unknown): Promise<{ upsertedCount: number }> {
  const data = jobData as { mints?: string[] };
  const mints = data.mints ?? [];

  if (mints.length === 0) {
    logger.info("token-universe-refresh: no mints provided, skipping");
    return { upsertedCount: 0 };
  }

  if (!env.HELIUS_API_KEY) {
    logger.warn("token-universe-refresh: HELIUS_API_KEY not configured, skipping");
    return { upsertedCount: 0 };
  }

  let upsertedCount = 0;
  for (const batch of chunkArray(mints, 100)) {
    const overviews = await helius.getTokenOverviewBatch(batch);
    for (const overview of overviews) {
      const marketCapUsd = overview.marketCapUsd ?? 0;
      if (!Number.isFinite(marketCapUsd) || marketCapUsd < env.TRACKING_MARKET_CAP_MIN_USD) {
        continue;
      }
      await upsertToken({
        mint: overview.mint,
        symbol: overview.symbol,
        name: overview.name,
        marketCapUsd,
        athUsd: overview.athUsd ?? null,
        circulatingSupply: overview.circulatingSupply ?? null,
        totalSupply: overview.totalSupply ?? null
      });
      upsertedCount += 1;
    }
  }

  logger.info({ upsertedCount }, "token-universe-refresh: complete");
  return { upsertedCount };
}

// ─── Job: holder-snapshot ─────────────────────────────────────────────────────
// Job data: { mint: string }
async function handleHolderSnapshot(jobData: unknown): Promise<{ snapshotCount: number; truncated: boolean }> {
  const data = jobData as { mint: string };
  const { mint } = data;

  if (!env.HELIUS_API_KEY) {
    logger.warn({ mint }, "holder-snapshot: HELIUS_API_KEY not configured, skipping");
    return { snapshotCount: 0, truncated: false };
  }

  const overview = await helius.getTokenOverview(mint);
  const supply = overview.circulatingSupply ?? overview.totalSupply ?? null;

  const tokenRow = await upsertToken({
    mint,
    symbol: overview.symbol,
    name: overview.name,
    marketCapUsd: overview.marketCapUsd ?? null,
    athUsd: overview.athUsd ?? null,
    circulatingSupply: overview.circulatingSupply ?? null,
    totalSupply: overview.totalSupply ?? null
  });

  const snapshotResult = await helius.getTokenHolders({
    mint,
    topHolderLimit: env.TOP_HOLDER_LIMIT,
    pageLimit: env.HELIUS_HOLDER_PAGE_LIMIT,
    maxPages: env.HELIUS_MAX_HOLDER_PAGES,
    decimals: overview.decimals ?? null,
    supplyUi: supply
  });

  const snapshotTime = new Date();
  const eligibleHolders = snapshotResult.holders.filter((h) => !isLikelyInfrastructureWallet(h.owner));

  for (const holder of eligibleHolders) {
    const walletRow = await upsertWallet(holder.owner);
    await db
      .insert(holderSnapshots)
      .values({
        tokenId: tokenRow.id,
        walletId: walletRow.id,
        snapshotTime,
        holderRank: holder.rank,
        amount: holder.uiAmount,
        shareOfSupply: holder.share
      })
      .onConflictDoNothing();
  }

  logger.info({ mint, snapshotCount: eligibleHolders.length, truncated: snapshotResult.truncated }, "holder-snapshot: complete");
  return { snapshotCount: eligibleHolders.length, truncated: snapshotResult.truncated };
}

// ─── Job: control-computation ─────────────────────────────────────────────────
// Job data: { sourceMint: string; targetMints?: string[] }
// Reads the most recent holder snapshot for sourceMint, then for each target token
// computes overlap wallet count, total units/USD held, and supply control %.
// Inserts a control_edges row and triggers an alert if threshold is crossed.
async function handleControlComputation(jobData: unknown): Promise<{ edgesComputed: number; alertsTriggered: number }> {
  const data = jobData as { sourceMint: string; targetMints?: string[] };
  const { sourceMint } = data;

  const [sourceTokenRow] = await db
    .select({ id: tokens.id, mint: tokens.mint, circulatingSupply: tokens.circulatingSupply, totalSupply: tokens.totalSupply })
    .from(tokens)
    .where(eq(tokens.mint, sourceMint))
    .limit(1);

  if (!sourceTokenRow) {
    logger.warn({ sourceMint }, "control-computation: source token not found in DB, skipping");
    return { edgesComputed: 0, alertsTriggered: 0 };
  }

  const latestSnapshotRows = await db
    .select({ snapshotTime: holderSnapshots.snapshotTime })
    .from(holderSnapshots)
    .where(eq(holderSnapshots.tokenId, sourceTokenRow.id))
    .orderBy(desc(holderSnapshots.snapshotTime))
    .limit(1);

  if (latestSnapshotRows.length === 0) {
    logger.warn({ sourceMint }, "control-computation: no snapshots found, run holder-snapshot first");
    return { edgesComputed: 0, alertsTriggered: 0 };
  }

  const snapshotTime = latestSnapshotRows[0].snapshotTime;

  const sourceHolders = await db
    .select({ walletId: holderSnapshots.walletId })
    .from(holderSnapshots)
    .where(and(eq(holderSnapshots.tokenId, sourceTokenRow.id), eq(holderSnapshots.snapshotTime, snapshotTime)));

  const sourceWalletIds = new Set(sourceHolders.map((h) => h.walletId));

  const targetTokenQuery = db
    .select({ id: tokens.id, mint: tokens.mint, circulatingSupply: tokens.circulatingSupply, totalSupply: tokens.totalSupply })
    .from(tokens)
    .where(gte(tokens.currentMarketCapUsd, env.TRACKING_MARKET_CAP_MIN_USD));

  const targetTokenRows = await targetTokenQuery;

  const filteredTargets =
    data.targetMints && data.targetMints.length > 0
      ? targetTokenRows.filter((t) => data.targetMints!.includes(t.mint))
      : targetTokenRows;

  let edgesComputed = 0;
  let alertsTriggered = 0;

  for (const targetToken of filteredTargets) {
    if (targetToken.id === sourceTokenRow.id) {
      continue;
    }

    const targetPositions = await db
      .select({ walletId: walletPositions.walletId, balance: walletPositions.balance, usdValue: walletPositions.usdValue })
      .from(walletPositions)
      .where(eq(walletPositions.tokenId, targetToken.id));

    const overlapPositions = targetPositions.filter((p) => sourceWalletIds.has(p.walletId));
    if (overlapPositions.length === 0) {
      continue;
    }

    const overlapWalletCount = new Set(overlapPositions.map((p) => p.walletId)).size;
    const totalUnitsHeld = overlapPositions.reduce((acc, p) => acc + p.balance, 0);
    const totalUsdHeld = overlapPositions.reduce((acc, p) => acc + (p.usdValue ?? 0), 0);
    const supply = targetToken.circulatingSupply ?? targetToken.totalSupply ?? null;
    const supplyControlPct = supply && supply > 0 ? totalUnitsHeld / supply : 0;

    await db.insert(controlEdges).values({
      sourceTokenId: sourceTokenRow.id,
      targetTokenId: targetToken.id,
      snapshotTime,
      overlapWalletCount,
      totalUnitsHeld,
      totalUsdHeld,
      supplyControlPct
    });

    edgesComputed += 1;

    if (supplyControlPct >= env.ALERT_CONTROL_THRESHOLD) {
      const cooldownKey = `${sourceTokenRow.id}:${targetToken.id}`;
      const cooldownWindow = new Date(Date.now() - 4 * 60 * 60 * 1000);

      const existing = await db
        .select({ id: alerts.id })
        .from(alerts)
        .where(and(eq(alerts.cooldownKey, cooldownKey), gte(alerts.triggeredAt, cooldownWindow)))
        .limit(1);

      if (existing.length === 0) {
        // Resolve wallet UUIDs → addresses for the top contributors
        const overlapWalletIdsSorted = [...new Set(overlapPositions.map((p) => p.walletId))]
          .slice(0, 10);

        const contributorWalletRows =
          overlapWalletIdsSorted.length > 0
            ? await db
                .select({ id: wallets.id, address: wallets.address })
                .from(wallets)
                .where(inArray(wallets.id, overlapWalletIdsSorted))
            : [];

        const walletAddressMap = new Map(contributorWalletRows.map((w) => [w.id, w.address]));

        const topContributorRows = overlapPositions
          .sort((a, b) => b.balance - a.balance)
          .slice(0, 10)
          .map((p) => ({
            wallet: walletAddressMap.get(p.walletId) ?? p.walletId,
            amount: p.balance
          }));

        const prevEdges = await db
          .select({ supplyControlPct: controlEdges.supplyControlPct })
          .from(controlEdges)
          .where(and(eq(controlEdges.sourceTokenId, sourceTokenRow.id), eq(controlEdges.targetTokenId, targetToken.id)))
          .orderBy(desc(controlEdges.snapshotTime))
          .limit(2);

        const previousControlPct = prevEdges.length > 1 ? (prevEdges[1].supplyControlPct ?? 0) : 0;

        await db.insert(alerts).values({
          sourceTokenId: sourceTokenRow.id,
          targetTokenId: targetToken.id,
          previousControlPct,
          supplyControlPct,
          overlapWalletCount,
          totalUsdHeld,
          topContributors: topContributorRows,
          telegramDelivered: false,
          cooldownKey
        });

        alertsTriggered += 1;
      }
    }
  }

  logger.info({ sourceMint, edgesComputed, alertsTriggered }, "control-computation: complete");
  return { edgesComputed, alertsTriggered };
}

// ─── Job: alert-delivery ──────────────────────────────────────────────────────
// Job data: { alertId?: string; sourceTokenMint: string; sourceTokenSymbol?: string;
//             targetTokenMint: string; targetTokenSymbol?: string;
//             supplyControlPct: number; overlapWalletCount: number;
//             totalUsdHeld: number; topContributors: { wallet: string; amount: number }[] }
async function handleAlertDelivery(jobData: unknown): Promise<{ delivered: number; failed: number }> {
  const data = jobData as {
    alertId?: string;
    sourceTokenMint: string;
    sourceTokenSymbol?: string;
    targetTokenMint: string;
    targetTokenSymbol?: string;
    supplyControlPct: number;
    overlapWalletCount: number;
    totalUsdHeld: number;
    topContributors: Array<{ wallet: string; amount: number }>;
  };

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_IDS.trim()) {
    logger.warn("alert-delivery: Telegram not configured, skipping delivery");
    return { delivered: 0, failed: 0 };
  }

  const chatIds = env.TELEGRAM_CHAT_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (chatIds.length === 0) {
    return { delivered: 0, failed: 0 };
  }

  const message = formatAlertMessage({
    sourceTokenMint: data.sourceTokenMint,
    sourceTokenSymbol: data.sourceTokenSymbol,
    targetTokenMint: data.targetTokenMint,
    targetTokenSymbol: data.targetTokenSymbol,
    supplyControlPct: data.supplyControlPct,
    overlapWalletCount: data.overlapWalletCount,
    totalUsdHeld: data.totalUsdHeld,
    topContributors: data.topContributors ?? []
  });

  const result = await broadcastTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatIds, message);

  if (data.alertId) {
    try {
      await db
        .update(alerts)
        .set({ telegramDelivered: result.delivered > 0 })
        .where(eq(alerts.id, data.alertId));
    } catch (error) {
      logger.warn({ alertId: data.alertId, error }, "alert-delivery: could not update telegramDelivered flag");
    }
  }

  logger.info({ ...result, chatIds: chatIds.length }, "alert-delivery: complete");
  return result;
}

// ─── Job: active-scan ─────────────────────────────────────────────────────────
// Job data: { mint: string; topResults?: number }
async function handleActiveScan(jobData: unknown): Promise<{ scanRunId: string; resultCount: number }> {
  const data = jobData as { mint: string; topResults?: number };
  const { mint } = data;
  const topResults = data.topResults ?? 10;

  if (!env.HELIUS_API_KEY) {
    logger.warn({ mint }, "active-scan (worker): HELIUS_API_KEY not configured, skipping");
    return { scanRunId: "", resultCount: 0 };
  }

  const { randomUUID } = await import("node:crypto");
  const scanRunId = randomUUID();
  const snapshotTime = new Date();

  await db
    .insert(scanRuns)
    .values({ id: scanRunId, inputMint: mint, status: "running", startedAt: snapshotTime })
    .onConflictDoNothing();

  try {
    const sourceToken = await helius.getTokenOverview(mint);
    const supply = sourceToken.circulatingSupply ?? sourceToken.totalSupply ?? null;

    const holderResult = await helius.getTokenHolders({
      mint,
      topHolderLimit: env.TOP_HOLDER_LIMIT,
      pageLimit: env.HELIUS_HOLDER_PAGE_LIMIT,
      maxPages: env.HELIUS_MAX_HOLDER_PAGES,
      decimals: sourceToken.decimals ?? null,
      supplyUi: supply
    });

    const holders = holderResult.holders.filter((h) => !isLikelyInfrastructureWallet(h.owner));

    const sourceTokenRow = await upsertToken({
      mint,
      symbol: sourceToken.symbol,
      name: sourceToken.name,
      marketCapUsd: sourceToken.marketCapUsd ?? null,
      athUsd: sourceToken.athUsd ?? null,
      circulatingSupply: sourceToken.circulatingSupply ?? null,
      totalSupply: sourceToken.totalSupply ?? null
    });

    for (const holder of holders) {
      const walletRow = await upsertWallet(holder.owner);
      await db
        .insert(holderSnapshots)
        .values({
          tokenId: sourceTokenRow.id,
          walletId: walletRow.id,
          snapshotTime,
          holderRank: holder.rank,
          amount: holder.uiAmount,
          shareOfSupply: holder.share
        })
        .onConflictDoNothing();
    }

    const aggregate = new Map<
      string,
      { symbol?: string; name?: string; wallets: Set<string>; units: number; usd: number }
    >();

    for (const holder of holders) {
      try {
        const positions = await helius.getWalletFungiblePositions({
          ownerAddress: holder.owner,
          pageLimit: env.HELIUS_WALLET_PAGE_LIMIT,
          maxPages: env.HELIUS_MAX_WALLET_PAGES
        });

        for (const position of positions) {
          if (position.mint === mint || position.amountUi <= 0) {
            continue;
          }
          const entry = aggregate.get(position.mint) ?? {
            symbol: position.symbol,
            name: position.name,
            wallets: new Set<string>(),
            units: 0,
            usd: 0
          };
          entry.symbol ??= position.symbol;
          entry.name ??= position.name;
          entry.wallets.add(holder.owner);
          entry.units += position.amountUi;
          entry.usd += position.usdValue ?? 0;
          aggregate.set(position.mint, entry);
        }
      } catch (error) {
        logger.warn({ holder: holder.owner, error }, "active-scan (worker): wallet enrichment error, skipping holder");
      }
    }

    const candidateMints = [...aggregate.keys()];
    const overviews: Awaited<ReturnType<typeof helius.getTokenOverviewBatch>>[] = [];
    for (const batch of chunkArray(candidateMints, 100)) {
      overviews.push(await helius.getTokenOverviewBatch(batch));
    }
    const overviewMap = new Map(overviews.flat().map((t) => [t.mint, t] as const));

    const eligible = [...aggregate.entries()]
      .map(([candidateMint, entry]) => {
        const overview = overviewMap.get(candidateMint);
        if (!overview) {
          return null;
        }
        const marketCapUsd = overview.marketCapUsd ?? 0;
        if (!Number.isFinite(marketCapUsd) || marketCapUsd < env.ACTIVE_SCAN_MARKET_CAP_MIN_USD) {
          return null;
        }
        const targetSupply = overview.circulatingSupply ?? overview.totalSupply ?? null;
        const controlPct = targetSupply && targetSupply > 0 ? entry.units / targetSupply : 0;
        const totalUsdHeld =
          entry.usd > 0
            ? entry.usd
            : overview.priceUsd !== null && overview.priceUsd !== undefined
              ? Number((overview.priceUsd * entry.units).toFixed(6))
              : 0;
        return {
          mint: candidateMint,
          symbol: overview.symbol ?? entry.symbol,
          name: overview.name ?? entry.name,
          marketCapUsd,
          athUsd: overview.athUsd ?? null,
          overlapHolderCount: entry.wallets.size,
          totalUsdHeld,
          controlPct
        };
      })
      .filter(Boolean) as Array<{
      mint: string;
      symbol?: string;
      name?: string;
      marketCapUsd: number;
      athUsd: number | null;
      overlapHolderCount: number;
      totalUsdHeld: number;
      controlPct: number;
    }>;

    const maxControlPct = Math.max(...eligible.map((e) => e.controlPct), 1);
    const maxTotalUsdHeld = Math.max(...eligible.map((e) => e.totalUsdHeld), 1);
    const maxOverlapCount = Math.max(...eligible.map((e) => e.overlapHolderCount), 1);

    const ranked = eligible
      .map((item) => {
        const scoreBreakdown = calculateActiveScanScore({
          controlPct: item.controlPct,
          totalUsdHeld: item.totalUsdHeld,
          overlapCount: item.overlapHolderCount,
          maxControlPct,
          maxTotalUsdHeld,
          maxOverlapCount
        });
        return { ...item, score: scoreBreakdown.finalScore };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topResults);

    await db.delete(scanResults).where(eq(scanResults.scanRunId, scanRunId));

    for (const [index, result] of ranked.entries()) {
      const tokenRow = await upsertToken({
        mint: result.mint,
        symbol: result.symbol,
        name: result.name,
        marketCapUsd: result.marketCapUsd,
        athUsd: result.athUsd
      });

      await db.insert(scanResults).values({
        scanRunId,
        tokenId: tokenRow.id,
        resultRank: index + 1,
        overlapWalletCount: result.overlapHolderCount,
        totalUsdHeld: result.totalUsdHeld,
        supplyControlPct: result.controlPct,
        marketCapUsd: result.marketCapUsd,
        athUsd: result.athUsd ?? null,
        weightedScore: result.score
      });
    }

    await db
      .update(scanRuns)
      .set({
        status: "succeeded",
        completedAt: new Date(),
        metadata: {
          returnedResultCount: ranked.length,
          eligibleResultCount: eligible.length,
          scannedHolderCount: holders.length,
          truncated: holderResult.truncated
        }
      })
      .where(eq(scanRuns.id, scanRunId));

    logger.info({ scanRunId, mint, resultCount: ranked.length }, "active-scan (worker): complete");
    return { scanRunId, resultCount: ranked.length };
  } catch (error) {
    await db
      .update(scanRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        metadata: { error: error instanceof Error ? error.message : String(error) }
      })
      .where(eq(scanRuns.id, scanRunId));
    throw error;
  }
}

// ─── Worker registry ──────────────────────────────────────────────────────────

const jobHandlers: Record<string, (data: unknown) => Promise<unknown>> = {
  [queueNames.tokenUniverseRefresh]: handleTokenUniverseRefresh,
  [queueNames.holderSnapshot]: handleHolderSnapshot,
  [queueNames.controlComputation]: handleControlComputation,
  [queueNames.alertDelivery]: handleAlertDelivery,
  [queueNames.activeScan]: handleActiveScan
};

const workers = Object.entries(queueNames).map(([_key, name]) => {
  const handler = jobHandlers[name];

  const worker = new Worker(
    name,
    async (job) => {
      logger.info({ queue: name, jobName: job.name, jobId: job.id }, "Processing job");

      if (!handler) {
        logger.warn({ queue: name }, "No handler registered for queue");
        return { status: "skipped", queue: name };
      }

      return handler(job.data);
    },
    {
      connection: createConnectionOptions(),
      concurrency: env.WORKER_CONCURRENCY
    }
  );

  worker.on("completed", (job) => {
    logger.info({ queue: name, jobId: job.id }, "Job completed");
  });

  worker.on("failed", (job, error) => {
    logger.error({ queue: name, jobId: job?.id, error: error.message }, "Job failed");
  });

  return { name, worker };
});

logger.info(
  { queues: workers.map((item) => item.name), concurrency: env.WORKER_CONCURRENCY },
  "Cabalfinder V2 worker online"
);

// ─── Periodic scheduler ───────────────────────────────────────────────────────
// Reads all tracked tokens from the DB and enqueues holder-snapshot and
// token-universe-refresh jobs on a configurable interval.  Set the interval
// env var to 0 to disable automatic scheduling for that job type.

const schedulerQueues = {
  holderSnapshot: new Queue(queueNames.holderSnapshot, { connection: createConnectionOptions() }),
  universeRefresh: new Queue(queueNames.tokenUniverseRefresh, { connection: createConnectionOptions() })
};

async function scheduleHolderSnapshots(): Promise<void> {
  try {
    const trackedTokens = await db
      .select({ mint: tokens.mint })
      .from(tokens)
      .where(gte(tokens.currentMarketCapUsd, env.TRACKING_MARKET_CAP_MIN_USD));

    if (trackedTokens.length === 0) {
      logger.debug("scheduler: no tracked tokens found, skipping holder-snapshot enqueue");
      return;
    }

    for (const token of trackedTokens) {
      await schedulerQueues.holderSnapshot.add(
        `holder-snapshot-${token.mint}`,
        { mint: token.mint },
        { jobId: `holder-snapshot-${token.mint}-${Date.now()}` }
      );
    }

    logger.info({ count: trackedTokens.length }, "scheduler: enqueued holder-snapshot jobs");
  } catch (error) {
    logger.error({ error }, "scheduler: failed to enqueue holder-snapshot jobs");
  }
}

async function scheduleUniverseRefresh(): Promise<void> {
  try {
    const trackedTokens = await db
      .select({ mint: tokens.mint })
      .from(tokens);

    if (trackedTokens.length === 0) {
      logger.debug("scheduler: no tokens found for universe-refresh");
      return;
    }

    const mints = trackedTokens.map((t) => t.mint);
    await schedulerQueues.universeRefresh.add(
      "universe-refresh",
      { mints },
      { jobId: `universe-refresh-${Date.now()}` }
    );

    logger.info({ mintCount: mints.length }, "scheduler: enqueued token-universe-refresh job");
  } catch (error) {
    logger.error({ error }, "scheduler: failed to enqueue token-universe-refresh job");
  }
}

const schedulerTimers: NodeJS.Timeout[] = [];

if (env.SNAPSHOT_INTERVAL_MS > 0) {
  logger.info({ intervalMs: env.SNAPSHOT_INTERVAL_MS }, "scheduler: holder-snapshot auto-scheduling enabled");
  const timer = setInterval(() => {
    void scheduleHolderSnapshots();
  }, env.SNAPSHOT_INTERVAL_MS);
  schedulerTimers.push(timer);
} else {
  logger.info("scheduler: holder-snapshot auto-scheduling disabled (SNAPSHOT_INTERVAL_MS=0)");
}

if (env.UNIVERSE_REFRESH_INTERVAL_MS > 0) {
  logger.info({ intervalMs: env.UNIVERSE_REFRESH_INTERVAL_MS }, "scheduler: universe-refresh auto-scheduling enabled");
  const timer = setInterval(() => {
    void scheduleUniverseRefresh();
  }, env.UNIVERSE_REFRESH_INTERVAL_MS);
  schedulerTimers.push(timer);
} else {
  logger.info("scheduler: universe-refresh auto-scheduling disabled (UNIVERSE_REFRESH_INTERVAL_MS=0)");
}

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down worker");
  for (const timer of schedulerTimers) {
    clearInterval(timer);
  }
  await Promise.all([
    ...workers.map(({ worker }) => worker.close()),
    schedulerQueues.holderSnapshot.close(),
    schedulerQueues.universeRefresh.close()
  ]);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
