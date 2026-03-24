# Cabalfinder

For the approved V2 redesign plan, see [docs/V2_SOLANA_HOLDER_INTELLIGENCE_PLAN.md](/Users/akshayukey/Downloads/VIBECODING/Cabalfinder/docs/V2_SOLANA_HOLDER_INTELLIGENCE_PLAN.md).
The remainder of this README documents the current legacy implementation, not the approved V2 architecture.

## V2 Scaffold

The new implementation foundation now lives in:

- [apps/web](/Users/akshayukey/Downloads/VIBECODING/Cabalfinder/apps/web)
- [apps/api](/Users/akshayukey/Downloads/VIBECODING/Cabalfinder/apps/api)
- [apps/worker](/Users/akshayukey/Downloads/VIBECODING/Cabalfinder/apps/worker)
- [packages/shared](/Users/akshayukey/Downloads/VIBECODING/Cabalfinder/packages/shared)
- [infra/docker-compose.v2.yml](/Users/akshayukey/Downloads/VIBECODING/Cabalfinder/infra/docker-compose.v2.yml)

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

Helius MCP setup details live in [docs/MCP_SETUP.md](/Users/akshayukey/Downloads/VIBECODING/Cabalfinder/docs/MCP_SETUP.md).

Check the scaffold:

```bash
npm run check:v2
```

## V2 Phase 2: Active Scan

The V2 API now includes the first real holder-intelligence slice: an active scan endpoint that:

- validates a Solana mint
- fetches holder accounts from Helius DAS / RPC
- enriches each holder wallet through the Helius Wallet API
- computes market cap from Helius asset price plus supply
- ranks the strongest overlaps
- persists the scan run, source holder snapshot, and ranked contributor positions in PostgreSQL

Required V2 env:

- `DATABASE_URL`
- `REDIS_URL`
- `HELIUS_API_KEY`
- `HELIUS_HOLDER_PAGE_LIMIT`
- `HELIUS_MAX_HOLDER_PAGES`
- `HELIUS_WALLET_PAGE_LIMIT`
- `HELIUS_MAX_WALLET_PAGES`

Generate and apply the V2 schema:

```bash
npm run db:generate
npm run db:migrate
```

Run the API:

```bash
npm run dev:api
```

Active scan endpoint:

```bash
curl -X POST http://localhost:4000/v1/scans/active \
  -H 'content-type: application/json' \
  -d '{"mint":"So11111111111111111111111111111111111111112","topResults":10}'
```

Fetch a persisted scan by id:

```bash
curl http://localhost:4000/v1/scans/active/<SCAN_RUN_ID>
```

Supporting routes:

- `GET /healthz`
- `GET /v1/system/status`

Provider strategy update:

- V2 is now **Helius-first**.
- Birdeye is no longer part of the active-scan implementation.
- Helius MCP is treated as the future agent tooling layer for research and workflow automation.

ATH behavior update:

- `athUsd` is now best-effort from Helius payloads in the active scan path.
- When Helius does not expose ATH for a token, the API keeps `athUsd` as `null` and includes a scoped warning.

On-chain Solana holder-correlation monitor with Telegram alerts.

## What this does

- Builds top-50 owner holder snapshots per configured SPL token.
- Computes cross-token control metric:
  - `C(A,B) = holdings of token A by top 50 holders of token B / supply of token A`
- Emits alert events and Telegram messages when control crosses threshold.
- Runs a single-token active scan for co-held tokens, filtered by on-chain market quality.

## Pure on-chain market cap logic

This project does not use Dexscreener or Birdeye.

- Price source: on-chain DEX pool vault reserves from `config/pools.json`
- Pool quality gate: minimum quote-side liquidity in USD (`MIN_MARKET_LIQUIDITY_USD`)
- Quote normalization:
  - USDC/USDT pools: direct USD
  - WSOL pools: converted to USD via the configured WSOL/USDC reference pool
- Price aggregation: liquidity-weighted median across eligible pools for a token
- Market cap estimate: `on-chain token supply * on-chain USD price`

## Setup

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

## Commands

Run snapshot + correlation + alerts once:

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

## Output files

Stored under `DATA_DIR` (default `./data`):

- `holders_<MINT>.json`
- `control_series.ndjson`
- `alert_state.json`
- `alerts.ndjson`

## Notes

- The repository now ships with a real BONK/JUP token list and live Raydium pool keys, but live scans and snapshots still depend heavily on the quality of your RPC provider.
- `npm run refresh:pools` regenerates `config/pools.json` from Raydium's live API for the current token list.
- Solana’s public RPC endpoints are rate-limited and not intended for production. The Solana docs recommend using a dedicated/private RPC for production workloads.
- On the public Solana RPC, the dashboard caps active scans to the top 20 holders and still may reject scan/snapshot workloads with `429` or secondary-index errors. Use a dedicated/indexed RPC if you want those features to complete reliably.
- For prototype/local use, file storage is fine. For production analytics, move the time-series data into SQLite or PostgreSQL; Helius’ current indexing guidance recommends PostgreSQL for most production Solana indexers and ClickHouse only when the dataset grows into heavier analytical workloads.
