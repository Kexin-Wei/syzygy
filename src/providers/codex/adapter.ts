import { AsyncQueue } from "../../core/queue.ts";
import type {
  AgentEvent,
  AgentSession,
  ApprovalHandler,
  ModelInfo,
  ProviderAdapter,
  SessionOptions,
  UserInput,
} from "../../core/types.ts";
import type { ModelListResponse } from "../../protocol/codex/v2/ModelListResponse.ts";
import type { ThreadStartResponse } from "../../protocol/codex/v2/ThreadStartResponse.ts";
import type { UserInput as CodexUserInput } from "../../protocol/codex/v2/UserInput.ts";
import { CodexRpc, EXIT_METHOD } from "./rpc.ts";

type Approval = { kind: "command" | "file-change" | "other"; reply: (ok: boolean, params: any) => unknown };

const APPROVALS: Record<string, Approval> = {
  "item/commandExecution/requestApproval": { kind: "command", reply: (ok) => ({ decision: ok ? "accept" : "decline" }) },
  "item/fileChange/requestApproval": { kind: "file-change", reply: (ok) => ({ decision: ok ? "accept" : "decline" }) },
  "item/permissions/requestApproval": {
    kind: "other",
    reply: (ok, p) => ({
      permissions: ok
        ? { ...(p.permissions?.network ? { network: p.permissions.network } : {}), ...(p.permissions?.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}) }
        : {},
      scope: "turn",
    }),
  },
};

function toCodexInput(input: UserInput[]): CodexUserInput[] {
  return input.map((i): CodexUserInput => {
    switch (i.type) {
      case "text":
        return { type: "text", text: i.text, text_elements: [] };
      case "image":
        return { type: "localImage", path: i.path };
      case "file":
        return { type: "mention", name: i.path.split("/").pop() ?? i.path, path: i.path };
    }
  });
}

/** `/usr/bin/zsh -lc "cmd"` → `cmd`, so the transcript shows the command rather than the shell wrapper. */
export function unwrapShell(command: string): string {
  const m = command.match(/^\S*?\b(?:ba|z)?sh -l?c (.+)$/s);
  if (!m) return command;
  // undo one level of POSIX quoting: '…' literal, "…" with \-escapes, bare words
  let out = "";
  const s = m[1]!;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return command;
      out += s.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === "\\" && '"\\$`'.includes(s[i + 1] ?? "")) i++;
        out += s[i];
      }
      if (i >= s.length) return command;
    } else if (c === "\\") out += s[++i] ?? "";
    else out += c;
  }
  return out;
}

function describeItem(item: any): { name: string; detail: string } | undefined {
  switch (item.type) {
    case "commandExecution":
      return { name: "shell", detail: unwrapShell(String(item.command ?? "")) };
    case "fileChange":
      return { name: "edit", detail: (item.changes ?? []).map((c: any) => c.path).join(", ") };
    case "mcpToolCall":
      return { name: `${item.server}.${item.tool}`, detail: JSON.stringify(item.arguments ?? {}).slice(0, 200) };
    case "webSearch":
      return { name: "web_search", detail: String(item.query ?? "") };
    default:
      return undefined;
  }
}

class CodexSession implements AgentSession {
  readonly provider = "codex" as const;
  private activeTurnId?: string;
  private interruptRequested = false;
  /** ends the in-flight turn; set while a turn is running */
  private finishTurn?: (status: "failed" | "interrupted", error: string) => void;

  constructor(
    private rpc: CodexRpc,
    readonly sessionId: string,
    readonly model: string,
    private effort: string,
    private onClose: () => void,
  ) {}

  send(input: UserInput[]): AsyncIterable<AgentEvent> {
    if (this.finishTurn) throw new Error("a turn is already in progress");
    const q = new AsyncQueue<AgentEvent>();
    const messages: string[] = [];
    let done = false;
    const finish = (ev: AgentEvent & { kind: "turn-complete" }) => {
      if (done) return;
      done = true;
      this.activeTurnId = undefined;
      this.interruptRequested = false;
      this.finishTurn = undefined;
      unsub();
      q.push(ev);
      q.end();
    };
    this.finishTurn = (status, error) => finish({ kind: "turn-complete", text: messages.at(-1) ?? "", status, error });

    const unsub = this.rpc.subscribe((method, p) => {
      if (method === EXIT_METHOD) return finish({ kind: "turn-complete", text: messages.at(-1) ?? "", status: "failed", error: p.message });
      if (p?.threadId !== this.sessionId) return;
      if (method === "item/agentMessage/delta") q.push({ kind: "text-delta", text: p.delta });
      else if (method === "thread/tokenUsage/updated") {
        // `last` is the latest model response; summing them gives this turn's usage
        const l = p.tokenUsage?.last;
        const tokens = l ? l.inputTokens + l.outputTokens : 0; // inputTokens already includes cached
        if (tokens > 0) q.push({ kind: "usage", tokens });
      }
      else if (method === "item/started" || method === "item/completed") {
        if (method === "item/completed" && p.item.type === "agentMessage") messages.push(p.item.text);
        const d = describeItem(p.item);
        if (d) q.push({ kind: "tool", ...d, status: method === "item/started" ? "started" : "completed" });
      } else if (method === "turn/completed") {
        const t = p.turn;
        const status = t.status === "inProgress" ? "failed" : t.status;
        finish({ kind: "turn-complete", text: messages.at(-1) ?? "", status, ...(t.error ? { error: t.error.message } : {}) });
      } else if (method === "error" && p.willRetry === false) {
        finish({ kind: "turn-complete", text: messages.at(-1) ?? "", status: "failed", error: p.error?.message });
      }
    });

    this.rpc
      .request("turn/start", { threadId: this.sessionId, input: toCodexInput(input), model: this.model, effort: this.effort })
      .then((r: any) => {
        if (done) return;
        this.activeTurnId = r.turn.id;
        if (this.interruptRequested) void this.interrupt();
      })
      .catch((e: Error) => finish({ kind: "turn-complete", text: "", status: "failed", error: e.message }));
    return q;
  }

