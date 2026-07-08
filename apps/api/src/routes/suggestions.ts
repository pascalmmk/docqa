import type { FastifyInstance } from "fastify";

export interface SuggestionsRouteDeps {
  suggest(userId: string): Promise<string[]>;
}

export async function suggestionRoutes(app: FastifyInstance, deps: SuggestionsRouteDeps) {
  app.get("/suggestions", async (req, reply) => {
    try {
      return { questions: await deps.suggest(req.userId) };
    } catch (err) {
      // Suggestions are decorative — degrade to none rather than erroring.
      req.log.warn({ err }, "suggestions failed");
      return reply.send({ questions: [] });
    }
  });
}
