/**
 * Raw-file storage abstraction. Disk impl for local dev / Fly volume;
 * swap for S3-compatible Tigris later without touching routes.
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FileStorage {
  save(key: string, data: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
}

export function diskStorage(rootDir: string): FileStorage {
  const resolve = (key: string) => {
    if (key.includes("..")) throw new Error("invalid storage key");
    return join(rootDir, key);
  };
  return {
    async save(key, data) {
      const path = resolve(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    async remove(key) {
      await rm(resolve(key), { force: true });
    },
  };
}
