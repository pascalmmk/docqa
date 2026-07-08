import type pg from "pg";

export interface UserAccount {
  id: string;
  username: string;
  password_hash: string;
}

export interface UsersRepo {
  findByUsername(username: string): Promise<UserAccount | null>;
}

export function pgUsersRepo(pool: pg.Pool): UsersRepo {
  return {
    async findByUsername(username) {
      const { rows } = await pool.query<UserAccount>(
        `SELECT id, username, password_hash FROM users
         WHERE username = $1 AND password_hash IS NOT NULL`,
        [username],
      );
      return rows[0] ?? null;
    },
  };
}
