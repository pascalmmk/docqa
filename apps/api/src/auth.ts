/**
 * Auth seam. Real GitHub OAuth (Auth.js on the web side + session
 * verification here) replaces devUserResolver later in week 1.
 * Routes only ever see `req.userId`.
 */
import type { FastifyRequest } from "fastify";
import type pg from "pg";

export type UserResolver = (req: FastifyRequest) => Promise<string | null>;

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

/**
 * Dev resolver: everyone is a single local dev user (github_id = 0),
 * created on first use. Good enough until OAuth lands.
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
