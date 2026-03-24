import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { ActiveScanService } from "../services/activeScanService.js";
import { assertValidSolanaMint } from "../lib/solana.js";
import { getActiveScanById } from "../repositories/activeScanRepository.js";

const activeScanRequestSchema = z.object({
  mint: z.string().min(1),
  topResults: z.number().int().min(1).max(25).default(10)
});

const activeScanService = new ActiveScanService();

export async function registerActiveScanRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/scans/active", async (request) => {
    const payload = activeScanRequestSchema.parse(request.body);
    const mint = assertValidSolanaMint(payload.mint);

    const { scanRunId, response } = await activeScanService.run({
      mint,
      topResults: payload.topResults
    });

    return {
      ok: true,
      scanRunId,
      ...response
    };
  });

  app.get("/v1/scans/active/:scanRunId", async (request, reply) => {
    const params = z.object({ scanRunId: z.string().uuid() }).parse(request.params);
    const data = await getActiveScanById(params.scanRunId);
    if (!data) {
      reply.code(404);
      return { ok: false, error: "Scan run not found." };
    }

    return {
      ok: true,
      scanRun: data.run,
      results: data.results.map((row) => ({
        rank: row.rank,
        mint: row.mint,
        ca: row.mint,
        symbol: row.symbol,
        name: row.name,
        overlapHolderCount: row.overlapHolderCount,
        totalUsdHeld: row.totalUsdHeld,
        controlPct: row.supplyControlPct,
        marketCapUsd: row.marketCapUsd,
        athUsd: row.athUsd,
        score: row.weightedScore
      })),
      copyCAs: data.results.map((row) => row.mint).join("\n")
    };
  });
}
