# Testing Cabalfinder

## Real-Data Rule

- Use the configured live `RPC_URL` and real on-chain mints only.
- Do not add fixture chain data, mock RPC servers, or test-only token lists back into this repository.

## Automated Stack

- `npm run test:live`: live-data smoke test against the current dashboard config and a real scan mint.
- `npm run test:live:mutations`: same as above, plus live snapshot/correlation mutation checks.
- `npm run test:load`: k6 load scenarios for `/api/state` and `/api/scan`.
- `npm run test:security`: OWASP ZAP baseline scan through Docker.

## Live Smoke Coverage

- Dashboard boot against the current real config.
- Live RPC health preflight via `getHealth`.
- Home page availability.
- `/api/state` success using the actual configured token and pool lists.
- `/api/scan` validation for invalid mint input.
- `/api/scan` success using the real mint `3H87g2Zd3T4TNfpnxHqN6e83xp8Avip1tx8Xv3j1pump` by default, or `LIVE_SCAN_MINT` if set.
- Optional live `/api/run/snapshot` and `/api/run/correlate` checks when mutation mode is enabled.

## Manual / Exploratory Scenarios

- Reverse proxy / origin mismatch:
  Use `localhost`, `127.0.0.1`, `0.0.0.0`, HTTPS termination, and a different host header. Browser-side `Failed to fetch` errors often come from origin or scheme mismatches rather than the API itself.
- Public-RPC exhaustion:
  Repeat `Run Full Cycle` and `Scan` under a real shared RPC provider to confirm behavior on `429`, timeout, and provider-specific account-index limits.
- Corrupted storage:
  Break `alerts.ndjson`, `control_series.ndjson`, and `alert_state.json` to see whether recovery and operator messaging are acceptable.
- Telegram failures:
  Use an invalid bot token and unreachable chat IDs while triggering alerts.
- Slow client aborts:
  Start a long scan, refresh the page, and verify no orphaned/duplicated writes are produced.
- Network isolation:
  Bring the real RPC down mid-request and verify the operator-facing message stays actionable.

## Exploit / Loophole Checklist

- Unauthenticated access to mutation endpoints.
- Request flooding on expensive endpoints.
- Double-submit races from rapid clicks or multiple tabs.
- Large-body abuse on `/api/scan`.
- Invalid or hostile mint strings.
- Path traversal against static asset paths.
- XSS via token labels or warning strings.
- Cache poisoning or stale state after repeated scans.
- Disk-write races in file-backed storage.
- CSRF if authentication is later added without same-origin protections.

## Concrete Workflow

- Set `RPC_URL` to a dedicated/private Solana RPC for repeatable live checks.
- Keep `config/tokens.json` and `config/pools.json` as the source of truth.
- Run `npm run refresh:pools` after changing `config/tokens.json` so the pool file stays on real live Raydium data.
- Use `LIVE_SCAN_MINT` for a known real mint you care about testing. The default is `3H87g2Zd3T4TNfpnxHqN6e83xp8Avip1tx8Xv3j1pump`.
- Run `npm run test:live` before shipping dashboard changes.
- Run `npm run test:live:mutations` when you want to validate snapshot/correlation behavior with live chain data.
- Run `npm run test:live -- --base-url=https://your-dashboard-host` to smoke-test an already deployed dashboard instead of starting a local one.

## Notes

- k6 is not bundled with npm. Install it from the official Grafana k6 distribution before running `npm run test:load`.
- ZAP baseline requires Docker.
- Live-data checks are naturally less deterministic than mock-based tests, so use a stable dedicated RPC and a mint with known trading activity for the best signal.
- The official Solana public RPC currently rate-limits `getProgramAccounts`, `getTokenLargestAccounts`, and `getTokenAccountsByOwner` heavily enough that snapshot and scan features should be treated as dedicated-RPC-only for reliable testing.
