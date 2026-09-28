import { Redis } from "ioredis";
import { config } from "../config.js";

// Cache client. Every helper fails soft: if Redis is down the API still works, just uncached.
let client: Redis | undefined;

function redis() {
  if (!client) {
    client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 500 });
    client.on("error", () => {}); // connection errors surface as failed commands, which we tolerate
  }
  return client;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number) {
  try {
    await redis().set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* cache is best-effort */
  }
}

/**
 * Per-tenant data version. Cache keys embed it, so bumping it on any write invalidates every
 * cached view for that tenant at once without scanning keys.
 */
export async function dataVersion(tenantId: string): Promise<string> {
  try {
    return (await redis().get(`ver:metrics:${tenantId}`)) ?? "0";
  } catch {
    return "nocache";
  }
}

export async function bumpDataVersion(tenantId: string) {
  try {
    await redis().incr(`ver:metrics:${tenantId}`);
  } catch {
    /* a missed bump only means up to one TTL of stale insights */
  }
}

export async function closeRedis() {
  await client?.quit().catch(() => {});
  client = undefined;
}
