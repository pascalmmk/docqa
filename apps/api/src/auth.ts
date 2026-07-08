/**
 * Auth: scrypt password hashing + HMAC-signed bearer tokens.
 * Routes only ever see `req.userId`; the resolver seam means the
 * token scheme can be swapped (e.g. for GitHub OAuth) without
 * touching any route.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import type pg from "pg";

const scrypt = promisify(scryptCb) as (pw: string, salt: string, len: number) => Promise<Buffer>;

export type UserResolver = (req: FastifyRequest) => Promise<string | null>;

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

/* ---------- passwords ---------- */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hex] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const hash = await scrypt(password, salt, 32);
  const expected = Buffer.from(hex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

/* ---------- tokens ---------- */

const WEEK_SEC = 7 * 24 * 60 * 60;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signToken(userId: string, secret: string, ttlSec = WEEK_SEC): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyToken(token: string, secret: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts as [string, string, string];
  const payload = `${userId}.${expStr}`;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expStr) < Date.now() / 1000) return null;
  return userId;
}

/** Resolves the user from an `Authorization: Bearer <token>` header. */
export function tokenUserResolver(secret: string): UserResolver {
  return async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    return verifyToken(header.slice(7), secret);
  };
}

/**
 * Dev resolver (kept for local hacking): everyone is a single local
 * dev user (github_id = 0), created on first use.
 */
export function devUserResolver(pool: pg.Pool): UserResolver {
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (github_id, email) VALUES (0, 'dev@localhost')
       ON CONFLICT (github_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
    );
    cached = rows[0]?.id ?? null;
    return cached;
  };
}
