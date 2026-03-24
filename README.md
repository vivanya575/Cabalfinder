# Cabalfinder

For the approved V2 redesign plan, see [docs/V2_SOLANA_HOLDER_INTELLIGENCE_PLAN.md](docs/V2_SOLANA_HOLDER_INTELLIGENCE_PLAN.md).

## V2 Scaffold

The new implementation foundation lives in:

- [apps/web](apps/web)
- [apps/api](apps/api)
- [apps/worker](apps/worker)
- [packages/shared](packages/shared)
- [infra/docker-compose.v2.yml](infra/docker-compose.v2.yml)

Install dependencies:

```bash
npm install
```

Fastest local startup (API + web, infra auto-start):

```bash
npm run dev:v2
```

### One-click launch (macOS)

If you do not want to run terminal commands manually, use the clickable launcher files in the repo root:

- `Start Cabalfinder.command` (API + web)
- `Start Cabalfinder Full.command` (API + worker + web)
- `Stop Cabalfinder.command` (stop launched services; also stops local Docker infra if available)

Double-click these in Finder. They run services in the background, write logs to `.run/logs`, and open the app at `http://localhost:3000`.

If you see "docker: command not found":

- Install Docker Desktop (or Colima + docker CLI), then rerun `npm run dev:v2`.
- If you already have external Postgres/Redis, run without local infra:

```bash
npm run dev:v2:no-infra
```

Manual options:

- Bring up local infrastructure:

```bash
npm run infra:up
```

- Run API + web together (no worker):

```bash
npm run dev:v2:ui
```

- Run full V2 services (API + worker + web):

```bash
npm run dev:v2:full
```

- Run individual services:

```bash
npm run dev:api
npm run dev:worker
npm run dev:web
npm run dev:mcp
```

When done, stop local infrastructure:

```bash
npm run infra:down
```

Helius MCP setup details live in [docs/MCP_SETUP.md](docs/MCP_SETUP.md).

Check the scaffold:

```bash
npm run check:v2
```

## V2 API Routes

### Health and status

```bash
GET  /healthz                  # liveness probe
GET  /v1/system/status         # configuration, thresholds, queue names, and provider flags
```

### Active scan

Validates a mint, fetches top-50 holders from Helius, enriches each holder's fungible positions, computes co-held token overlap, ranks results, and persists everything in PostgreSQL.

```bash
# Run a new active scan
curl -X POST http://localhost:4000/v1/scans/active \
  -H 'content-type: application/json' \
  -d '{"mint":"So11111111111111111111111111111111111111112","topResults":10}'

# Fetch a persisted scan by id
curl http://localhost:4000/v1/scans/active/<SCAN_RUN_ID>
```

### Alerts

Paginated list of threshold-crossing control-edge alerts with resolved token metadata.

```bash
GET /v1/alerts?limit=25&offset=0
```

Response fields: `id`, `triggeredAt`, `supplyControlPct`, `previousControlPct`, `overlapWalletCount`, `totalUsdHeld`, `topContributors`, `telegramDelivered`, `sourceToken`, `targetToken`.

### Universe

Tokens currently tracked (market cap above the configured floor), ordered by market cap descending.

```bash
GET /v1/universe?limit=50&offset=0&minMarketCap=10000
```

### Score preview

Compute the weighted ranking score for a set of inputs without running a full scan.

```bash
curl -X POST http://localhost:4000/v1/scoring/active-scan \
  -H 'content-type: application/json' \
  -d '{"controlPct":0.3,"totalUsdHeld":50000,"overlapCount":12,"maxControlPct":1,"maxTotalUsdHeld":500000,"maxOverlapCount":50}'
```

### Job triggers

Manually enqueue background jobs without needing direct Redis access.

```bash
# Refresh market data for specific mints
curl -X POST http://localhost:4000/v1/jobs/universe-refresh \
  -H 'content-type: application/json' \
  -d '{"mints":["So11111111111111111111111111111111111111112"]}'

# Snapshot top holders for a specific mint
curl -X POST http://localhost:4000/v1/jobs/holder-snapshot \
  -H 'content-type: application/json' \
  -d '{"mint":"So11111111111111111111111111111111111111112"}'

# Run cross-control computation for a source mint
curl -X POST http://localhost:4000/v1/jobs/control-computation \
  -H 'content-type: application/json' \
  -d '{"sourceMint":"So11111111111111111111111111111111111111112"}'
```

## V2 Worker

The worker process subscribes to five BullMQ queues and processes jobs in parallel.

| Queue | Payload | What it does |
|---|---|---|
| `token-universe-refresh` | `{ mints: string[] }` | Helius batch-fetch → upsert tokens above the tracking market-cap floor |
| `holder-snapshot` | `{ mint: string }` | Fetch top-N holders from Helius and persist snapshots |
| `control-computation` | `{ sourceMint: string; targetMints?: string[] }` | Cross-reference wallet positions, write control edges, trigger alerts |
| `alert-delivery` | alert payload | Broadcast Telegram message, mark delivery status |
| `active-scan` | `{ mint: string; topResults?: number }` | Full holder-enrichment + scoring pipeline |

### Automatic scheduling

