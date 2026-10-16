import type { ProviderId } from "../core/types.ts";

export const PROVIDER_COLOR: Record<ProviderId, string> = { codex: "green", claude: "#d97757" };
export const PROVIDER_LABEL: Record<ProviderId, string> = { codex: "codex", claude: "claude" };

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function clip(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`].join("\n");
}
