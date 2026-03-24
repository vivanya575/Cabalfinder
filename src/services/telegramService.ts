import type { AlertEvent, TokenConfig } from "../types.js";

export class TelegramService {
  constructor(
    private readonly botToken: string | undefined,
    private readonly chatIds: string[]
  ) {}

  private async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.botToken) {
      return;
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram send failed (${res.status}): ${body}`);
    }
  }

  async broadcastAlert(event: AlertEvent, tokenByMint: Map<string, TokenConfig>): Promise<void> {
    if (!this.botToken || this.chatIds.length === 0) {
      return;
    }

    const tokenA = tokenByMint.get(event.tokenA);
    const tokenB = tokenByMint.get(event.tokenB);
    const symbolA = tokenA?.symbol ?? event.tokenA;
    const symbolB = tokenB?.symbol ?? event.tokenB;

    const contributors = event.contributors
      .slice(0, 5)
      .map((row, idx) => `${idx + 1}. ${row.owner}: ${row.amountUi.toFixed(4)}`)
      .join("\n");

    const text = [
      "ALERT: cross-token whale control threshold crossed",
      `A: ${symbolA}`,
      `B: ${symbolB}`,
      `Prev: ${(event.prevControl * 100).toFixed(2)}%`,
      `Now: ${(event.control * 100).toFixed(2)}%`,
      `Time: ${event.snapshotTime}`,
      `Mint A: ${event.tokenA}`,
      `Mint B: ${event.tokenB}`,
      "Top contributors (A balances among B top-50):",
      contributors || "n/a"
    ].join("\n");

    for (const chatId of this.chatIds) {
      await this.sendMessage(chatId, text);
    }
  }
}
