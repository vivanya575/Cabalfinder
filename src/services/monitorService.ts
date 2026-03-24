import type { AppConfig } from "../config.js";
import { FileStorage } from "../lib/storage.js";
import type { AlertEvent, ControlRow, HolderSnapshot, PoolConfig, TokenConfig } from "../types.js";
import type { DashboardState } from "../types/dashboard.js";
import { mapWithConcurrency } from "../lib/async.js";
import { HolderService } from "./holderService.js";
import { MarketCapService } from "./marketCapService.js";
import { SolanaRpcClient } from "../lib/rpc.js";
import { TelegramService } from "./telegramService.js";

export class MonitorService {
  private readonly rpc: SolanaRpcClient;
  private readonly holderService: HolderService;
  private readonly marketCapService: MarketCapService;
  private readonly storage: FileStorage;
  private readonly telegram: TelegramService;
  private readonly tokenByMint: Map<string, TokenConfig>;
  private readonly pools: PoolConfig[];

  constructor(
    private readonly config: AppConfig,
    private readonly tokens: TokenConfig[],
    pools: PoolConfig[]
  ) {
    this.rpc = new SolanaRpcClient(config.rpcUrl, config.rpcTimeoutMs);
    this.holderService = new HolderService(this.rpc);
    this.pools = pools;
    this.marketCapService = new MarketCapService(
      this.rpc,
      this.holderService,
      pools,
      config.stableMints,
      config.wsolMint,
      config.solUsdReferencePoolId,
      config.minMarketLiquidityUsd,
      config.priceCacheTtlMs
    );
    this.storage = new FileStorage(config.dataDir);
    this.telegram = new TelegramService(config.telegramBotToken, config.telegramChatIds);
    this.tokenByMint = new Map(this.tokens.map((token) => [token.mint, token]));
  }

  private getWarnings(): string[] {
    const warnings: string[] = [];

    if (this.tokens.length < 2) {
      warnings.push("Configure at least 2 tokens to produce cross-token correlation rows and alerts.");
    }

    const incompletePools = this.pools.filter((pool) => !pool.baseVault || !pool.quoteVault);
    if (incompletePools.length > 0) {
      warnings.push(
        `${incompletePools.length} pool config entr${incompletePools.length === 1 ? "y is" : "ies are"} missing vault accounts, so price and scan results will be incomplete.`
      );
    }

    if (/api\.mainnet(-beta)?\.solana\.com/.test(this.config.rpcUrl)) {
      warnings.push("Public Solana RPC endpoints are rate-limited and not intended for production; use a dedicated/private RPC before relying on this in production.");
    }

    if (this.config.scanHolderLimit < 50) {
      warnings.push(
        `Active scanner is capped to the top ${this.config.scanHolderLimit} holders on the current RPC configuration to avoid rate-limit failures.`
      );
    }

    return warnings;
  }

  private tokenLabel(mint: string): string {
    const token = this.tokenByMint.get(mint);
    if (!token) {
      return mint;
    }
    return `${token.symbol ?? "?"} (${mint.slice(0, 4)}...${mint.slice(-4)})`;
  }

  private async getOwnerPortfolioSafe(owner: string): Promise<Map<string, number>> {
    try {
      return await this.holderService.getOwnerPortfolio(owner);
    } catch {
      return new Map<string, number>();
    }
  }

  async getDashboardState(): Promise<DashboardState> {
    await this.storage.ensure();

    const [recentAlerts, recentControlRows, lastSnapshots] = await Promise.all([
      this.storage.readRecentAlerts(50),
      this.storage.readRecentControlRows(200),
      Promise.all(this.tokens.map((token) => this.storage.readHolderSnapshot(token.mint)))
    ]);

    return {
      tokens: this.tokens,
      recentAlerts: recentAlerts.reverse(),
      recentControlRows: recentControlRows.reverse(),
      lastSnapshots: lastSnapshots.filter(Boolean) as HolderSnapshot[],
      threshold: this.config.alertThreshold,
      scanHolderLimit: this.config.scanHolderLimit,
      warnings: this.getWarnings()
    };
  }

  async runSnapshots(): Promise<void> {
    await this.storage.ensure();
    await mapWithConcurrency(this.tokens, this.config.rpcConcurrency, async (token) => {
      const supplyUi = await this.rpc.getTokenSupplyUi(token.mint);
      if (supplyUi < this.config.minSupply) {
        return;
      }

      const holders = await this.holderService.getTopHolders(token.mint, 50);
      const snapshot: HolderSnapshot = {
        tokenMint: token.mint,
        snapshotTime: new Date().toISOString(),
        supplyUi,
        holders: holders.map((holder, idx) => ({
          rank: idx + 1,
          owner: holder.owner,
          amountUi: holder.amountUi,
          share: supplyUi > 0 ? holder.amountUi / supplyUi : 0
        }))
      };
      await this.storage.saveHolderSnapshot(snapshot);
    });
  }

