import type { Subprocess } from "bun";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { AsyncQueue, readLines } from "../../core/queue.ts";
import { writePrivate } from "../../core/runtime.ts";
import type { AccountUsage, AgentEvent, AgentSession, ModelInfo, ProviderAdapter, SessionOptions, UserInput } from "../../core/types.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Aliases the Claude CLI maps to its newest model, so no list call is needed. */
const MODELS: ModelInfo[] = [
  { id: "opus", displayName: "Opus (latest)", efforts: EFFORTS, isDefault: true, supportsImages: true },
  { id: "sonnet", displayName: "Sonnet (latest)", efforts: EFFORTS, isDefault: false, supportsImages: true },
  { id: "haiku", displayName: "Haiku (latest)", efforts: EFFORTS, isDefault: false, supportsImages: true },
];

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Claude `rate_limit_event` info → percent used of the 5h and weekly windows (it reports 0–1 utilization). */
export function claudeUsage(info: any, at = Date.now()): AccountUsage | null {
  const w = info?.unifiedWindows;
  if (!w) return null;
  const pct = (x: any) => (typeof x?.utilization === "number" ? Math.round(x.utilization * 1000) / 10 : null);
  return { fiveHour: pct(w.five_hour), weekly: pct(w.seven_day), at };
}

/** One readable line per tool call: the command, path or query instead of the raw JSON input. */
export function describeClaudeTool(name: string, input: any): string {
  const i = input ?? {};
  const join = (...parts: unknown[]) => parts.filter((p) => typeof p === "string" && p).join("  in ");
  let s: string;
  switch (name) {
    case "Bash":
      s = String(i.command ?? "");
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      s = String(i.file_path ?? i.notebook_path ?? "");
      break;
    case "Grep":
    case "Glob":
      s = join(i.pattern, i.path);
      break;
    case "WebFetch":
      s = String(i.url ?? "");
      break;
    case "WebSearch":
      s = String(i.query ?? "");
      break;
    case "Task":
    case "Agent":
      s = String(i.description ?? i.prompt ?? "");
      break;
    case "TodoWrite":
      s = `${(i.todos ?? []).length} todos`;
      break;
    default: {
      const first = Object.values(i).find((v) => typeof v === "string");
      s = typeof first === "string" ? first : JSON.stringify(i);
    }
  }
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
}

async function toClaudeContent(input: UserInput[]): Promise<any[]> {
  const out: any[] = [];
  for (const i of input) {
    if (i.type === "text") out.push({ type: "text", text: i.text });
    else if (i.type === "file") out.push({ type: "text", text: `Attached path: @${i.path}` });
    else {
      const ext = i.path.split(".").pop()?.toLowerCase() ?? "";
      const media_type = IMAGE_TYPES[ext];
      if (!media_type) throw new Error(`unsupported image type: ${i.path}`);
      const data = Buffer.from(await Bun.file(i.path).arrayBuffer()).toString("base64");
      out.push({ type: "image", source: { type: "base64", media_type, data } });
    }
  }
  return out;
}

/** One long-lived `claude -p` stream-json process per session. */
class ClaudeSession implements AgentSession {
  readonly provider = "claude" as const;
  model: string;
  private current?: { q: AsyncQueue<AgentEvent>; messages: string[] };
  private stderrTail: string[] = [];
  private exited = false;

  constructor(
    private proc: Subprocess<"pipe", "pipe", "pipe">,
    public sessionId: string,
    requestedModel: string,
    private cleanup: () => void,
  ) {
    this.model = requestedModel;
    const stdoutDone = this.pump();
    this.pumpStderr();
    proc.exited.then(async (code) => {
      await stdoutDone; // a final `result` line may still be buffered
      this.exited = true;
      this.cleanup();
      this.finish({ status: "failed", error: `claude exited (${code}): ${this.stderrTail.join("\n")}` });
    });
  }

  send(input: UserInput[]): AsyncIterable<AgentEvent> {
    if (this.current) throw new Error("a turn is already in progress");
    const q = new AsyncQueue<AgentEvent>();
    this.current = { q, messages: [] };
    if (this.exited) {
      this.finish({ status: "failed", error: "claude process has exited" });
      return q;
    }
    toClaudeContent(input)
      .then((content) => this.write({ type: "user", message: { role: "user", content } }))
      .catch((e: Error) => this.finish({ status: "failed", error: e.message }));
    return q;
  }

  compact(): AsyncIterable<AgentEvent> {
    return this.send([{ type: "text", text: "/compact" }]);
  }

