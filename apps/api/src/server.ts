import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { env } from "./env.js";
import { AppError } from "./lib/errors.js";
import { registerActiveScanRoutes } from "./routes/activeScan.js";
import { registerScoringRoutes } from "./routes/scoring.js";
import { registerStatusRoutes } from "./routes/status.js";

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL
    }
  });

  await app.register(cors, {
    origin: true
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        ok: false,
        error: error.issues[0]?.message ?? "Invalid request."
      });
      return;
    }

    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        ok: false,
        error: error.message
      });
      return;
    }

    app.log.error(error);
    reply.code(500).send({
      ok: false,
      error: error instanceof Error ? error.message : "Internal server error."
    });
  });

  await registerStatusRoutes(app);
  await registerScoringRoutes(app);
  await registerActiveScanRoutes(app);

  return app;
}
