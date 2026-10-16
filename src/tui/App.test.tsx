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
    async updateSettings(patch: Partial<Settings>) {
      settings = { ...settings, ...patch };
    },
    async send(input: unknown[]) {
      sent.push(input);
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

test("tool calls fold into one line; Ctrl+O shows every command", async () => {
  const { core } = fakeCore();
  const { lastFrame, frames, stdin, unmount } = render(<App core={core} />);
  await tick();
  const ee = core as unknown as EventEmitter;
  for (const cmd of ["git status", "gh pr view 35", "git fetch origin"]) ee.emit("main", { kind: "tool", name: "Bash", detail: cmd, status: "started" });
  ee.emit("main", { kind: "tool", name: "Read", detail: "/repo/AGENTS.md", status: "started" });
  await tick();
  expect(lastFrame()).toContain("4 tool calls · Bash ×3, Read · Read /repo/AGENTS.md"); // live line shows the latest call
  ee.emit("main", { kind: "turn-complete", text: "done", status: "completed" });
  await tick();
  const folded = frames.join("\n");
  expect(folded).toContain("4 tool calls · Bash ×3, Read");
  expect(folded).not.toContain("gh pr view 35");
  await type(stdin, "\x0f"); // Ctrl+O
  const expanded = frames.join("\n");
  expect(expanded).toContain("gh pr view 35");
  expect(expanded).toContain("/repo/AGENTS.md");
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
