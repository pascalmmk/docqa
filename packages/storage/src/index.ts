/**
 * Raw-file storage, shared by API (write) and worker (read).
 * Disk for local dev; S3-compatible (Tigris) in production, because
 * Fly machines don't share a filesystem.
 */
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

export interface FileStorage {
  save(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
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
    async get(key) {
      return readFile(resolve(key));
    },
    async remove(key) {
      await rm(resolve(key), { force: true });
    },
  };
}

export interface S3Options {
  endpoint?: string; // e.g. Tigris: https://t3.storage.dev
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function s3Storage(opts: S3Options): FileStorage {
  const client = new S3Client({
    region: opts.region ?? "auto",
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
  });
  const Bucket = opts.bucket;
  return {
    async save(key, data) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: data }));
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) throw new Error(`empty body for ${key}`);
      return Buffer.from(bytes);
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

/** Picks S3 when BUCKET_NAME is configured (Tigris sets these on Fly), else disk. */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): FileStorage {
  if (env.BUCKET_NAME && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return s3Storage({
      bucket: env.BUCKET_NAME,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_ENDPOINT_URL_S3 ? { endpoint: env.AWS_ENDPOINT_URL_S3 } : {}),
      ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
    });
  }
  return diskStorage(env.DATA_DIR ?? "./data");
}

/** Canonical object key for a user's uploaded file. */
export function storageKey(userId: string, contentHash: string): string {
  return `${userId}/${contentHash}`;
}
