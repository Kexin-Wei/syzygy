import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/db.ts";
import { Core, formatTokens, pickMain, usageNote } from "./core.ts";

test("formats token counts", () => {
  expect(formatTokens(950)).toBe("950");
  expect(formatTokens(12_400)).toBe("12k");
  expect(formatTokens(1_250_000)).toBe("1.3M");
});

test("usage note names both agents", () => {
  expect(usageNote("codex", "claude", { codex: 2_000_000, claude: 1_500_000 })).toBe(
    "[syzygy] tokens used in the last 5h: Codex (you) 2.0M, Claude Code (subagent) 1.5M.",
  );
});

test("picks the less-used provider as main once usage matters", () => {
  expect(pickMain({ codex: 1_100_000, claude: 0 }, "codex")).toBe("claude");
  expect(pickMain({ codex: 200_000, claude: 900_000 }, "claude")).toBe("codex");
  expect(pickMain({ codex: 50_000, claude: 0 }, "codex")).toBe("codex"); // below the floor
});

test("note turns into a rule past a 2x gap", () => {
  expect(usageNote("codex", "claude", { codex: 1_100_000, claude: 0 })).toContain("delegate every multi-step part");
  expect(usageNote("codex", "claude", { codex: 0, claude: 400_000 })).toContain("do the work yourself");
  expect(usageNote("codex", "claude", { codex: 300_000, claude: 200_000 })).not.toContain("Rule");
  expect(usageNote("codex", "claude", { codex: 60_000, claude: 0 })).not.toContain("Rule"); // below the floor
});

test("startup opens a new chat unless resuming; untouched chats are reused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syzygy-core-"));
  const core = new Core(new Store(":memory:"));
  try {
    await core.openProject(dir, { resume: false });
    const first = core.session.id;
    await core.openProject(dir, { resume: false });
    expect(core.session.id).toBe(first); // still empty: reuse instead of piling up blank chats
    core.store.addMessage(first, "user", "hi");
    await core.openProject(dir, { resume: false });
    expect(core.session.id).not.toBe(first);
    const second = core.session.id;
    core.store.addMessage(second, "user", "hello");
    await core.openProject(dir, { resume: false }); // leaves a new empty session on top
    await core.openProject(dir, { resume: true });
    expect(core.session.id).toBe(second);
  } finally {
    await core.shutdown();
  }
});
