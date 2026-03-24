import type { FastifyInstance } from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { alerts, tokens } from "../db/schema.js";

export async function registerAlertsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/alerts", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0)
      })
      .parse(request.query);

    const rows = await db
      .select({
        id: alerts.id,
        triggeredAt: alerts.triggeredAt,
        previousControlPct: alerts.previousControlPct,
        supplyControlPct: alerts.supplyControlPct,
        overlapWalletCount: alerts.overlapWalletCount,
        totalUsdHeld: alerts.totalUsdHeld,
        topContributors: alerts.topContributors,
        telegramDelivered: alerts.telegramDelivered,
        sourceTokenId: alerts.sourceTokenId,
        targetTokenId: alerts.targetTokenId
      })
      .from(alerts)
      .orderBy(desc(alerts.triggeredAt))
      .limit(query.limit)
      .offset(query.offset);

    const tokenIdSet = new Set<string>();
    for (const row of rows) {
      tokenIdSet.add(row.sourceTokenId);
      tokenIdSet.add(row.targetTokenId);
    }
    const tokenIds = [...tokenIdSet];

    const tokenRows =
      tokenIds.length > 0
        ? await db
            .select({ id: tokens.id, mint: tokens.mint, symbol: tokens.symbol, name: tokens.name })
            .from(tokens)
            .where(inArray(tokens.id, tokenIds))
        : [];

    const tokenMap = new Map(tokenRows.map((t) => [t.id, t]));

    return {
      ok: true,
      alerts: rows.map((row) => ({
        id: row.id,
        triggeredAt: row.triggeredAt,
        previousControlPct: row.previousControlPct,
        supplyControlPct: row.supplyControlPct,
        overlapWalletCount: row.overlapWalletCount,
        totalUsdHeld: row.totalUsdHeld,
        topContributors: row.topContributors,
        telegramDelivered: row.telegramDelivered,
        sourceToken: tokenMap.get(row.sourceTokenId) ?? { id: row.sourceTokenId, mint: null, symbol: null, name: null },
        targetToken: tokenMap.get(row.targetTokenId) ?? { id: row.targetTokenId, mint: null, symbol: null, name: null }
      })),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        count: rows.length
      }
    };
  });
}
