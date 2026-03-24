# Cabalfinder V2: Solana Holder Intelligence Plan

Status: Approved design
Last updated: March 23, 2026
Audience: Solo trader / researcher

Update: The provider strategy has been revised from Birdeye-first to Helius-first.
The live V2 implementation now uses Helius DAS, Helius RPC, Helius Wallet API, and Helius MCP-oriented workflow assumptions.
Where this document still references Birdeye, treat those references as superseded by the Helius migration.

## Why V2 Exists

The current app is too narrow for the real Solana market structure.

It assumes:
- a small static token list
- static pool configs
- request-time RPC computation
- Raydium-style liquidity as the main market model

That is no longer sufficient.

Solana token discovery and trading now spans:
- launchpads and bonding curves:
  Pump, LetsBONK.fun, Raydium LaunchLab, Believe, Moonshot, Meteora DBC, Jupiter Studio, and others
- post-launch liquidity venues:
  Pump AMM / PumpSwap, Raydium, Meteora AMM / DAMM v2, Orca, and Jupiter-routed liquidity

V2 re-centers the product on what the user actually wants:
- holder-group intelligence
- wallet overlap and cross-control detection
- near-real-time Telegram alerts
- active token scans for co-held tokens

## Validated Product Scope

### Primary user

Solo trader / researcher.

### Solana-only scope

All logic is Solana chain specific.

### Core workflows

1. Continuous monitoring
   Track tokens above the minimum market cap threshold and detect when the top 50 holders of one token collectively control 20 percent or more of another token's supply.

2. Active scan
   Given a token mint, fetch its top 50 holders, inspect the SPL tokens they hold, filter co-held tokens above 5,000 USD market cap, rank the results, and return the top 10.

### Hard product rules

- Monitoring universe threshold: 10,000 USD market cap
- Alert threshold: 20 percent supply control
- Active scan threshold: 5,000 USD market cap
- Active scan output size: top 10 co-held tokens
- Alert latency target: under 30 seconds after fresh data is available
- Market data priority: Helius first

### Required output fields for active scan

- token name / symbol
- contract address (CA)
- market cap
- ATH
- overlap holder count
- total USD held by the scanned token's top 50 holders
- control percentage
- weighted ranking score

## Explicit Non-Goals

- No trade execution
- No token launch flow
- No bundler / sniper / buyer bot functionality
- No multi-chain support
- No generic DeFi portfolio tracker
- No public-RPC-only production design

## Assumptions

- Birdeye remains the primary market intelligence source in the current 2026 design.
- Birdeye APIs and WebSockets are available on a paid package that supports the required token, holder, and stream endpoints.
- Wallet APIs on Birdeye are useful but not sufficient as the only ownership source for this workload because package limits remain tight.
- A dedicated indexed Solana provider is acceptable for fallback and enrichment where Birdeye coverage or limits are insufficient.
- Token classification by launchpad / AMM is important, but exact protocol labeling should not block V1 ship.

## Understanding Summary

- Build a Solana holder-intelligence tool, not a generic dashboard.
- Focus on top-50 holder overlap across tokens.
- Use Birdeye first for market data, ATH, token discovery, and as much holder data as package access allows.
- Send Telegram alerts when holder overlap implies 20 percent or more supply control.
- Ship the active scan flow before building the full global monitoring engine.
- Preserve protocol context across launchpads and liquidity venues without hardcoding a Raydium-only worldview.

## Decision Log

1. Product scope
   The product is analytics / intelligence only.

2. User
   The main user is a solo trader / researcher.

3. Primary workflow
   Wallet and holder-group intelligence is the center of the product.

4. Market data strategy
   Birdeye is the primary provider for market cap, ATH, token metadata, token discovery, and protocol-level market context.

5. Alert speed
   Alerts should target near-real-time delivery, under 30 seconds when fresh inputs are available.

6. Core logic
   The main logic is top-50 holder overlap and cross-token supply control.

7. Active scan ranking
   Use a weighted score that combines overlap count, USD held, and control percentage.

8. Architecture
   Replace the monolithic RPC-bound dashboard with UI, API, workers, relational storage, and queue-backed processing.

