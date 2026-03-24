const HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/";
const HELIUS_WALLET_API_URL = "https://api.helius.xyz";

function pickNumber(input: unknown, keys: string[]): number | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : null;
    if (value !== null && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function pickString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw;
    }
  }
  return undefined;
}

function pickNested(input: unknown, path: string[]): unknown {
  let current = input;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function scaleAmount(rawAmount: number | null, decimals: number | null): number | null {
  if (rawAmount === null) {
    return null;
  }
  if (decimals === null || !Number.isFinite(decimals) || decimals < 0) {
    return rawAmount;
  }
  return rawAmount / 10 ** decimals;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HeliusTokenOverview {
  mint: string;
  symbol?: string;
  name?: string;
  decimals?: number | null;
  marketCapUsd?: number | null;
  priceUsd?: number | null;
  circulatingSupply?: number | null;
  totalSupply?: number | null;
  athUsd?: number | null;
}

export interface HeliusTokenHolder {
  rank: number;
  owner: string;
  uiAmount: number;
  share: number;
}

export interface HeliusWalletTokenPosition {
  mint: string;
  symbol?: string;
  name?: string;
  amountUi: number;
  usdValue: number | null;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code: number; message: string };
}

export class HeliusWorkerClient {
  constructor(private readonly apiKey: string) {}

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const url = new URL(HELIUS_RPC_URL);
      url.searchParams.set("api-key", this.apiKey);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "cabalfinder-worker", method, params })
      });

      const payload = (await response.json().catch(() => null)) as RpcEnvelope<T> | null;
      if (response.ok && !payload?.error && payload?.result !== undefined) {
        return payload.result;
      }

      const statusCode = response.status;
      const msg = payload?.error?.message ?? `Helius ${method} HTTP ${statusCode}`;
      lastError = new Error(msg);

      if (attempt < 3 && isRetryableStatus(statusCode)) {
        await sleep(400 * attempt);
        continue;
      }
      throw lastError;
    }
    throw lastError ?? new Error(`Helius ${method} failed`);
  }

  private toOverview(asset: unknown, fallbackMint?: string): HeliusTokenOverview {
    const tokenInfo = pickNested(asset, ["token_info"]);
    const metadata = pickNested(asset, ["content", "metadata"]);
    const priceInfo = pickNested(tokenInfo, ["price_info"]);
    const marketData = pickNested(asset, ["market_data"]);

    const decimals = pickNumber(tokenInfo, ["decimals"]);
    const rawSupply =
      pickNumber(tokenInfo, ["supply", "supply_raw", "mint_supply"]) ??
      pickNumber(pickNested(tokenInfo, ["supply_info"]), ["supply", "total_supply"]);
    const rawCirculating =
      pickNumber(tokenInfo, ["circulating_supply", "circulatingSupply"]) ??
      pickNumber(pickNested(tokenInfo, ["supply_info"]), ["circulating_supply", "circulatingSupply"]);

    const totalSupply = scaleAmount(rawSupply, decimals);
    const circulatingSupply = scaleAmount(rawCirculating, decimals) ?? totalSupply;
    const priceUsd =
      pickNumber(priceInfo, ["price_per_token", "pricePerToken", "price", "usd_price"]) ??
      pickNumber(tokenInfo, ["price_per_token", "pricePerToken", "price"]);
    const marketCapUsd =
      priceUsd !== null && circulatingSupply !== null ? Number((priceUsd * circulatingSupply).toFixed(6)) : null;
    const athUsd =
      pickNumber(priceInfo, ["ath", "all_time_high", "allTimeHigh", "athUsd"]) ??
      pickNumber(tokenInfo, ["ath", "all_time_high", "allTimeHigh", "athUsd"]) ??
      pickNumber(marketData, ["ath", "all_time_high", "allTimeHigh", "athUsd"]);

    return {
      mint: pickString(asset, ["id"]) ?? fallbackMint ?? "",
      symbol: pickString(tokenInfo, ["symbol"]) ?? pickString(metadata, ["symbol"]),
      name: pickString(metadata, ["name"]) ?? pickString(tokenInfo, ["name"]),
      decimals,
      marketCapUsd,
      priceUsd,
      circulatingSupply,
      totalSupply,
      athUsd
    };
  }

  async getTokenOverview(mint: string): Promise<HeliusTokenOverview> {
    const data = await this.rpc<Record<string, unknown>>("getAsset", { id: mint });
    return this.toOverview(data, mint);
  }

  async getTokenOverviewBatch(mints: string[]): Promise<HeliusTokenOverview[]> {
    if (mints.length === 0) {
      return [];
    }
    const assets = await this.rpc<unknown[]>("getAssetBatch", { ids: mints });
    return assets.map((asset, index) => this.toOverview(asset, mints[index]));
  }

  async getTokenHolders(params: {
    mint: string;
    topHolderLimit: number;
    pageLimit: number;
    maxPages: number;
    decimals: number | null;
    supplyUi: number | null;
  }): Promise<{ holders: HeliusTokenHolder[]; truncated: boolean; totalAccounts: number | null }> {
    const ownerBalances = new Map<string, number>();
    let totalAccounts: number | null = null;
    let fetchedAccounts = 0;

    for (let page = 1; page <= params.maxPages; page += 1) {
      const result = await this.rpc<{
        total?: number;
        token_accounts?: unknown[];
      }>("getTokenAccounts", {
        mint: params.mint,
        page,
        limit: params.pageLimit,
        options: { showZeroBalance: false }
      });

      const tokenAccounts = result.token_accounts ?? [];
      totalAccounts = result.total ?? totalAccounts;

      for (const row of tokenAccounts) {
        const owner = pickString(row, ["owner"]);
        const amountRaw = pickNumber(row, ["amount"]);
        if (!owner || amountRaw === null || amountRaw <= 0) {
          continue;
        }
        ownerBalances.set(owner, (ownerBalances.get(owner) ?? 0) + amountRaw);
        fetchedAccounts += 1;
      }

      if (tokenAccounts.length < params.pageLimit) {
        break;
      }
    }

    const holders = [...ownerBalances.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, params.topHolderLimit)
      .map(([owner, amountRaw], index) => {
        const uiAmount = scaleAmount(amountRaw, params.decimals) ?? amountRaw;
        const share = params.supplyUi && params.supplyUi > 0 ? uiAmount / params.supplyUi : 0;
        return { rank: index + 1, owner, uiAmount, share };
      });

    const truncated = totalAccounts !== null ? fetchedAccounts < totalAccounts : false;
    return { holders, truncated, totalAccounts };
  }

  async getWalletFungiblePositions(params: {
    ownerAddress: string;
    pageLimit: number;
    maxPages: number;
  }): Promise<HeliusWalletTokenPosition[]> {
    const positions: HeliusWalletTokenPosition[] = [];

    for (let page = 1; page <= params.maxPages; page += 1) {
      try {
        const result = await this.rpc<{ total?: number; items?: unknown[] }>("getAssetsByOwner", {
          ownerAddress: params.ownerAddress,
          page,
          limit: params.pageLimit,
          displayOptions: { showFungible: true }
        });

        const rows = result.items ?? [];
        for (const row of rows) {
          const position = this.parseFungibleAsset(row);
          if (position) {
            positions.push(position);
          }
        }

        const total = result.total ?? rows.length;
        if (page * params.pageLimit >= total || rows.length < params.pageLimit) {
          break;
        }
      } catch (error) {
        if (page === 1) {
          await this.loadWalletFallback(params.ownerAddress, params.pageLimit, positions);
          break;
        }
        throw error;
      }
    }

    return positions;
  }

  private parseFungibleAsset(item: unknown): HeliusWalletTokenPosition | null {
    const mint = pickString(item, ["id"]);
    const tokenInfo = pickNested(item, ["token_info"]);
    const metadata = pickNested(item, ["content", "metadata"]);
    const priceInfo = pickNested(tokenInfo, ["price_info"]);
    const decimals = pickNumber(tokenInfo, ["decimals"]);
    const rawBalance = pickNumber(tokenInfo, ["balance"]);
    const amountUi = scaleAmount(rawBalance, decimals);

    if (!mint || amountUi === null || amountUi <= 0) {
      return null;
    }

    const explicitUsdValue =
      pickNumber(tokenInfo, ["total_price"]) ?? pickNumber(priceInfo, ["total_price", "totalPrice"]);
    const pricePerToken =
      pickNumber(priceInfo, ["price_per_token", "pricePerToken", "price"]) ??
      pickNumber(tokenInfo, ["price_per_token", "pricePerToken", "price"]);

    return {
      mint,
      symbol: pickString(tokenInfo, ["symbol"]) ?? pickString(metadata, ["symbol"]),
      name: pickString(metadata, ["name"]) ?? pickString(tokenInfo, ["name"]),
      amountUi,
      usdValue: explicitUsdValue ?? (pricePerToken !== null ? Number((pricePerToken * amountUi).toFixed(6)) : null)
    };
  }

  private async loadWalletFallback(
    ownerAddress: string,
    pageLimit: number,
    out: HeliusWalletTokenPosition[]
  ): Promise<void> {
    const url = new URL(`/v1/wallet/${ownerAddress}/balances`, HELIUS_WALLET_API_URL);
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.set("showZeroBalance", "false");
    url.searchParams.set("showNativeBalance", "false");
    url.searchParams.set("showNfts", "false");

    const response = await fetch(url, {
      headers: { Accept: "application/json", "X-Api-Key": this.apiKey }
    });

    if (!response.ok) {
      return;
    }

    const payload = (await response.json().catch(() => null)) as { balances?: unknown[] } | null;
    for (const row of payload?.balances ?? []) {
      const mint = pickString(row, ["mint", "address", "assetId"]);
      const amountUi =
        pickNumber(row, ["balance", "amount", "uiAmount"]) ??
        scaleAmount(pickNumber(row, ["rawBalance", "amountRaw"]), pickNumber(row, ["decimals"]));
      if (!mint || amountUi === null || amountUi <= 0) {
        continue;
      }
      const explicitUsdValue = pickNumber(row, ["usdValue", "valueUsd", "totalUsdValue"]);
      const pricePerToken = pickNumber(row, ["pricePerToken", "price", "priceUsd"]);
      out.push({
        mint,
        symbol: pickString(row, ["symbol"]),
        name: pickString(row, ["name"]),
        amountUi,
        usdValue: explicitUsdValue ?? (pricePerToken !== null ? Number((pricePerToken * amountUi).toFixed(6)) : null)
      });
    }
  }
}
