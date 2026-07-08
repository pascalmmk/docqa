import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { UsersRepo } from "../repositories/users.js";
import { verifyPassword, signToken } from "../auth.js";

export interface AuthDeps {
  users: UsersRepo;
  secret: string;
}

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

/** Public routes — registered outside the auth-guarded scope. */
export async function authRoutes(app: FastifyInstance, deps: AuthDeps) {
  app.post<{ Body: unknown }>("/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ title: "username and password required", status: 400 });
    }
    const { username, password } = parsed.data;

    const user = await deps.users.findByUsername(username);
    const valid = user && (await verifyPassword(password, user.password_hash));
    if (!valid) {
      return reply.status(401).send({ title: "invalid username or password", status: 401 });
    }

    return {
      token: signToken(user.id, deps.secret),
      user: { id: user.id, username: user.username },
    };
  });
}
