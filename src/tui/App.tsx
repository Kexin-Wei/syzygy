import { Box, Text, useApp, useInput, usePaste, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";
import type { Core, PendingApproval } from "../core/core.ts";
import { completePath, parseInput } from "../core/input.ts";
import { memoryPath, readMemory } from "../core/memory.ts";
import type { ProviderId, UserInput } from "../core/types.ts";
import type { MessageRow, SessionRow } from "../store/db.ts";
import { ListPicker } from "./ListPicker.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { type LiveSubView, SubPanel } from "./SubPanel.tsx";
import { ago, PROVIDER_COLOR } from "./theme.ts";
import { type Entry, Transcript } from "./Transcript.tsx";

type Mode = "chat" | "sessions" | "archived" | "projects" | "model";

const HELP = `Commands
  /new [codex|claude]   new session (optionally with a different main agent)
  /sessions             switch session (a = archive)      /archived  browse archive (a = restore)
  /archive              archive this session              /projects  switch project
  /project <path>       open a folder as a project        /model     models, effort, approvals
  /main codex|claude    set the default main agent and start a new session
  /paste                attach the clipboard image        /approvals ask|auto
  /remember <note>      add to shared project memory      /memory    show project memory
  /help  /quit
Keys
  Enter send · Tab complete @path (or toggle subagent panel) · Esc interrupt (denies pending approvals) · Ctrl+C quit
  Approval prompts: y allow · n deny
Attach files with @path, @"path with spaces", or drag a file into the terminal.`;

let seq = 0;
const nid = () => `e${++seq}`;

function rowsToEntries(rows: MessageRow[], provider: ProviderId): Entry[] {
  return rows.map((m): Entry => {
    if (m.role === "user") return { id: nid(), kind: "user", text: m.text, attachments: m.meta.attachments as string[] | undefined };
    if (m.role === "assistant") return { id: nid(), kind: "assistant", provider, text: m.text, model: m.meta.model as string, status: m.meta.status as string };
    if (m.role === "subagent")
      return { id: nid(), kind: "subagent", provider: m.meta.provider as ProviderId, text: m.text, subId: String(m.meta.subtaskId), model: m.meta.model as string, status: m.meta.status as string };
    return { id: nid(), kind: "system", text: m.text };
  });
}

export function App({ core }: { core: Core }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [session, setSession] = useState<SessionRow>(core.session);
  const [entries, setEntries] = useState<Entry[]>(() => rowsToEntries(core.store.messages(core.session.id), core.session.mainProvider));
  const [epoch, setEpoch] = useState(0);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [subs, setSubs] = useState<Record<string, LiveSubView>>({});
  const [showSubs, setShowSubs] = useState(true);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  // mirrors `approvals` synchronously so fast keypresses never act on a stale list
  const approvalsRef = useRef<PendingApproval[]>([]);
  const [input, setInput] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [pending, setPending] = useState<UserInput[]>([]);
  const [mode, setMode] = useState<Mode>("chat");
  const [, setTick] = useState(0);
  const [status, setStatus] = useState("");
  const [model, setModel] = useState<string>(core.session.mainModel ?? "");
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);

  const push = (...e: Entry[]) => setEntries((prev) => [...prev, ...e]);
  const sys = (text: string) => push({ id: nid(), kind: "system", text });
  const setInputText = (t: string) => {
    setInput(t);
    setInputKey((k) => k + 1); // remount so the cursor lands at the end
  };

  useEffect(() => {
    const onMain = (ev: Parameters<Parameters<typeof core.on<"main">>[1]>[0]) => {
      if (ev.kind === "text-delta") setStreaming((s) => s + ev.text);
      else if (ev.kind === "session") setModel(ev.model);
      else if (ev.kind === "tool" && ev.status === "started" && !ev.name.startsWith("mcp__syzygy") && ev.name !== "syzygy.delegate")
        push({ id: nid(), kind: "tool", who: "main", name: ev.name, detail: ev.detail });
      else if (ev.kind === "turn-complete") {
        setStreaming("");
        push({
          id: nid(),
          kind: "assistant",
          provider: core.session.mainProvider,
          text: ev.text || ev.error || "",
          model: core.mainResolved?.model,
          status: ev.status,
        });
        if (ev.error && ev.text) sys(ev.error);
      }
    };
    const onSubStart = (row: any) => setSubs((p) => ({ ...p, [row.id]: { row, tools: [], text: "" } }));
    const onSub = (id: string, ev: any) =>
      setSubs((p) => {
        const s = p[id];
        if (!s) return p;
        if (ev.kind === "text-delta") return { ...p, [id]: { ...s, text: s.text + ev.text } };
        if (ev.kind === "tool" && ev.status === "started") return { ...p, [id]: { ...s, tools: [...s.tools, `${ev.name} ${ev.detail.replace(/\s+/g, " ")}`] } };
        return p;
      });
    const onSubEnd = (row: any) => {
      setSubs((p) => {
        const { [row.id]: _, ...rest } = p;
        return rest;
      });
      push({ id: nid(), kind: "subagent", provider: row.provider, text: row.result || "", subId: row.id, model: row.model, status: row.status });
    };
    const onApproval = (a: PendingApproval) => {
      approvalsRef.current = [...approvalsRef.current, a];
      setApprovals(approvalsRef.current);
    };
    const onApprovalResolved = (id: string) => {
      approvalsRef.current = approvalsRef.current.filter((a) => a.id !== id);
      setApprovals(approvalsRef.current);
    };
    const onStatus = (s: string) => setStatus(s);
    const onBusy = (b: boolean) => setBusy(b);
    const onSession = (s: SessionRow) => {
      stdout.write("\x1b[2J\x1b[3J\x1b[H");
      setSession(s);
      setModel(s.mainModel ?? "");
      setEntries(rowsToEntries(core.store.messages(s.id), s.mainProvider));
      setEpoch((e) => e + 1);
      setSubs({});
      setStreaming("");
    };
    core.on("main", onMain);
    core.on("sub-start", onSubStart);
    core.on("sub", onSub);
    core.on("sub-end", onSubEnd);
    core.on("approval", onApproval);
    core.on("approval-resolved", onApprovalResolved);
    core.on("status", onStatus);
    core.on("busy", onBusy);
    core.on("session", onSession);
    return () => {
      core.off("main", onMain);
      core.off("sub-start", onSubStart);
      core.off("sub", onSub);
      core.off("sub-end", onSubEnd);
      core.off("approval", onApproval);
      core.off("approval-resolved", onApprovalResolved);
      core.off("status", onStatus);
      core.off("busy", onBusy);
      core.off("session", onSession);
    };
  }, []);

  const quit = async () => {
    await core.shutdown();
    exit();
  };

  const run = (p: Promise<unknown>) => p.catch((e) => sys(`error: ${e.message ?? e}`));

  async function command(line: string): Promise<void> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
        return sys(HELP);
      case "quit":
      case "exit":
        return quit();
      case "new":
        if (arg && arg !== "codex" && arg !== "claude") return sys("usage: /new [codex|claude]");
        return core.newSession((arg || undefined) as ProviderId | undefined);
      case "main":
        if (arg !== "codex" && arg !== "claude") return sys("usage: /main codex|claude");
        await core.updateSettings({ mainProvider: arg });
        return core.newSession(arg);
      case "sessions":
        return setMode("sessions");
      case "archived":
        return setMode("archived");
      case "archive":
        return core.setArchived(core.session.id, true);
      case "projects":
        return setMode("projects");
      case "project":
        if (!arg) return sys("usage: /project <path>");
        return core.openProject(arg.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
      case "model":
      case "models":
        return setMode("model");
      case "approvals":
        if (arg !== "ask" && arg !== "auto") return sys(`approvals: ${core.settings.approvals} (usage: /approvals ask|auto)`);
        await core.updateSettings({ approvals: arg });
        return sys(`approvals: ${arg}`);
      case "paste": {
        const att = await core.pasteImage();
        setPending((p) => [...p, att]);
        return sys(`attached ${(att as { path: string }).path}`);
      }
      case "remember":
        if (!arg) return sys("usage: /remember <note>");
        return sys(`saved to ${core.remember(arg)}`);
      case "memory": {
        const m = readMemory(core.project.path);
        return sys(m ? m : `no shared memory yet (${memoryPath(core.project.path)}); add with /remember`);
      }
      default:
        return sys(`unknown command /${cmd} (try /help)`);
    }
  }

  function submit(text: string) {
    const line = text.trim();
    if (!line && !pending.length) return;
    setInputText("");
    if (line) history.current.unshift(line);
    histIdx.current = -1;
    if (line.startsWith("/")) return void run(command(line));
    if (busy) return sys("agent is working; Esc to interrupt");
    const parsed = parseInput(line, core.project.path);
    const all = [...parsed.input, ...pending];
    const attachments = all.filter((i) => i.type !== "text").map((i) => (i as { path: string }).path);
    setPending([]);
    push({ id: nid(), kind: "user", text: line, attachments });
    setStatus("");
    void run(core.send(all));
  }

  usePaste(
    (text) => {
      // drag-and-drop pastes a path; keep it inline so parseInput attaches it
      const t = text.replace(/\r?\n$/, "");
      setInputText(input + (input && !input.endsWith(" ") ? " " : "") + t);
    },
    { isActive: mode === "chat" && approvals.length === 0 },
  );

  // always active, so a stuck prompt or open picker never traps the user
  useInput((ch, key) => {
    if (key.ctrl && ch === "c") void quit();
  });

  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "c") return;
      const a = approvalsRef.current[0];
      if (a) {
        if (ch === "y" || ch === "n") core.resolveApproval(a.id, ch === "y");
        else if (key.escape) {
          void run(core.interrupt()); // denies pending approvals too
          sys("interrupting…");
        }
        return;
      }
      if (key.escape && busy) {
        void run(core.interrupt());
        return sys("interrupting…");
      }
      if (key.tab) {
        const c = completePath(input, core.project.path);
        if (c) {
          setInputText(c.text);
          if (c.options.length) setStatus(c.options.join("  "));
        } else setShowSubs((v) => !v);
        return;
      }
      if (key.upArrow && history.current.length) {
        histIdx.current = Math.min(history.current.length - 1, histIdx.current + 1);
        return setInputText(history.current[histIdx.current]!);
      }
      if (key.downArrow) {
        histIdx.current = Math.max(-1, histIdx.current - 1);
        return setInputText(histIdx.current < 0 ? "" : history.current[histIdx.current]!);
      }
    },
    { isActive: mode === "chat" },
  );

  const settings = core.settings;
  const mainIntent = settings.main[session.mainProvider];
  const subIntent = settings.sub[session.mainProvider];
  const liveSubs = Object.values(subs);

  let overlay = null;
  if (mode === "model") {
    overlay = (
      <ModelPicker
        core={core}
        onDone={(msg) => {
          setMode("chat");
          if (!msg) return;
          sys(msg);
          if (core.settings.mainProvider !== core.session.mainProvider) {
            if (core.store.messages(core.session.id).length === 0) void run(core.newSession());
            else sys(`this session stays on ${core.session.mainProvider}; /new to start one with ${core.settings.mainProvider}`);
          }
        }}
      />
    );
  } else if (mode === "sessions" || mode === "archived") {
    const archived = mode === "archived";
    overlay = (
      <ListPicker
        title={archived ? `Archived sessions · ${core.project.name}` : `Sessions · ${core.project.name}`}
        items={core.store.listSessions(core.project.id, archived).map((s) => ({
          key: s.id,
          label: `${s.id === session.id ? "● " : ""}${s.title}`,
          hint: `${s.mainProvider} · ${ago(s.updatedAt)}`,
        }))}
        footer={archived ? "Enter restore & open · a restore · Esc back" : "Enter open · a archive · Esc back"}
        onPick={(it) => {
          setMode("chat");
          void run(core.resumeSession(it.key));
        }}
        onKey={(ch, it) => {
          if (ch !== "a" || !it) return;
          void run(core.setArchived(it.key, !archived)).then(() => setTick((t) => t + 1));
        }}
        onCancel={() => setMode("chat")}
      />
    );
  } else if (mode === "projects") {
    overlay = (
      <ListPicker
        title="Projects"
        items={core.store.listProjects().map((p) => ({ key: p.path, label: p.name, hint: p.path }))}
        footer="Enter open · Esc back · /project <path> to add"
        onPick={(it) => {
          setMode("chat");
          void run(core.openProject(it.key));
        }}
        onCancel={() => setMode("chat")}
      />
    );
  }

  const approval = approvals[0];

  return (
    <Box flexDirection="column">
      <Transcript entries={entries} epoch={epoch} />
      {streaming ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={PROVIDER_COLOR[session.mainProvider]} bold>
            ◆ {session.mainProvider}
          </Text>
          <Text>{streaming}</Text>
        </Box>
      ) : null}
      {showSubs ? <SubPanel subs={liveSubs} /> : liveSubs.length ? <Text color="magenta">↳ {liveSubs.length} subagent(s) working (Tab to show)</Text> : null}
      {approval ? (
        <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">
            Approve {approval.who === "main" ? "main agent" : "subagent"} ({approval.provider}) {approval.kind}?
          </Text>
          <Text>{approval.detail}</Text>
          <Text dimColor>y allow · n deny{approvals.length > 1 ? ` · ${approvals.length - 1} more queued` : ""}</Text>
        </Box>
      ) : null}
      {overlay}
      {mode === "chat" ? (
        <Box flexDirection="column" marginTop={1}>
          {pending.length ? (
            <Text dimColor>
              📎 {pending.map((p) => (p as { path: string }).path.split("/").pop()).join(", ")}
            </Text>
          ) : null}
          <Box borderStyle="round" borderColor={busy ? "gray" : "cyan"} paddingX={1}>
            <Text color="cyan">{busy ? "… " : "› "}</Text>
            <TextInput
              key={inputKey}
              value={input}
              onChange={setInput}
              onSubmit={submit}
              focus={!approval}
              placeholder={busy ? "working… (Esc to interrupt)" : "message, @file, /help"}
            />
          </Box>
        </Box>
      ) : null}
      <Box justifyContent="space-between">
        <Text dimColor wrap="truncate-end">
          {core.project.name} · <Text color={PROVIDER_COLOR[session.mainProvider]}>{session.mainProvider}</Text> {model || mainIntent.family}/{mainIntent.effort}
          {" → sub "}
          <Text color={PROVIDER_COLOR[subIntent.provider]}>{subIntent.provider}</Text> {subIntent.family}/{subIntent.effort} · approvals {settings.approvals}
        </Text>
        <Text dimColor wrap="truncate-start">
          {status}
        </Text>
      </Box>
    </Box>
  );
}
