"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { IconAlert, IconArrowRight, IconQuote, IconSearch, IconSend } from "@/components/icons";
import { LogoMark } from "@/components/Logo";
import { Page, PageHeader } from "@/components/PageHeader";
import { api, ApiError, type AskResponse } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useI18n } from "@/lib/i18n/provider";
import { PREVIEW } from "@/lib/preview";

const EXAMPLES = ["ask.example1", "ask.example2", "ask.example3"] as const;

/** Turns "[2]" markers in the answer into citation chips that jump to the matching source card. */
function AnswerText({ text }: { text: string }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    // dir="auto": the answer's language follows the documents, not the UI, so let its first strong character decide.
    <p className="text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-fg" dir="auto" data-testid="ask-answer">
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/);
        return m ? (
          <a
            key={i}
            href={`#source-${m[1]}`}
            className="mx-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded-md border border-brand-line bg-brand-soft px-1 align-[0.1em] text-[0.6875rem] font-semibold text-brand-soft-fg no-underline transition-colors hover:border-brand"
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
    <Page width="4xl">
      <PageHeader title={t("ask.title")} description={t("ask.subtitle")} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="card mt-6 flex items-center gap-2 p-1.5 ps-4 transition-shadow focus-within:border-brand focus-within:ring-3 focus-within:ring-brand/15"
      >
        <IconSearch size={18} className="text-fg-subtle" />
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("ask.placeholder")}
          aria-label={t("ask.inputLabel")}
          maxLength={500}
          dir="auto"
          data-testid="ask-input"
          className="h-10 min-w-0 flex-1 bg-transparent text-[0.9375rem] text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none"
        />
        <button disabled={busy} data-testid="ask-submit" className="btn btn-primary h-10">
          <IconSend size={15} className="rtl:-scale-x-100" />
          {busy ? t("ask.thinking") : t("ask.submit")}
        </button>
      </form>

      {/* The preview can only answer these, so they stay on screen there. */}
      {(!result || PREVIEW) && !busy && (
        <div className="mt-4">
          <p className="eyebrow">{t("ask.tryExample")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {EXAMPLES.map((key, i) => (
              <button
                key={key}
                type="button"
                data-testid={`ask-example-${i + 1}`}
                onClick={() => {
                  const q = t(key);
                  setQuestion(q);
                  ask(q);
                }}
                className="group inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-start text-sm text-fg-muted shadow-xs transition-colors hover:border-brand-line hover:text-fg"
              >
                {t(key)}
                <IconArrowRight size={14} className="text-fg-subtle group-hover:text-brand-text rtl:-scale-x-100" />
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p
          role="alert"
          data-testid="ask-error"
          className="mt-4 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-text"
        >
          <IconAlert size={16} className="mt-0.5" />
          <span>{error}</span>
        </p>
      )}

      {(busy || result) && (
        <section className="mt-8 space-y-4" aria-busy={busy}>
          {/* The question, as a chat bubble on the end side. */}
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-ee-md bg-brand px-4 py-2.5 text-sm text-brand-fg shadow-xs">
              <span className="sr-only">{t("ask.you")}: </span>
              <span dir="auto">{asked}</span>
            </div>
          </div>

          <div className="card p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <LogoMark size={24} />
              <span className="text-sm font-semibold text-fg">{t("ask.answer")}</span>
              {result && !busy && (
                <span className="ms-auto flex flex-wrap gap-1.5">
                  <span className="badge badge-neutral">{result.provider}</span>
                  <span className="badge badge-neutral tabular-nums">{t("ask.ms", { ms: result.ms })}</span>
                </span>
              )}
            </div>
            {busy || !result ? (
              <div className="space-y-2 motion-safe:animate-pulse" role="status" aria-label={t("ask.thinking")}>
                <div className="h-3 w-11/12 rounded bg-muted" />
                <div className="h-3 w-9/12 rounded bg-muted" />
                <div className="h-3 w-10/12 rounded bg-muted" />
              </div>
            ) : (
              <AnswerText text={result.answer} />
            )}
          </div>

          {result && !busy && result.citations.length > 0 && (
            <div data-testid="ask-sources" className="pt-2">
              <h2 className="eyebrow flex items-center gap-1.5">
                <IconQuote size={14} />
                {t("ask.sources")}
              </h2>
              <ol className="mt-3 grid gap-3 sm:grid-cols-2">
                {result.citations.map((c) => (
                  <li
                    key={c.n}
                    id={`source-${c.n}`}
                    data-testid="ask-source"
                    className={`scroll-mt-20 rounded-card border bg-surface p-4 text-sm shadow-card transition-shadow target:ring-2 target:ring-ring ${
                      c.cited ? "border-brand-line" : "border-line opacity-75"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${
                          c.cited ? "bg-brand text-brand-fg" : "bg-muted text-fg-muted"
                        }`}
                      >
                        {c.n}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <bdi className="font-medium text-fg">{c.title}</bdi>
                          {c.cited && <span className="badge badge-brand shrink-0">{t("ask.cited")}</span>}
                        </div>
                        <p className="mt-0.5 text-xs text-fg-subtle tabular-nums">
                          {t("ask.sourceMeta", {
                            chunk: c.chunkIndex,
                            score: formatNumber(c.score, locale, {
                              minimumFractionDigits: 3,
                              maximumFractionDigits: 3,
                            }),
                          })}
                        </p>
                      </div>
                    </div>
                    <p className="mt-2.5 line-clamp-3 border-s-2 border-line ps-3 text-fg-muted" dir="auto">
                      {c.snippet}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
    </Page>
  );
}
