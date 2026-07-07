import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { createPool, checkDb } from "./db/pool.js";

const config = loadConfig();
const pool = config.DATABASE_URL ? createPool(config.DATABASE_URL) : null;

const app = buildServer({
  config,
  checkReadiness: async () => (pool ? checkDb(pool) : true),
});

// Graceful shutdown: stop accepting connections, drain, close pools.
const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    await pool?.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

app
  .listen({ port: config.PORT, host: config.HOST })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
