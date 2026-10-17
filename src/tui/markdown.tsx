import { Box, Text } from "ink";

// A small markdown renderer for the transcript: headings, bold/italic/code, links,
// fenced code, blockquotes, bullet/numbered lists, and tables. Unknown syntax falls
// back to plain text, and partial (still-streaming) markdown never throws.

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  dim?: boolean;
}

const INLINE = [
  { re: /`([^`]+)`/, style: { code: true } },
  { re: /\*\*([^*]+)\*\*/, style: { bold: true } },
  { re: /__([^_]+)__/, style: { bold: true } },
  { re: /\*([^*\n]+)\*/, style: { italic: true } },
  { re: /(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/, style: { italic: true } },
  { re: /~~([^~]+)~~/, style: { dim: true } },
] as const;

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;

/** Split one line of text into styled spans. Unmatched markers stay literal. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let rest = text;
  while (rest) {
    let best: { index: number; len: number; span: Span; tail: string } | null = null;
    for (const { re, style } of INLINE) {
      const m = re.exec(rest);
      if (m && (best === null || m.index < best.index)) best = { index: m.index, len: m[0].length, span: { text: m[1]!, ...style }, tail: rest.slice(m.index + m[0].length) };
    }
    const lm = LINK.exec(rest);
    if (lm && (best === null || lm.index < best.index)) {
      // render as "text (url)" with the url dimmed
      best = { index: lm.index, len: lm[0].length, span: { text: lm[1]! }, tail: `\u0000${lm[2]}\u0000${rest.slice(lm.index + lm[0].length)}` };
    }
    if (!best) {
      spans.push({ text: rest });
      break;
    }
    if (best.index > 0) spans.push({ text: rest.slice(0, best.index) });
    spans.push(best.span);
    // a link leaves a sentinel-wrapped url to emit dimmed right after the text
    if (best.tail.startsWith("\u0000")) {
      const end = best.tail.indexOf("\u0000", 1);
      spans.push({ text: ` (${best.tail.slice(1, end)})`, dim: true });
      rest = best.tail.slice(end + 1);
    } else {
      rest = best.tail;
    }
  }
  return spans;
}

function Inline({ text }: { text: string }) {
  return (
    <Text>
      {parseInline(text).map((s, i) => (
        <Text key={i} bold={s.bold} italic={s.italic} dimColor={s.dim} color={s.code ? "cyan" : undefined}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lines: string[] }
  | { kind: "quote"; text: string }
  | { kind: "list"; items: { marker: string; text: string }[] }
  | { kind: "table"; rows: string[][]; align: number }
  | { kind: "hr" };

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Parse markdown into blocks. Resilient to partial input. */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```/);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!);
      blocks.push({ kind: "code", lines: code });
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      flush();
      const header = cells(line);
      i += 2;
      const rows = [header];
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      blocks.push({ kind: "table", rows, align: header.length });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: h[1]!.length, text: h[2]! });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "hr" });
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      flush();
      const quote = [q[1]!];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1]!)) quote.push(lines[++i]!.replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const items: { marker: string; text: string }[] = [];
      let j = i;
      let li2: RegExpMatchArray | null = li;
      while (li2) {
        const ordered = /^\d/.test(li2[2]!);
        items.push({ marker: ordered ? li2[2]! : "•", text: li2[3]! });
        j++;
        const next = lines[j];
        li2 = next ? next.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/) : null;
      }
      i = j - 1;
      blocks.push({ kind: "list", items });
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line);
  }
  flush();
  return blocks;
}

/** Visible text of inline markdown, with the markers removed (used for table cells). */
function plainInline(text: string): string {
  return parseInline(text)
    .map((s) => s.text)
    .join("");
}

function Table({ rows }: { rows: string[][] }) {
  const cols = Math.max(...rows.map((r) => r.length));
  const cell = (r: string[], c: number) => plainInline(r[c] ?? "");
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) widths[c] = Math.min(40, Math.max(3, ...rows.map((r) => cell(r, c).length)));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  return (
    <Box flexDirection="column" marginY={0}>
      {rows.map((r, ri) => (
        <Text key={ri} wrap="truncate-end">
          <Text dimColor>│ </Text>
          {Array.from({ length: cols }, (_, c) => (
            <Text key={c}>
              <Text bold={ri === 0}>{pad(cell(r, c), widths[c]!)}</Text>
              <Text dimColor> │ </Text>
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case "heading":
      return (
        <Box marginTop={b.level <= 2 ? 1 : 0}>
          <Text bold color={b.level <= 2 ? "cyan" : undefined}>
            <Inline text={b.text} />
          </Text>
        </Box>
      );
    case "code":
      return (
        <Box flexDirection="column" marginLeft={1} borderStyle="round" borderColor="gray" paddingX={1}>
          {b.lines.length ? b.lines.map((l, i) => <Text key={i} color="cyan">{l || " "}</Text>) : <Text> </Text>}
        </Box>
      );
    case "quote":
      return (
        <Box borderStyle="bold" borderTop={false} borderRight={false} borderBottom={false} borderColor="gray" paddingLeft={1}>
          <Text dimColor>
            <Inline text={b.text} />
          </Text>
        </Box>
      );
    case "list":
      return (
        <Box flexDirection="column">
          {b.items.map((it, i) => (
            <Box key={i}>
              <Text dimColor>{`${it.marker} `}</Text>
              <Text>
                <Inline text={it.text} />
              </Text>
            </Box>
          ))}
        </Box>
      );
    case "table":
      return <Table rows={b.rows} />;
    case "hr":
      return <Text dimColor>────────</Text>;
    default:
      return (
        <Text>
          <Inline text={b.text} />
        </Text>
      );
  }
}

/** Render markdown text as Ink elements. */
export function Markdown({ children }: { children: string }) {
  const blocks = parseBlocks(children);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </Box>
  );
}
