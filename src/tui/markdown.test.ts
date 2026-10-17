import { expect, test } from "bun:test";
import { parseBlocks, parseInline } from "./markdown.tsx";

test("parses inline bold, italic, code, and links", () => {
  expect(parseInline("a **b** c")).toEqual([{ text: "a " }, { text: "b", bold: true }, { text: " c" }]);
  expect(parseInline("use `git status` now")).toEqual([{ text: "use " }, { text: "git status", code: true }, { text: " now" }]);
  expect(parseInline("see [docs](http://x)")).toEqual([{ text: "see " }, { text: "docs" }, { text: " (http://x)", dim: true }]);
  expect(parseInline("plain")).toEqual([{ text: "plain" }]);
  // unterminated markers stay literal (streaming safety)
  expect(parseInline("half **bold")).toEqual([{ text: "half **bold" }]);
});

test("does not treat snake_case as italic", () => {
  expect(parseInline("call set_main_provider ok")).toEqual([{ text: "call set_main_provider ok" }]);
});

test("parses headings, lists, code fences, and tables", () => {
  const blocks = parseBlocks("# Title\n\n- one\n- two\n\n```\ncode line\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |");
  expect(blocks[0]).toEqual({ kind: "heading", level: 1, text: "Title" });
  expect(blocks[1]).toMatchObject({ kind: "list", items: [{ marker: "•", text: "one" }, { marker: "•", text: "two" }] });
  expect(blocks[2]).toEqual({ kind: "code", lines: ["code line"] });
  expect(blocks[3]).toEqual({ kind: "table", rows: [["A", "B"], ["1", "2"]], align: 2 });
});

test("keeps an unterminated code fence as a code block", () => {
  expect(parseBlocks("```\nstill typing")).toEqual([{ kind: "code", lines: ["still typing"] }]);
});