  async runCorrelationAndAlerts(): Promise<{ rows: number; alerts: number }> {
    await this.storage.ensure();
    const snapshots = (
      await Promise.all(this.tokens.map((token) => this.storage.readHolderSnapshot(token.mint)))
    ).filter(Boolean) as HolderSnapshot[];

    const uniqueAddresses = new Set<string>();
    for (const snapshot of snapshots) {
      for (const holder of snapshot.holders) {
        uniqueAddresses.add(holder.owner);
      }
    }

    const portfolioCache = new Map<string, Map<string, number>>();
    const owners = [...uniqueAddresses];
    const portfolios = await mapWithConcurrency(owners, this.config.rpcConcurrency, async (owner) => ({
      owner,
      portfolio: await this.getOwnerPortfolioSafe(owner)
    }));
    for (const { owner, portfolio } of portfolios) {
      portfolioCache.set(owner, portfolio);
    }

    const rows: ControlRow[] = [];
    const now = new Date().toISOString();

    for (const a of snapshots) {
      for (const b of snapshots) {
        if (a.tokenMint === b.tokenMint) {
          continue;
        }

        let sum = 0;
        for (const holder of b.holders) {
          const portfolio = portfolioCache.get(holder.owner);
          const amount = portfolio?.get(a.tokenMint) ?? 0;
          sum += amount;
        }

        const control = a.supplyUi > 0 ? sum / a.supplyUi : 0;
        rows.push({ tokenA: a.tokenMint, tokenB: b.tokenMint, snapshotTime: now, control });
      }
    }

    await this.storage.appendControlRows(rows);

    const alertState = await this.storage.loadAlertState();
    const events: AlertEvent[] = [];

    for (const row of rows) {
      const key = `${row.tokenA}|${row.tokenB}`;
      const prev = alertState[key] ?? 0;
      if (prev < this.config.alertThreshold && row.control >= this.config.alertThreshold) {
        const snapshotB = snapshots.find((snap) => snap.tokenMint === row.tokenB);
        const contributors: Array<{ owner: string; amountUi: number }> = [];
        if (snapshotB) {
          for (const holder of snapshotB.holders) {
            const amount = portfolioCache.get(holder.owner)?.get(row.tokenA) ?? 0;
            if (amount > 0) {
              contributors.push({ owner: holder.owner, amountUi: amount });
            }
          }
          contributors.sort((x, y) => y.amountUi - x.amountUi);
        }

        events.push({
          tokenA: row.tokenA,
          tokenB: row.tokenB,
          snapshotTime: row.snapshotTime,
          prevControl: prev,
          control: row.control,
          contributors: contributors.slice(0, 10)
        });
      }
      alertState[key] = row.control;
    }

    await this.storage.saveAlertState(alertState);
    await this.storage.appendAlerts(events);

    for (const event of events) {
      await this.telegram.broadcastAlert(event, this.tokenByMint);
    }

    return { rows: rows.length, alerts: events.length };
  }

  async runSingleTokenScan(targetMint: string, topResults = 10): Promise<Array<Record<string, unknown>>> {
    const holders = await this.holderService.getTopHolders(targetMint, this.config.scanHolderLimit);
    const aggregate = new Map<string, { totalUnits: number; byHolder: Map<string, number> }>();

    const portfolios = await mapWithConcurrency(holders, this.config.rpcConcurrency, async (holder) => ({
      holder,
      portfolio: await this.getOwnerPortfolioSafe(holder.owner)
    }));

    for (const { holder, portfolio } of portfolios) {
      for (const [mint, amount] of portfolio.entries()) {
        if (mint === targetMint || amount <= 0) {
          continue;
        }
        const entry = aggregate.get(mint) ?? { totalUnits: 0, byHolder: new Map<string, number>() };
        entry.totalUnits += amount;
        entry.byHolder.set(holder.owner, amount);
        aggregate.set(mint, entry);
      }
    }

    const rows = (
      await mapWithConcurrency([...aggregate.entries()], this.config.rpcConcurrency, async ([mint, stats]) => {
        const [priceQuote, marketCap] = await Promise.all([
          this.marketCapService.getPriceQuoteUsd(mint),
          this.marketCapService.getMarketCapUsd(mint)
        ]);

        if (!priceQuote || !marketCap) {
          return null;
        }

        return {
          mint,
          marketCapUsd: marketCap,
          priceUsd: priceQuote.priceUsd,
          sourcePool: priceQuote.sourcePoolId,
          quoteLiquidityUsd: priceQuote.quoteLiquidityUsd,
          totalUnitsHeldByTop50: stats.totalUnits,
          totalUsdHeldByTop50: stats.totalUnits * priceQuote.priceUsd
        };
      })
    ).filter(Boolean) as Array<Record<string, unknown>>;

    rows.sort((a, b) => Number(b.totalUsdHeldByTop50) - Number(a.totalUsdHeldByTop50));

    return rows.slice(0, topResults).map((row) => ({
      ...row,
      label: this.tokenLabel(String(row.mint))
    }));
  }
}
