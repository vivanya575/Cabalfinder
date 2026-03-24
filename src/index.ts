import { loadConfig, loadPoolList, loadTokenList } from "./config.js";
import { MonitorService } from "./services/monitorService.js";
import { startDashboardServer } from "./web/server.js";

function printUsage(): void {
  console.log("Usage:");
  console.log("  npm run start -- run-once");
  console.log("  npm run start -- snapshot");
  console.log("  npm run start -- correlate");
  console.log("  npm run start -- scan <TOKEN_MINT>");
  console.log("  npm run start -- web [PORT]");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const [tokens, pools] = await Promise.all([
    loadTokenList(config.tokenListPath),
    loadPoolList(config.poolListPath)
  ]);

  const monitor = new MonitorService(config, tokens, pools);

  const command = process.argv[2] ?? "run-once";
  if (command === "run-once") {
    await monitor.runSnapshots();
    const result = await monitor.runCorrelationAndAlerts();
    console.log(`Correlation rows: ${result.rows}, alerts: ${result.alerts}`);
    return;
  }

  if (command === "snapshot") {
    await monitor.runSnapshots();
    console.log("Snapshots complete.");
    return;
  }

  if (command === "correlate") {
    const result = await monitor.runCorrelationAndAlerts();
    console.log(`Correlation rows: ${result.rows}, alerts: ${result.alerts}`);
    return;
  }

  if (command === "scan") {
    const mint = process.argv[3];
    if (!mint) {
      throw new Error("Missing token mint for scan command");
    }
    const rows = await monitor.runSingleTokenScan(mint, 10);
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (command === "web") {
    const portRaw = process.argv[3] ?? "8787";
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid port: ${portRaw}`);
    }
    await startDashboardServer(port);
    return;
  }

  printUsage();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
