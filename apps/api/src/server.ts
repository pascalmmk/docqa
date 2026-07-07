import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { MAX_UPLOAD_BYTES } from "@docqa/shared";
import type { Config } from "./config.js";
import type { UserResolver } from "./auth.js";
import { healthRoutes } from "./routes/health.js";
import { documentRoutes, type DocumentsDeps } from "./routes/documents.js";

export interface ServerDeps {
  config: Config;
  /** Returns true when downstream deps (Postgres, Redis) are reachable. */
  checkReadiness?: () => Promise<boolean>;
  /** Resolves the authenticated user for a request; null → 401. */
  resolveUser?: UserResolver;
  /** When provided, document routes are registered. */
  documents?: DocumentsDeps;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, checkReadiness, resolveUser, documents } = deps;

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

  app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  app.register(healthRoutes, {
    checkReadiness: checkReadiness ?? (async () => true),
  });

  if (documents) {
    app.register(async (authed) => {
      authed.addHook("preHandler", async (req, reply) => {
        const userId = resolveUser ? await resolveUser(req) : null;
        if (!userId) {
          return reply
            .status(401)
            .type("application/problem+json")
            .send({ title: "unauthorized", status: 401, instance: req.url });
        }
        req.userId = userId;
      });
      await documentRoutes(authed, documents);
    });
  }

  return app;
}
