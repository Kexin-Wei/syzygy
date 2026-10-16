import { Box, Text } from "ink";
import type { SubtaskRow } from "../store/db.ts";
import { PROVIDER_LABEL } from "./theme.ts";
import { ToolGroup, type ToolCall } from "./Transcript.tsx";

export interface LiveSubView {
  row: SubtaskRow;
  tools: ToolCall[];
  text: string;
}

export function SubPanel({ subs, expanded = false }: { subs: LiveSubView[]; expanded?: boolean }) {
  if (!subs.length) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      {subs.map((s) => (
        <Box key={s.row.id} flexDirection="column">
          <Text color="magenta" bold>
            ↳ {s.row.id} · {PROVIDER_LABEL[s.row.provider]} {s.row.model} · {s.row.effort} · working…
          </Text>
          <Text dimColor wrap="truncate-end">
            task: {s.row.task.replace(/\s+/g, " ")}
          </Text>
          <ToolGroup items={expanded ? s.tools.slice(-10) : s.tools} expanded={expanded} live />
          {s.text ? <Text wrap="truncate-end">{s.text.split("\n").filter(Boolean).slice(-2).join(" ⏎ ")}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}
