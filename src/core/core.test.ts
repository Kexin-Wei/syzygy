import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/db.ts";
import type { AgentEvent, AgentSession } from "./types.ts";
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

test("restarts the backend and resends once when it exits before producing output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syzygy-retry-"));
  const core = new Core(new Store(":memory:"));
  await core.openProject(dir, { resume: false });

  // first turn: backend dies immediately; second turn: succeeds
  const scripts: AgentEvent[][] = [
    [{ kind: "turn-complete", text: "", status: "failed", error: "codex app-server exited (0): boom" }],
    [{ kind: "text-delta", text: "hi" }, { kind: "turn-complete", text: "hi there", status: "completed" }],
  ];
  let starts = 0;
  const fakeSession = (events: AgentEvent[]): AgentSession =>
    ({
      provider: "codex",
      sessionId: `thr-${starts}`,
      async *send() {
        yield* events;
      },
      async interrupt() {},
      async close() {},
    }) as unknown as AgentSession;
  const anyCore = core as any;
  anyCore.resolve = async () => ({ provider: "codex", model: "gpt-x", effort: "low" });
  anyCore.adapter = async () => ({ startSession: async () => fakeSession(scripts[starts++]!) });

  const seen: AgentEvent[] = [];
  core.on("main", (e) => seen.push(e));
  await core.send([{ type: "text", text: "do it" }]);

  expect(starts).toBe(2); // started a fresh backend for the retry
  // the user never sees the transient backend-death failure, only the successful answer
  const completes = seen.filter((e) => e.kind === "turn-complete");
  expect(completes).toHaveLength(1);
  expect(completes[0]).toMatchObject({ status: "completed", text: "hi there" });
  const msgs = core.store.messages(core.session.id).filter((m) => m.role === "assistant");
  expect(msgs).toHaveLength(1);
  expect(msgs[0]!.text).toBe("hi there");
  await core.shutdown();
});

test("shows the failure when the backend dies again on the retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syzygy-retry2-"));
  const core = new Core(new Store(":memory:"));
  await core.openProject(dir, { resume: false });
  let starts = 0;
  const anyCore = core as any;
  anyCore.resolve = async () => ({ provider: "codex", model: "gpt-x", effort: "low" });
  anyCore.adapter = async () => ({
    startSession: async () => {
      starts++;
      return {
        provider: "codex",
        sessionId: "t",
        async *send(): AsyncGenerator<AgentEvent> {
          yield { kind: "turn-complete", text: "", status: "failed", error: "codex app-server exited (0): boom" };
        },
        async interrupt() {},
        async close() {},
      } as unknown as AgentSession;
    },
  });
  const seen: AgentEvent[] = [];
  core.on("main", (e) => seen.push(e));
  await core.send([{ type: "text", text: "do it" }]);
  expect(starts).toBe(2); // tried once more, then gave up
  const completes = seen.filter((e) => e.kind === "turn-complete");
  expect(completes).toHaveLength(1);
  expect(completes[0]).toMatchObject({ status: "failed" });
  await core.shutdown();
});

test("compact runs the backend's compaction and records a note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syzygy-compact-"));
  const core = new Core(new Store(":memory:"));
  await core.openProject(dir, { resume: false });
  const anyCore = core as any;
  anyCore.resolve = async () => ({ provider: "codex", model: "gpt-x", effort: "low" });
  anyCore.adapter = async () => ({
    startSession: async () =>
      ({
        provider: "codex",
        sessionId: "t",
        async *send() {},
        async *compact(): AsyncGenerator<AgentEvent> {
          yield { kind: "turn-complete", text: "", status: "completed" };
        },
        async interrupt() {},
        async close() {},
      }) as unknown as AgentSession,
  });
  const r = await core.compact();
  expect(r).toBe("context compacted");
  const sysMsgs = core.store.messages(core.session.id).filter((m) => m.role === "system");
  expect(sysMsgs.at(-1)!.text).toBe("context compacted");
  await core.shutdown();
});

test("compact reports when the backend has no manual compaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syzygy-nocompact-"));
  const core = new Core(new Store(":memory:"));
  await core.openProject(dir, { resume: false });
  const anyCore = core as any;
  anyCore.resolve = async () => ({ provider: "codex", model: "gpt-x", effort: "low" });
  anyCore.adapter = async () => ({
    startSession: async () => ({ provider: "codex", sessionId: "t", async *send() {}, async interrupt() {}, async close() {} }) as unknown as AgentSession,
  });
  expect(await core.compact()).toContain("no manual compaction");
  await core.shutdown();
});
