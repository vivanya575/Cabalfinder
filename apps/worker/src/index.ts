import { Worker } from "bullmq";
import pino from "pino";
import { queueNames } from "@cabalfinder/shared";
import { env } from "./env.js";

const logger = pino({ level: env.LOG_LEVEL });

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

const workers = Object.entries(queueNames).map(([key, name]) => {
  const worker = new Worker(
    name,
    async (job) => {
      logger.info(
        {
          queue: name,
          jobName: job.name,
          jobId: job.id,
          data: job.data
        },
        "Processed scaffold job placeholder"
      );

      return {
        status: "accepted",
        queue: name,
        worker: key
      };
    },
    {
      connection: createConnectionOptions(),
      concurrency: env.WORKER_CONCURRENCY
    }
  );

  worker.on("completed", (job) => {
    logger.info({ queue: name, jobId: job.id }, "Job completed");
  });

  worker.on("failed", (job, error) => {
    logger.error({ queue: name, jobId: job?.id, error }, "Job failed");
  });

  return { name, worker };
});

logger.info(
  {
    queues: workers.map((item) => item.name),
    concurrency: env.WORKER_CONCURRENCY
  },
  "Cabalfinder V2 worker scaffold online"
);

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down worker scaffold");
  await Promise.all(workers.map(({ worker }) => worker.close()));
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
