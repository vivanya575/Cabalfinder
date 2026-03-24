"use client";

import { type FormEvent, useEffect, useState, useTransition } from "react";
import { launchProtocols, liquidityProtocols, providerNames, queueNames, v2Defaults } from "@cabalfinder/shared";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

const capabilities = [
  {
    title: "Helius DAS + RPC",
    detail: "Use getAsset, getAssetBatch, and getTokenAccounts to discover token metadata, compute market cap from supply and price, and derive holder groups from indexed token accounts."
  },
  {
    title: "Helius Wallet API",
    detail: "Pull wallet balances with USD context for each top holder so the active scan can rank real co-held assets without a paid market-data dependency."
  },
  {
    title: "Helius MCP",
    detail: "Keep the stack agent-ready: MCP tooling gives you wallet analysis, docs lookup, RPC helpers, and Helius-native workflows for future automation."
  }
] as const;

const controlFlows = [
  {
    label: "1",
    title: "Index Top Holders",
    body: "For a scanned mint, Helius getTokenAccounts becomes the source of truth for holder discovery. We aggregate token accounts by owner and rank the resulting wallet group."
  },
  {
    label: "2",
    title: "Expand Wallet Positions",
    body: "Each holder wallet is enriched through the Helius Wallet API so we can see which fungible tokens the group actually holds and how much USD sits in each position."
  },
  {
    label: "3",
    title: "Score Control Clusters",
    body: "Candidate tokens are filtered above the market-cap floor, scored by supply control, overlap count, and aggregate USD held, then returned with copy-ready contract addresses."
  }
] as const;

type StatusResponse = {
  ok: boolean;
  thresholds: {
    trackingMarketCapMinUsd: number;
    activeScanMarketCapMinUsd: number;
    alertControlThreshold: number;
    topHolderLimit: number;
  };
  providers: Record<string, boolean>;
  heliusTuning: {
    holderPageLimit: number;
    maxHolderPages: number;
    walletPageLimit: number;
    maxWalletPages: number;
  };
};

type ScanResponse = {
  ok: boolean;
  error?: string;
  scanRunId: string;
  sourceToken: {
    mint: string;
    symbol?: string;
    name?: string;
    marketCapUsd?: number | null;
    athUsd?: number | null;
  };
  results: Array<{
    mint: string;
    ca: string;
    symbol?: string;
    name?: string;
    marketCapUsd: number;
    athUsd?: number | null;
    overlapHolderCount: number;
    totalUsdHeld: number;
    controlPct: number;
    score: number;
    scoreBreakdown: {
      normalizedControlPct: number;
      normalizedTotalUsdHeld: number;
      normalizedOverlapCount: number;
      finalScore: number;
    };
  }>;
  summary: {
    scannedHolderCount: number;
    returnedResultCount: number;
    eligibleResultCount: number;
    topHolderLimit: number;
    marketCapFloorUsd: number;
    copyCAs: string;
  };
  warnings: string[];
};

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1_000_000 ? 0 : 2
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

