import { afterAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { pool } from "../src/lib/db.js";
import { seedDemo } from "../src/lib/demoSeed.js";
import { closeQueue, enqueueIngest } from "../src/lib/queue.js";
import { closeRedis } from "../src/lib/redis.js";

// The real queue, wrapped so one test can stand in for a Redis that refuses a job.
const realEnqueue = vi.hoisted(() => ({ fn: undefined as undefined | ((id: string) => Promise<void>) }));
vi.mock("../src/lib/queue.js", async (original) => {
  const queue = await original<typeof import("../src/lib/queue.js")>();
  realEnqueue.fn = queue.enqueueIngest;
  return { ...queue, enqueueIngest: vi.fn(queue.enqueueIngest) };
});

// Needs Postgres + Redis (CI provides both). Skipped locally unless INTEGRATION=1.
const run = process.env.INTEGRATION === "1" ? describe : describe.skip;

run("demo seed (postgres)", () => {
  afterAll(async () => {
    await closeQueue();
    await closeRedis();
    await pool.end();
  });

  // Documents a run created: queued for the worker (INGEST_MODE=queue, as in CI) or indexed inline.
  const added = (run: Awaited<ReturnType<typeof seedDemo>>) =>
    "documentsQueued" in run ? run.documentsQueued : run.documentsAdded;

  const newOptions = () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return { email: `seed-${suffix}@x.io`, password: "demo-password", tenantName: `Seed ${suffix}` };
  };

  it("can run twice at once without creating the workspace or its documents twice", async () => {
    const options = newOptions();

    // Vercel Cron may deliver one run twice. The second waits for the first, then finds everything in place.
    const runs = await Promise.all([seedDemo(options), seedDemo(options)]);
    expect(runs.map(added).sort()).toEqual([0, 4]);

    const { rows } = await pool.query<{ tenants: number; documents: number }>(
      `SELECT count(DISTINCT u.tenant_id)::int AS tenants, count(d.id)::int AS documents
         FROM users u LEFT JOIN documents d ON d.tenant_id = u.tenant_id
        WHERE u.email = $1`,
      [options.email],
    );
    expect(rows[0]).toEqual({ tenants: 1, documents: 4 });

    // And again later (the daily run): KPIs refreshed, nothing added.
    const again = await seedDemo(options);
    expect(added(again)).toBe(0);
    expect(again.points).toBeGreaterThan(0);
  });

  // Queue mode never retries a document, so every one the seed leaves behind must have a job.
  it.skipIf(config.INGEST_MODE !== "queue")("a job Redis refused is added and queued again by the next run", async () => {
    const options = newOptions();
    const documentIds = async () =>
      (
        await pool.query<{ id: string }>(
          "SELECT d.id FROM documents d JOIN users u ON u.tenant_id = d.tenant_id WHERE u.email = $1",
          [options.email],
        )
      ).rows
        .map((r) => r.id)
        .sort();
    const queued: string[] = [];
    const take = async (id: string) => void queued.push(id);
    const enqueue = vi.mocked(enqueueIngest);

    try {
      enqueue.mockImplementationOnce(take).mockRejectedValueOnce(new Error("redis refused"));
      await expect(seedDemo(options)).rejects.toThrow("redis refused");
      expect(await documentIds()).toEqual(queued); // only the document that got its job is left

      enqueue.mockImplementation(take);
      expect(await seedDemo(options)).toMatchObject({ documentsQueued: 3 });
      expect(await documentIds()).toEqual([...queued].sort());
      expect(queued).toHaveLength(4);
    } finally {
      enqueue.mockImplementation(realEnqueue.fn!);
    }
  });
});
