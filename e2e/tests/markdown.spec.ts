import { expect, test } from "@playwright/test";
import { countWords, parseInline, parseMarkdown, plainText, takeWords } from "../../apps/web/lib/markdown";

// Plain unit tests of the Ask page's Markdown subset: no page fixture, so no browser is started for them.

test.describe("answer Markdown", () => {
  test("inline: bold, italic, code and [n] citations", () => {
    expect(parseInline("A **bold** and *italic* or _also_ with `x*y` [2].")).toEqual([
      { type: "text", text: "A " },
      { type: "strong", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "italic" }] },
      { type: "text", text: " or " },
      { type: "em", children: [{ type: "text", text: "also" }] },
      { type: "text", text: " with " },
      { type: "code", text: "x*y" },
      { type: "text", text: " " },
      { type: "cite", n: 2 },
      { type: "text", text: "." },
    ]);
    expect(parseInline("**30 days [1]**")).toEqual([
      { type: "strong", children: [{ type: "text", text: "30 days " }, { type: "cite", n: 1 }] },
    ]);
    expect(parseInline("[1][3]")).toEqual([
      { type: "cite", n: 1 },
      { type: "cite", n: 3 },
    ]);
  });

  test("bold italics, whichever way the runs close", () => {
    const text = (t: string) => ({ type: "text", text: t });
    const blocks = parseMarkdown("***Important:*** read this [1].");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "strong", children: [{ type: "em", children: [text("Important:")] }] },
          text(" read this "),
          { type: "cite", n: 1 },
          text("."),
        ],
      },
    ]);
    expect(plainText(blocks)).toBe("Important: read this [1].");
    expect(parseInline("___both___")).toEqual([{ type: "strong", children: [{ type: "em", children: [text("both")] }] }]);
    expect(parseInline("***a** b*")).toEqual([
      { type: "em", children: [{ type: "strong", children: [text("a")] }, text(" b")] },
    ]);
    expect(parseInline("***a* b**")).toEqual([
      { type: "strong", children: [{ type: "em", children: [text("a")] }, text(" b")] },
    ]);
    // Only part of the run closes: the rest stays literal.
    expect(parseInline("***a*")).toEqual([text("**"), { type: "em", children: [text("a")] }]);
    expect(parseInline("a *** b")).toEqual([text("a *** b")]);
  });

  test("leaves text that only looks like Markdown alone", () => {
    const literal = (s: string) => expect(parseInline(s)).toEqual([{ type: "text", text: s }]);
    literal("2 * 3 * 4 = 24");
    literal("set max_upload_bytes and snake_case_name");
    literal("an unmatched **star and a lone ` backtick");
    literal("[see above] and [12a]");
    expect(parseInline("\\*not italic\\* and \\[1\\]")).toEqual([{ type: "text", text: "*not italic* and [1]" }]);
  });

  test("raw HTML and links stay visible text", () => {
    expect(parseInline('<img src=x onerror="alert(1)"> [docs](javascript:alert(1))')).toEqual([
      { type: "text", text: '<img src=x onerror="alert(1)"> [docs](javascript:alert(1))' },
    ]);
  });

  test("blocks: paragraphs with line breaks, headings, lists and code", () => {
    const md = [
      "## Refunds",
      "First line",
      "second line [1]",
      "",
      "- unused items",
      "* in the original box",
      "  continued here",
      "",
      "3. third",
      "4) fourth",
      "---",
      "```",
      "a  *literal*  block",
      "```",
      "> quoted **text**",
    ].join("\r\n");
    expect(parseMarkdown(md)).toEqual([
      { type: "heading", children: [{ type: "text", text: "Refunds" }] },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "First line" },
          { type: "br" },
          { type: "text", text: "second line " },
          { type: "cite", n: 1 },
        ],
      },
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          [{ type: "text", text: "unused items" }],
          [{ type: "text", text: "in the original box" }, { type: "br" }, { type: "text", text: "continued here" }],
        ],
      },
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [[{ type: "text", text: "third" }], [{ type: "text", text: "fourth" }]],
      },
      { type: "code", text: "a  *literal*  block" },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "quoted " },
          { type: "strong", children: [{ type: "text", text: "text" }] },
        ],
      },
    ]);
  });

  test("a list right under a sentence starts its own block", () => {
    expect(parseMarkdown("Options:\n1. credit\n2. refund").map((b) => b.type)).toEqual(["paragraph", "list"]);
  });

  test("the extractive answer format renders as one paragraph", () => {
    const extractive =
      "Customers can request a full refund within 30 days of delivery. [1] After 30 days we offer credit. [1]";
    const blocks = parseMarkdown(extractive);
    expect(blocks).toHaveLength(1);
    expect(plainText(blocks)).toBe(extractive);
  });

  test("the reveal shows a formatted prefix and ends on the whole answer", () => {
    const blocks = parseMarkdown("Get **a full refund** in `30` days [1].\n\n- one item\n- two items");
    // Get, a, full, refund, in, `30`, days, [1], "." and four list words.
    expect(countWords(blocks)).toBe(13);
    expect(takeWords(blocks, 2)).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Get " },
          { type: "strong", children: [{ type: "text", text: "a" }] },
        ],
      },
    ]);
    expect(plainText(takeWords(blocks, 10))).toBe("Get a full refund in 30 days [1].\n• one");
    expect(takeWords(blocks, countWords(blocks))).toEqual(blocks);
    expect(takeWords(blocks, 0)).toEqual([]);
  });

  test("plain text for screen readers drops the syntax", () => {
    expect(plainText(parseMarkdown("# Policy\n**Bold** and *soft* [2]\n\n1. first\n2. second"))).toBe(
      "Policy\nBold and soft [2]\n1. first\n2. second",
    );
  });
});
