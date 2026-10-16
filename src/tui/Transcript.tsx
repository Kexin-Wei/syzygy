import { Box, Static, Text } from "ink";
import type { ProviderId } from "../core/types.ts";
import { clip, PROVIDER_COLOR, PROVIDER_LABEL } from "./theme.ts";

export type Entry =
  | { id: string; kind: "user"; text: string; attachments?: string[] }
  | { id: string; kind: "assistant"; provider: ProviderId; text: string; model?: string; status?: string }
  | { id: string; kind: "subagent"; provider: ProviderId; text: string; subId: string; model?: string; status?: string }
  | { id: string; kind: "tool"; who: "main" | "subagent"; name: string; detail: string }
  | { id: string; kind: "system"; text: string };

function EntryView({ e }: { e: Entry }) {
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
    case "tool":
      return (
        <Text dimColor>
          {e.who === "subagent" ? "    ↳ " : "  "}⚙ {e.name} {e.detail.replace(/\s+/g, " ").slice(0, 100)}
        </Text>
      );
    case "system":
      return (
        <Text color="yellow" dimColor>
          {"  "}
          {e.text}
        </Text>
      );
  }
}

/** Finished entries render once into scrollback; `epoch` remounts after a session switch. */
export function Transcript({ entries, epoch }: { entries: Entry[]; epoch: number }) {
  return (
    <Static key={epoch} items={entries}>
      {(e) => <EntryView key={e.id} e={e} />}
    </Static>
  );
}
