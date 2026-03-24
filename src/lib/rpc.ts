import bs58 from "bs58";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_PROGRAM_IDS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] as const;

type JsonRpcParams = Record<string, unknown> | unknown[];

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface ProgramAccount {
  pubkey: string;
  account: {
    data: [string, string];
  };
}

interface MaybeProgramAccount {
  data: [string, string] | string | null;
}

interface ParsedTokenAmount {
  uiAmount?: number | null;
  uiAmountString?: string;
}

interface ParsedTokenAccountInfo {
  mint?: string;
  tokenAmount?: ParsedTokenAmount;
}

interface ParsedProgramAccount {
  account: {
    data?: {
      parsed?: {
        info?: ParsedTokenAccountInfo;
      };
    };
  };
}

interface LargestTokenAccount {
  address: string;
}

interface ParsedTokenBalance {
  amount: string;
  decimals: number;
  uiAmountString?: string;
}

export interface TokenAccountOwnerBalance {
  mint: string;
  owner: string;
  amountRaw: bigint;
}

export class SolanaRpcClient {
  private readonly mintProgramCache = new Map<string, string>();

  constructor(
    private readonly rpcUrl: string,
    private readonly requestTimeoutMs = 20_000
  ) {}

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private retryDelayMs(attempt: number): number {
    const base = 350;
    const max = 3_500;
    return Math.min(base * 2 ** attempt, max);
  }

  private async callRpc<T>(method: string, params: JsonRpcParams): Promise<T> {
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const res = await fetch(this.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });

        if (!res.ok) {
          if (res.status === 429 && attempt < maxAttempts - 1) {
            const retryAfter = Number(res.headers.get("retry-after") ?? "0");
            const backoff = retryAfter > 0 ? retryAfter * 1000 : this.retryDelayMs(attempt);
            await this.sleep(backoff);
            continue;
          }
          throw new Error(`RPC HTTP ${res.status} for ${method}`);
        }

        const payload = (await res.json()) as JsonRpcResponse<T>;
        if (payload.error) {
          const shouldRetry = payload.error.code === -32005 || /rate|limit|too many/i.test(payload.error.message);
          if (shouldRetry && attempt < maxAttempts - 1) {
            await this.sleep(this.retryDelayMs(attempt));
            continue;
          }
          throw new Error(`RPC ${method} failed: ${payload.error.message}`);
        }