9. Storage
   Use PostgreSQL plus TimescaleDB and Redis. Do not use file-based storage for V2.

10. Protocol model
    Treat launchpads, bonding curves, migrations, and AMMs as first-class token context.

## Recommended Architecture

### Stack

- Frontend: Next.js, React, TypeScript, Tailwind CSS, shadcn/ui
- API: Fastify, TypeScript, Zod
- Workers: Node.js worker processes
- Queue and locks: BullMQ plus Redis
- Primary database: PostgreSQL plus TimescaleDB
- Query / schema layer: Drizzle ORM
- Logging and tracing: Pino, OpenTelemetry, Sentry
- Alerts: Telegram Bot API

### Why this stack

- It separates user interaction from heavy chain work.
- It supports near-real-time job execution.
- It handles both relational entities and historical time series.
- It is much easier to evolve than the current single-process app.

## Provider Strategy

### Birdeye first

Use Birdeye as the primary source for:
- token universe discovery
- token metadata
- token market cap and trading data
- ATH and price stats
- token overview
- token holder endpoint where available
- token security / market context
- real-time listing, pair, token-stats, transaction, and wallet transaction streams

Relevant Birdeye capabilities confirmed in current official docs:
- WebSocket events:
  `SUBSCRIBE_TOKEN_NEW_LISTING`, `SUBSCRIBE_NEW_PAIR`, `SUBSCRIBE_TXS`, `SUBSCRIBE_WALLET_TXS`, `SUBSCRIBE_TOKEN_STATS`
- REST APIs:
  `/defi/v3/token/list`
  `/defi/v3/token/market-data`
  `/defi/v3/price/stats/single`
  `/defi/token_overview`
  `/defi/v3/token/holder`
  `/wallet/v2/token-balance`
  `/wallet/tx_list`

### Indexed Solana provider

Use Helius DAS or a similar indexed provider for:
- wallet fungible token positions
- Token-2022-safe wallet ownership
- fallback enrichment when Birdeye wallet APIs are too rate-limited

### Dedicated Solana RPC / indexer

Use a dedicated Solana data provider for:
- fallback supply reads
- validation of ownership math
- protocol / program enrichment where vendor abstractions are not enough

### Historical / research layer

Use Dune for:
- offline validation
- strategy research
- historical protocol and trading analytics

Do not put production alert latency on Dune.

## Domain Model

### Tokens

Fields:
- mint
- symbol
- name
- decimals
- current_market_cap_usd
- ath_usd
- liquidity_usd
- circulating_supply
- total_supply
- first_seen_at
- launch_protocol
- migration_state
- primary_quote_token
- birdeye_rank / priority
- risk_flags

### Wallets

Fields:
- address
- labels
- tags
- first_seen_at
- last_seen_at
- quality_flags

### Wallet positions

Fields:
- wallet
- mint
- balance
- usd_value
- source
- observed_at

### Holder snapshots

Fields:
- mint
- snapshot_time
- holder_rank
- holder_wallet
- amount
- share_of_supply

### Control edges

Represents:
- source token B holder group controlling target token A

Fields:
- source_mint
- target_mint
- snapshot_time
- overlap_wallet_count
- total_units_held
- total_usd_held
- supply_control_pct
- weighted_score

### Alerts

Fields:
- source_mint
- target_mint
- triggered_at
- supply_control_pct
- previous_control_pct
- top_contributors
- telegram_status
- cooldown_key

### Scan runs and scan results

Fields:
- input_mint
- started_at
- completed_at
- snapshot_version
- result_rank
- result_mint
- overlap_wallet_count
- total_usd_held
- supply_control_pct
- market_cap_usd
- ath_usd
- weighted_score

## Protocol Context Model

Every token should carry protocol context even if some values are initially unknown.

### Launch protocol

Examples:
- Pump
- LetsBONK.fun
- LaunchLab
- Believe
- Moonshot
- Meteora DBC
- Jupiter Studio
- unknown

### Liquidity protocols

Examples:
- Pump AMM / PumpSwap
- Raydium
- Meteora AMM
- Meteora DAMM v2
- Orca
- Jupiter routed
- multi
- unknown

### Migration state

