"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconCopy,
  IconPlus,
  IconQuote,
  IconSearch,
  IconSend,
} from "@/components/icons";
import { LogoMark } from "@/components/Logo";
import { Page, PageHeader } from "@/components/PageHeader";
import {
  api,
  ApiError,
  ASK_HISTORY_CHARS,
  ASK_HISTORY_TURNS,
  getToken,
  type AskResponse,
  type AskTurn,
} from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useI18n } from "@/lib/i18n/provider";
import { PREVIEW } from "@/lib/preview";

const EXAMPLES = ["ask.example1", "ask.example2", "ask.example3"] as const;

interface Turn {
  id: string;
  question: string;
  result: AskResponse;
}

// Per browser tab (sessionStorage): the conversation survives a reload or a trip to another page, and
// is gone when the tab closes. Tagged with the session's token, so another sign-in starts a fresh chat.
const STORE_KEY = "opsmind.ask.thread";
const MAX_STORED_TURNS = 20;

const sessionTag = () => getToken()?.slice(-24) ?? "";

function loadThread(): Turn[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "null") as { tag: string; turns: Turn[] } | null;
    return saved && saved.tag === sessionTag() && Array.isArray(saved.turns) ? saved.turns : [];
  } catch {
    return []; // storage blocked (private mode, sandboxed frame) or a corrupt entry: start empty
  }
}

function saveThread(turns: Turn[]) {
  try {
    if (turns.length === 0) sessionStorage.removeItem(STORE_KEY);
    else sessionStorage.setItem(STORE_KEY, JSON.stringify({ tag: sessionTag(), turns: turns.slice(-MAX_STORED_TURNS) }));
  } catch {
    /* the chat still works, it just will not survive a reload */
  }
}

/** The last turns as the API takes them: oldest first, capped in number and length. */
const historyOf = (turns: Turn[]): AskTurn[] =>
  turns.slice(-ASK_HISTORY_TURNS).map((t) => ({
    question: t.question.slice(0, ASK_HISTORY_CHARS),
    answer: t.result.answer.slice(0, ASK_HISTORY_CHARS),
  }));

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Reveals `text` word by word in about a second, whatever its length. Starts with the first word so the
 * answer is never an empty box; with reduced motion (or animate=false) everything shows at once.
 */
function useTypewriter(text: string, animate: boolean, onDone: () => void) {
  const tokens = useMemo(() => text.split(/(\s+)/), [text]);
  const [shown, setShown] = useState(() => (animate && !prefersReducedMotion() ? 1 : tokens.length));
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (shown >= tokens.length) {
      if (animate) done.current();
      return;
    }
    const step = Math.max(1, Math.ceil(tokens.length / 50));
    const id = setTimeout(() => setShown((n) => Math.min(tokens.length, n + step)), 20);
    return () => clearTimeout(id);
  }, [shown, tokens.length, animate]);

  return { text: shown >= tokens.length ? text : tokens.slice(0, shown).join(""), typing: shown < tokens.length };
}

/** Turns "[2]" markers in the answer into citation chips that jump to the matching source card. */
function AnswerText({ text, turnId, testId }: { text: string; turnId: string; testId?: string }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    // dir="auto": the answer's language follows the documents, not the UI, so let its first strong character decide.
    <p className="text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-fg" dir="auto" data-testid={testId}>
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/);
        return m ? (
          <a
            key={i}
            href={`#source-${turnId}-${m[1]}`}
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

function QuestionBubble({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-ee-md bg-brand px-4 py-2.5 text-sm text-brand-fg shadow-xs">
        <span className="sr-only">{t("ask.you")}: </span>
        <span dir="auto">{text}</span>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      type="button"
      data-testid="ask-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          /* clipboard refused (permissions, insecure origin): nothing useful to show */
        }
      }}
      aria-label={copied ? t("ask.copied") : t("ask.copy")}
      title={t("ask.copy")}
      className="btn btn-ghost btn-sm w-8 px-0 text-fg-subtle hover:text-fg"
    >
      {copied ? <IconCheck size={15} className="text-success" /> : <IconCopy size={15} />}
    </button>
  );
}

/**
 * One question and its answer. Only the latest turn carries the original test ids (ask-answer,
 * ask-sources, ask-source), so selectors written for the single-answer page still find exactly one.
 */
