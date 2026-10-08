import { Router } from "express";
import { aiPost } from "../lib/aiClient.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { aiRateLimit } from "../middleware/rateLimit.js";
import { ASK_HISTORY_CHARS, ASK_HISTORY_TURNS, AskBody } from "../schemas.js";

export const askRouter = Router();

/** Response shape of the Python service (snake_case). */
interface AiAskResult {
  answer: string;
  provider: string;
  ms: number;
  detail?: string;
  /** The standalone question retrieval ran with (the follow-up rewritten with the history). */
  retrieval_query?: string;
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
  const { question, topK, history } = AskBody.parse(req.body);
  const { status, data } = await aiPost<AiAskResult>("/v1/ask", {
    tenant_id: req.user!.tenantId,
    question,
    top_k: topK,
    // Already validated; capped again here because the AI service refuses, rather than trims, anything longer.
    ...(history.length > 0 && {
      history: history.slice(-ASK_HISTORY_TURNS).map((t) => ({
        question: t.question.slice(0, ASK_HISTORY_CHARS),
        answer: t.answer.slice(0, ASK_HISTORY_CHARS),
      })),
    }),
  });
  if (status !== 200) throw new HttpError(502, data.detail ?? "AI service error");

  await audit({
    tenantId: req.user!.tenantId,
    actorId: req.user!.sub,
    action: "ai.asked",
    target: question.slice(0, 120),
    meta: { citations: data.citations.length, ms: data.ms, provider: data.provider, turns: history.length },
  });

  res.json({
    answer: data.answer,
    provider: data.provider,
    ms: data.ms,
    ...(data.retrieval_query && { retrievalQuery: data.retrieval_query }),
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
