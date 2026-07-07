import { describe, it, expect } from "vitest";
import { buildServer } from "./server.js";
import { loadConfig } from "./config.js";

const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "error" });

describe("health endpoints", () => {
  it("GET /healthz returns ok", async () => {
    const app = buildServer({ config });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz returns 200 when deps are up", async () => {
    const app = buildServer({ config, checkReadiness: async () => true });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
  });

  it("GET /readyz returns 503 when deps are down", async () => {
    const app = buildServer({ config, checkReadiness: async () => false });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
  });

  it("unknown route returns problem+json", async () => {
    const app = buildServer({ config });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});
