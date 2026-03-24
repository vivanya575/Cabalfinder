import fs from "node:fs/promises";
import path from "node:path";
import type { AlertEvent, ControlRow, HolderSnapshot } from "../types.js";

interface AlertState {
  [pair: string]: number;
}

async function readNdjsonFile<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

export class FileStorage {
  constructor(private readonly baseDir: string) {}

  private resolve(rel: string): string {
    return path.resolve(this.baseDir, rel);
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  async saveHolderSnapshot(snapshot: HolderSnapshot): Promise<void> {
    const file = this.resolve(`holders_${snapshot.tokenMint}.json`);
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2), "utf8");
  }

  async readHolderSnapshot(tokenMint: string): Promise<HolderSnapshot | null> {
    const file = this.resolve(`holders_${tokenMint}.json`);
    try {
      const raw = await fs.readFile(file, "utf8");
      return JSON.parse(raw) as HolderSnapshot;
    } catch {
      return null;
    }
  }

  async appendControlRows(rows: ControlRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const file = this.resolve("control_series.ndjson");
    const block = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await fs.appendFile(file, block, "utf8");
  }

  async readRecentControlRows(limit: number): Promise<ControlRow[]> {
    const file = this.resolve("control_series.ndjson");
    const rows = await readNdjsonFile<ControlRow>(file);
    return rows.slice(Math.max(0, rows.length - limit));
  }

  async loadAlertState(): Promise<AlertState> {
    const file = this.resolve("alert_state.json");
    try {
      const raw = await fs.readFile(file, "utf8");
      return JSON.parse(raw) as AlertState;
    } catch {
      return {};
    }
  }

  async saveAlertState(state: AlertState): Promise<void> {
    const file = this.resolve("alert_state.json");
    await fs.writeFile(file, JSON.stringify(state, null, 2), "utf8");
  }

  async appendAlerts(events: AlertEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const file = this.resolve("alerts.ndjson");
    const block = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await fs.appendFile(file, block, "utf8");
  }

  async readRecentAlerts(limit: number): Promise<AlertEvent[]> {
    const file = this.resolve("alerts.ndjson");
    const rows = await readNdjsonFile<AlertEvent>(file);
    return rows.slice(Math.max(0, rows.length - limit));
  }
}
