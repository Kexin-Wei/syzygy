import { expect, test } from "bun:test";
import { formatTokens, usageNote } from "./core.ts";

test("formats token counts", () => {
  expect(formatTokens(950)).toBe("950");
  expect(formatTokens(12_400)).toBe("12k");
  expect(formatTokens(1_250_000)).toBe("1.3M");
});

test("usage note names both agents", () => {
  expect(usageNote("codex", "claude", { codex: 2_000_000, claude: 30_000 })).toBe(
    "[syzygy] tokens used in the last 5h: Codex (you) 2.0M, Claude Code (subagent) 30k.",
  );
});
