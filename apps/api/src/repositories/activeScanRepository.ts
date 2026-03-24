import { eq } from "drizzle-orm";
import type { ActiveScanResponse } from "@cabalfinder/shared";
import { db } from "../db/client.js";
import { holderSnapshots, scanResults, scanRuns, tokens, walletPositions, wallets } from "../db/schema.js";

interface PersistScanParams {
  inputMint: string;
  scanRunId: string;
  snapshotTime: Date;
  response: ActiveScanResponse;
  sourceHolders: Array<{
    owner: string;
    rank: number;
    uiAmount: number;
    share: number;
  }>;
  resultContributors: Array<{
    walletAddress: string;
    mint: string;
    symbol?: string;
    name?: string;
    marketCapUsd: number;
    athUsd: number | null;
    amountUi: number;
    usdValue: number | null;
  }>;
}

async function upsertTokenRow(token: {
  mint: string;
  symbol?: string;
  name?: string;
  marketCapUsd?: number | null;
  athUsd?: number | null;
}): Promise<{ id: string; mint: string }> {
  const [row] = await db
    .insert(tokens)
    .values({
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      currentMarketCapUsd: token.marketCapUsd ?? null,
      athUsd: token.athUsd ?? null,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: tokens.mint,
      set: {
        symbol: token.symbol,
        name: token.name,
        currentMarketCapUsd: token.marketCapUsd ?? null,
        athUsd: token.athUsd ?? null,
        updatedAt: new Date()
      }
    })
    .returning({
      id: tokens.id,
      mint: tokens.mint
    });

  return row;
}

async function upsertWalletRow(address: string): Promise<{ id: string; address: string }> {
  const [row] = await db
    .insert(wallets)
    .values({
      address,
      lastSeenAt: new Date()
    })
    .onConflictDoUpdate({
      target: wallets.address,
      set: {
        lastSeenAt: new Date()
      }
    })
    .returning({
      id: wallets.id,
      address: wallets.address
    });

  return row;
}

function buildTokenCacheKey(token: {
  mint: string;
  symbol?: string;
  name?: string;
  marketCapUsd?: number | null;
  athUsd?: number | null;
}): string {
  return token.mint;
}

export async function persistActiveScan(params: PersistScanParams): Promise<void> {
  const tokenCache = new Map<string, { id: string; mint: string }>();
  const walletCache = new Map<string, { id: string; address: string }>();

  const getOrCreateToken = async (token: {
    mint: string;
    symbol?: string;
    name?: string;
    marketCapUsd?: number | null;
    athUsd?: number | null;
  }) => {
    const key = buildTokenCacheKey(token);
    const cached = tokenCache.get(key);
    if (cached) {
      return cached;
    }

    const row = await upsertTokenRow(token);
    tokenCache.set(key, row);
    return row;
  };

  const getOrCreateWallet = async (address: string) => {
    const cached = walletCache.get(address);
    if (cached) {
      return cached;
    }

    const row = await upsertWalletRow(address);
    walletCache.set(address, row);
    return row;
  };

  const sourceToken = await getOrCreateToken(params.response.sourceToken);

  await db
    .insert(scanRuns)
    .values({
      id: params.scanRunId,
      inputMint: params.inputMint,
      status: "running",
      startedAt: params.snapshotTime,
      snapshotVersion: params.snapshotTime.toISOString(),
      metadata: {
        warnings: params.response.warnings,
        sourceTokenMint: params.response.sourceToken.mint,
        topHolderLimit: params.response.summary.topHolderLimit,
        marketCapFloorUsd: params.response.summary.marketCapFloorUsd
      }
    })
    .onConflictDoNothing();

  for (const holder of params.sourceHolders) {
    const wallet = await getOrCreateWallet(holder.owner);
    await db
      .insert(holderSnapshots)
      .values({
        tokenId: sourceToken.id,
        walletId: wallet.id,
        snapshotTime: params.snapshotTime,
        holderRank: holder.rank,
        amount: holder.uiAmount,
        shareOfSupply: holder.share
      })
      .onConflictDoNothing();
  }

  await db.delete(scanResults).where(eq(scanResults.scanRunId, params.scanRunId));

  for (const [index, result] of params.response.results.entries()) {
    const tokenRow = await getOrCreateToken({
      mint: result.mint,
      symbol: result.symbol,
      name: result.name,
      marketCapUsd: result.marketCapUsd,
      athUsd: result.athUsd
    });

    await db.insert(scanResults).values({
      scanRunId: params.scanRunId,
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

  for (const contributor of params.resultContributors) {
    const wallet = await getOrCreateWallet(contributor.walletAddress);
    const token = await getOrCreateToken({
      mint: contributor.mint,
      symbol: contributor.symbol,
      name: contributor.name,
      marketCapUsd: contributor.marketCapUsd,
      athUsd: contributor.athUsd
    });

    await db.insert(walletPositions).values({
      walletId: wallet.id,
      tokenId: token.id,
      balance: contributor.amountUi,
      usdValue: contributor.usdValue,
      source: "active_scan",
      observedAt: params.snapshotTime
    });
  }

  await db
    .update(scanRuns)
    .set({
      status: "succeeded",
      completedAt: new Date(),
      metadata: {
        warnings: params.response.warnings,
        eligibleResultCount: params.response.summary.eligibleResultCount,
        returnedResultCount: params.response.summary.returnedResultCount,
        sourceTokenId: sourceToken.id,
        scannedHolderCount: params.response.summary.scannedHolderCount,
        copyCAs: params.response.summary.copyCAs
      }
    })
    .where(eq(scanRuns.id, params.scanRunId));
}

export async function markActiveScanFailed(scanRunId: string, inputMint: string, error: string): Promise<void> {
  await db
    .insert(scanRuns)
    .values({
      id: scanRunId,
      inputMint,
      status: "failed",
      startedAt: new Date(),
      completedAt: new Date(),
      metadata: {
        error
      }
    })
    .onConflictDoUpdate({
      target: scanRuns.id,
      set: {
        status: "failed",
        completedAt: new Date(),
        metadata: {
          error
        }
      }
    });
}

export async function getActiveScanById(scanRunId: string) {
  const [run] = await db
    .select()
    .from(scanRuns)
    .where(eq(scanRuns.id, scanRunId))
    .limit(1);

  if (!run) {
    return null;
  }

  const rows = await db
    .select({
      rank: scanResults.resultRank,
      overlapHolderCount: scanResults.overlapWalletCount,
      totalUsdHeld: scanResults.totalUsdHeld,
      supplyControlPct: scanResults.supplyControlPct,
      marketCapUsd: scanResults.marketCapUsd,
      athUsd: scanResults.athUsd,
      weightedScore: scanResults.weightedScore,
      mint: tokens.mint,
      symbol: tokens.symbol,
      name: tokens.name
    })
    .from(scanResults)
    .innerJoin(tokens, eq(scanResults.tokenId, tokens.id))
    .where(eq(scanResults.scanRunId, scanRunId))
    .orderBy(scanResults.resultRank);

  return {
    run,
    results: rows
  };
}
