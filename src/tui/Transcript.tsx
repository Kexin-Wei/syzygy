import { Box, Static, Text } from "ink";
import type { ProviderId } from "../core/types.ts";
import { clip, PROVIDER_COLOR, PROVIDER_LABEL } from "./theme.ts";

export type Entry =
  | { id: string; kind: "user"; text: string; attachments?: string[] }
  | { id: string; kind: "assistant"; provider: ProviderId; text: string; model?: string; status?: string }
  | { id: string; kind: "subagent"; provider: ProviderId; text: string; subId: string; model?: string; status?: string }
  | { id: string; kind: "tools"; who: "main" | "subagent"; items: ToolCall[] }
  | { id: string; kind: "system"; text: string };

export interface ToolCall {
  name: string;
  detail: string;
}

/** "Bash ×3, Read" */
export function toolCounts(items: ToolCall[]): string {
  const counts = new Map<string, number>();
  for (const t of items) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
}

/** Folded: one line per run of tool calls. Expanded (Ctrl+O): every call with its full command. */
export function ToolGroup({ items, expanded, indent = "  ", live = false }: { items: ToolCall[]; expanded: boolean; indent?: string; live?: boolean }) {
  if (!items.length) return null;
  const one = (t: ToolCall) => `${t.name} ${t.detail.replace(/\s+/g, " ")}`;
  if (!expanded) {
    const last = items.at(-1)!;
    return (
      <Text dimColor wrap="truncate-end">
        {indent}⚙ {items.length === 1 ? one(last) : `${items.length} tool calls · ${toolCounts(items)}${live ? ` · ${one(last)}` : ""}`}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      {items.map((t, i) => (
        <Box key={i} flexDirection="column">
          <Text dimColor>
            {indent}⚙ <Text bold>{t.name}</Text>
          </Text>
          <Box marginLeft={indent.length + 4}>
            <Text dimColor>{clip(t.detail, 30)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function EntryView({ e, expanded }: { e: Entry; expanded: boolean }) {
  switch (e.kind) {
    case "user":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            › you
          </Text>
          <Text>{e.text}</Text>
          {e.attachments?.map((a) => (
            <Text key={a} dimColor>
              {"  📎 "}
              {a}
            </Text>
          ))}
        </Box>
      );
    case "assistant":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={PROVIDER_COLOR[e.provider]} bold>
            ◆ {PROVIDER_LABEL[e.provider]}
            {e.model ? <Text dimColor> {e.model}</Text> : null}
            {e.status && e.status !== "completed" ? <Text color="red"> [{e.status}]</Text> : null}
          </Text>
          <Text>{e.text}</Text>
        </Box>
      );
    case "subagent":
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2} borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text color="magenta" bold>
            ↳ subagent {e.subId} · {PROVIDER_LABEL[e.provider]}
            {e.model ? ` ${e.model}` : ""}
            {e.status && e.status !== "completed" ? <Text color="red"> [{e.status}]</Text> : null}
          </Text>
          <Text>{clip(e.text, 14)}</Text>
        </Box>
      );
    case "tools":
      return <ToolGroup items={e.items} expanded={expanded} indent={e.who === "subagent" ? "    ↳ " : "  "} />;
    case "system":
      return (
        <Text color="yellow" dimColor>
          {"  "}
          {e.text}
        </Text>
      );
  }
}

/** Finished entries render once into scrollback; `epoch` remounts after a session switch or a fold toggle. */
export function Transcript({ entries, epoch, expanded = false }: { entries: Entry[]; epoch: number; expanded?: boolean }) {
  return (
    <Static key={epoch} items={entries}>
      {(e) => <EntryView key={e.id} e={e} expanded={expanded} />}
    </Static>
  );
}
