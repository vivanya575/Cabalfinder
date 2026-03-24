const TELEGRAM_API_BASE = "https://api.telegram.org";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string
): Promise<void> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });

    if (response.ok) {
      return;
    }

    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await sleep(500 * attempt);
      continue;
    }

    const body = (await response.text().catch(() => "")) || `HTTP ${response.status}`;
    throw new Error(`Telegram API error: ${body}`);
  }
}

export async function broadcastTelegramMessage(
  botToken: string,
  chatIds: string[],
  text: string
): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;

  for (const chatId of chatIds) {
    try {
      await sendTelegramMessage(botToken, chatId, text);
      delivered += 1;
    } catch {
      failed += 1;
    }
  }

  return { delivered, failed };
}

export function formatAlertMessage(params: {
  sourceTokenSymbol?: string;
  sourceTokenMint: string;
  targetTokenSymbol?: string;
  targetTokenMint: string;
  supplyControlPct: number;
  overlapWalletCount: number;
  totalUsdHeld: number;
  topContributors: Array<{ wallet: string; amount: number }>;
}): string {
  const sourceName = params.sourceTokenSymbol ?? params.sourceTokenMint.slice(0, 8) + "…";
  const targetName = params.targetTokenSymbol ?? params.targetTokenMint.slice(0, 8) + "…";
  const controlStr = `${(params.supplyControlPct * 100).toFixed(1)}%`;
  const usdStr = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(params.totalUsdHeld);

  const contributors = params.topContributors
    .slice(0, 5)
    .map((c) => `  • <code>${c.wallet.slice(0, 8)}…</code> (${c.amount.toLocaleString()} units)`)
    .join("\n");

  return [
    `🚨 <b>CABAL ALERT</b>`,
    ``,
    `Top-50 holders of <b>${sourceName}</b> collectively control <b>${controlStr}</b> of <b>${targetName}</b> supply.`,
    ``,
    `<b>Details</b>`,
    `  • Overlap wallets: ${params.overlapWalletCount}`,
    `  • Total USD held: ${usdStr}`,
    `  • Control: ${controlStr}`,
    ``,
    `<b>Source token CA:</b>`,
    `<code>${params.sourceTokenMint}</code>`,
    ``,
    `<b>Target token CA:</b>`,
    `<code>${params.targetTokenMint}</code>`,
    params.topContributors.length > 0 ? `\n<b>Top contributors:</b>\n${contributors}` : ""
  ]
    .join("\n")
    .trim();
}
