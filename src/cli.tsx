#!/usr/bin/env bun
import { render } from "ink";
import { Core } from "./core/core.ts";
import type { ProviderId } from "./core/types.ts";
import { App } from "./tui/App.tsx";

const USAGE = `syzygy [project-dir] [--main codex|claude] [-c|--resume]
syzygy doctor          check this machine's setup

Codex and Claude Code in one terminal: one main agent talks to you and
delegates to the other. Starts a new chat; -c/--resume continues the
project's last one. Type /help inside for commands.`;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
if (args[0] === "doctor") {
  const { doctor } = await import("./doctor.ts");
  process.exit(await doctor());
}
const resume = args.includes("-c") || args.includes("--resume");
for (const f of ["-c", "--resume"]) while (args.includes(f)) args.splice(args.indexOf(f), 1);
let main: ProviderId | undefined;
const mi = args.indexOf("--main");
if (mi >= 0) {
  const v = args.splice(mi, 2)[1];
  if (v !== "codex" && v !== "claude") {
    console.error("--main must be codex or claude");
    process.exit(2);
  }
  main = v;
}

const core = new Core();
await core.openProject(args[0] ?? process.cwd(), { resume });
if (main && main !== core.session.mainProvider) {
  await core.updateSettings({ mainProvider: main }, "project");
  await core.newSession(main);
}

const cleanup = () => {
  core.bridge.stop();
};
process.on("exit", cleanup);
process.on("SIGTERM", () => core.shutdown().finally(() => process.exit(0)));

const app = render(<App core={core} />, { exitOnCtrlC: false });
await app.waitUntilExit();
process.exit(0);
