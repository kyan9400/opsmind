/**
 * A deliberately small Markdown subset for AI answers: paragraphs with line breaks, headings (shown as a
 * bold line), bullet and numbered lists, fenced code, **bold**, *italic*, `code` and [n] citation markers.
 *
 * Chat models format their replies this way, so plain text would show literal asterisks and hashes. The
 * parser only builds a tree of plain objects; React renders it as elements, never as an HTML string, so
 * raw HTML or a link in an answer stays visible text and nothing in it can run or navigate.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "cite"; n: number }
  | { type: "br" };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { type: "code"; text: string };

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const ESCAPABLE = new Set("\\`*_[]#+-.!>");
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/** Index of the delimiter that closes one opened just before `from`, or -1 when nothing closes it. */
function findClose(src: string, from: number, delim: string): number {
  const ch = delim[0];
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      // Code spans are opaque: a "*" inside one never closes the emphasis around it.
      const end = src.indexOf("`", i + 1);
      if (end !== -1) i = end;
      continue;
    }
    if (!src.startsWith(delim, i)) continue;
    if (delim.length === 1 && src[i + 1] === ch) {
      i++; // a doubled delimiter inside *…* belongs to a nested **…**
      continue;
    }
    if (isSpace(src[i - 1])) continue; // "2 * 3" is arithmetic, not a closing delimiter
    if (ch === "_" && LETTER_OR_DIGIT.test(src[i + delim.length] ?? "")) continue; // snake_case
    if (i > from) return i;
  }
  return -1;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && ESCAPABLE.has(src[i + 1] ?? "")) {
      text += src[++i];
      continue;
    }
    if (c === "\n") {
      flush();
      out.push({ type: "br" });
      continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1 && !src.slice(i + 1, end).includes("\n")) {
        flush();
        out.push({ type: "code", text: src.slice(i + 1, end) });
        i = end;
        continue;
      }
    }
    if (c === "[") {
      const m = /^\[(\d{1,3})\]/.exec(src.slice(i, i + 5));
      if (m) {
        flush();
        out.push({ type: "cite", n: Number(m[1]) });
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const delim = src[i + 1] === c ? c + c : c;
      const opens =
        !isSpace(src[i + delim.length]) && !(c === "_" && LETTER_OR_DIGIT.test(src[i - 1] ?? ""));
      const close = opens ? findClose(src, i + delim.length, delim) : -1;
      if (close !== -1) {
        flush();
        const children = parseInline(src.slice(i + delim.length, close));
        out.push(delim.length === 2 ? { type: "strong", children } : { type: "em", children });
        i = close + delim.length - 1;
        continue;
      }
      text += delim; // unmatched: keep the characters as typed
      i += delim.length - 1;
      continue;
    }
    text += c;
  }
  flush();
  return out;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$/;
const BULLET = /^\s*[-*+•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?/;

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  let code: string[] | null = null;

  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };
  const endList = () => {
    if (list) {
      blocks.push({ type: "list", ordered: list.ordered, start: list.start, items: list.items.map(parseInline) });
    }
    list = null;
  };

  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    if (code) {
      if (FENCE.test(raw)) {
        blocks.push({ type: "code", text: code.join("\n") });
        code = null;
      } else code.push(raw);
      continue;
    }
    const line = raw.replace(QUOTE, "").trimEnd();
    if (FENCE.test(line)) {
      endParagraph();
      endList();
      code = [];
      continue;
    }
    if (!line.trim() || RULE.test(line)) {
      endParagraph();
      endList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      endList();
      blocks.push({ type: "heading", children: parseInline(heading[1]) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      endParagraph();
      const ordered = numbered !== null;
      if (!list || list.ordered !== ordered) {
        endList();
        list = { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      }
      list.items.push(bullet ? bullet[1] : numbered![2]);
      continue;
    }
    if (list && /^\s/.test(line)) {
      // An indented line under an item continues that item.
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    endList();
    paragraph.push(line);
  }
  if (code) blocks.push({ type: "code", text: code.join("\n") }); // an unclosed fence runs to the end
  endParagraph();
  endList();
  return blocks;
}

// ------------------------------------------------------------------ word-by-word reveal

const countText = (s: string) => s.match(/\S+/g)?.length ?? 0;

/** The start of `s` holding its first `n` words, with the spacing between them kept. */
function takeText(s: string, n: number): string {
  const words = /\S+/g;
  let end = 0;
  for (let k = 0; k < n; k++) {
    const m = words.exec(s);
    if (!m) break;
    end = m.index + m[0].length;
  }
  return s.slice(0, end);
}

function countInline(nodes: Inline[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "text") n += countText(node.text);
    else if (node.type === "strong" || node.type === "em") n += countInline(node.children);
    else if (node.type !== "br") n += 1; // a code span or a citation appears as one piece
  }
  return n;
}

/** How many reveal steps an answer has: words, plus one per code span and citation. */
export function countWords(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === "list") for (const item of b.items) n += countInline(item);
    else if (b.type === "code") n += countText(b.text);
    else n += countInline(b.children);
  }
  return n;
}

function takeInline(nodes: Inline[], budget: { left: number }): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (budget.left <= 0) break;
    if (node.type === "text") {
      const n = countText(node.text);
      out.push(n <= budget.left ? node : { type: "text", text: takeText(node.text, budget.left) });
      budget.left -= Math.min(n, budget.left);
    } else if (node.type === "strong" || node.type === "em") {
      const children = takeInline(node.children, budget);
      if (children.length) out.push({ type: node.type, children });
    } else {
      out.push(node);
      if (node.type !== "br") budget.left -= 1;
    }
  }
  return out;
}

/**
 * The first `n` words of an answer, as blocks that are already formatted: the reveal never shows a
 * half-typed "**" that only turns bold once its closing pair arrives.
 */
export function takeWords(blocks: Block[], n: number): Block[] {
  const budget = { left: n };
  const out: Block[] = [];
  for (const b of blocks) {
    if (budget.left <= 0) break;
    if (b.type === "list") {
      const items: Inline[][] = [];
      for (const item of b.items) {
        if (budget.left <= 0) break;
        items.push(takeInline(item, budget));
      }
      out.push({ ...b, items });
    } else if (b.type === "code") {
      const words = countText(b.text);
      out.push(words <= budget.left ? b : { type: "code", text: takeText(b.text, budget.left) });
      budget.left -= Math.min(words, budget.left);
    } else {
      out.push({ type: b.type, children: takeInline(b.children, budget) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ plain text

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      node.type === "text" || node.type === "code"
        ? node.text
        : node.type === "cite"
          ? `[${node.n}]`
          : node.type === "br"
            ? "\n"
            : inlineText(node.children),
    )
    .join("");
}

/** The answer without Markdown syntax, for screen-reader announcements. */
export function plainText(blocks: Block[]): string {
  return blocks
    .map((b) =>
      b.type === "list"
        ? b.items.map((item, i) => `${b.ordered ? `${b.start + i}.` : "•"} ${inlineText(item)}`).join("\n")
        : b.type === "code"
          ? b.text
          : inlineText(b.children),
    )
    .join("\n");
}
