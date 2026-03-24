import { randomUUID } from "node:crypto";
import { type ActiveScanResponse, calculateActiveScanScore } from "@cabalfinder/shared";
import { env } from "../env.js";
import { HeliusClient, type HeliusTokenHolder, type HeliusTokenOverview } from "../clients/helius.js";
import { mapWithConcurrency } from "../lib/async.js";
import { AppError } from "../lib/errors.js";
import { markActiveScanFailed, persistActiveScan } from "../repositories/activeScanRepository.js";

interface RunActiveScanParams {
  mint: string;
  topResults: number;
}

interface AggregatedHolding {
  mint: string;
  symbol?: string;
  name?: string;
  overlapWallets: Set<string>;
  contributors: Map<
    string,
    {
      amountUi: number;
      usdValue: number | null;
    }
  >;
  totalUnitsHeld: number;
  totalUsdHeld: number;
}

interface CandidateTokenResult {
  mint: string;
  symbol?: string;
  name?: string;
  marketCapUsd: number;
  athUsd: number | null;
  overlapHolderCount: number;
  totalUsdHeld: number;
  controlPct: number;
  scoreBreakdown: ReturnType<typeof calculateActiveScanScore>;
  score: number;
}

interface ResultContributorPosition {
  walletAddress: string;
  mint: string;
  symbol?: string;
  name?: string;
  marketCapUsd: number;
  athUsd: number | null;
  amountUi: number;
  usdValue: number | null;
}

