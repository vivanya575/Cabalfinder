import type { HolderBalance } from "../types.js";
import { SolanaRpcClient } from "../lib/rpc.js";

export class HolderService {
  private readonly decimalsCache = new Map<string, number>();

  constructor(private readonly rpc: SolanaRpcClient) {}

  async getTokenDecimals(mint: string): Promise<number> {
    const cached = this.decimalsCache.get(mint);
    if (cached !== undefined) {
      return cached;
    }
    const decimals = await this.rpc.getMintDecimals(mint);
    this.decimalsCache.set(mint, decimals);
    return decimals;
  }

  async getTopHolders(mint: string, limit = 50): Promise<HolderBalance[]> {
    const rows = await this.rpc.getTopHoldersByMint(mint);
    const ownerTotals = new Map<string, bigint>();

    for (const row of rows) {
      const prev = ownerTotals.get(row.owner) ?? 0n;
      ownerTotals.set(row.owner, prev + row.amountRaw);
    }

    const decimals = await this.getTokenDecimals(mint);
    const divisor = 10 ** decimals;

    return [...ownerTotals.entries()]
      .map(([owner, amountRaw]) => ({
        owner,
        amountRaw,
        amountUi: Number(amountRaw) / divisor
      }))
      .sort((a, b) => (a.amountRaw > b.amountRaw ? -1 : 1))
      .slice(0, limit);
  }

  async getOwnerPortfolio(owner: string): Promise<Map<string, number>> {
    return this.rpc.getTokenBalancesUiByOwner(owner);
  }
}