The worker periodically re-enqueues `holder-snapshot` and `token-universe-refresh` jobs for all tokens already stored in the database.

Two env vars control the intervals:

- `SNAPSHOT_INTERVAL_MS` — how often to enqueue new holder snapshots (default: 15 minutes)
- `UNIVERSE_REFRESH_INTERVAL_MS` — how often to refresh market data for tracked tokens (default: 5 minutes)

Set either to `0` to disable automatic scheduling for that job type.

## V2 Setup

Required env vars:

- `DATABASE_URL`
- `REDIS_URL`
- `HELIUS_API_KEY`
- `HELIUS_HOLDER_PAGE_LIMIT`
- `HELIUS_MAX_HOLDER_PAGES`
- `HELIUS_WALLET_PAGE_LIMIT`
- `HELIUS_MAX_WALLET_PAGES`
- `SNAPSHOT_INTERVAL_MS` (optional, default `900000`)
- `UNIVERSE_REFRESH_INTERVAL_MS` (optional, default `300000`)

Generate and apply the V2 schema:

```bash
npm run db:generate
npm run db:migrate
```

Provider strategy:

- V2 is **Helius-first**. Birdeye is not used in the active-scan or monitoring path.
- Helius MCP is the future agent tooling layer for research and workflow automation.

ATH behavior:

- `athUsd` is best-effort from Helius payloads.
- When Helius does not expose ATH for a token, the API returns `athUsd: null` with a scoped warning.

---

## Legacy V1 (on-chain dashboard)

The sections below document the original file-backed on-chain dashboard. It remains functional but is superseded by the V2 architecture above.

### What this does

- Builds top-50 owner holder snapshots per configured SPL token.
- Computes cross-token control metric:
  - `C(A,B) = holdings of token A by top 50 holders of token B / supply of token A`
- Emits alert events and Telegram messages when control crosses threshold.
- Runs a single-token active scan for co-held tokens, filtered by on-chain market quality.

### Pure on-chain market cap logic

This project does not use Dexscreener or Birdeye.

- Price source: on-chain DEX pool vault reserves from `config/pools.json`
- Pool quality gate: minimum quote-side liquidity in USD (`MIN_MARKET_LIQUIDITY_USD`)
- Quote normalization:
  - USDC/USDT pools: direct USD
  - WSOL pools: converted to USD via the configured WSOL/USDC reference pool
- Price aggregation: liquidity-weighted median across eligible pools for a token
- Market cap estimate: `on-chain token supply * on-chain USD price`

### Setup (legacy)

1. Install dependencies

```bash
npm install
```

2. Create env file

```bash
cp .env.example .env
```

3. Fill required values in `.env`

- `RPC_URL`
- `RPC_TIMEOUT_MS` (optional, default `20000`)
- `RPC_CONCURRENCY` (optional, default `2` on the public Solana RPC, otherwise `4`)
- `SCAN_HOLDER_LIMIT` (optional, default `20` on the public Solana RPC, otherwise `50`)
- `PRICE_CACHE_TTL_MS` (optional, default `15000`)
- `TELEGRAM_BOT_TOKEN` (optional)
- `TELEGRAM_CHAT_IDS` (optional)

4. Update token and pool configs

- `config/tokens.json`: list of real tokens to monitor.
- `config/pools.json`: list of live DEX pools with token vault accounts.

Refresh the pool file from Raydium's live API after you change the token list:

```bash
npm run refresh:pools
```

### Commands (legacy)

```bash
npm run start -- run-once
```

Only refresh top-holder snapshots:

```bash
npm run start -- snapshot
```

Only compute correlation and alerts:

```bash
npm run start -- correlate
```

Active scan for one token mint:

```bash
npm run start -- scan <TOKEN_MINT>
```

Run web dashboard (no terminal interaction needed after launch):

```bash
npm run web
```

Open `http://localhost:8787`.

Run the local quality gate:

```bash
npm run check
```

Run the live-data smoke suite against your real RPC and current config:

```bash
npm run test:live
```

To exercise live snapshot/correlation endpoints too:

```bash
npm run test:live:mutations
```

For the broader live-data test matrix, load testing, and security scanning steps, see `TESTING.md`.

### Output files (legacy)

Stored under `DATA_DIR` (default `./data`):

- `holders_<MINT>.json`
- `control_series.ndjson`
- `alert_state.json`
- `alerts.ndjson`

### Notes (legacy)

- The repository now ships with a real BONK/JUP token list and live Raydium pool keys, but live scans and snapshots still depend heavily on the quality of your RPC provider.
- `npm run refresh:pools` regenerates `config/pools.json` from Raydium's live API for the current token list.
- Solana’s public RPC endpoints are rate-limited and not intended for production. The Solana docs recommend using a dedicated/private RPC for production workloads.
- On the public Solana RPC, the dashboard caps active scans to the top 20 holders and still may reject scan/snapshot workloads with `429` or secondary-index errors. Use a dedicated/indexed RPC if you want those features to complete reliably.
- For prototype/local use, file storage is fine. For production analytics, move the time-series data into SQLite or PostgreSQL; Helius’ current indexing guidance recommends PostgreSQL for most production Solana indexers and ClickHouse only when the dataset grows into heavier analytical workloads.