function chooseSupply(token: HeliusTokenOverview): number | null {
  const circulating = token.circulatingSupply;
  if (circulating && circulating > 0) {
    return circulating;
  }

  const total = token.totalSupply;
  if (total && total > 0) {
    return total;
  }

  return null;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
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

export class ActiveScanService {
  private readonly helius = new HeliusClient(env.HELIUS_API_KEY);

  async run(params: RunActiveScanParams): Promise<{ scanRunId: string; response: ActiveScanResponse }> {
    const scanRunId = randomUUID();
    const snapshotTime = new Date();
    const warnings: string[] = [];

    try {
      const sourceToken = await this.helius.getTokenOverview(params.mint);
      const holderSnapshot = await this.helius.getTokenHolders({
        mint: params.mint,
        topHolderLimit: env.TOP_HOLDER_LIMIT,
        pageLimit: env.HELIUS_HOLDER_PAGE_LIMIT,
        maxPages: env.HELIUS_MAX_HOLDER_PAGES,
        decimals: sourceToken.decimals ?? null,
        supplyUi: chooseSupply(sourceToken)
      });

      if (holderSnapshot.truncated) {
        warnings.push(
          `Top-holder discovery was truncated after ${env.HELIUS_MAX_HOLDER_PAGES} Helius holder pages. Rankings are based on the indexed subset.`
        );
      }

      const holders = holderSnapshot.holders.filter((holder) => !isLikelyInfrastructureWallet(holder.owner));
      if (holders.length === 0) {
        throw new AppError(404, "No eligible top holders were found for this token.");
      }

      if (holders.length < holderSnapshot.holders.length) {
        warnings.push(`Excluded ${holderSnapshot.holders.length - holders.length} likely infrastructure holder addresses.`);
      }

      const aggregate = new Map<string, AggregatedHolding>();
      const skippedHolders: Array<{ owner: string; reason: string }> = [];

      await mapWithConcurrency(holders, 1, async (holder) => {
        try {
          const positions = await this.helius.getWalletFungiblePositions({
            ownerAddress: holder.owner,
            pageLimit: env.HELIUS_WALLET_PAGE_LIMIT,
            maxPages: env.HELIUS_MAX_WALLET_PAGES
          });

          for (const position of positions) {
            if (position.mint === params.mint || position.amountUi <= 0) {
              continue;
            }

            const entry = aggregate.get(position.mint) ?? {
              mint: position.mint,
              symbol: position.symbol,
              name: position.name,
              overlapWallets: new Set<string>(),
              contributors: new Map<string, { amountUi: number; usdValue: number | null }>(),
              totalUnitsHeld: 0,
              totalUsdHeld: 0
            };

            entry.symbol ??= position.symbol;
            entry.name ??= position.name;
            entry.overlapWallets.add(holder.owner);

            const existingContributor = entry.contributors.get(holder.owner);
            if (existingContributor) {
              existingContributor.amountUi += position.amountUi;
              existingContributor.usdValue = (existingContributor.usdValue ?? 0) + (position.usdValue ?? 0);
            } else {
              entry.contributors.set(holder.owner, {
                amountUi: position.amountUi,
                usdValue: position.usdValue
              });
            }

            entry.totalUnitsHeld += position.amountUi;
            entry.totalUsdHeld += position.usdValue ?? 0;
            aggregate.set(position.mint, entry);
          }
        } catch (error) {
          skippedHolders.push({
            owner: holder.owner,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      });

      if (skippedHolders.length > 0) {
        const sample = skippedHolders
          .slice(0, 3)
          .map((item) => `${item.owner}: ${item.reason}`)
          .join(" | ");
        warnings.push(`Skipped ${skippedHolders.length} holder wallets during expansion. ${sample}`);
      }

      const candidateMints = [...aggregate.keys()];
      const overviewBatches = await mapWithConcurrency(chunkArray(candidateMints, 100), 2, async (mintBatch) =>
        this.helius.getTokenOverviewBatch(mintBatch)
      );
      const overviewMap = new Map(overviewBatches.flat().map((token) => [token.mint, token] as const));

      const eligible = [...aggregate.values()]
        .map((entry) => {
          const overview = overviewMap.get(entry.mint);
          if (!overview) {
            return null;
          }

          const marketCapUsd = overview.marketCapUsd ?? 0;
          if (!Number.isFinite(marketCapUsd) || marketCapUsd < env.ACTIVE_SCAN_MARKET_CAP_MIN_USD) {
            return null;
          }

          const supply = chooseSupply(overview);
          const controlPct = supply && supply > 0 ? entry.totalUnitsHeld / supply : 0;
          const totalUsdHeld =
            entry.totalUsdHeld > 0
              ? entry.totalUsdHeld
              : overview.priceUsd !== null && overview.priceUsd !== undefined
                ? Number((overview.priceUsd * entry.totalUnitsHeld).toFixed(6))
                : 0;

          return {
            mint: entry.mint,
            symbol: overview.symbol ?? entry.symbol,
            name: overview.name ?? entry.name,
            marketCapUsd,
            athUsd: overview.athUsd ?? null,
            overlapHolderCount: entry.overlapWallets.size,
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

      if (eligible.length === 0) {
        warnings.push("No co-held tokens passed the active scan market-cap filter under the current Helius-backed model.");
      } else {
        const missingAthCount = eligible.filter((item) => item.athUsd === null).length;
        if (missingAthCount > 0) {
          warnings.push(
            `ATH is best-effort from Helius and was unavailable for ${missingAthCount} of ${eligible.length} eligible tokens.`
          );
        }
      }

      const maxControlPct = Math.max(...eligible.map((item) => item.controlPct), 1);
      const maxTotalUsdHeld = Math.max(...eligible.map((item) => item.totalUsdHeld), 1);
      const maxOverlapCount = Math.max(...eligible.map((item) => item.overlapHolderCount), 1);

      const ranked: CandidateTokenResult[] = eligible
        .map((item) => {
          const scoreBreakdown = calculateActiveScanScore({
            controlPct: item.controlPct,
            totalUsdHeld: item.totalUsdHeld,
            overlapCount: item.overlapHolderCount,
            maxControlPct,
            maxTotalUsdHeld,
            maxOverlapCount
          });

          return {
            ...item,
            scoreBreakdown,
            score: scoreBreakdown.finalScore
          };
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, params.topResults);

      const resultContributors: ResultContributorPosition[] = ranked.flatMap((item) => {
        const entry = aggregate.get(item.mint);
        if (!entry) {
          return [];
        }

        return [...entry.contributors.entries()].map(([walletAddress, contributor]) => ({
          walletAddress,
          mint: item.mint,
          symbol: item.symbol,
          name: item.name,
          marketCapUsd: item.marketCapUsd,
          athUsd: item.athUsd,
          amountUi: contributor.amountUi,
          usdValue:
            contributor.usdValue && contributor.usdValue > 0
              ? contributor.usdValue
              : item.marketCapUsd > 0 && item.totalUsdHeld > 0 && entry.totalUnitsHeld > 0
                ? Number(((contributor.amountUi / entry.totalUnitsHeld) * item.totalUsdHeld).toFixed(6))
                : null
        }));
      });

      const response: ActiveScanResponse = {
        sourceToken: {
          mint: sourceToken.mint,
          symbol: sourceToken.symbol,
          name: sourceToken.name,
          marketCapUsd: sourceToken.marketCapUsd ?? null,
          athUsd: sourceToken.athUsd ?? null
        },
        results: ranked.map((item) => ({
          mint: item.mint,
          ca: item.mint,
          symbol: item.symbol,
          name: item.name,
          marketCapUsd: item.marketCapUsd,
          athUsd: item.athUsd,
          overlapHolderCount: item.overlapHolderCount,
          totalUsdHeld: item.totalUsdHeld,
          controlPct: item.controlPct,
          score: item.score,
          scoreBreakdown: item.scoreBreakdown
        })),
        summary: {
          scannedHolderCount: holders.length,
          returnedResultCount: ranked.length,
          eligibleResultCount: eligible.length,
          topHolderLimit: env.TOP_HOLDER_LIMIT,
          marketCapFloorUsd: env.ACTIVE_SCAN_MARKET_CAP_MIN_USD,
          copyCAs: ranked.map((item) => item.mint).join("\n")
        },
        warnings
      };

      try {
        await persistActiveScan({
          inputMint: params.mint,
          scanRunId,
          snapshotTime,
          response,
          sourceHolders: holders.map((holder) => ({
            owner: holder.owner,
            rank: holder.rank,
            uiAmount: holder.uiAmount,
            share: holder.share
          })),
          resultContributors
        });
      } catch (error) {
        warnings.push(`Persistence skipped: ${error instanceof Error ? error.message : String(error)}`);
      }

      return { scanRunId, response };
    } catch (error) {
      try {
        await markActiveScanFailed(scanRunId, params.mint, error instanceof Error ? error.message : String(error));
      } catch {
        // ignore persistence failure on error path
      }
      throw error;
    }
  }
}
