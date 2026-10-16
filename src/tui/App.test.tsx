import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type { Core } from "../core/core.ts";
import { DEFAULT_SETTINGS, type Settings } from "../store/db.ts";
import { App } from "./App.tsx";

const dir = mkdtempSync(join(tmpdir(), "syzygy-app-"));
mkdirSync(join(dir, "src"));
writeFileSync(join(dir, "src", "main.ts"), "");
writeFileSync(join(dir, "README.md"), "");

const KEY = { up: "\x1b[A", down: "\x1b[B", tab: "\t", shiftTab: "\x1b[Z", enter: "\r", esc: "\x1b" };
const tick = () => new Promise((r) => setTimeout(r, 30));

/** Just enough of Core for the chat screen. */
function fakeCore() {
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const sent: unknown[] = [];
  const core = Object.assign(new EventEmitter(), {
    project: { id: 1, name: "proj", path: dir },
    session: { id: "s1", projectId: 1, title: "t", mainProvider: "codex", mainSessionId: null, mainModel: null, archived: false, createdAt: 0, updatedAt: 0 },
    store: { messages: () => [] },
    usage: () => ({ codex: null, claude: null }),
    busy: false,
    async interrupt() {},
    async updateSettings(patch: Partial<Settings>) {
      settings = { ...settings, ...patch };
    },
    async send(input: unknown[]) {
      sent.push(input);
    },
    /** what the real core does when a turn starts or ends */
    setBusy(b: boolean) {
      core.busy = b;
      core.emit("busy", b);
    },
  });
  Object.defineProperty(core, "settings", { get: () => settings }); // Object.assign would snapshot a getter
  return { core: core as unknown as Core, sent };
}

