import type { ModelInfo, ModelIntent, ResolvedModel } from "./types.ts";

export const DEFAULT_INTENTS = {
  codex: { provider: "codex", family: "sol", effort: "low" },
  claude: { provider: "claude", family: "opus", effort: "medium" },
} as const satisfies Record<string, ModelIntent>;

/** Claude CLI resolves these aliases to the newest model itself. */
const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** "gpt-6.1-sol" -> [6, 1]; ids without a version sort last. */
function versionOf(id: string): number[] {
  const m = id.match(/(\d+(?:\.\d+)*)/);
  return m?.[1] ? m[1].split(".").map(Number) : [];
}

function compareVersionsDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function pickEffort(requested: string, supported: string[], fallback?: string): { effort: string; note?: string } {
  if (supported.length === 0 || supported.includes(requested)) return { effort: requested };
  const effort = fallback && supported.includes(fallback) ? fallback : supported[0]!;
  return { effort, note: `effort "${requested}" unsupported, using "${effort}"` };
}

/**
 * Picker options: version-free family names ("sol") for versioned ids, so a
 * stored choice keeps tracking upgrades, plus the exact ids for pinning.
 */
export function familyOptions(models: ModelInfo[]): string[] {
  const families = new Set<string>();
  for (const m of models) {
    if (CLAUDE_ALIASES.has(m.id)) families.add(m.id);
    else if (versionOf(m.id).length) {
      const last = m.id.split(/[-_]/).pop();
      if (last && !/\d/.test(last)) families.add(last);
    }
  }
  return [...families, ...models.map((m) => m.id).filter((id) => !families.has(id))];
}

/**
 * Pick the newest available model in the intent's family. `models` must be the
 * live list for this account (not a cache), so retired or unentitled models
 * are never chosen.
 */
export function resolveIntent(intent: ModelIntent, models: ModelInfo[]): ResolvedModel {
  if (intent.provider === "claude" && CLAUDE_ALIASES.has(intent.family)) {
    return { provider: "claude", model: intent.family, ...pickEffort(intent.effort, CLAUDE_EFFORTS) };
  }

  const family = intent.family.toLowerCase();
  const exact = models.find((m) => m.id === intent.family);
  const candidates = exact
    ? [exact]
    : models
        .filter((m) => m.id.toLowerCase().split(/[-_]/).includes(family))
        .sort((a, b) => compareVersionsDesc(versionOf(a.id), versionOf(b.id)));

  const chosen = candidates[0] ?? models.find((m) => m.isDefault) ?? models[0];
  if (!chosen) return { provider: intent.provider, model: intent.family, effort: intent.effort, note: "no model list available" };

  const { effort, note: effortNote } = pickEffort(intent.effort, chosen.efforts, chosen.defaultEffort);
  const notes = [candidates[0] ? undefined : `no "${intent.family}" model available, using ${chosen.id}`, effortNote].filter(Boolean);
  return { provider: intent.provider, model: chosen.id, effort, ...(notes.length ? { note: notes.join("; ") } : {}) };
}
