"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type Ref } from "react";
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
import { countWords, parseMarkdown, plainText, takeWords, type Block, type Inline } from "@/lib/markdown";
import { PREVIEW } from "@/lib/preview";

const EXAMPLES = ["ask.example1", "ask.example2", "ask.example3"] as const;
// How long an announcement stays in the live region. Screen readers queue the text when it changes, so
// emptying it later does not cut the reading short; the common 7 s (as in React Aria) leaves slow ones time.
const ANNOUNCE_MS = 7000;

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
const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? "auto" : "smooth");

/**
 * Reveals an answer of `total` words in about a second, whatever its length. Starts with the first word so
 * the answer is never an empty box; with reduced motion (or animate=false) everything shows at once.
 */
function useTypewriter(total: number, animate: boolean, onDone: () => void) {
  const [shown, setShown] = useState(() => (animate && !prefersReducedMotion() ? Math.min(1, total) : total));
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (shown >= total) {
      if (animate) done.current();
      return;
    }
    const step = Math.max(1, Math.ceil(total / 50));
    const id = setTimeout(() => setShown((n) => Math.min(total, n + step)), 20);
    return () => clearTimeout(id);
  }, [shown, total, animate]);

  return { shown, typing: shown < total };
}

function Inlines({ nodes, turnId, typing }: { nodes: Inline[]; turnId: string; typing: boolean }) {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <Fragment key={i}>{node.text}</Fragment>;
      case "br":
        return <br key={i} />;
      case "code":
        return (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {node.text}
          </code>
        );
      case "cite":
        // "[2]" becomes a chip that jumps to source card 2. Out of the tab order while the text is still
        // hidden from assistive tech (aria-hidden must not contain focusable elements).
        return (
          <a
            key={i}
            href={`#source-${turnId}-${node.n}`}
            tabIndex={typing ? -1 : undefined}
            className="mx-0.5 inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded-md border border-brand-line bg-brand-soft px-1 align-[0.1em] text-[0.6875rem] font-semibold text-brand-soft-fg no-underline transition-colors hover:border-brand"
          >
            {node.n}
          </a>
        );
      default: {
        const Tag = node.type === "strong" ? "strong" : "em";
        return (
          <Tag key={i} className={node.type === "strong" ? "font-semibold" : undefined}>
            <Inlines nodes={node.children} turnId={turnId} typing={typing} />
          </Tag>
        );
      }
    }
  });
}

