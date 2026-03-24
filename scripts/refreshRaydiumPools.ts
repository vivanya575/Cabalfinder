import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, loadTokenList } from "../src/config.js";
import type { PoolConfig } from "../src/types.js";

const RAYDIUM_API_BASE = "https://api-v3.raydium.io";

interface RaydiumMintRef {
  address: string;
  symbol?: string;
  name?: string;
}

interface RaydiumPoolInfo {
  id: string;
  tvl?: number;
  mintA: RaydiumMintRef;
  mintB: RaydiumMintRef;
}

interface RaydiumPoolKey {
  id: string;
  mintA: RaydiumMintRef;
  mintB: RaydiumMintRef;
  vault: {
    A: string;
    B: string;
  };
  programId: string;
}

function parseArgs(argv: string[]): { outputPath?: string } {
  let outputPath: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
    }
  }

  return { outputPath };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Raydium API HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

async function fetchBestPoolId(baseMint: string, quoteMint: string): Promise<RaydiumPoolInfo | null> {
  const url = new URL(`${RAYDIUM_API_BASE}/pools/info/mint`);
  url.searchParams.set("mint1", baseMint);
  url.searchParams.set("mint2", quoteMint);
  url.searchParams.set("poolType", "all");
  url.searchParams.set("poolSortField", "default");
  url.searchParams.set("sortType", "desc");
  url.searchParams.set("pageSize", "5");
  url.searchParams.set("page", "1");

  const payload = await fetchJson<{ success: boolean; data?: { data?: RaydiumPoolInfo[] } }>(url.toString());
  const candidates = payload.data?.data ?? [];
  if (!payload.success || candidates.length === 0) {
    return null;
  }

  return candidates.sort((a, b) => Number(b.tvl ?? 0) - Number(a.tvl ?? 0))[0] ?? null;
}

async function fetchPoolKeys(ids: string[]): Promise<RaydiumPoolKey[]> {
  if (ids.length === 0) {
    return [];
  }

  const url = new URL(`${RAYDIUM_API_BASE}/pools/key/ids`);
  url.searchParams.set("ids", ids.join(","));
  const payload = await fetchJson<{ success: boolean; data?: RaydiumPoolKey[] }>(url.toString());
  if (!payload.success) {
    throw new Error(`Raydium API rejected pool key lookup for ids=${ids.join(",")}`);
  }
  return payload.data ?? [];
}

async function main(): Promise<void> {
  const { outputPath } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const tokens = await loadTokenList(config.tokenListPath);
  const poolPath = path.resolve(outputPath ?? config.poolListPath);

  const stableReferenceMint = [...config.stableMints][0];
  const referencePool = await fetchBestPoolId(config.wsolMint, stableReferenceMint);
  if (!referencePool) {
    throw new Error(`Unable to discover a live reference pool for ${config.wsolMint}/${stableReferenceMint}`);
  }

  const pairRequests: Array<Promise<RaydiumPoolInfo | null>> = [];

  for (const token of tokens) {
    if (token.mint === config.wsolMint || config.stableMints.has(token.mint)) {
      continue;
    }
    for (const quoteMint of [...config.stableMints, config.wsolMint]) {
      pairRequests.push(fetchBestPoolId(token.mint, quoteMint));
    }
  }

  const discovered = [referencePool, ...((await Promise.all(pairRequests)).filter(Boolean) as RaydiumPoolInfo[])];
  const uniquePoolIds = [...new Set(discovered.map((pool) => pool.id))];
  const poolKeys = await fetchPoolKeys(uniquePoolIds);

  const pools: PoolConfig[] = poolKeys.map((pool) => ({
    id: pool.id === referencePool.id ? config.solUsdReferencePoolId : pool.id,
    dex: `raydium:${pool.programId}`,
    baseMint: pool.mintA.address,
    quoteMint: pool.mintB.address,
    baseVault: pool.vault.A,
    quoteVault: pool.vault.B
  }));

  await fs.writeFile(poolPath, `${JSON.stringify(pools, null, 2)}\n`, "utf8");
  console.log(`Wrote ${pools.length} live pools to ${poolPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
