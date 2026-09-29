/**
 * The public demo workspace: a read-only "viewer" login for visitors, 180 days of KPIs and a few company
 * documents to ask questions about. Run by the CLI (src/seedDemo.ts) and by the daily cron route.
 *
 * Idempotent: re-running refreshes the KPIs (relative to today), resets the viewer's password and adds
 * any missing documents. Visitors get the viewer role, so they can explore, ask and export but cannot
 * change or delete anything. It refuses to touch a DEMO_EMAIL that belongs to any other workspace, and
 * removes every account in the demo workspace except its owner and the viewer.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { hashPassword } from "./auth.js";
import { query, withTx } from "./db.js";
import { todayUtc } from "./dates.js";
import { generateDemoData } from "./demoData.js";
import { claimDemoWorkspace } from "./demoWorkspace.js";
import { HttpError } from "./errors.js";
import { ingestDocument } from "./ingest.js";
import { importDemo } from "./metrics.js";
import { enqueueIngest } from "./queue.js";
import { bumpDataVersion } from "./redis.js";

const DemoEnv = z.object({
  DEMO_EMAIL: z.string().trim().toLowerCase().email(),
  DEMO_PASSWORD: z.string().min(8),
  DEMO_TENANT_NAME: z.string().default("Northwind Supply (demo)"),
});

export interface DemoSeedOptions {
  email: string;
  password: string;
  tenantName: string;
}

/** Reads DEMO_EMAIL, DEMO_PASSWORD and DEMO_TENANT_NAME. */
export function demoSeedOptions(env: NodeJS.ProcessEnv = process.env): DemoSeedOptions {
  const parsed = DemoEnv.safeParse(env);
  if (!parsed.success) {
    throw new HttpError(503, "demo seed is not configured: set DEMO_EMAIL and DEMO_PASSWORD (8+ characters)");
  }
  const { DEMO_EMAIL, DEMO_PASSWORD, DEMO_TENANT_NAME } = parsed.data;
  return { email: DEMO_EMAIL, password: DEMO_PASSWORD, tenantName: DEMO_TENANT_NAME };
}

const DOCUMENTS: { title: string; body: string }[] = [
  {
    title: "Refund and returns policy",
    body: `Refund and returns policy

Customers can request a full refund within 30 days of delivery. The item must be unused and in its original packaging.
After 30 days and up to 90 days, we offer store credit instead of a refund.
Refunds are paid to the original payment method within 5 business days of the returned item arriving at the warehouse.
Damaged-on-arrival items are refunded or replaced immediately; ask the customer for a photo and the order number (format NW-123456).`,
  },
  {
    title: "Shipping and delivery",
    body: `Shipping and delivery

Orders placed before 14:00 ship the same business day from the Kazan warehouse.
Standard delivery takes 2-4 business days within Russia; express delivery (next day) is available in Moscow and Saint Petersburg.
Shipping is free for orders over 5,000 RUB. International shipping is not offered yet.
If a parcel is delayed by more than 3 days, support may issue a 10% discount code without manager approval.`,
  },
  {
    title: "Expense approval",
    body: `Expense approval

Expenses up to 10,000 RUB are approved by the team lead.
Expenses from 10,000 to 100,000 RUB need approval from the department head.
Anything above 100,000 RUB, and all software subscriptions regardless of amount, must be approved by the CFO.
Submit receipts in the finance portal within 14 days; late submissions are not reimbursed.`,
  },
  {
    title: "Support incident runbook",
    body: `Support incident runbook

Severity 1: the checkout or payment flow is down. Page the on-call engineer immediately and post in #incidents.
Severity 2: a feature is degraded for many customers, for example search or order tracking. Create a ticket and notify the team lead within 30 minutes.
Severity 3: a single customer is affected. Handle in the normal support queue.
After a Severity 1 incident, the on-call engineer writes a postmortem within 3 business days.`,
  },
];

// Next to the migration lock (7_274_001). Vercel Cron may deliver one run twice and a manual run can
// overlap a scheduled one; taking turns keeps the workspace and its documents from being created twice.
// Transaction-scoped, so it also works through a transaction-mode pooler (Neon), unlike a session lock.
const SEED_LOCK_ID = 7_274_002;

/**
 * Queue mode: hands newly added documents to the worker right after they are committed, before anything
 * else can fail. A re-run skips titles it already has and queue mode never retries, so a document left
 * without a job would stay "queued" for good. If Redis refuses one, the documents not handed over are
 * removed, and the next run adds and queues them again.
 */
async function queueForWorker(added: string[]) {
  for (const [i, id] of added.entries()) {
    try {
      await enqueueIngest(id);
    } catch (err) {
      await query("DELETE FROM documents WHERE id = ANY($1::uuid[])", [added.slice(i)]).catch((dbErr: Error) =>
        console.error(JSON.stringify({ msg: "could not remove unqueued demo documents", error: dbErr.message })),
      );
      throw err;
    }
  }
}

export async function seedDemo({ email, password, tenantName }: DemoSeedOptions) {
  const passwordHash = await hashPassword(password);
  // An owner nobody can log in as: the workspace must have one, and the public login stays a viewer.
  // Its random password is never printed and is replaced on every run.
  const ownerHash = await hashPassword(randomBytes(32).toString("hex"));

  const { tenantId, removedUsers, added } = await withTx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [SEED_LOCK_ID]);
    const claimed = await claimDemoWorkspace(tx, { email, tenantName, viewerHash: passwordHash, ownerHash });

    const have = new Set(
      (await tx.query<{ title: string }>("SELECT title FROM documents WHERE tenant_id = $1", [claimed.tenantId])).rows.map(
        (d) => d.title,
      ),
    );
    const added: string[] = [];
    for (const doc of DOCUMENTS.filter((d) => !have.has(d.title))) {
      const body = Buffer.from(doc.body, "utf8");
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO documents (tenant_id, title, filename, mime_type, size_bytes, content)
         VALUES ($1, $2, $3, 'text/plain', $4, $5) RETURNING id`,
        [claimed.tenantId, doc.title, `${doc.title.toLowerCase().replace(/\s+/g, "-")}.txt`, body.length, body],
      );
      added.push(rows[0].id);
    }
    return { ...claimed, added };
  });

  if (config.INGEST_MODE === "queue") await queueForWorker(added);

  const kpis = await importDemo(tenantId, generateDemoData(todayUtc()));
  await bumpDataVersion(tenantId);
  const summary = { msg: "demo workspace ready", email, metrics: kpis.metrics, points: kpis.points, removedUsers };

  if (config.INGEST_MODE === "queue") return { ...summary, documentsQueued: added.length };

  // Inline: index now and wait, so the run reports real outcomes. Also retries any demo document an
  // earlier run left unindexed (the AI service was cold, down or misconfigured), which makes the daily
  // cron self-healing. One at a time keeps the AI service's small connection pool free for visitors.
  const pending = await query<{ id: string }>(
    "SELECT id FROM documents WHERE tenant_id = $1 AND status <> 'ready' ORDER BY created_at",
    [tenantId],
  );
  let documentsIndexed = 0;
  for (const { id } of pending) if ((await ingestDocument(id)) === "ready") documentsIndexed++;
  return {
    ...summary,
    documentsAdded: added.length,
    documentsIndexed,
    documentsFailed: pending.length - documentsIndexed,
  };
}
