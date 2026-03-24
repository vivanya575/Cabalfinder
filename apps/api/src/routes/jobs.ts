import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import { z } from "zod";
import { queueNames } from "@cabalfinder/shared";
import { env } from "../env.js";

function createConnectionOptions() {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || "6379"),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null
  };
}

let universeRefreshQueue: Queue | null = null;
let holderSnapshotQueue: Queue | null = null;
let controlComputationQueue: Queue | null = null;

function getUniverseRefreshQueue(): Queue {
  if (!universeRefreshQueue) {
    universeRefreshQueue = new Queue(queueNames.tokenUniverseRefresh, { connection: createConnectionOptions() });
  }
  return universeRefreshQueue;
}

function getHolderSnapshotQueue(): Queue {
  if (!holderSnapshotQueue) {
    holderSnapshotQueue = new Queue(queueNames.holderSnapshot, { connection: createConnectionOptions() });
  }
  return holderSnapshotQueue;
}

function getControlComputationQueue(): Queue {
  if (!controlComputationQueue) {
    controlComputationQueue = new Queue(queueNames.controlComputation, { connection: createConnectionOptions() });
  }
  return controlComputationQueue;
}

const universeRefreshBodySchema = z.object({
  mints: z.array(z.string().min(1)).min(1)
});

const holderSnapshotBodySchema = z.object({
  mint: z.string().min(1)
});

const controlComputationBodySchema = z.object({
  sourceMint: z.string().min(1),
  targetMints: z.array(z.string().min(1)).optional()
});

export async function registerJobsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/jobs/universe-refresh", async (request) => {
    const body = universeRefreshBodySchema.parse(request.body);
    const queue = getUniverseRefreshQueue();
    const job = await queue.add("universe-refresh", { mints: body.mints }, {
      jobId: `universe-refresh-${Date.now()}`
    });
    return {
      ok: true,
      jobId: job.id,
      queue: queueNames.tokenUniverseRefresh,
      mintCount: body.mints.length
    };
  });

  app.post("/v1/jobs/holder-snapshot", async (request) => {
    const body = holderSnapshotBodySchema.parse(request.body);
    const mint = body.mint.trim();
    const queue = getHolderSnapshotQueue();
    const job = await queue.add("holder-snapshot", { mint }, {
      jobId: `holder-snapshot-${mint}-${Date.now()}`
    });
    return {
      ok: true,
      jobId: job.id,
      queue: queueNames.holderSnapshot,
      mint
    };
  });

  app.post("/v1/jobs/control-computation", async (request) => {
    const body = controlComputationBodySchema.parse(request.body);
    const sourceMint = body.sourceMint.trim();
    const queue = getControlComputationQueue();
    const job = await queue.add("control-computation", {
      sourceMint,
      targetMints: body.targetMints
    }, {
      jobId: `control-computation-${sourceMint}-${Date.now()}`
    });
    return {
      ok: true,
      jobId: job.id,
      queue: queueNames.controlComputation,
      sourceMint
    };
  });
}
