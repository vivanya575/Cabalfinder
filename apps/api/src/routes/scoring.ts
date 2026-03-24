import type { FastifyInstance } from "fastify";
import { calculateActiveScanScore, v2Defaults } from "@cabalfinder/shared";
import { z } from "zod";

const scorePreviewSchema = z.object({
  controlPct: z.number().nonnegative(),
  totalUsdHeld: z.number().nonnegative(),
  overlapCount: z.number().int().nonnegative(),
  maxControlPct: z.number().positive().default(1),
  maxTotalUsdHeld: z.number().positive(),
  maxOverlapCount: z.number().positive().default(v2Defaults.topHolderLimit)
});

export async function registerScoringRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/scoring/active-scan", async (request) => {
    const payload = scorePreviewSchema.parse(request.body);
    return {
      ok: true,
      input: payload,
      output: calculateActiveScanScore(payload)
    };
  });
}