Examples:
- bonding_curve
- final_stretch
- migrated
- unknown

This protocol model allows the dashboard to support filters like the screenshoted ecosystem view without making protocol classification the core engine.

## Core Algorithms

### 1. Monitoring universe builder

Purpose:
- define which tokens are tracked continuously

Flow:
1. Pull the current Solana token universe from Birdeye token list endpoints.
2. Enrich tokens with market data, trading data, and liquidity.
3. Filter to tokens with market cap above 10,000 USD.
4. Apply sanity checks:
   minimum tradability
   minimum liquidity
   not obviously broken or frozen if those flags are available
5. Store the current eligible universe.

### 2. Top-50 holder snapshot builder

Purpose:
- build the holder groups used by both alerts and active scans

Preferred flow:
1. Query Birdeye token holder endpoint for the token.
2. Normalize balances and share of supply.
3. Exclude or downrank non-user addresses if they are identifiable.
4. Persist top 50 holders and snapshot metadata.

Fallback flow:
- if Birdeye holder data is incomplete or unavailable, use the indexed Solana provider / dedicated chain path

### 3. Wallet position enrichment

Purpose:
- discover what else each holder wallet owns

Flow:
1. For each holder wallet in the group, fetch fungible token positions.
2. Prefer indexed ownership APIs that work across SPL and Token-2022.
3. Convert balances to USD using Birdeye market data.
4. Filter zero-balance and dust positions.

### 4. Cross-control computation

For each source token B:
1. take the top 50 holders of B
2. union their token positions
3. group by target token A
4. compute:
   overlap wallet count
   total units of A held by B's holder group
   total USD of A held by B's holder group
   supply control percent of A
5. keep only target tokens A with market cap above 10,000 USD
6. if control percent crosses 20 percent and passes cooldown rules, emit an alert

### 5. Active scan

Input:
- token mint

Flow:
1. fetch top 50 holders of the scanned token
2. fetch each holder's fungible positions
3. filter co-held tokens to market cap above 5,000 USD
4. aggregate by token
5. compute:
   overlap wallet count
   total USD held
   supply control percent
   weighted score
   ATH
6. sort descending by weighted score
7. return top 10

### 6. Ranking formula for active scan

Initial V1 formula:

`score = 0.40 * normalized_control_pct + 0.35 * normalized_usd_held + 0.25 * normalized_overlap_count`

Why this formula:
- control percent reflects concentration power
- USD held reflects real economic weight
- overlap count reflects breadth of holder-group participation

Possible V2 additions:
- liquidity quality adjustment
- security risk penalty
- launchpad / migration-stage boost or penalty

## Address Filtering Rules

The engine should avoid treating infrastructure accounts as real whale conviction when possible.

Priority exclusions or penalties:
- LP vaults and AMM vaults
- bonding curve accounts
- burn addresses
- known program-owned treasuries
- protocol escrow accounts
- exchange hot wallets if confidently labeled

If an address cannot be confidently classified, mark it and keep the row explainable instead of silently removing it.

## Telegram Alert Semantics

Alert condition:
- `source token B holder group controls >= 20 percent of target token A supply`

Alert payload:
- source token name and mint
- target token name and mint
- supply control percent
- overlap wallet count
- total USD held
- top contributor wallets
- market cap and ATH if available
- copy-ready CA values

Alert controls:
- dedupe identical threshold crossings
- cooldown window per source-target pair
- hysteresis so tiny oscillations around 20 percent do not spam the channel

## API and UI Surfaces

### API

V1 endpoints:
- `GET /api/universe`
- `GET /api/token/:mint`
- `GET /api/token/:mint/holders`
- `POST /api/scan`
- `GET /api/alerts`
- `GET /api/control/:mint`
- `GET /api/watchlists`

### UI modules

V1 screens:
- dashboard overview
- active scan
- alert feed
- token drilldown
- wallet drilldown

Key UX requirements:
- copy-ready CA buttons everywhere
- clear score breakdown in active scan
- visible protocol context:
  launch source, migration state, liquidity venues
- alert timeline with source-to-target relationship

## Operational Design

### Worker types

- universe refresh worker
- holder snapshot worker
- wallet enrichment worker
- control computation worker
- active scan worker
- Telegram delivery worker