/** The answer's Markdown subset (lib/markdown.ts) as elements; [n] markers become citation chips. */
function AnswerText({
  blocks,
  turnId,
  typing,
  testId,
}: {
  blocks: Block[];
  turnId: string;
  typing: boolean;
  testId?: string;
}) {
  const inl = (nodes: Inline[]) => <Inlines nodes={nodes} turnId={turnId} typing={typing} />;
  return (
    <div
      className="space-y-3 text-[0.9375rem] leading-relaxed text-fg"
      data-testid={testId}
      // A stable hook for tests and screenshots: "done" once the word-by-word reveal has finished.
      data-typing={typing ? "typing" : "done"}
      // The half-revealed text is noise to a screen reader; the full answer sits next to it until done.
      aria-hidden={typing || undefined}
    >
      {/* dir="auto" per block: the answer's language follows the documents, not the UI. */}
      {blocks.map((b, i) => {
        if (b.type === "list") {
          const List = b.ordered ? "ol" : "ul";
          return (
            <List
              key={i}
              dir="auto"
              start={b.ordered && b.start !== 1 ? b.start : undefined}
              className={`space-y-1 ps-5 marker:text-fg-subtle ${b.ordered ? "list-decimal" : "list-disc"}`}
            >
              {b.items.map((item, j) => (
                <li key={j}>{inl(item)}</li>
              ))}
            </List>
          );
        }
        if (b.type === "code") {
          return (
            <pre
              key={i}
              dir="ltr"
              className="overflow-x-auto rounded-control bg-muted px-3 py-2 font-mono text-[0.8125rem]"
            >
              <code>{b.text}</code>
            </pre>
          );
        }
        return (
          <p key={i} dir="auto" className={b.type === "heading" ? "font-semibold" : undefined}>
            {inl(b.children)}
          </p>
        );
      })}
    </div>
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
    <>
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
        aria-label={t("ask.copy")}
        title={t("ask.copy")}
        className="btn btn-ghost btn-sm w-8 px-0 text-fg-subtle hover:text-fg"
      >
        {copied ? <IconCheck size={15} className="text-success" /> : <IconCopy size={15} />}
      </button>
      {/* Swapping the button's label is not announced; an always-mounted live region is. A sibling, because
          a button's contents are presentational to assistive tech. */}
      <span role="status" className="sr-only" data-testid="ask-copy-status">
        {copied ? t("ask.copied") : ""}
      </span>
    </>
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
  itemRef,
}: {
  turn: Turn;
  latest: boolean;
  animate: boolean;
  onTyped: () => void;
  itemRef?: Ref<HTMLLIElement>;
}) {
  const { t, locale } = useI18n();
  const { result } = turn;
  // Nothing in the documents answered it: say so in the UI language, and list no unrelated sources.
  const notFound = result.found === false;
  const answer = notFound ? t("ask.noAnswer") : result.answer;
  const blocks = useMemo(() => parseMarkdown(answer), [answer]);
  const total = useMemo(() => countWords(blocks), [blocks]);
  const typed = useTypewriter(total, animate, onTyped);
  const searched =
    result.retrievalQuery && result.retrievalQuery.trim().toLowerCase() !== turn.question.trim().toLowerCase()
      ? result.retrievalQuery
      : null;
  // The label is in the UI language and the query in the user's; <bdi> keeps the query's direction from
  // reordering the label (an English "...?" inside the Arabic label would otherwise show its "?" first).
  const [searchedBefore, searchedAfter = ""] = t("ask.searchedFor").split("{query}");

  return (
    // scroll-mt clears the sticky top bar and the sandbox banner when a new turn is scrolled to its start.
    <li ref={itemRef} data-testid="ask-turn" className="scroll-mt-28 space-y-4">
      <QuestionBubble text={turn.question} />

      <div className="card p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <LogoMark size={24} />
          <span className="text-sm font-semibold text-fg">{t("ask.answer")}</span>
          <span className="ms-auto flex flex-wrap items-center gap-1.5">
            {/* The preview's provider note is a whole sentence in Russian and Arabic: let it wrap rather than
                push the page sideways on a phone. A radius of half the one-line height keeps the pill shape. */}
            <span className="badge badge-neutral max-w-full rounded-[0.625rem] whitespace-normal">{result.provider}</span>
            <span className="badge badge-neutral tabular-nums">{t("ask.ms", { ms: result.ms })}</span>
            <CopyButton text={answer} />
          </span>
        </div>
        <AnswerText
          blocks={typed.typing ? takeWords(blocks, typed.shown) : blocks}
          turnId={turn.id}
          typing={typed.typing}
          testId={latest ? "ask-answer" : undefined}
        />
        {typed.typing && (
          <p className="sr-only" dir="auto">
            {plainText(blocks)}
          </p>
        )}
        {searched && (
          <p
            className="mt-3 flex items-center gap-1.5 text-xs text-fg-subtle"
            data-testid={latest ? "ask-searched" : undefined}
          >
            <IconSearch size={13} className="shrink-0" />
            <span>
              {searchedBefore}
              <bdi>{searched}</bdi>
              {searchedAfter}
            </span>
          </p>
        )}
      </div>

      {!notFound && result.citations.length > 0 && (
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
                // Uncited sources step back by lying flat on the page (no surface, no shadow), not by fading:
                // at 75% opacity their small grey text fell under 4.5:1.
                className={`scroll-mt-32 rounded-card border p-4 text-sm transition-shadow target:ring-2 target:ring-ring ${
                  c.cited ? "border-brand-line bg-surface shadow-card" : "border-line bg-canvas"
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
  // One polite announcement per question ("Thinking…", then the whole answer), never the word-by-word text.
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const newTurnRef = useRef<HTMLLIElement>(null);
  const busy = pending !== null;

  // Read after mount: the server render has no sessionStorage, and both renders must match.
  useEffect(() => {
    setTurns(loadThread());
    setRestored(true);
  }, []);

  useEffect(() => {
    if (restored) saveThread(turns);
  }, [turns, restored]);

  // Emptied once read out: left in place, a browse-mode screen-reader user would meet the whole answer a
  // second time below the thread. Removing text from a live region is not announced.
  useEffect(() => {
    if (!announcement) return;
    const id = setTimeout(() => setAnnouncement(""), ANNOUNCE_MS);
    return () => clearTimeout(id);
  }, [announcement]);

  // While waiting, keep the question and the skeleton below it in view.
  useEffect(() => {
    if (pending) endRef.current?.scrollIntoView({ block: "end", behavior: scrollBehavior() });
  }, [pending]);

  // When the answer arrives, show the start of the new turn, not the end of the thread: the source cards
  // render at full height at once, and on a phone they would push the answer being typed off screen.
  useEffect(() => {
    if (!typingId) return;
    newTurnRef.current?.scrollIntoView({ block: "start", behavior: scrollBehavior() });
    // The submit button was disabled (or the example chip removed) while waiting, which drops focus to
    // <body>; put it back in the input for the follow-up. Not on touch screens, where focusing the input
    // opens the on-screen keyboard over the answer, and never away from something the user focused since.
    const active = document.activeElement;
    const lost = !active || active === document.body || formRef.current?.contains(active);
    if (lost && window.matchMedia?.("(pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true });
  }, [typingId]);

  async function ask(raw: string) {
    const q = raw.trim();
    if (!q || busy) return;
    setPending(q);
    setError(null);
    setQuestion("");
    setAnnouncement(t("ask.thinking"));
    try {
      const result = await api<AskResponse>("/ask", {
        method: "POST",
        body: JSON.stringify({ question: q, ...(turns.length > 0 && { history: historyOf(turns) }) }),
      });
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setTurns((prev) => [...prev, { id, question: q, result }]);
      setTypingId(id);
      setAnnouncement(
        `${t("ask.answer")}: ${result.found === false ? t("ask.noAnswer") : plainText(parseMarkdown(result.answer))}`,
      );
    } catch (err) {
      setAnnouncement(""); // the error has its own role="alert"
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
    setAnnouncement("");
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
              itemRef={turn.id === typingId ? newTurnRef : undefined}
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
                {/* Announced through the page's live region instead. */}
                <div className="space-y-2 motion-safe:animate-pulse" aria-hidden="true">
                  <div className="h-3 w-11/12 rounded bg-muted" />
                  <div className="h-3 w-9/12 rounded bg-muted" />
                  <div className="h-3 w-10/12 rounded bg-muted" />
                </div>
              </div>
            </li>
          )}
        </ol>
        <div ref={endRef} className="scroll-mb-28" />
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="ask-live">
          {announcement}
        </p>

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
            ref={formRef}
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
