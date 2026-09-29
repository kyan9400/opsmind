/**
 * Seeds the public demo workspace: a read-only "viewer" login for visitors, 180 days of KPIs and a
 * few company documents to ask questions about.
 *
 *   DEMO_EMAIL=demo@opsmind.dev DEMO_PASSWORD=... node dist/seedDemo.js
 *
 * Idempotent: re-running refreshes the KPIs (relative to today), resets the viewer's password and
 * adds any missing documents. Visitors get the viewer role, so they can explore, ask and export
 * but cannot change or delete anything. It refuses to touch a DEMO_EMAIL that belongs to any other
 * workspace, and removes every account in the demo workspace except its owner and the viewer.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { hashPassword } from "./lib/auth.js";
import { pool, query, withTx } from "./lib/db.js";
import { todayUtc } from "./lib/dates.js";
import { generateDemoData } from "./lib/demoData.js";
import { claimDemoWorkspace } from "./lib/demoWorkspace.js";
import { importDemo } from "./lib/metrics.js";
import { closeQueue, enqueueIngest } from "./lib/queue.js";
import { bumpDataVersion, closeRedis } from "./lib/redis.js";

const env = z
  .object({
    DEMO_EMAIL: z.string().trim().toLowerCase().email(),
    DEMO_PASSWORD: z.string().min(8),
    DEMO_TENANT_NAME: z.string().default("Northwind Supply (demo)"),
  })
  .parse(process.env);

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

async function main() {
  const passwordHash = await hashPassword(env.DEMO_PASSWORD);
  // An owner nobody can log in as: the workspace must have one, and the public login stays a viewer.
  // Its random password is never printed and is replaced on every run.
  const ownerHash = await hashPassword(randomBytes(32).toString("hex"));

  const { tenantId, removedUsers } = await withTx((tx) =>
    claimDemoWorkspace(tx, {
      email: env.DEMO_EMAIL,
      tenantName: env.DEMO_TENANT_NAME,
      viewerHash: passwordHash,
      ownerHash,
    }),
  );

  const kpis = await importDemo(tenantId, generateDemoData(todayUtc()));
  await bumpDataVersion(tenantId);

  const have = new Set(
    (await query<{ title: string }>("SELECT title FROM documents WHERE tenant_id = $1", [tenantId])).map((d) => d.title),
  );
  let queued = 0;
  for (const doc of DOCUMENTS.filter((d) => !have.has(d.title))) {
    const body = Buffer.from(doc.body, "utf8");
    const [row] = await query<{ id: string }>(
      `INSERT INTO documents (tenant_id, title, filename, mime_type, size_bytes, content)
       VALUES ($1, $2, $3, 'text/plain', $4, $5) RETURNING id`,
      [tenantId, doc.title, `${doc.title.toLowerCase().replace(/\s+/g, "-")}.txt`, body.length, body],
    );
    await enqueueIngest(row.id);
    queued++;
  }

  console.log(
    JSON.stringify({
      msg: "demo workspace ready",
      email: env.DEMO_EMAIL,
      metrics: kpis.metrics,
      points: kpis.points,
      documentsQueued: queued,
      removedUsers,
    }),
  );
}

try {
  await main();
} finally {
  await closeQueue();
  await closeRedis();
  await pool.end();
}
