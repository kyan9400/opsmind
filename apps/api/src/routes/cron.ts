import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { config } from "../config.js";
import { demoSeedOptions, seedDemo } from "../lib/demoSeed.js";
import { HttpError } from "../lib/errors.js";
import { deleteExpiredSandboxes } from "../lib/sandbox.js";

/**
 * Scheduled jobs. Vercel Cron calls them (apps/api/vercel.json) with "Authorization: Bearer <CRON_SECRET>";
 * app.ts mounts this router only when CRON_SECRET is set.
 */
export const cronRouter = Router();

const sha256 = (value: string) => createHash("sha256").update(value).digest();

// Hashing both sides gives equal-length buffers, so the comparison takes the same time for any input and
// the response time reveals nothing about the secret.
const requireCronSecret: RequestHandler = (req, _res, next) => {
  if (!timingSafeEqual(sha256(req.get("authorization") ?? ""), sha256(`Bearer ${config.CRON_SECRET}`))) {
    throw new HttpError(401, "unauthorized");
  }
  next();
};
cronRouter.use(requireCronSecret);

// Daily. The demo KPIs are dated relative to the seed day, so without a refresh the analytics periods
// (last 7/30/90/180 days) drift into the past. The run also keeps a free database from being archived.
// Expired sandboxes go first, so a misconfigured demo login (503) cannot keep them around.
// Hobby plans allow only daily crons, so the cleanup shares this one instead of a schedule of its own.
cronRouter.get("/seed", async (_req, res) => {
  const sandboxesDeleted = await deleteExpiredSandboxes();
  res.json({ ...(await seedDemo(demoSeedOptions())), sandboxesDeleted });
});
