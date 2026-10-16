import { expect, test } from "bun:test";
import { codexUsage, unwrapShell } from "./adapter.ts";

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

test("reads account usage from a rate-limit snapshot", () => {
  const snap = {
    primary: { usedPercent: 46, windowDurationMins: 300, resetsAt: 1 },
    secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 2 },
  } as any;
  expect(codexUsage(snap, 5)).toEqual({ fiveHour: 46, weekly: 22, at: 5 });
  expect(codexUsage({ primary: null, secondary: null } as any)).toBeNull();
});
