// Live delegation round trip in a throwaway project.
// Usage: bun scripts/delegate.ts <main: codex|claude> [sub family, e.g. sonnet|sol] (SYZ_APPROVALS=auto to test auto approvals)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../src/core/core.ts";
import type { ProviderId } from "../src/core/types.ts";
import { DEFAULT_SETTINGS, Store } from "../src/store/db.ts";

const mainProvider = (process.argv[2] ?? "claude") as ProviderId;
const subFamily = process.argv[3];
const dir = mkdtempSync(join(tmpdir(), "syzygy-delegate-"));
const core = new Core(new Store(":memory:"));

const sub = subFamily
  ? { ...DEFAULT_SETTINGS.sub, [mainProvider]: { provider: /^(opus|sonnet|haiku)/.test(subFamily) ? "claude" : "codex", family: subFamily, effort: "low" } }
  : DEFAULT_SETTINGS.sub;
core.store.saveGlobalSettings({ ...DEFAULT_SETTINGS, mainProvider, sub, allowSubOverride: false, approvals: process.env.SYZ_APPROVALS === "auto" ? "auto" : "ask" });
await core.openProject(dir);

core.on("main", (e) => e.kind !== "text-delta" && console.log("[main]", JSON.stringify(e).slice(0, 300)));
core.on("sub-start", (r) => console.log("[sub-start]", r.id, r.provider, r.model, r.effort));
core.on("sub", (id, e) => e.kind === "tool" && console.log(`[sub ${id}]`, e.name, e.status, e.detail.slice(0, 80)));
core.on("sub-end", (r) => console.log("[sub-end]", r.id, r.status, JSON.stringify(r.result).slice(0, 200)));
core.on("status", (s) => console.log("[status]", s));
core.on("approval", (a) => {
  console.log("[approval]", a.who, a.kind, a.detail.slice(0, 120), "-> allow");
  core.resolveApproval(a.id, true);
});

await core.send([
  {
    type: "text",
    text: "Use the syzygy delegate tool to ask the subagent to create a file hello.txt in the current directory containing exactly 'hi from subagent'. Then read the file yourself and tell me its contents.",
  },
]);

const file = Bun.file(join(dir, "hello.txt"));
console.log("\nhello.txt:", (await file.exists()) ? JSON.stringify(await file.text()) : "MISSING");
console.log("transcript roles:", core.store.messages(core.session.id).map((m) => m.role).join(","));
await core.shutdown();
