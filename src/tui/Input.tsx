import { Text, useInput } from "ink";
import { useState } from "react";

// A small line editor to replace ink-text-input, adding readline-style word
// navigation and editing. App owns Tab / Esc / arrows-for-history / Ctrl+O / Ctrl+F,
// so this ignores those and only edits text.

const WORD = /\w/;

/** Index of the start of the word to the left of `c` (skip spaces, then the word). */
export function wordLeft(v: string, c: number): number {
  let i = c;
  while (i > 0 && !WORD.test(v[i - 1]!)) i--;
  while (i > 0 && WORD.test(v[i - 1]!)) i--;
  return i;
}

/** Index just past the word to the right of `c`. */
export function wordRight(v: string, c: number): number {
  let i = c;
  while (i < v.length && !WORD.test(v[i]!)) i++;
  while (i < v.length && WORD.test(v[i]!)) i++;
  return i;
}

export interface EditState {
  value: string;
  cursor: number;
}

type Key = {
  leftArrow?: boolean;
  rightArrow?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
};

/** Apply one keypress to the editor state; returns null for keys this editor doesn't handle. */
export function applyEdit(s: EditState, input: string, key: Key): EditState | null {
  const { value: v, cursor: c } = s;
  const del = (from: number, to: number): EditState => ({ value: v.slice(0, from) + v.slice(to), cursor: from });
  const word = key.ctrl || key.meta;

  if (key.leftArrow) return { value: v, cursor: word ? wordLeft(v, c) : Math.max(0, c - 1) };
  if (key.rightArrow) return { value: v, cursor: word ? wordRight(v, c) : Math.min(v.length, c + 1) };
  if (key.meta && input === "b") return { value: v, cursor: wordLeft(v, c) };
  if (key.meta && input === "f") return { value: v, cursor: wordRight(v, c) };
  if (key.ctrl && input === "a") return { value: v, cursor: 0 };
  if (key.ctrl && input === "e") return { value: v, cursor: v.length };
  if (key.ctrl && input === "u") return { value: v.slice(c), cursor: 0 };
  if (key.ctrl && input === "k") return { value: v.slice(0, c), cursor: c };
  if ((key.ctrl && input === "w") || (key.meta && (key.backspace || key.delete))) return del(wordLeft(v, c), c);
  if (key.backspace || key.delete) return c > 0 ? del(c - 1, c) : s;
  if (input && !key.ctrl && !key.meta) return { value: v.slice(0, c) + input + v.slice(c), cursor: c + input.length };
  return null;
}

export function Input({
  value,
  onChange,
  onSubmit,
  focus = true,
  placeholder = "",
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  focus?: boolean;
  placeholder?: string;
}) {
  const [cursor, setCursor] = useState(value.length);
  const c = Math.min(cursor, value.length);

  useInput(
    (input, key) => {
      // keys owned by the app, never text edits
      if (key.tab || key.upArrow || key.downArrow || key.escape || key.pageUp || key.pageDown) return;
      if (key.ctrl && (input === "c" || input === "o" || input === "f")) return;
      if (key.return) return onSubmit?.(value);
      const next = applyEdit({ value, cursor: c }, input, key);
      if (!next) return;
      setCursor(next.cursor);
      if (next.value !== value) onChange(next.value);
    },
    { isActive: focus },
  );

  if (!value) {
    return (
      <Text>
        {focus ? <Text inverse>{placeholder ? placeholder[0] : " "}</Text> : null}
        <Text dimColor>{focus ? placeholder.slice(1) : placeholder}</Text>
      </Text>
    );
  }
  if (!focus) return <Text>{value}</Text>;
  const before = value.slice(0, c);
  const at = value[c] ?? " ";
  const after = value.slice(c + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}
