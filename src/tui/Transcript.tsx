import { Box, Static, Text } from "ink";
import type { ProviderId } from "../core/types.ts";
import { Markdown } from "./markdown.tsx";
import { clip, PROVIDER_COLOR, PROVIDER_LABEL } from "./theme.ts";

export type Entry =
  | { id: string; kind: "user"; text: string; attachments?: string[] }
  /** `continued`: a later part of the same turn (text after tool calls), shown without the header */
  | { id: string; kind: "assistant"; provider: ProviderId; text: string; model?: string; status?: string; continued?: boolean }
  | { id: string; kind: "subagent"; provider: ProviderId; text: string; subId: string; model?: string; status?: string }
  | { id: string; kind: "tools"; who: "main" | "subagent"; items: ToolCall[] }
  | { id: string; kind: "system"; text: string };

/** Your messages: a shaded block with a cyan bar, so they stand apart from the agents' plain text. */
export function UserMessage({ text, attachments }: { text: string; attachments?: string[] }) {
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="bold" borderTop={false} borderRight={false} borderBottom={false} borderColor="cyan" backgroundColor="blackBright" paddingX={1}>
      <Text>{text}</Text>
      {attachments?.map((a) => (
        <Text key={a} dimColor>
          📎 {a}
        </Text>
      ))}
    </Box>
  );
}

export interface ToolCall {
  name: string;
  detail: string;
  /** the agent's own one-line description of the call, shown instead of the raw command when folded */
  summary?: string;
}

/** "Bash ×3, Read" */
export function toolCounts(items: ToolCall[]): string {
  const counts = new Map<string, number>();
  for (const t of items) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
}

/** Folded rows per group: the first ones in the transcript, the latest ones while still running. */
const FOLDED_ROWS = { done: 12, live: 6 };

/** Folded: one truncated line per call. Expanded (Ctrl+O): every call with its full command. */
export function ToolGroup({ items, expanded, indent = "  ", live = false }: { items: ToolCall[]; expanded: boolean; indent?: string; live?: boolean }) {
  if (!items.length) return null;
  if (!expanded) {
    const max = live ? FOLDED_ROWS.live : FOLDED_ROWS.done;
    const shown = items.length <= max ? items : live ? items.slice(-max) : items.slice(0, max);
    const hidden = items.length - shown.length;
    return (
      <Box flexDirection="column">
        {items.length > 1 ? (
          <Text dimColor>
            {indent}⚙ {items.length} tool calls · {toolCounts(items)}
          </Text>
        ) : null}
        {live && hidden ? <Text dimColor>{indent}  … {hidden} earlier</Text> : null}
        {shown.map((t, i) => (
          <Text key={i} dimColor wrap="truncate-end">
            {indent}
            {items.length > 1 ? "  " : "⚙ "}
            <Text bold>{t.name}</Text> {(t.summary || t.detail).replace(/\s+/g, " ")}
          </Text>
        ))}
        {!live && hidden ? <Text dimColor>{indent}  … {hidden} more · Ctrl+O to expand</Text> : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {items.map((t, i) => (
        <Box key={i} flexDirection="column">
          <Text dimColor>
            {indent}⚙ <Text bold>{t.name}</Text>
            {t.summary ? ` — ${t.summary.replace(/\s+/g, " ")}` : ""}
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
      return <UserMessage text={e.text} attachments={e.attachments} />;
    case "assistant":
      return (
        <Box flexDirection="column" marginTop={e.continued ? 0 : 1}>
          {e.continued ? null : (
            <Text color={PROVIDER_COLOR[e.provider]} bold>
              ◆ {PROVIDER_LABEL[e.provider]}
              {e.model ? <Text dimColor> {e.model}</Text> : null}
            </Text>
          )}
          {e.text ? (
            <Box borderStyle="bold" borderTop={false} borderRight={false} borderBottom={false} borderColor={PROVIDER_COLOR[e.provider]} paddingLeft={1}>
              <Markdown>{e.text}</Markdown>
            </Box>
          ) : null}
          {e.status && e.status !== "completed" ? <Text color="red">{"  "}[{e.status}]</Text> : null}
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
          <Markdown>{clip(e.text, 30)}</Markdown>
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
