import type { PoolConfig, PriceQuote } from "../types.js";
import { SolanaRpcClient } from "../lib/rpc.js";
import { HolderService } from "./holderService.js";

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

interface CandidatePool {
  pool: PoolConfig;
  targetSide: "base" | "quote";
}

export class MarketCapService {
  private readonly poolsByMint = new Map<string, CandidatePool[]>();
  private readonly priceQuoteCache = new Map<string, CacheEntry<PriceQuote | null>>();
  private readonly marketCapCache = new Map<string, CacheEntry<number | null>>();
  private readonly poolReserveCache = new Map<string, CacheEntry<{ base: number; quote: number } | null>>();
  private readonly supplyCache = new Map<string, CacheEntry<number>>();
  private readonly scalarCache = new Map<string, CacheEntry<number | null>>();

  constructor(
    private readonly rpc: SolanaRpcClient,
    private readonly holderService: HolderService,
    private readonly pools: PoolConfig[],
    private readonly stableMints: Set<string>,
    private readonly wsolMint: string,
    private readonly solUsdReferencePoolId: string,
    private readonly minQuoteLiquidityUsd: number,
    private readonly cacheTtlMs: number
  ) {
    for (const pool of pools) {
      const baseList = this.poolsByMint.get(pool.baseMint) ?? [];
      baseList.push({ pool, targetSide: "base" });
      this.poolsByMint.set(pool.baseMint, baseList);

      const quoteList = this.poolsByMint.get(pool.quoteMint) ?? [];
      quoteList.push({ pool, targetSide: "quote" });
      this.poolsByMint.set(pool.quoteMint, quoteList);
    }
  }

  private getCached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    loader: () => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const value = loader();
    cache.set(key, {
      expiresAt: now + this.cacheTtlMs,
      value
    });

    value.catch(() => {
      if (cache.get(key)?.value === value) {
        cache.delete(key);
      }
    });

    return value;
  }

  private async readPoolReserves(pool: PoolConfig): Promise<{ base: number; quote: number } | null> {
    return this.getCached(this.poolReserveCache, pool.id, async () => {
      if (!pool.baseVault || !pool.quoteVault) {
        return null;
      }

      try {
        const [base, quote] = await Promise.all([
          this.rpc.getTokenAccountBalanceUi(pool.baseVault),
          this.rpc.getTokenAccountBalanceUi(pool.quoteVault)
        ]);
        return { base, quote };
      } catch {
        return null;
      }
    });
  }

  private async getSolUsdPrice(): Promise<number | null> {
    return this.getCached(this.scalarCache, "sol-usd-price", async () => {
      const refPool = this.pools.find((pool) => pool.id === this.solUsdReferencePoolId);
      if (!refPool) {
        return null;
      }

      const reserves = await this.readPoolReserves(refPool);
      if (!reserves || reserves.base <= 0 || reserves.quote <= 0) {
        return null;
      }

      return reserves.quote / reserves.base;
    });
  }

  private async getTokenSupplyCached(mint: string): Promise<number> {
    return this.getCached(this.supplyCache, mint, () => this.rpc.getTokenSupplyUi(mint));
  }

  private async getReferenceUsdRate(mint: string, solUsd: number | null): Promise<number | null> {
    if (this.stableMints.has(mint)) {
      return 1;
    }
    if (mint === this.wsolMint) {
      return solUsd;
    }
    return null;
  }

  async getPriceQuoteUsd(mint: string): Promise<PriceQuote | null> {
    return this.getCached(this.priceQuoteCache, mint, async () => {
      const candidatePools = this.poolsByMint.get(mint) ?? [];
      if (candidatePools.length === 0) {
        return null;
      }

      let solUsd: number | null = null;
      const weighted: Array<{ price: number; liquidity: number; poolId: string }> = [];

      for (const candidate of candidatePools) {
        const { pool, targetSide } = candidate;
        const reserves = await this.readPoolReserves(pool);
        if (!reserves || reserves.base <= 0 || reserves.quote <= 0) {
          continue;
        }

        if (solUsd === null) {
          solUsd = await this.getSolUsdPrice();
        }

        const quoteMint = targetSide === "base" ? pool.quoteMint : pool.baseMint;
        const quoteReserve = targetSide === "base" ? reserves.quote : reserves.base;
        const targetReserve = targetSide === "base" ? reserves.base : reserves.quote;
        const quoteToUsd = await this.getReferenceUsdRate(quoteMint, solUsd);
        if (quoteToUsd === null) {
          continue;
        }

        const quoteLiquidityUsd = quoteReserve * quoteToUsd;
        if (quoteLiquidityUsd < this.minQuoteLiquidityUsd) {
          continue;
        }

        const priceUsd = (quoteReserve / targetReserve) * quoteToUsd;
        weighted.push({ price: priceUsd, liquidity: quoteLiquidityUsd, poolId: pool.id });
      }

      if (weighted.length === 0) {
        return null;
      }

      const sorted = weighted.sort((a, b) => a.price - b.price);
      const totalWeight = sorted.reduce((acc, row) => acc + row.liquidity, 0);
      let rolling = 0;
      let selected = sorted[sorted.length - 1];

      for (const row of sorted) {
        rolling += row.liquidity;
        if (rolling >= totalWeight / 2) {
          selected = row;
          break;
        }
      }

      return {
        mint,
        priceUsd: selected.price,
        quoteLiquidityUsd: selected.liquidity,
        sourcePoolId: selected.poolId
      };
    });
  }

  async getMarketCapUsd(mint: string): Promise<number | null> {
    return this.getCached(this.marketCapCache, mint, async () => {
      const [quote, supplyUi] = await Promise.all([
        this.getPriceQuoteUsd(mint),
        this.getTokenSupplyCached(mint)
      ]);
      if (!quote || supplyUi <= 0) {
        return null;
      }
      return quote.priceUsd * supplyUi;
    });
  }

  async getPortfolioMarketCaps(portfolio: Map<string, number>): Promise<Map<string, number>> {
    const output = new Map<string, number>();
    for (const [mint, balance] of portfolio.entries()) {
      if (balance <= 0) {
        continue;
      }
      const price = await this.getPriceQuoteUsd(mint);
      if (!price) {
        continue;
      }
      output.set(mint, balance * price.priceUsd);
    }
    return output;
  }

  async getTokenMetadataHints(mint: string): Promise<{ supplyUi: number; decimals: number }> {
    const [supplyUi, decimals] = await Promise.all([
      this.getTokenSupplyCached(mint),
      this.holderService.getTokenDecimals(mint)
    ]);
    return { supplyUi, decimals };
  }
}
