import { describe, it, expect, beforeAll } from "vitest";
import { buildServer } from "../server.js";
import { loadConfig } from "../config.js";
import { hashPassword, signToken, verifyToken, tokenUserResolver } from "../auth.js";
import type { UsersRepo } from "../repositories/users.js";

const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "error" });
const SECRET = "test-secret";

describe("tokens", () => {
  it("round-trips a valid token", () => {
    const token = signToken("user-1", SECRET);
    expect(verifyToken(token, SECRET)).toBe("user-1");
  });

  it("rejects tampered and wrong-secret tokens", () => {
    const token = signToken("user-1", SECRET);
    expect(verifyToken(token.replace("user-1", "user-2"), SECRET)).toBeNull();
    expect(verifyToken(token, "other-secret")).toBeNull();
  });

  it("rejects expired tokens", () => {
    const token = signToken("user-1", SECRET, -10);
    expect(verifyToken(token, SECRET)).toBeNull();
  });
});

describe("POST /auth/login", () => {
  let users: UsersRepo;

  beforeAll(async () => {
    const password_hash = await hashPassword("demo1234");
    users = {
      async findByUsername(username) {
        return username === "alice" ? { id: "alice-id", username, password_hash } : null;
      },
    };
  });

  function makeApp() {
    return buildServer({ config, auth: { users, secret: SECRET } });
  }

  it("returns a working token for valid credentials", async () => {
    const res = await makeApp().inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice", password: "demo1234" },
    });
    expect(res.statusCode).toBe(200);
    const { token, user } = res.json();
    expect(user.username).toBe("alice");
    expect(verifyToken(token, SECRET)).toBe("alice-id");
  });

  it("401 on wrong password and unknown user", async () => {
    const app = makeApp();
    const wrong = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alice", password: "nope" },
    });
    expect(wrong.statusCode).toBe(401);
    const unknown = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "mallory", password: "demo1234" },
    });
    expect(unknown.statusCode).toBe(401);
  });

  it("400 on malformed body", async () => {
    const res = await makeApp().inject({ method: "POST", url: "/auth/login", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("tokenUserResolver guards protected routes", () => {
  function protectedApp() {
    return buildServer({
      config,
      resolveUser: tokenUserResolver(SECRET),
      documents: {
        documents: {
          findByHash: async () => null,
          insert: async () => {
            throw new Error("unused");
          },
          listByUser: async () => [],
          getById: async () => null,
          remove: async () => null,
        },
        storage: { save: async () => {}, get: async () => Buffer.alloc(0), remove: async () => {} },
        queue: { enqueue: async () => {}, close: async () => {} },
      },
    });
  }

  it("401 without a token, 200 with one", async () => {
    const app = protectedApp();
    const noToken = await app.inject({ method: "GET", url: "/documents" });
    expect(noToken.statusCode).toBe(401);

    const token = signToken("00000000-0000-0000-0000-000000000001", SECRET);
    const withToken = await app.inject({
      method: "GET",
      url: "/documents",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(withToken.statusCode).toBe(200);
    expect(withToken.json()).toEqual([]);
  });
});