async function type(stdin: { write: (s: string) => void }, ...keys: string[]) {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

test("@ shows file suggestions, arrows select, Tab accepts", async () => {
  const { core } = fakeCore();
  const { stdin, lastFrame, unmount } = render(<App core={core} />);
  await tick();
  await type(stdin, "see @");
  expect(lastFrame()).toContain("› src/");
  expect(lastFrame()).toContain("README.md");
  await type(stdin, KEY.down);
  expect(lastFrame()).toContain("› README.md");
  await type(stdin, KEY.tab);
  expect(lastFrame()).toContain("see @README.md");
  unmount();
});

test("Enter accepts a folder suggestion instead of sending, then sends", async () => {
  const { core, sent } = fakeCore();
  const { stdin, lastFrame, unmount } = render(<App core={core} />);
  await tick();
  await type(stdin, "see @sr", KEY.enter);
  expect(lastFrame()).toContain("› src/main.ts");
  expect(sent).toHaveLength(0);
  await type(stdin, KEY.enter, KEY.enter);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContainEqual({ type: "file", path: join(dir, "src/main.ts") });
  unmount();
});

test("@name finds files in nested folders", async () => {
  const { core } = fakeCore();
  const { stdin, lastFrame, unmount } = render(<App core={core} />);
  await tick();
  await type(stdin, "see @main", KEY.tab);
  expect(lastFrame()).toContain("see @src/main.ts");
  unmount();
});

test("tool calls fold to one line each; Ctrl+O shows full commands", async () => {
  const { core } = fakeCore();
  const { lastFrame, frames, stdin, unmount } = render(<App core={core} />);
  await tick();
  const ee = core as unknown as EventEmitter;
  const tool = (name: string, detail: string) => ee.emit("main", { kind: "tool", name, detail, status: "started" });
  tool("Bash", "git status\necho second-line");
  for (let i = 1; i <= 13; i++) tool("Bash", `step ${i}`);
  tool("Read", "/repo/AGENTS.md");
  await tick();
  // live: header plus the latest calls
  expect(lastFrame()).toContain("15 tool calls · Bash ×14, Read");
  expect(lastFrame()).toContain("… 9 earlier");
  expect(lastFrame()).toContain("Read /repo/AGENTS.md");
  ee.emit("main", { kind: "turn-complete", text: "done", status: "completed" });
  await tick();
  const folded = frames.join("\n");
  expect(folded).toContain("Bash git status echo second-line"); // one line per call
  expect(folded).toContain("… 3 more · Ctrl+O to expand");
  await type(stdin, "\x0f"); // Ctrl+O
  const expanded = frames.join("\n");
  expect(expanded).toMatch(/git status\n\s+echo second-line/); // full multi-line command
  expect(expanded).toContain("step 13");
  unmount();
});

test("a turn shows text and tool calls in the order they happened", async () => {
  const { core } = fakeCore();
  const { frames, unmount } = render(<App core={core} />);
  await tick();
  const ee = core as unknown as EventEmitter;
  ee.emit("main", { kind: "text-delta", text: "Checking the branches." });
  ee.emit("main", { kind: "tool", name: "shell", detail: "git fetch origin", status: "started" });
  ee.emit("main", { kind: "tool", name: "shell", detail: "gh pr view 34", status: "started" });
  ee.emit("main", { kind: "text-delta", text: "\n\nBoth PRs are stale." });
  ee.emit("main", { kind: "turn-complete", text: "Both PRs are stale.", status: "completed" });
  await tick();
  const out = frames.at(-1)!;
  const at = (s: string) => out.indexOf(s);
  expect(at("Checking the branches.")).toBeGreaterThan(-1);
  expect(at("Checking the branches.")).toBeLessThan(at("2 tool calls"));
  expect(at("gh pr view 34")).toBeLessThan(at("Both PRs are stale."));
  expect(out.match(/◆ codex/g)).toHaveLength(1); // one header per turn
  expect(out.match(/Both PRs are stale\./g)).toHaveLength(1);
  unmount();
});

test("messages sent while busy are queued and go out when the turn ends", async () => {
  const { core, sent } = fakeCore();
  const fake = core as unknown as { setBusy(b: boolean): void };
  const { stdin, lastFrame, unmount } = render(<App core={core} />);
  await tick();
  fake.setBusy(true);
  await type(stdin, "first", KEY.enter, "second", KEY.enter);
  expect(sent).toHaveLength(0);
  expect(lastFrame()).toContain("⏳ first");
  expect(lastFrame()).toContain("⏳ second");
  fake.setBusy(false);
  await tick();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContainEqual({ type: "text", text: "first" });
  expect(lastFrame()).not.toContain("⏳ first");
  fake.setBusy(true);
  await tick();
  fake.setBusy(false);
  await tick();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toContainEqual({ type: "text", text: "second" });
  unmount();
});

test("Esc while busy returns queued messages to the input", async () => {
  const { core, sent } = fakeCore();
  const fake = core as unknown as { setBusy(b: boolean): void };
  const { stdin, lastFrame, unmount } = render(<App core={core} />);
  await tick();
  fake.setBusy(true);
  await type(stdin, "fix the tests", KEY.enter, KEY.esc);
  expect(lastFrame()).not.toContain("⏳");
  expect(lastFrame()).toContain("… fix the tests"); // back in the input box (busy prompt)
  fake.setBusy(false);
  await tick();
  expect(sent).toHaveLength(0);
  unmount();
});

test("Esc dismisses suggestions", async () => {
  const { core } = fakeCore();
  const { stdin, lastFrame, unmount } = render(<App core={core} />);
  await tick();
  await type(stdin, "@", KEY.esc);
  expect(lastFrame()).not.toContain("README.md");
  unmount();
});

test("Shift+Tab toggles approvals", async () => {
  const { core } = fakeCore();
  const { stdin, lastFrame, unmount } = render(<App core={core} />);
  await tick();
  expect(lastFrame()).toContain("approvals ask");
  await type(stdin, KEY.shiftTab);
  expect(core.settings.approvals).toBe("auto");
  expect(lastFrame()).toContain("approvals auto");
  await type(stdin, KEY.shiftTab);
  expect(core.settings.approvals).toBe("ask");
  unmount();
});
