export type MintAddress = string;
export type WalletAddress = string;

export interface TokenConfig {
  mint: MintAddress;
  symbol?: string;
  name?: string;
}

export interface PoolConfig {
  id: string;
  dex: string;
  baseMint: MintAddress;
  quoteMint: MintAddress;
  baseVault: string;
  quoteVault: string;
}

export interface HolderBalance {
  owner: WalletAddress;
  amountRaw: bigint;
  amountUi: number;
}

export interface HolderSnapshot {
  tokenMint: MintAddress;
  snapshotTime: string;
  supplyUi: number;
  holders: Array<{
    rank: number;
    owner: WalletAddress;
    amountUi: number;
    share: number;
  }>;
}

export interface PriceQuote {
  mint: MintAddress;
  priceUsd: number;
  quoteLiquidityUsd: number;
  sourcePoolId: string;
}

export interface ControlRow {
  tokenA: MintAddress;
  tokenB: MintAddress;
  snapshotTime: string;
  control: number;
}

export interface AlertEvent {
  tokenA: MintAddress;
  tokenB: MintAddress;
  snapshotTime: string;
  prevControl: number;
  control: number;
  contributors: Array<{ owner: WalletAddress; amountUi: number }>;
}
