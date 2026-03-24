import { spawn } from "node:child_process";
import { env } from "./env.js";

if (!env.HELIUS_API_KEY) {
  console.warn("[mcp] HELIUS_API_KEY is empty. The server can still start, but most tools require a configured key.");
}

const child = spawn(
  "helius-mcp",
  [],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      HELIUS_API_KEY: env.HELIUS_API_KEY,
      HELIUS_NETWORK: env.HELIUS_NETWORK
    }
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    console.error(`[mcp] helius-mcp exited via signal ${signal}`);
    return;
  }

  process.exitCode = code ?? 0;
});

child.on("error", (error) => {
  process.exitCode = 1;
  console.error(`[mcp] failed to start helius-mcp: ${error.message}`);
});
