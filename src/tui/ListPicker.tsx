import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface PickItem {
  key: string;
  label: string;
  hint?: string;
}

export function ListPicker(props: {
  title: string;
  items: PickItem[];
  footer: string;
  onPick: (item: PickItem) => void;
  onKey?: (input: string, item: PickItem | undefined) => void;
  onCancel: () => void;
}) {
  const [i, setI] = useState(0);
  const sel = Math.min(i, Math.max(0, props.items.length - 1));
  useInput((input, key) => {
    if (key.escape) props.onCancel();
    else if (key.upArrow) setI(Math.max(0, sel - 1));
    else if (key.downArrow) setI(Math.min(props.items.length - 1, sel + 1));
    else if (key.return && props.items[sel]) props.onPick(props.items[sel]);
    else if (input) props.onKey?.(input, props.items[sel]);
  });
  const start = Math.max(0, Math.min(sel - 7, props.items.length - 15));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text bold color="blue">
        {props.title}
      </Text>
      {props.items.length === 0 ? <Text dimColor>(empty)</Text> : null}
      {props.items.slice(start, start + 15).map((it, idx) => {
        const active = start + idx === sel;
        return (
          <Text key={it.key} inverse={active} wrap="truncate-end">
            {active ? "› " : "  "}
            {it.label}
            {it.hint ? <Text dimColor> {it.hint}</Text> : null}
          </Text>
        );
      })}
      <Text dimColor>{props.footer}</Text>
    </Box>
  );
}