        if (payload.result === undefined) {
          throw new Error(`RPC ${method} returned empty result`);
        }
        return payload.result;
      } catch (error) {
        if (attempt >= maxAttempts - 1) {
          throw error;
        }
        await this.sleep(this.retryDelayMs(attempt));
      }
    }

    throw new Error(`RPC ${method} failed after retries`);
  }

  async getTokenSupplyUi(mint: string): Promise<number> {
    const result = await this.callRpc<{ value: ParsedTokenBalance }>("getTokenSupply", [mint, { commitment: "confirmed" }]);
    const uiAmount = Number(result.value.uiAmountString ?? "0");
    return Number.isFinite(uiAmount) ? uiAmount : 0;
  }

  async getMintProgramId(mint: string): Promise<string> {
    const cached = this.mintProgramCache.get(mint);
    if (cached) {
      return cached;
    }

    const result = await this.callRpc<{ value: { owner: string } | null }>("getAccountInfo", [
      mint,
      {
        commitment: "confirmed",
        encoding: "base64",
        dataSlice: { offset: 0, length: 0 }
      }
    ]);

    const owner = result.value?.owner;
    if (!owner || !TOKEN_PROGRAM_IDS.includes(owner as (typeof TOKEN_PROGRAM_IDS)[number])) {
      throw new Error(`Unsupported token program for mint ${mint}: ${owner ?? "unknown owner"}`);
    }

    this.mintProgramCache.set(mint, owner);
    return owner;
  }

  async getTokenAccountBalanceUi(tokenAccount: string): Promise<number> {
    const result = await this.callRpc<{ value: ParsedTokenBalance }>("getTokenAccountBalance", [tokenAccount, { commitment: "confirmed" }]);
    const raw = result.value.uiAmountString ?? "0";
    const balance = Number(raw);
    return Number.isFinite(balance) ? balance : 0;
  }

  async getTopHoldersByMint(mint: string): Promise<TokenAccountOwnerBalance[]> {
    const programId = await this.getMintProgramId(mint);
    const filters: Array<Record<string, unknown>> = [{ memcmp: { offset: 0, bytes: mint } }];
    if (programId === TOKEN_PROGRAM_ID) {
      filters.unshift({ dataSize: 165 });
    }

    let accounts: ProgramAccount[];
    try {
      accounts = await this.callRpc<ProgramAccount[]>("getProgramAccounts", [
        programId,
        {
          commitment: "confirmed",
          encoding: "base64",
          dataSlice: { offset: 32, length: 40 },
          filters
        }
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (programId === TOKEN_2022_PROGRAM_ID && /secondary indexes|unavailable for key/i.test(message)) {
        return this.getLargestTokenAccountsByMint(mint);
      }
      throw error;
    }

    const rows: TokenAccountOwnerBalance[] = [];
    for (const account of accounts) {
      const row = this.parseOwnerBalanceAccountData(mint, account.account.data);
      if (row) {
        rows.push(row);
      }
    }

    return rows;
  }

  private parseOwnerBalanceAccountData(mint: string, data: [string, string] | string | null): TokenAccountOwnerBalance | null {
    if (!Array.isArray(data)) {
      return null;
    }

    const bytes = Buffer.from(data[0], "base64");
    if (bytes.length < 40) {
      return null;
    }

    const owner = bs58.encode(bytes.subarray(0, 32));
    const amountRaw = bytes.readBigUInt64LE(32);
    if (amountRaw === 0n) {
      return null;
    }

    return { mint, owner, amountRaw };
  }

  private async getLargestTokenAccountsByMint(mint: string): Promise<TokenAccountOwnerBalance[]> {
    const largest = await this.callRpc<{ value: LargestTokenAccount[] }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    const addresses = largest.value.map((row) => row.address).filter(Boolean);
    if (addresses.length === 0) {
      return [];
    }

    const details = await this.callRpc<{ value: Array<MaybeProgramAccount | null> }>("getMultipleAccounts", [
      addresses,
      {
        commitment: "confirmed",
        encoding: "base64",
        dataSlice: { offset: 32, length: 40 }
      }
    ]);

    const rows: TokenAccountOwnerBalance[] = [];
    for (const account of details.value) {
      const row = this.parseOwnerBalanceAccountData(mint, account?.data ?? null);
      if (row) {
        rows.push(row);
      }
    }
    return rows;
  }

  async getTokenBalancesUiByOwner(owner: string): Promise<Map<string, number>> {
    const results = await Promise.all(
      TOKEN_PROGRAM_IDS.map((programId) =>
        this.callRpc<{ value: ParsedProgramAccount[] }>("getTokenAccountsByOwner", [
          owner,
          { programId },
          {
            commitment: "confirmed",
            encoding: "jsonParsed"
          }
        ])
      )
    );

    const balances = new Map<string, number>();
    for (const result of results) {
      for (const account of result.value) {
        const info = account.account.data?.parsed?.info;
        const mint = info?.mint;
        if (!mint) {
          continue;
        }

        const rawAmount = info.tokenAmount?.uiAmountString ?? info.tokenAmount?.uiAmount ?? 0;
        const amountUi = Number(rawAmount);
        if (!Number.isFinite(amountUi) || amountUi <= 0) {
          continue;
        }

        const prev = balances.get(mint) ?? 0;
        balances.set(mint, prev + amountUi);
      }
    }

    return balances;
  }

  async getMintDecimals(mint: string): Promise<number> {
    const result = await this.callRpc<{ value: { data: [string, string] | string | null } | null }>("getAccountInfo", [
      mint,
      {
        commitment: "confirmed",
        encoding: "base64",
        dataSlice: { offset: 44, length: 1 }
      }
    ]);
    const data = result.value?.data;
    if (!Array.isArray(data)) {
      throw new Error(`Mint account ${mint} not found`);
    }
    const bytes = Buffer.from(data[0], "base64");
    if (bytes.length < 1) {
      throw new Error(`Mint account ${mint} has invalid size`);
    }
    return bytes.readUInt8(0);
  }
}
