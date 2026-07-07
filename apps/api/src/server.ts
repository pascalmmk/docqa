import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { healthRoutes } from "./routes/health.js";

export interface ServerDeps {
  config: Config;
  /** Returns true when downstream deps (Postgres, Redis) are reachable. */
  checkReadiness?: () => Promise<boolean>;
}

export function buildServer({ config, checkReadiness }: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization"],
    },
    genReqId: () => randomUUID(),
  });

  // RFC 7807 problem+json error envelope
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    reply
      .status(status)
      .type("application/problem+json")
      .send({
        type: "about:blank",
        title: status >= 500 ? "Internal Server Error" : err.message,
        status,
        instance: req.url,
      });
  });

  app.register(healthRoutes, {
    checkReadiness: checkReadiness ?? (async () => true),
  });

  return app;
}
