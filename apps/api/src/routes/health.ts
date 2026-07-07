import type { FastifyInstance } from "fastify";

export interface HealthOpts {
  checkReadiness: () => Promise<boolean>;
}

export async function healthRoutes(app: FastifyInstance, opts: HealthOpts) {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    const ready = await opts.checkReadiness().catch(() => false);
    if (!ready) {
      return reply.status(503).send({ status: "not ready" });
    }
    return { status: "ready" };
  });
}
