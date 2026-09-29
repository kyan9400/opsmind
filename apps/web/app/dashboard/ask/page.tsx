"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type AskResponse } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useI18n } from "@/lib/i18n/provider";
import { PREVIEW } from "@/lib/preview";

const EXAMPLES = ["ask.example1", "ask.example2", "ask.example3"] as const;

/** Turns "[2]" markers in the answer into links that jump to the matching source card. */
function AnswerText({ text }: { text: string }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    // dir="auto": the answer's language follows the documents, not the UI, so let its first strong character decide.
    <p className="whitespace-pre-wrap leading-relaxed" dir="auto" data-testid="ask-answer">
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/);
        return m ? (
          <a
            key={i}
            href={`#source-${m[1]}`}
            className="mx-0.5 rounded bg-indigo-100 px-1 align-super text-[10px] font-semibold text-indigo-700 no-underline dark:bg-indigo-900/50 dark:text-indigo-300"
          >
            {m[1]}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        );
      })}
    </p>
  );
}

export default function AskPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResponse | null>(null);
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(q: string) {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    setAsked(q);
    try {
      setResult(await api<AskResponse>("/ask", { method: "POST", body: JSON.stringify({ question: q }) }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return router.replace("/login");
      setError((err as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t("ask.title")}</h1>
      <p className="mt-1 text-sm text-zinc-500">{t("ask.subtitle")}</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="mt-6 flex gap-2"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("ask.placeholder")}
          aria-label={t("ask.inputLabel")}
          maxLength={500}
          dir="auto"
          data-testid="ask-input"
          className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 outline-none focus:border-indigo-500 dark:border-zinc-700"
        />
        <button
          disabled={busy}
          data-testid="ask-submit"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {busy ? t("ask.thinking") : t("ask.submit")}
        </button>
      </form>

      {/* The preview can only answer these, so they stay on screen there. */}
      {(!result || PREVIEW) && !busy && (
        <div className="mt-4 flex flex-wrap gap-2">
          {EXAMPLES.map((key, i) => (
            <button
              key={key}
              data-testid={`ask-example-${i + 1}`}
              onClick={() => {
                const q = t(key);
                setQuestion(q);
                ask(q);
              }}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" data-testid="ask-error" className="mt-4 text-sm text-red-600">
          {error}
        </p>
      )}

      {result && (
        <section className="mt-8 space-y-6">
          <div className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <p className="mb-2 text-xs text-zinc-500" dir="auto">
              {asked}
            </p>
            <AnswerText text={result.answer} />
            <p className="mt-3 text-xs text-zinc-500">
              {result.provider} · {t("ask.ms", { ms: result.ms })}
            </p>
          </div>

          {result.citations.length > 0 && (
            <div data-testid="ask-sources">
              <h2 className="text-sm font-medium text-zinc-500">{t("ask.sources")}</h2>
              <ol className="mt-2 space-y-2">
                {result.citations.map((c) => (
                  <li
                    key={c.n}
                    id={`source-${c.n}`}
                    data-testid="ask-source"
                    className={`rounded-lg border p-3 text-sm target:ring-2 target:ring-indigo-500 ${
                      c.cited ? "border-indigo-300 dark:border-indigo-800" : "border-zinc-200 opacity-70 dark:border-zinc-800"
                    }`}
                  >
                    <div className="flex justify-between gap-4">
                      <span className="font-medium">
                        [{c.n}] <bdi>{c.title}</bdi>
                      </span>
                      <span className="shrink-0 text-xs text-zinc-500">
                        {t("ask.sourceMeta", {
                          chunk: c.chunkIndex,
                          score: formatNumber(c.score, locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
                        })}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-3 text-zinc-600 dark:text-zinc-400" dir="auto">
                      {c.snippet}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