function TurnView({
  turn,
  latest,
  animate,
  onTyped,
}: {
  turn: Turn;
  latest: boolean;
  animate: boolean;
  onTyped: () => void;
}) {
  const { t, locale } = useI18n();
  const { result } = turn;
  const typed = useTypewriter(result.answer, animate, onTyped);
  const searched =
    result.retrievalQuery && result.retrievalQuery.trim().toLowerCase() !== turn.question.trim().toLowerCase()
      ? result.retrievalQuery
      : null;

  return (
    <li data-testid="ask-turn" className="space-y-4">
      <QuestionBubble text={turn.question} />

      <div className="card p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <LogoMark size={24} />
          <span className="text-sm font-semibold text-fg">{t("ask.answer")}</span>
          <span className="ms-auto flex flex-wrap items-center gap-1.5">
            <span className="badge badge-neutral">{result.provider}</span>
            <span className="badge badge-neutral tabular-nums">{t("ask.ms", { ms: result.ms })}</span>
            <CopyButton text={result.answer} />
          </span>
        </div>
        <div aria-busy={typed.typing}>
          <AnswerText text={typed.text} turnId={turn.id} testId={latest ? "ask-answer" : undefined} />
        </div>
        {searched && (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-fg-subtle">
            <IconSearch size={13} />
            <span dir="auto">{t("ask.searchedFor", { query: searched })}</span>
          </p>
        )}
      </div>

      {result.citations.length > 0 && (
        <div data-testid={latest ? "ask-sources" : undefined} className="pt-2">
          <h3 className="eyebrow flex items-center gap-1.5">
            <IconQuote size={14} />
            {t("ask.sources")}
          </h3>
          <ol className="mt-3 grid gap-3 sm:grid-cols-2">
            {result.citations.map((c) => (
              <li
                key={c.n}
                id={`source-${turn.id}-${c.n}`}
                data-testid={latest ? "ask-source" : undefined}
                className={`scroll-mt-32 rounded-card border bg-surface p-4 text-sm shadow-card transition-shadow target:ring-2 target:ring-ring ${
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
                        score: formatNumber(c.score, locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
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
    </li>
  );
}

export default function AskPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [typingId, setTypingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = pending !== null;

  // Read after mount: the server render has no sessionStorage, and both renders must match.
  useEffect(() => {
    setTurns(loadThread());
    setRestored(true);
  }, []);

  useEffect(() => {
    if (restored) saveThread(turns);
  }, [turns, restored]);

  // Keep the newest question, then its answer, in view as the thread grows.
  useEffect(() => {
    if (!pending && !typingId) return;
    endRef.current?.scrollIntoView({ block: "end", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [pending, typingId]);

  async function ask(raw: string) {
    const q = raw.trim();
    if (!q || busy) return;
    setPending(q);
    setError(null);
    setQuestion("");
    try {
      const result = await api<AskResponse>("/ask", {
        method: "POST",
        body: JSON.stringify({ question: q, ...(turns.length > 0 && { history: historyOf(turns) }) }),
      });
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setTurns((prev) => [...prev, { id, question: q, result }]);
      setTypingId(id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return router.replace("/login");
      setError((err as Error).message);
      setQuestion(q); // nothing is lost: the question goes back into the box for a retry
    } finally {
      setPending(null);
    }
  }

  function newChat() {
    setTurns([]);
    setTypingId(null);
    setError(null);
    setQuestion("");
    inputRef.current?.focus();
  }

  return (
    <Page width="4xl">
      {/* Full-height column, so the input sits at the bottom of the screen like in any chat. */}
      <div className="flex min-h-[calc(100dvh-8.5rem)] flex-col">
        <PageHeader
          title={t("ask.title")}
          description={t("ask.subtitle")}
          actions={
            (turns.length > 0 || error) && (
              <button
                type="button"
                onClick={newChat}
                disabled={busy}
                data-testid="ask-new-chat"
                className="btn btn-secondary btn-sm"
              >
                <IconPlus size={15} />
                {t("ask.newChat")}
              </button>
            )
          }
        />

        <ol data-testid="ask-thread" aria-label={t("ask.threadLabel")} className="mt-8 space-y-8 empty:hidden">
          {turns.map((turn, i) => (
            <TurnView
              key={turn.id}
              turn={turn}
              latest={i === turns.length - 1 && !busy}
              animate={turn.id === typingId}
              onTyped={() => setTypingId((id) => (id === turn.id ? null : id))}
            />
          ))}
          {pending && (
            <li className="space-y-4" aria-busy="true">
              <QuestionBubble text={pending} />
              <div className="card p-5">
                <div className="mb-3 flex items-center gap-2">
                  <LogoMark size={24} />
                  <span className="text-sm font-semibold text-fg">{t("ask.answer")}</span>
                </div>
                <div className="space-y-2 motion-safe:animate-pulse" role="status" aria-label={t("ask.thinking")}>
                  <div className="h-3 w-11/12 rounded bg-muted" />
                  <div className="h-3 w-9/12 rounded bg-muted" />
                  <div className="h-3 w-10/12 rounded bg-muted" />
                </div>
              </div>
            </li>
          )}
        </ol>
        <div ref={endRef} className="scroll-mb-28" />

        {/* The preview can only answer these, so they stay on screen there. */}
        {(turns.length === 0 || PREVIEW) && !busy && (
          <div className="mt-6">
            <p className="eyebrow">{t("ask.tryExample")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {EXAMPLES.map((key, i) => (
                <button
                  key={key}
                  type="button"
                  data-testid={`ask-example-${i + 1}`}
                  onClick={() => ask(t(key))}
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
            className="mt-6 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-text"
          >
            <IconAlert size={16} className="mt-0.5" />
            <span>{error}</span>
          </p>
        )}

        {/* Pinned to the bottom edge; the fade keeps the thread readable as it scrolls underneath. */}
        <div className="sticky bottom-0 z-10 -mx-4 mt-auto bg-gradient-to-t from-canvas from-70% to-transparent px-4 pt-8 pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
            className="card flex items-center gap-2 p-1.5 ps-4 shadow-raised transition-shadow focus-within:border-brand focus-within:ring-3 focus-within:ring-brand/15"
          >
            <IconSearch size={18} className="text-fg-subtle" />
            <input
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={turns.length > 0 ? t("ask.followUp") : t("ask.placeholder")}
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
        </div>
      </div>
    </Page>
  );
}