  async interrupt(): Promise<void> {
    if (!this.finishTurn) return;
    if (!this.activeTurnId) {
      this.interruptRequested = true; // sent once turn/start answers
      return;
    }
    await this.rpc.request("turn/interrupt", { threadId: this.sessionId, turnId: this.activeTurnId }).catch(() => {});
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.finishTurn?.("interrupted", "session closed");
    this.onClose();
    await this.rpc.request("thread/unsubscribe", { threadId: this.sessionId }).catch(() => {});
  }
}

/** One app-server process shared by all codex sessions. */
export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;
  private approvalHandlers = new Map<string, ApprovalHandler>();
  /** in-flight approval prompts by JSON-RPC request id, so serverRequest/resolved can dismiss them */
  private openApprovals = new Map<string, AbortController>();

  private constructor(private rpc: CodexRpc) {
    rpc.onServerRequest = async (method, params, requestId) => {
      const approval = APPROVALS[method];
      if (!approval) throw new Error(`unsupported server request ${method}`);
      const handler = this.approvalHandlers.get(params?.threadId);
      if (!handler) return approval.reply(false, params);
      const detail = params?.command ?? params?.reason ?? JSON.stringify(params).slice(0, 300);
      const ctl = new AbortController();
      this.openApprovals.set(String(requestId), ctl);
      try {
        const ok = await handler({ provider: "codex", kind: approval.kind, detail: String(detail), signal: ctl.signal });
        return approval.reply(ok, params);
      } finally {
        this.openApprovals.delete(String(requestId));
      }
    };
    rpc.subscribe((method, p) => {
      if (method === "serverRequest/resolved") this.openApprovals.get(String(p.requestId))?.abort();
      if (method === EXIT_METHOD) for (const c of this.openApprovals.values()) c.abort();
    });
  }

  static async create(): Promise<CodexAdapter> {
    return new CodexAdapter(await CodexRpc.connect());
  }

  alive(): boolean {
    return !this.rpc.exited;
  }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const r: ModelListResponse = await this.rpc.request("model/list", { cursor });
      for (const m of r.data) {
        if (m.hidden) continue;
        out.push({
          id: m.id,
          displayName: m.displayName,
          efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
          defaultEffort: m.defaultReasoningEffort,
          isDefault: m.isDefault,
          supportsImages: m.inputModalities.includes("image"),
        });
      }
      cursor = r.nextCursor;
    } while (cursor);
    return out;
  }

  async startSession(opts: SessionOptions): Promise<AgentSession> {
    const config: Record<string, unknown> = {};
    for (const s of opts.mcpServers ?? []) {
      config[`mcp_servers.${s.name}`] = {
        command: s.command,
        args: s.args,
        ...(s.env ? { env: s.env } : {}),
        // delegate calls block until the subagent is done
        tool_timeout_sec: 6 * 3600,
        // syzygy's own tools; otherwise codex asks for approval and "never" turns that into a rejection
        default_tools_approval_mode: "approve",
      };
    }
    if (opts.network) config["sandbox_workspace_write.network_access"] = true;
    const common = {
      model: opts.resolved.model,
      cwd: opts.cwd,
      approvalPolicy: opts.approvals === "auto" ? "never" : "on-request",
      sandbox: "workspace-write",
      ...(Object.keys(config).length ? { config } : {}),
      ...(opts.instructions ? { developerInstructions: opts.instructions } : {}),
    };
    const r: ThreadStartResponse = opts.resumeId
      ? await this.rpc.request("thread/resume", { threadId: opts.resumeId, ...common })
      : await this.rpc.request("thread/start", common);
    const threadId = r.thread.id;
    if (opts.onApproval) this.approvalHandlers.set(threadId, opts.onApproval);
    return new CodexSession(this.rpc, threadId, r.model, opts.resolved.effort, () => this.approvalHandlers.delete(threadId));
  }

  async archive(threadId: string): Promise<void> {
    await this.rpc.request("thread/archive", { threadId });
  }

  async unarchive(threadId: string): Promise<void> {
    await this.rpc.request("thread/unarchive", { threadId });
  }

  async dispose(): Promise<void> {
    await this.rpc.close();
  }
}
