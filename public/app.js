const statusEl = document.getElementById("status");
const warningsEl = document.getElementById("warnings");
const alertsEl = document.getElementById("alerts");
const controlsEl = document.getElementById("controls");
const snapshotsEl = document.getElementById("snapshots");
const scanResultsEl = document.getElementById("scanResults");
const scanSubmitBtn = document.getElementById("scanSubmitBtn");
const allButtons = Array.from(document.querySelectorAll("button"));
let tokenLookup = new Map();
let busy = false;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#ff5e5e" : "#92b5d8";
}

function setBusy(isBusy) {
  busy = isBusy;
  allButtons.forEach((button) => {
    button.disabled = isBusy;
  });
  scanInput.disabled = isBusy;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return map[char] || char;
  });
}

function shortMint(value, lead = 6, tail = 4) {
  const text = String(value);
  return `${text.slice(0, lead)}...${text.slice(-tail)}`;
}

function tokenLabel(mint) {
  const token = tokenLookup.get(mint);
  if (!token) {
    return shortMint(mint);
  }
  return token.symbol || token.name || shortMint(mint);
}

function pct(x) {
  return `${(Number(x) * 100).toFixed(2)}%`;
}

function money(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) {
    return "-";
  }
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

async function callApi(path, options = {}) {
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options
    });

    const contentType = res.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await res.json()
      : { ok: false, error: (await res.text()) || `Request failed ${res.status}` };

    if (!res.ok || body.ok === false) {
      throw new Error(body.error || `Request failed ${res.status}`);
    }

    return body;
  } catch (error) {
    if (error instanceof Error && error.message) {
      if (/Request body exceeds|mint is required|valid 32-byte|already running|Invalid JSON|RPC |Request failed/i.test(error.message)) {
        throw error;
      }
      throw new Error(`Network request failed. Check that the dashboard server is running and the RPC is reachable. (${error.message})`);
    }
    throw new Error("Network request failed. Check that the dashboard server is running and the RPC is reachable.");
  }
}

function renderWarnings(warnings) {
  warningsEl.innerHTML = warnings.length
    ? warnings
        .map(
          (warning) => `
      <article class="item warning">
        ${escapeHtml(warning)}
      </article>
    `
        )
        .join("")
    : '<p class="item">No operator warnings.</p>';
}

function renderAlerts(alerts) {
  alertsEl.innerHTML = alerts.length
    ? alerts
        .map(
          (a) => `
      <article class="item">
        <strong>${pct(a.control)}</strong> of ${escapeHtml(tokenLabel(a.tokenA))} now controlled by top holders of ${escapeHtml(tokenLabel(a.tokenB))}
        <div>Previous: ${pct(a.prevControl)}</div>
        <div>${new Date(a.snapshotTime).toLocaleString()}</div>
      </article>
    `
        )
        .join("")
    : '<p class="item">No alerts yet.</p>';
}

function renderControls(rows) {
  controlsEl.innerHTML = rows.length
    ? rows
        .slice(0, 40)
        .map(
          (r) => `
      <article class="item">
        <div>${escapeHtml(tokenLabel(r.tokenB))} -> ${escapeHtml(tokenLabel(r.tokenA))}</div>
        <strong>${pct(r.control)}</strong>
        <div>${new Date(r.snapshotTime).toLocaleString()}</div>
      </article>
    `
        )
        .join("")
    : '<p class="item">No control rows yet.</p>';
}

function renderSnapshots(snapshots) {
  snapshotsEl.innerHTML = snapshots.length
    ? snapshots
        .map(
          (s) => `
      <article class="item">
        <div><strong>${escapeHtml(tokenLabel(s.tokenMint))}</strong> Supply: ${Number(s.supplyUi).toLocaleString()}</div>
        <div>Top holders captured: ${s.holders.length}</div>
        <div>Updated: ${new Date(s.snapshotTime).toLocaleString()}</div>
      </article>
    `
        )
        .join("")
    : '<p class="item">No snapshots stored yet.</p>';
}

function renderScanTable(rows) {
  if (!rows.length) {
    scanResultsEl.innerHTML = '<p class="item">No qualifying tokens found for this scan.</p>';
    return;
  }

  const table = `
    <table>
      <thead>
          <tr>
            <th>Token</th>
            <th>Mint</th>
            <th>Price</th>
            <th>Quote Liquidity</th>
            <th>Market Cap</th>
            <th>Whale Exposure</th>
          </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            <td>${escapeHtml(r.label || "-")}</td>
            <td>${escapeHtml(shortMint(String(r.mint), 8, 4))}</td>
            <td>${money(r.priceUsd)}</td>
            <td>${money(r.quoteLiquidityUsd)}</td>
            <td>${money(r.marketCapUsd)}</td>
            <td>${money(r.totalUsdHeldByTop50)}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
  `;
  scanResultsEl.innerHTML = table;
}

async function refreshState() {
  setStatus("Refreshing dashboard state...");
  const { state } = await callApi("/api/state");
  tokenLookup = new Map((state.tokens || []).map((token) => [token.mint, token]));
  if (scanSubmitBtn) {
    scanSubmitBtn.textContent = `Scan Top-${state.scanHolderLimit || 50} Whale Overlap`;
  }
  renderWarnings(state.warnings || []);
  renderAlerts(state.recentAlerts || []);
  renderControls(state.recentControlRows || []);
  renderSnapshots(state.lastSnapshots || []);
  setStatus(
    `Loaded: ${state.tokens.length} configured tokens, threshold ${pct(state.threshold)}, scan top ${state.scanHolderLimit || 50}`
  );
}

async function runAction(path, label) {
  if (busy) {
    setStatus("Another dashboard action is already running.", true);
    return;
  }

  try {
    setBusy(true);
    setStatus(`${label}...`);
    await callApi(path, { method: "POST" });
    await refreshState();
    setStatus(`${label} complete`);
  } catch (error) {
    setStatus(String(error), true);
  } finally {
    setBusy(false);
  }
}

async function runScan(mint) {
  if (!mint || busy) {
    if (busy) {
      setStatus("Another dashboard action is already running.", true);
    }
    return;
  }

  try {
    setBusy(true);
    setStatus("Running active scan...");
    const { rows } = await callApi("/api/scan", {
      method: "POST",
      body: JSON.stringify({ mint })
    });
    renderScanTable(rows || []);
    setStatus("Scan complete");
  } catch (error) {
    setStatus(String(error), true);
  } finally {
    setBusy(false);
  }
}

document.getElementById("runAllBtn").addEventListener("click", () => runAction("/api/run/all", "Full cycle"));
document.getElementById("snapshotBtn").addEventListener("click", () => runAction("/api/run/snapshot", "Snapshot"));
document.getElementById("correlateBtn").addEventListener("click", () => runAction("/api/run/correlate", "Correlation"));
document.getElementById("refreshBtn").addEventListener("click", refreshState);

const scanInput = document.getElementById("scanMint");

document.getElementById("scanForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mint = scanInput.value.trim();
  await runScan(mint);
});

refreshState().catch((error) => {
  setStatus(String(error), true);
});

const params = new URLSearchParams(window.location.search);
const mintParam = params.get("mint")?.trim();
if (mintParam) {
  scanInput.value = mintParam;
  if (params.get("auto") === "1") {
    runScan(mintParam);
  }
}
