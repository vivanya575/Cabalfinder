import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config.js";

const DEFAULT_SCAN_MINT = "3H87g2Zd3T4TNfpnxHqN6e83xp8Avip1tx8Xv3j1pump";
const DEFAULT_PORT = 8788;
const STARTUP_TIMEOUT_MS = 45_000;

interface DashboardStateResponse {
  ok: boolean;
  state?: {
    tokens: Array<{ mint: string; symbol?: string; name?: string }>;
    warnings?: string[];
  };
  error?: string;
}

interface ScanResponse {
  ok: boolean;
  rows?: unknown[];
  error?: string;
}

function parseArgs(argv: string[]): {
  baseUrl?: string;
  port: number;
  scanMint: string;
  runMutations: boolean;
} {
  let baseUrl: string | undefined;
  let port = Number(process.env.LIVE_WEB_PORT ?? String(DEFAULT_PORT));
  let scanMint = process.env.LIVE_SCAN_MINT?.trim() || DEFAULT_SCAN_MINT;
  let runMutations = process.env.LIVE_MUTATION_TESTS === "1";

  for (const arg of argv) {
    if (arg === "--mutations") {
      runMutations = true;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
      continue;
    }
    if (arg.startsWith("--mint=")) {
      scanMint = arg.slice("--mint=".length).trim() || scanMint;
    }
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid port: ${port}`);
  }

  return { baseUrl, port, scanMint, runMutations };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

async function waitForDashboard(baseUrl: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "dashboard did not start";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/state`);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(1000);
  }

  throw new Error(`Timed out waiting for dashboard at ${baseUrl}: ${lastError}`);
}

async function preflightRpc(): Promise<void> {
  const config = loadConfig();
  const response = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getHealth",
      params: []
    })
  });

  if (!response.ok) {
    throw new Error(`RPC preflight failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { result?: string; error?: { message?: string } };
  if (payload.error) {
    throw new Error(`RPC preflight failed: ${payload.error.message ?? "unknown error"}`);
  }

  if (payload.result !== "ok") {
    throw new Error(`RPC preflight returned unexpected result: ${String(payload.result)}`);
  }
}

async function main(): Promise<void> {
  const { baseUrl: providedBaseUrl, port, scanMint, runMutations } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const baseUrl = providedBaseUrl ?? `http://127.0.0.1:${port}`;

  console.log(`Using live RPC: ${config.rpcUrl}`);
  console.log(`Using live scan mint: ${scanMint}`);
  console.log(`Mutation tests: ${runMutations ? "enabled" : "disabled"}`);

  let serverProcess: ReturnType<typeof spawn> | null = null;
  if (!providedBaseUrl) {
    await preflightRpc();
    serverProcess = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", "src/index.ts", "web", String(port)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      }
    );

    serverProcess.stdout?.on("data", (chunk) => {
      process.stdout.write(`[dashboard] ${chunk}`);
    });
    serverProcess.stderr?.on("data", (chunk) => {
      process.stderr.write(`[dashboard] ${chunk}`);
    });
  } else {
    console.log("Skipping local RPC preflight because --base-url targets an existing dashboard.");
  }

  try {
    await waitForDashboard(baseUrl);

    const homeResponse = await fetch(`${baseUrl}/`);
    if (!homeResponse.ok) {
      throw new Error(`Dashboard home page failed with HTTP ${homeResponse.status}`);
    }
    console.log(`PASS / -> HTTP ${homeResponse.status}`);

    const stateResponse = await fetchJson<DashboardStateResponse>(`${baseUrl}/api/state`);
    if (stateResponse.status !== 200 || !stateResponse.body.ok || !stateResponse.body.state) {
      throw new Error(`Dashboard state failed: ${JSON.stringify(stateResponse.body)}`);
    }
    console.log(`PASS /api/state -> ${stateResponse.body.state.tokens.length} configured tokens`);
    if ((stateResponse.body.state.warnings ?? []).length > 0) {
      console.log(`WARN operator warnings: ${(stateResponse.body.state.warnings ?? []).join(" | ")}`);
    }

    const invalidScan = await fetchJson<ScanResponse>(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mint: "not-a-valid-solana-mint" })
    });
    if (invalidScan.status !== 400) {
      throw new Error(`Invalid scan should return 400, received ${invalidScan.status}`);
    }
    console.log("PASS /api/scan rejects invalid mint");

    const liveScan = await fetchJson<ScanResponse>(`${baseUrl}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mint: scanMint })
    });
    if (liveScan.status !== 200 || !liveScan.body.ok || !Array.isArray(liveScan.body.rows)) {
      throw new Error(`Live scan failed: ${JSON.stringify(liveScan.body)}`);
    }
    console.log(`PASS /api/scan live mint -> ${liveScan.body.rows.length} qualifying rows`);

    if (runMutations) {
      const snapshot = await fetchJson<{ ok: boolean; message?: string; error?: string }>(`${baseUrl}/api/run/snapshot`, {
        method: "POST"
      });
      if (snapshot.status !== 200 || !snapshot.body.ok) {
        throw new Error(`Snapshot failed: ${JSON.stringify(snapshot.body)}`);
      }
      console.log("PASS /api/run/snapshot");

      if (stateResponse.body.state.tokens.length >= 2) {
        const correlate = await fetchJson<{ ok: boolean; result?: { rows: number; alerts: number }; error?: string }>(
          `${baseUrl}/api/run/correlate`,
          { method: "POST" }
        );
        if (correlate.status !== 200 || !correlate.body.ok || !correlate.body.result) {
          throw new Error(`Correlate failed: ${JSON.stringify(correlate.body)}`);
        }
        console.log(`PASS /api/run/correlate -> rows=${correlate.body.result.rows}, alerts=${correlate.body.result.alerts}`);
      } else {
        console.log("SKIP /api/run/correlate because fewer than 2 tokens are configured");
      }
    } else {
      console.log("SKIP mutation endpoints; rerun with --mutations to exercise snapshot/correlation on live data");
    }
  } finally {
    if (serverProcess) {
      serverProcess.kill("SIGINT");
      await delay(500);
      if (!serverProcess.killed) {
        serverProcess.kill("SIGTERM");
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
