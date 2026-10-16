import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/db.ts";
import { Core, formatPct, pickMain, usageNote } from "./core.ts";

const u = (fiveHour: number | null, weekly: number | null = null) => ({ fiveHour, weekly, at: 0 });

test("formats percentages", () => {
  expect(formatPct(17.4)).toBe("17%");
  expect(formatPct(null)).toBe("?");
});

test("usage note shows 5h and weekly limits for both agents", () => {
  expect(usageNote("codex", "claude", { codex: u(40, 22), claude: u(30, 39) })).toBe(
    "[syzygy] subscription usage (5h / weekly limit): Codex (you) 40% / 22%, Claude Code (subagent) 30% / 39%.",
  );
  expect(usageNote("codex", "claude", { codex: u(40), claude: null })).toContain("Claude Code (subagent) ? / ?");
});

test("picks the provider using less of its 5h limit once usage matters", () => {
  expect(pickMain({ codex: u(46), claude: u(17) }, "codex")).toBe("claude");
  expect(pickMain({ codex: u(12), claude: u(60) }, "claude")).toBe("codex");
  expect(pickMain({ codex: u(8), claude: u(1) }, "codex")).toBe("codex"); // below the floor
  expect(pickMain({ codex: u(80), claude: null }, "codex")).toBe("codex"); // unknown: keep the default
});

test("note turns into a rule past a 2x gap", () => {
  expect(usageNote("codex", "claude", { codex: u(46), claude: u(17) })).toContain("delegate every multi-step part");
  expect(usageNote("codex", "claude", { codex: u(10), claude: u(40) })).toContain("do the work yourself");
  expect(usageNote("codex", "claude", { codex: u(30), claude: u(20) })).not.toContain("Rule");
  expect(usageNote("codex", "claude", { codex: u(6), claude: u(0) })).not.toContain("Rule"); // below the floor
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
