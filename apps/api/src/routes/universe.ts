import type { FastifyInstance } from "fastify";
import { desc, gte, isNotNull, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { tokens } from "../db/schema.js";
import { env } from "../env.js";

export async function registerUniverseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/universe", async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        minMarketCap: z.coerce.number().nonnegative().default(0)
      })
      .parse(request.query);

    const floor = Math.max(query.minMarketCap, env.TRACKING_MARKET_CAP_MIN_USD);

    const rows = await db
      .select({
        id: tokens.id,
        mint: tokens.mint,
        symbol: tokens.symbol,
        name: tokens.name,
        currentMarketCapUsd: tokens.currentMarketCapUsd,
        athUsd: tokens.athUsd,
        circulatingSupply: tokens.circulatingSupply,
        launchProtocol: tokens.launchProtocol,
        migrationState: tokens.migrationState,
        updatedAt: tokens.updatedAt
      })
      .from(tokens)
      .where(and(isNotNull(tokens.currentMarketCapUsd), gte(tokens.currentMarketCapUsd, floor)))
      .orderBy(desc(tokens.currentMarketCapUsd))
      .limit(query.limit)
      .offset(query.offset);

    return {
      ok: true,
      universe: rows,
      trackingFloorUsd: floor,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        count: rows.length
      }
    };
  });
}
