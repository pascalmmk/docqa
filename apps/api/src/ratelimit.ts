/**
 * Token-bucket rate limiting per user in Redis (design doc §5).
 * Atomic via Lua; protects the LLM budget. 429 + Retry-After on empty bucket.
 */
import type { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
}

export interface RateLimiter {
  consume(key: string): Promise<RateLimitResult>;
}

export function allowAll(): RateLimiter {
  return { async consume() { return { allowed: true }; } };
}

const LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

tokens = math.min(capacity, tokens + (now - ts) * refill_per_sec)

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('EXPIRE', key, math.ceil(capacity / refill_per_sec) * 2)
  return {1, 0}
else
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('EXPIRE', key, math.ceil(capacity / refill_per_sec) * 2)
  local wait = math.ceil((1 - tokens) / refill_per_sec)
  return {0, wait}
end
`;

export interface TokenBucketOptions {
  /** Bucket size, e.g. 20 questions. */
  capacity: number;
  /** Refill rate per second, e.g. 20/3600 for 20 per hour. */
  refillPerSec: number;
  prefix: string;
}

export function redisTokenBucket(redis: Redis, opts: TokenBucketOptions): RateLimiter {
  return {
    async consume(key) {
      const now = Date.now() / 1000;
      const [allowed, wait] = (await redis.eval(
        LUA,
        1,
        `${opts.prefix}:${key}`,
        opts.capacity,
        opts.refillPerSec,
        now,
      )) as [number, number];
      return allowed === 1 ? { allowed: true } : { allowed: false, retryAfterSec: wait };
    },
  };
}
