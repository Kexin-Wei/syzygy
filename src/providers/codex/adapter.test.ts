import { expect, test } from "bun:test";
import { unwrapShell } from "./adapter.ts";

test("strips the login-shell wrapper from codex commands", () => {
  expect(unwrapShell(`/usr/bin/zsh -lc "pwd && rg --files -g 'AGENTS.md'"`)).toBe("pwd && rg --files -g 'AGENTS.md'");
  expect(unwrapShell(`/bin/bash -lc 'tectonic --keep-logs paper.tex'`)).toBe("tectonic --keep-logs paper.tex");
  expect(unwrapShell(`/usr/bin/zsh -lc "echo \\"hi\\" \\$HOME"`)).toBe(`echo "hi" $HOME`);
  // codex joins quoting styles: 'a'"'"'b' → a'b
  expect(unwrapShell(`bash -lc 'a'"'"'b'`)).toBe("a'b");
});

test("leaves other commands alone", () => {
  expect(unwrapShell("git status")).toBe("git status");
  expect(unwrapShell(`/usr/bin/zsh -lc "unterminated`)).toBe(`/usr/bin/zsh -lc "unterminated`);
});
