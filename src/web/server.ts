import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import bs58 from "bs58";
import { loadConfig, loadPoolList, loadTokenList } from "../config.js";
import { MonitorService } from "../services/monitorService.js";

const PUBLIC_DIR = path.resolve(process.cwd(), "public");
const MAX_REQUEST_BODY_BYTES = 16 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

class DashboardJobRunner {
  private activeJob: string | null = null;

  async runExclusive<T>(jobName: string, task: () => Promise<T>): Promise<T> {
    if (this.activeJob) {
      throw new HttpError(409, `Another dashboard job is already running (${this.activeJob}).`);
    }

    this.activeJob = jobName;
    try {
      return await task();
    } finally {
      this.activeJob = null;
    }
  }
}

function errorResponse(error: unknown): Response {
  let message = error instanceof Error ? error.message : "Unknown error";
  let status = error instanceof HttpError ? error.status : 500;

  if (/RPC HTTP 429|Too many requests|rate.?limit|secondary indexes|unavailable for key/i.test(message)) {
    status = 503;
    message = `Current RPC endpoint cannot complete this action (${message}). Use a dedicated/indexed Solana RPC for scans and snapshots.`;
  }

  return json({ ok: false, error: message }, status);
}

function resolvePublicFilePath(requestPath: string): string | null {
  try {
    const decoded = decodeURIComponent(requestPath);
    const normalized = path.posix.normalize(decoded.replace(/\\/g, "/"));
    const relativePath = normalized === "/" ? "index.html" : normalized.replace(/^\/+/, "");
    const fullPath = path.resolve(PUBLIC_DIR, relativePath);
    const relativeToPublic = path.relative(PUBLIC_DIR, fullPath);
    if (relativeToPublic.startsWith("..") || path.isAbsolute(relativeToPublic)) {
      return null;
    }
    return fullPath;
  } catch {
    return null;
  }
}

async function readPublicFile(filePath: string): Promise<Response> {
  const fullPath = resolvePublicFilePath(filePath);
  if (!fullPath) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const file = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    const contentType =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "application/javascript; charset=utf-8"
            : "application/octet-stream";

    return new Response(file, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const responseBody = Buffer.from(await response.arrayBuffer());
  res.end(responseBody);
}

function parseJsonBody<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function assertValidMint(mint: string): string {
  const trimmed = mint.trim();
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 32) {
      throw new Error("Invalid length");
    }
  } catch {
    throw new HttpError(400, "mint must be a valid 32-byte Solana address.");
  }
  return trimmed;
}

export async function startDashboardServer(port = 8787): Promise<void> {
  const config = loadConfig();
  const [tokens, pools] = await Promise.all([
    loadTokenList(config.tokenListPath),
    loadPoolList(config.poolListPath)
  ]);

  const monitor = new MonitorService(config, tokens, pools);
  const jobRunner = new DashboardJobRunner();

  const { createServer } = await import("node:http");
  createServer(async (req, res) => {
    try {
      const requestBody = await readRequestBody(req);
      const origin = `http://${req.headers.host ?? `localhost:${port}`}`;
      const request = new Request(new URL(req.url ?? "/", origin), {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: requestBody.length > 0 ? new Uint8Array(requestBody) : undefined
      });

      const response = await handleRequest(request, monitor, jobRunner);
      await writeNodeResponse(res, response);
    } catch (error) {
      await writeNodeResponse(res, errorResponse(error));
    }
  }).listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`);
  });
}

async function handleRequest(
  req: Request,
  monitor: MonitorService,
  jobRunner: DashboardJobRunner
): Promise<Response> {
  const url = new URL(req.url);

  try {
    if (url.pathname === "/api/state" && req.method === "GET") {
      const state = await monitor.getDashboardState();
      return json({ ok: true, state });
    }

    if (url.pathname === "/api/run/snapshot" && req.method === "POST") {
      await jobRunner.runExclusive("snapshot", () => monitor.runSnapshots());
      return json({ ok: true, message: "Snapshots complete" });
    }

    if (url.pathname === "/api/run/correlate" && req.method === "POST") {
      const result = await jobRunner.runExclusive("correlate", () => monitor.runCorrelationAndAlerts());
      return json({ ok: true, result });
    }

    if (url.pathname === "/api/run/all" && req.method === "POST") {
      const result = await jobRunner.runExclusive("run-all", async () => {
        await monitor.runSnapshots();
        return monitor.runCorrelationAndAlerts();
      });
      return json({ ok: true, result });
    }

    if (url.pathname === "/api/scan" && req.method === "POST") {
      const payload = parseJsonBody<{ mint?: string }>(await req.text());
      if (!payload.mint) {
        return json({ ok: false, error: "mint is required" }, 400);
      }
      const mint = assertValidMint(payload.mint);
      const rows = await jobRunner.runExclusive("scan", () => monitor.runSingleTokenScan(mint, 10));
      return json({ ok: true, rows });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "Not found" }, 404);
    }

    if (url.pathname === "/") {
      return readPublicFile("/");
    }

    return readPublicFile(url.pathname);
  } catch (error) {
    return errorResponse(error);
  }
}
