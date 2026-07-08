/**
 * Seeds demo accounts for the login page.
 * Usage: pnpm --filter @docqa/api seed
 * Idempotent: re-running resets the demo passwords.
 */
import pg from "pg";
import { hashPassword } from "../auth.js";

const DEMO_ACCOUNTS = [
  { username: "alice", password: "demo1234" },
  { username: "bob", password: "demo1234" },
  { username: "charlie", password: "demo1234" },
];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });

for (const { username, password } of DEMO_ACCOUNTS) {
  const password_hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (username, password_hash, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [username, password_hash, `${username}@demo.docqa`],
  );
  console.log(`seeded ${username} / ${password}`);
}

await pool.end();
