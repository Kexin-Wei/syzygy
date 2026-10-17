import { expect, test } from "bun:test";
import { applyEdit, wordLeft, wordRight } from "./Input.tsx";

test("word boundaries", () => {
  const v = "git commit --amend";
  expect(wordLeft(v, v.length)).toBe(13); // start of "amend"
  expect(wordLeft(v, 13)).toBe(4); // from the "--amend" gap back to the start of "commit"
  expect(wordRight("foo bar", 0)).toBe(3);
  expect(wordRight("foo bar", 3)).toBe(7);
});

test("word-left / word-right arrows move by word", () => {
  const s = { value: "alpha beta", cursor: 10 };
  expect(applyEdit(s, "", { leftArrow: true, ctrl: true })).toEqual({ value: "alpha beta", cursor: 6 });
  expect(applyEdit({ value: "alpha beta", cursor: 0 }, "", { rightArrow: true, meta: true })).toEqual({ value: "alpha beta", cursor: 5 });
});

test("delete word back (Ctrl+W) and kill to end (Ctrl+K)", () => {
  expect(applyEdit({ value: "one two", cursor: 7 }, "w", { ctrl: true })).toEqual({ value: "one ", cursor: 4 });
  expect(applyEdit({ value: "keep drop", cursor: 4 }, "k", { ctrl: true })).toEqual({ value: "keep", cursor: 4 });
});

test("home/end and plain insert/backspace", () => {
  expect(applyEdit({ value: "abc", cursor: 1 }, "a", { ctrl: true })).toEqual({ value: "abc", cursor: 0 });
  expect(applyEdit({ value: "abc", cursor: 1 }, "e", { ctrl: true })).toEqual({ value: "abc", cursor: 3 });
  expect(applyEdit({ value: "ac", cursor: 1 }, "b", {})).toEqual({ value: "abc", cursor: 2 });
  expect(applyEdit({ value: "abc", cursor: 2 }, "", { backspace: true })).toEqual({ value: "ac", cursor: 1 });
});

test("returns null for keys the editor ignores", () => {
  expect(applyEdit({ value: "x", cursor: 1 }, "", {})).toBeNull();
});
