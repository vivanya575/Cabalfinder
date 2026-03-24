# Helius MCP Setup (Local + In-Repo)

This repository now includes two ways to run Helius MCP tooling.

## 1) Local MCP host configuration (recommended for agent clients)

Add Helius MCP to your MCP host/client config:

```json
{
  "mcpServers": {
    "helius": {
      "command": "npx",
      "args": ["helius-mcp@latest"]
    }
  }
}
```

Set your key in shell environment (or use the MCP onboarding tool `setHeliusApiKey`):

```bash
export HELIUS_API_KEY=your-helius-key
export HELIUS_NETWORK=mainnet-beta
```

Quick check:

```bash
npx helius-mcp@latest
```

## 2) In-repo MCP workspace app

The monorepo now includes `apps/mcp` as a managed launcher for the official Helius MCP server.

Run from repo root:

```bash
npm run dev:mcp
```

What it does:

- loads env from root `.env`
- forwards `HELIUS_API_KEY` and `HELIUS_NETWORK`
- launches the official `helius-mcp` process with inherited stdio

## Environment variables

Required for useful calls:

- `HELIUS_API_KEY`

Optional:

- `HELIUS_NETWORK` (defaults to `mainnet-beta`)

## Notes

- Keep `.env` out of version control.
- `apps/mcp` intentionally delegates tool behavior to the official `helius-mcp` package to minimize drift.
- For advanced MCP composition (custom tool wrappers), add a second phase service that composes `apps/api` domain operations over MCP.