### Queue design

- one queue per major workload class
- per-token dedupe keys
- per-wallet throttling
- retry with backoff
- dead-letter handling for persistent provider failures

### Caching

Cache in Redis:
- Birdeye token overview
- Birdeye market data
- ATH and price stats
- wallet position fetches
- protocol classification hints

## Performance and Scale Assumptions

- tens of thousands of eligible Solana tokens over time
- active tracked universe is smaller after liquidity / sanity filters
- each holder snapshot touches up to 50 wallets
- wallet position fan-out is the dominant cost center
- near-real-time alerts require incremental refresh and priority queues, not full-universe rescans every cycle

## Security and Reliability

- never expose expensive mutation endpoints without auth if this is deployed publicly
- use API-side rate limiting for scans
- isolate worker credentials from the frontend
- store provider API keys only on the server
- persist alert state transactionally
- make Telegram delivery idempotent
- log every provider failure with token, wallet, and job context

## V1 Build Phases

### Phase 1: foundation

- create the new app structure
- add Postgres, Timescale, Redis
- wire Fastify and worker services
- integrate Birdeye market and listing data
- integrate indexed wallet ownership provider

### Phase 2: active scan first

- implement top-50 holder fetch
- implement wallet position enrichment
- implement weighted ranking
- return top 10 with CA, market cap, ATH
- build the active scan UI

### Phase 3: continuous alert engine

- build token universe refresh
- schedule holder snapshots
- compute control edges
- send Telegram alerts with cooldown and dedupe

### Phase 4: intelligence UX

- token and wallet drilldowns
- launchpad / AMM filters
- saved scans
- alert history
- watchlists

## Testing Strategy

### Unit tests

- ranking formula
- threshold crossing logic
- cooldown and hysteresis
- address filtering rules

### Integration tests

- Birdeye client wrappers
- wallet enrichment pipeline
- snapshot persistence
- alert dedupe logic

### Live-data tests

- active scan against known Solana mints
- top-holder fetch sanity against Birdeye
- Telegram delivery dry run
- provider degradation handling

### Strategy validation

- compare selected control edges and token overlap stats against Dune and manual spot checks

## Key Risks and Mitigations

### Risk: provider rate limits

Mitigation:
- aggressive caching
- queue-based throttling
- fallback providers
- active-scan-first rollout

### Risk: bad holder quality

Mitigation:
- protocol-aware exclusion rules
- labeled address registry
- transparent score breakdowns

### Risk: false positives around supply

Mitigation:
- normalize circulating vs total supply consistently
- version the supply source used per computation

### Risk: protocol fragmentation

Mitigation:
- keep protocol context as extensible metadata
- separate protocol adapters from core overlap engine

## Recommended First Implementation Slice

Build only this first:

1. Birdeye token universe above 10,000 USD market cap
2. Active scan for one token
3. Top 50 holders
4. Holder wallet positions
5. Filter co-held tokens above 5,000 USD market cap
6. Rank and return top 10 with:
   symbol
   CA
   market cap
   ATH
   overlap count
   total USD held
   control percent
   weighted score

Then build Telegram threshold alerts second.

This order gives the fastest useful validation of the real product logic.

## References

- Birdeye WebSocket docs:
  https://docs.birdeye.so/docs/websocket
- Birdeye package access and endpoint availability:
  https://docs.birdeye.so/docs/data-accessibility-by-packages
- Birdeye new token listing stream:
  https://docs.birdeye.so/docs/subscribe_token_new_listing
- Birdeye new pair stream:
  https://docs.birdeye.so/docs/subscribe_new_pair
- Birdeye wallet transaction stream:
  https://docs.birdeye.so/docs/subscribe_wallet_txs
- Birdeye token price stats rollout:
  https://docs.birdeye.so/changelog/20250625-new-endpoints-for-token-price-stats
- Helius DAS overview:
  https://www.helius.dev/docs/zh/das-api
- Dune Solana DEX trading overview:
  https://docs.dune.com/data-catalog/curated/dex-trades/solana/overview
- Pump public docs:
  https://github.com/pump-fun/pump-public-docs