function shortAddress(value: string): string {
  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export default function HomePage() {
  const [mint, setMint] = useState("");
  const [scanLookupId, setScanLookupId] = useState("");
  const [scanResponse, setScanResponse] = useState<ScanResponse | null>(null);
  const [statusResponse, setStatusResponse] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      try {
        const response = await fetch(`${API_BASE}/v1/system/status`, { cache: "no-store" });
        const payload = (await response.json()) as StatusResponse & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Could not load Helius system status.");
        }

        if (!cancelled) {
          startTransition(() => {
            setStatusResponse(payload);
            setStatusError(null);
          });
        }
      } catch (error) {
        if (!cancelled) {
          setStatusError(error instanceof Error ? error.message : "Could not load Helius system status.");
        }
      }
    }

    void loadStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleScanSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setScanError(null);
    setCopiedLabel(null);

    try {
      const response = await fetch(`${API_BASE}/v1/scans/active`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          mint,
          topResults: 10
        })
      });

      const payload = (await response.json()) as ScanResponse & { error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "Helius scan failed.");
      }

      startTransition(() => {
        setScanResponse(payload);
        setScanLookupId(payload.scanRunId);
        setScanError(null);
      });
    } catch (error) {
      setScanResponse(null);
      setScanError(error instanceof Error ? error.message : "Helius scan failed.");
    }
  }

  async function handleScanLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setScanError(null);
    setCopiedLabel(null);

    const lookupId = scanLookupId.trim();
    if (!lookupId) {
      setScanError("Enter a scanRunId to load persisted results.");
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/v1/scans/active/${lookupId}`, {
        method: "GET",
        cache: "no-store"
      });

      const payload = (await response.json()) as ScanResponse & { error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "Could not load scan by id.");
      }

      startTransition(() => {
        setScanResponse(payload);
        setScanLookupId(payload.scanRunId);
        setScanError(null);
      });
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "Could not load scan by id.");
    }
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedLabel(label);
      window.setTimeout(() => setCopiedLabel(null), 1600);
    } catch {
      setCopiedLabel("Clipboard unavailable");
      window.setTimeout(() => setCopiedLabel(null), 1600);
    }
  }

  return (
    <main className="helius-shell">
      <div className="helius-orbit helius-orbit-a" />
      <div className="helius-orbit helius-orbit-b" />

      <section className="hero-grid">
        <div className="hero-copy panel">
          <p className="eyebrow">Helius-native Solana Intelligence</p>
          <h1 className="hero-title">CABALFINDER SIGNAL DESK</h1>
          <p className="hero-body">
            Rebuilt around Helius DAS, RPC, Wallet API, and MCP so the scanner works on a free-tier-compatible data spine and is ready
            for agent-driven research workflows.
          </p>

          <div className="hero-metrics">
            <MetricCard label="Tracking Floor" value={`$${v2Defaults.trackingMarketCapMinUsd.toLocaleString()}`} />
            <MetricCard label="Scan Floor" value={`$${v2Defaults.activeScanMarketCapMinUsd.toLocaleString()}`} />
            <MetricCard label="Alert Trigger" value={`${(v2Defaults.controlAlertThresholdPct * 100).toFixed(0)}%`} />
          </div>

          <div className="hero-pills">
            <span>Wallet clusters</span>
            <span>Top-50 holder groups</span>
            <span>Helius MCP aware</span>
            <span>Copy-ready CAs</span>
          </div>

          <div className="hero-links">
            <a href="https://www.helius.dev/agents" target="_blank" rel="noreferrer">
              Helius for Agents
            </a>
            <a href="https://www.helius.dev/docs/agents/mcp/tools" target="_blank" rel="noreferrer">
              MCP Tool Catalog
            </a>
            <a href="https://www.helius.dev/docs/billing/rate-limits" target="_blank" rel="noreferrer">
              Free-tier Limits
            </a>
          </div>
        </div>

        <div className="scan-panel panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Live Active Scan</p>
              <h2>Paste any Solana mint</h2>
            </div>
            <div className="status-chip">{isPending ? "Running" : "Ready"}</div>
          </div>

          <form className="scan-form" onSubmit={handleScanSubmit}>
            <label className="sr-only" htmlFor="mint">
              Token mint
            </label>
            <input
              id="mint"
              name="mint"
              placeholder="Enter token CA / mint"
              value={mint}
              onChange={(event) => setMint(event.target.value)}
              autoComplete="off"
            />
            <button type="submit" disabled={isPending || mint.trim().length === 0}>
              {isPending ? "Scanning..." : "Run Helius Scan"}
            </button>
          </form>

          <div className="scan-meta">
            <span>Endpoint: `/v1/scans/active`</span>
            <span>Lookup: `/v1/scans/active/:scanRunId`</span>
          </div>

          <form className="scan-form lookup-form" onSubmit={handleScanLookup}>
            <label className="sr-only" htmlFor="scanLookupId">
              Scan run id lookup
            </label>
            <input
              id="scanLookupId"
              name="scanLookupId"
              placeholder="Load a persisted scanRunId"
              value={scanLookupId}
              onChange={(event) => setScanLookupId(event.target.value)}
              autoComplete="off"
            />
            <button type="submit" disabled={isPending || scanLookupId.trim().length === 0}>
              {isPending ? "Loading..." : "Load by ID"}
            </button>
          </form>

          {scanError ? <p className="error-banner">{scanError}</p> : null}
          {copiedLabel ? <p className="copy-banner">{copiedLabel}</p> : null}

          {scanResponse ? (
            <div className="scan-results">
              <div className="result-summary">
                <div>
                  <p className="result-kicker">Scan run</p>
                  <strong>{scanResponse.scanRunId}</strong>
                </div>
                <div>
                  <p className="result-kicker">Source token</p>
                  <strong>{scanResponse.sourceToken.symbol ?? shortAddress(scanResponse.sourceToken.mint)}</strong>
                </div>
                <div>
                  <p className="result-kicker">Scanned holders</p>
                  <strong>{scanResponse.summary.scannedHolderCount}</strong>
                </div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => copyText(scanResponse.summary.copyCAs, "Copied all CAs")}
                >
                  Copy all CAs
                </button>
              </div>

              {scanResponse.warnings.length > 0 ? (
                <div className="warning-stack">
                  {scanResponse.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}

              <div className="results-grid">
                {scanResponse.results.map((result, index) => (
                  <article key={result.mint} className="result-card">
                    <div className="result-head">
                      <span className="result-rank">{String(index + 1).padStart(2, "0")}</span>
                      <button className="ghost-button" type="button" onClick={() => copyText(result.ca, `Copied ${result.ca}`)}>
                        Copy CA
                      </button>
                    </div>
                    <h3>{result.symbol ?? shortAddress(result.mint)}</h3>
                    <p className="result-name">{result.name ?? "Unnamed token"}</p>
                    <dl>
                      <MetricRow label="CA" value={shortAddress(result.ca)} mono />
                      <MetricRow label="Market cap" value={formatUsd(result.marketCapUsd)} />
                      <MetricRow label="Group USD" value={formatUsd(result.totalUsdHeld)} />
                      <MetricRow label="Control" value={formatPercent(result.controlPct)} />
                      <MetricRow label="Overlap" value={String(result.overlapHolderCount)} />
                      <MetricRow label="ATH" value={result.athUsd === null ? "N/A" : formatUsd(result.athUsd)} />
                      <MetricRow label="Score" value={result.score.toFixed(3)} />
                    </dl>
                  </article>
                ))}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <p className="empty-title">No scan loaded yet.</p>
              <p>
                The Helius-first active scan pulls top holders, expands each wallet through Wallet API balances, then ranks the strongest
                co-held tokens above the live market-cap floor.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="info-grid">
        <div className="panel span-two">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Why Helius</p>
              <h2>One provider stack instead of paid market-data fragmentation</h2>
            </div>
          </div>
          <div className="card-grid">
            {capabilities.map((item) => (
              <article key={item.title} className="info-card">
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">System State</p>
              <h2>Provider readiness</h2>
            </div>
          </div>

          {statusResponse ? (
            <>
              <div className="provider-list">
                {Object.entries(statusResponse.providers).map(([provider, available]) => (
                  <div key={provider} className="provider-row">
                    <span>{provider}</span>
                    <strong>{available ? "Configured" : "Missing"}</strong>
                  </div>
                ))}
              </div>
              <div className="tuning-block">
                <MetricRow label="Holder page size" value={String(statusResponse.heliusTuning.holderPageLimit)} />
                <MetricRow label="Holder page cap" value={String(statusResponse.heliusTuning.maxHolderPages)} />
                <MetricRow label="Wallet page size" value={String(statusResponse.heliusTuning.walletPageLimit)} />
                <MetricRow label="Wallet page cap" value={String(statusResponse.heliusTuning.maxWalletPages)} />
              </div>
            </>
          ) : (
            <p className="muted-copy">{statusError ?? "Loading Helius system status..."}</p>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Signal Pipeline</p>
            <h2>How the intelligence loop works</h2>
          </div>
        </div>
        <div className="flow-grid">
          {controlFlows.map((item) => (
            <article key={item.label} className="flow-card">
              <span className="flow-label">{item.label}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="info-grid">
        <div className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Protocol Surface</p>
              <h2>Launch and liquidity context</h2>
            </div>
          </div>
          <div className="tag-cloud">
            {launchProtocols.map((protocol) => (
              <span key={protocol}>{protocol.replaceAll("_", " ")}</span>
            ))}
          </div>
          <div className="tag-cloud secondary">
            {liquidityProtocols.map((protocol) => (
              <span key={protocol}>{protocol.replaceAll("_", " ")}</span>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Runtime Backbone</p>
              <h2>Queues and services</h2>
            </div>
          </div>
          <div className="tag-cloud">
            {Object.values(queueNames).map((queue) => (
              <span key={queue}>{queue}</span>
            ))}
          </div>
          <div className="stack-block">
            <MetricRow label="Primary data plane" value={providerNames.helius} />
            <MetricRow label="Wallet expansion" value={providerNames.heliusWallet} />
            <MetricRow label="Agent tooling" value={providerNames.heliusMcp} />
            <MetricRow label="Persistence" value={providerNames.postgres} />
          </div>
        </div>
      </section>
    </main>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MetricRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="metric-row">
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined}>{value}</strong>
    </div>
  );
}
