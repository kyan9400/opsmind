import { Redis } from "ioredis";
import { config } from "../config.js";

// Cache client. Every helper fails soft: if Redis is down the API still works, just uncached.
let client: Redis | undefined;

// Null when no REDIS_URL is configured (inline mode on a serverless host): the cache then lives in this
// instance's memory, and the data version helpers do nothing, instead of dialling a Redis that does not
// exist on every request.
function redis(): Redis | null {
  if (!config.REDIS_URL) return null;
  if (!client) {
    client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 500 });
    client.on("error", () => {}); // connection errors surface as failed commands, which we tolerate
  }
  return client;
}

/**
 * True when every API instance shares the cache (Redis). Without it each instance has its own and never
 * sees another one's bumpDataVersion(), so its keys must name their content instead (lib/insights.ts).
 */
export const sharedCache = () => config.REDIS_URL !== undefined;

// The in-memory stand-in: enough for repeat views on a warm instance to skip the AI service. Values are
// stored as JSON, as in Redis, so a caller never gets an object another request can change. Bounded: past
// LOCAL_MAX_ENTRIES the oldest goes (a Map iterates in insertion order).
const LOCAL_MAX_ENTRIES = 200;
const local = new Map<string, { json: string; expiresAt: number }>();

function localGet(key: string): string | null {
  const entry = local.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.json;
  local.delete(key);
  return null;
}

function localSet(key: string, json: string, ttlSeconds: number) {
  local.delete(key);
  if (local.size >= LOCAL_MAX_ENTRIES) local.delete(local.keys().next().value!);
  local.set(key, { json, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const shared = redis();
    const raw = shared ? await shared.get(key) : localGet(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number) {
  try {
    const shared = redis();
    if (shared) await shared.set(key, JSON.stringify(value), "EX", ttlSeconds);
    else localSet(key, JSON.stringify(value), ttlSeconds);
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
    return (await redis()?.get(`ver:metrics:${tenantId}`)) ?? "0";
  } catch {
    return "nocache";
  }
}

export async function bumpDataVersion(tenantId: string) {
  try {
    await redis()?.incr(`ver:metrics:${tenantId}`);
  } catch {
    /* a missed bump only means up to one TTL of stale insights */
  }
}

export async function closeRedis() {
  await client?.quit().catch(() => {});
  client = undefined;
}
