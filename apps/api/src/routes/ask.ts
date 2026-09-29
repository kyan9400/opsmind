import { Router } from "express";
import { aiPost } from "../lib/aiClient.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { aiRateLimit } from "../middleware/rateLimit.js";
import { AskBody } from "../schemas.js";

export const askRouter = Router();

/** Response shape of the Python service (snake_case). */
interface AiAskResult {
  answer: string;
  provider: string;
  ms: number;
  detail?: string;
  citations: {
    n: number;
    document_id: string;
    title: string;
    chunk_index: number;
    snippet: string;
    score: number;
    cited: boolean;
  }[];
}

askRouter.post("/", requireAuth, requireRole("viewer"), aiRateLimit, async (req, res) => {
  const { question, topK } = AskBody.parse(req.body);
  const { status, data } = await aiPost<AiAskResult>("/v1/ask", {
    tenant_id: req.user!.tenantId,
    question,
    top_k: topK,
  });
  if (status !== 200) throw new HttpError(502, data.detail ?? "AI service error");

  await audit({
    tenantId: req.user!.tenantId,
    actorId: req.user!.sub,
    action: "ai.asked",
    target: question.slice(0, 120),
    meta: { citations: data.citations.length, ms: data.ms, provider: data.provider },
  });

  res.json({
    answer: data.answer,
    provider: data.provider,
    ms: data.ms,
    citations: data.citations.map((c) => ({
      n: c.n,
      documentId: c.document_id,
      title: c.title,
      chunkIndex: c.chunk_index,
      snippet: c.snippet,
      score: c.score,
      cited: c.cited,
    })),
  });
});