  async interrupt(): Promise<void> {
    if (this.current) this.write({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } });
  }

  async close(): Promise<void> {
    this.finish({ status: "interrupted", error: "session closed" });
    if (!this.exited) {
      this.proc.stdin.end();
      this.proc.kill();
    }
    await this.proc.exited;
  }

  private write(msg: unknown): void {
    if (this.exited) return;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
      this.proc.stdin.flush();
    } catch {
      // process is going away; the exit handler reports it
    }
  }

  private finish(r: { status: "completed" | "interrupted" | "failed"; text?: string; error?: string }): void {
    const cur = this.current;
    if (!cur) return;
    this.current = undefined;
    cur.q.push({ kind: "turn-complete", text: r.text ?? cur.messages.at(-1) ?? "", status: r.status, ...(r.error ? { error: r.error } : {}) });
    cur.q.end();
  }

  private handle(m: any): void {
    const cur = this.current;
    if (m.type === "system" && m.subtype === "init") {
      this.model = m.model;
      if (m.session_id) this.sessionId = m.session_id; // resume may continue under a new id
      cur?.q.push({ kind: "session", sessionId: this.sessionId, model: m.model });
    } else if (m.type === "stream_event") {
      const e = m.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && !m.parent_tool_use_id) {
        cur?.q.push({ kind: "text-delta", text: e.delta.text });
      }
    } else if (m.type === "assistant" && !m.parent_tool_use_id) {
      const text = m.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      if (text) cur?.messages.push(text);
      for (const c of m.message.content) {
        if (c.type === "tool_use") {
          const summary = typeof c.input?.description === "string" ? c.input.description : undefined;
          cur?.q.push({ kind: "tool", name: c.name, detail: describeClaudeTool(c.name, c.input), summary, status: "started" });
        }
      }
    } else if (m.type === "rate_limit_event") {
      const usage = claudeUsage(m.rate_limit_info);
      if (usage) cur?.q.push({ kind: "account-usage", usage });
    } else if (m.type === "result") {
      if (m.session_id) this.sessionId = m.session_id;
      const status = m.subtype === "success" ? "completed" : m.subtype === "error_during_execution" && m.is_error === false ? "interrupted" : "failed";
      this.finish({ status, text: typeof m.result === "string" ? m.result : undefined, ...(status === "failed" ? { error: m.subtype } : {}) });
    }
  }

  private async pump(): Promise<void> {
    for await (const line of readLines(this.proc.stdout)) {
      try {
        this.handle(JSON.parse(line));
      } catch {
        // non-JSON noise from hooks; ignore
      }
    }
  }

  private async pumpStderr(): Promise<void> {
    for await (const line of readLines(this.proc.stderr)) {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    }
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;

  alive(): boolean {
    return true; // no shared backend; each session owns its process
  }

  async listModels(): Promise<ModelInfo[]> {
    return MODELS;
  }

  /** Claude Code reports usage only with a model response, so send the smallest one we can (haiku, no tools). */
  async readUsage(): Promise<AccountUsage | null> {
    const proc = Bun.spawn(["claude", "-p", "ok", "--model", "haiku", "--max-turns", "1", "--tools", "", "--output-format", "stream-json", "--verbose"], {
      cwd: tmpdir(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), 90_000);
    try {
      for await (const line of readLines(proc.stdout)) {
        try {
          const m = JSON.parse(line);
          if (m.type === "rate_limit_event") return claudeUsage(m.rate_limit_info);
        } catch {}
      }
      return null;
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
  }

  async startSession(opts: SessionOptions): Promise<AgentSession> {
    const sessionId = opts.resumeId ?? crypto.randomUUID();
    const args = [
      "claude", "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", opts.resolved.model,
      "--effort", opts.resolved.effort,
      ...(opts.resumeId ? ["--resume", opts.resumeId] : ["--session-id", sessionId]),
    ];
    let configPath: string | undefined;
    if (opts.mcpServers?.length) {
      const mcpServers = Object.fromEntries(opts.mcpServers.map((s) => [s.name, { command: s.command, args: s.args, env: s.env ?? {} }]));
      // a file, not a JSON argument, so the bridge token never appears in the process list
      configPath = writePrivate(`mcp-${crypto.randomUUID()}.json`, JSON.stringify({ mcpServers }));
      args.push("--mcp-config", configPath);
      if (mcpServers.syzygy) {
        // permission prompts go to the syzygy MCP server, which forwards them to the UI
        args.push("--permission-prompt-tool", "mcp__syzygy__approve", "--allowedTools", "mcp__syzygy__delegate", "mcp__syzygy__followup");
      }
    }
    args.push("--permission-mode", opts.approvals === "auto" ? "auto" : "default");
    if (opts.instructions) args.push("--append-system-prompt", opts.instructions);
    const proc = Bun.spawn(args, {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // delegate calls block until the subagent is done
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(6 * 3600_000) },
    });
    return new ClaudeSession(proc, sessionId, opts.resolved.model, () => configPath && rmSync(configPath, { force: true }));
  }

  async dispose(): Promise<void> {}
}
