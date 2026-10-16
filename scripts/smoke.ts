// Live check: resolve default intents, run one turn on each provider.
// Usage: bun scripts/smoke.ts [codex|claude]
import { DEFAULT_INTENTS, resolveIntent } from "../src/core/models.ts";
import type { ProviderAdapter } from "../src/core/types.ts";
import { ClaudeAdapter } from "../src/providers/claude/adapter.ts";
import { CodexAdapter } from "../src/providers/codex/adapter.ts";

const only = process.argv[2];
const cwd = process.cwd();

async function run(adapter: ProviderAdapter) {
  const resolved = resolveIntent(DEFAULT_INTENTS[adapter.id], await adapter.listModels());
  console.log(`\n[${adapter.id}] resolved`, resolved);
  const session = await adapter.startSession({ cwd, resolved });
  let deltas = 0;
  for await (const ev of session.send([{ type: "text", text: "Reply with exactly: pong" }])) {
    if (ev.kind === "text-delta") deltas++;
    else console.log(`[${adapter.id}]`, ev);
  }
  console.log(`[${adapter.id}] session=${session.sessionId} deltas=${deltas}`);
  await session.close();
  await adapter.dispose();
}

if (only !== "claude") await run(await CodexAdapter.create());
if (only !== "codex") await run(new ClaudeAdapter());
