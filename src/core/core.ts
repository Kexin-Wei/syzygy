import { EventEmitter } from "node:events";
import { join } from "node:path";
import { ClaudeAdapter } from "../providers/claude/adapter.ts";
import { CodexAdapter } from "../providers/codex/adapter.ts";
import { DATA_DIR, type Project, type SessionRow, type Settings, Store, type SubtaskRow } from "../store/db.ts";
import { Bridge } from "./bridge.ts";
import { attachmentFor, pasteClipboardImage } from "./input.ts";
import { appendMemory, memoryBlock } from "./memory.ts";
import { resolveIntent } from "./models.ts";
import type { AgentEvent, AgentSession, ApprovalRequest, ModelInfo, ModelIntent, ProviderAdapter, ProviderId, ResolvedModel, UserInput } from "./types.ts";

export interface PendingApproval extends Omit<ApprovalRequest, "signal"> {
  id: string;
  who: "main" | "subagent";
}

export interface CoreEvents {
  main: [AgentEvent];
  "sub-start": [SubtaskRow];
  sub: [string, AgentEvent];
  "sub-end": [SubtaskRow];
  approval: [PendingApproval];
  "approval-resolved": [string];
  status: [string];
  session: [SessionRow];
  busy: [boolean];
}

type ToolResult = { text: string; isError?: boolean };

const PROVIDER_NAME: Record<ProviderId, string> = { codex: "Codex", claude: "Claude Code" };
const CLAUDE_FAMILIES = /^(opus|sonnet|haiku|fable|claude-)/i;

function mainInstructions(sub: ModelIntent, projectPath: string): string {
  return (
    `You are the main agent in Syzygy: you talk to the user and can hand work to a subagent ` +
    `(${PROVIDER_NAME[sub.provider]}, ${sub.family} at ${sub.effort} effort) through the syzygy MCP tools.\n` +
    `- delegate(task, files?): starts a fresh subagent in the same project directory and returns its report and a subagent_id.\n` +
    `- followup(subagent_id, message): continues that subagent with its context intact.\n` +
    `Delegate when the user asks you to involve the subagent, or when a self-contained piece of work (implementation, review, ` +
    `investigation) benefits from a second agent. Give complete instructions: it cannot see this conversation. ` +
    `Say which files it may change. You stay responsible for the result: check its report before relying on it.` +
    memoryBlock(projectPath)
  );
}

function subInstructions(main: ProviderId, projectPath: string): string {
  return (
    `You are a subagent in Syzygy, working on a task handed to you by the main agent (${PROVIDER_NAME[main]}), not by the user directly. ` +
    `Do the task, then end with a concise report: what you did, files changed, and anything you could not verify.` +
    memoryBlock(projectPath)
  );
}

const settle = (ps: (Promise<unknown> | undefined)[]) => Promise.allSettled(ps.filter(Boolean));

export class Core extends EventEmitter<CoreEvents> {
  readonly store: Store;
  readonly bridge: Bridge;
  project!: Project;
  session!: SessionRow;
  mainResolved?: ResolvedModel;
  busy = false;

  private restartPending = false;
  private adapters = new Map<ProviderId, Promise<ProviderAdapter>>();
  private modelCache = new Map<ProviderId, ModelInfo[]>();
  private main?: AgentSession;
  private turnDone?: Promise<void>;
  /** subagents with a turn in flight; idle ones are closed and resumed on followup */
  private runningSubs = new Map<string, AgentSession>();
  private approvals = new Map<string, (ok: boolean) => void>();

  constructor(store = new Store()) {
    super();
    this.store = store;
    this.bridge = new Bridge((tool, args, role) => this.handleTool(tool, args, role as "main" | "sub"));
  }

  // --- adapters & models ---

  async adapter(id: ProviderId): Promise<ProviderAdapter> {
    const cached = this.adapters.get(id);
    if (cached) {
      const a = await cached.catch(() => undefined);
      if (a?.alive()) return a;
      this.adapters.delete(id); // backend died or never started; recreate
    }
    const created = id === "codex" ? CodexAdapter.create() : Promise.resolve(new ClaudeAdapter());
    this.adapters.set(id, created);
    created.catch(() => this.adapters.delete(id));
    return created;
  }

  async models(id: ProviderId, refresh = false): Promise<ModelInfo[]> {
    if (refresh || !this.modelCache.has(id)) this.modelCache.set(id, await (await this.adapter(id)).listModels());
    return this.modelCache.get(id)!;
  }

  async resolve(intent: ModelIntent): Promise<ResolvedModel> {
    return resolveIntent(intent, await this.models(intent.provider));
  }

  get settings(): Settings {
    return this.store.projectSettings(this.project.id);
  }

  /** Persist settings and restart the main agent on its next turn so changes apply. */
  async updateSettings(patch: Partial<Settings>, scope: "global" | "project" = "global"): Promise<void> {
    if (scope === "global") this.store.saveGlobalSettings({ ...this.store.globalSettings(), ...patch });
    else this.store.saveProjectSettings(this.project.id, patch);
    await this.dropMain();
  }

  // --- projects & sessions ---

  async openProject(path: string): Promise<void> {
    await this.closeAgents();
    this.project = this.store.openProject(path);
    const latest = this.store.listSessions(this.project.id)[0];
    this.setSession(latest ?? this.store.createSession(this.project.id, this.settings.mainProvider));
  }

  async newSession(mainProvider?: ProviderId): Promise<void> {
    await this.closeAgents();
    this.setSession(this.store.createSession(this.project.id, mainProvider ?? this.settings.mainProvider));
  }

  async resumeSession(id: string): Promise<void> {
    const s = this.store.getSession(id);
    if (!s) throw new Error(`no session ${id}`);
    await this.closeAgents();
    if (s.archived) await this.setArchived(id, false);
    this.setSession(this.store.getSession(id)!);
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    const s = this.store.getSession(id);
    if (!s) return;
    this.store.updateSession(id, { archived });
    // keep codex's own session list in sync so its desktop app agrees
    if (s.mainProvider === "codex" && s.mainSessionId) {
      const codex = (await this.adapter("codex").catch(() => undefined)) as CodexAdapter | undefined;
      await (archived ? codex?.archive(s.mainSessionId) : codex?.unarchive(s.mainSessionId))?.catch(() => {});
    }
    if (id === this.session.id && archived) await this.newSession();
  }

  remember(note: string): string {
    const p = appendMemory(this.project.path, note);
    void this.dropMain(); // reload instructions with the new memory
    return p;
  }

  async pasteImage(): Promise<UserInput> {
    return attachmentFor(await pasteClipboardImage(join(DATA_DIR, "attachments")));
  }

  private setSession(s: SessionRow): void {
    this.session = s;
    this.mainResolved = undefined;
    this.emit("session", s);
  }

  // --- turns ---

  private async ensureMain(): Promise<AgentSession> {
    if (this.main) return this.main;
    const settings = this.settings;
    const provider = this.session.mainProvider;
    const resolved = await this.resolve(settings.main[provider]);
    if (resolved.note) this.emit("status", resolved.note);
    this.main = await (await this.adapter(provider)).startSession({
      cwd: this.project.path,
      resolved,
      resumeId: this.session.mainSessionId ?? undefined,
      mcpServers: [this.bridge.mcpSpec("main")],
      instructions: mainInstructions(settings.sub[provider], this.project.path),
      approvals: settings.approvals,
      onApproval: (req) => this.askApproval(req, "main"),
    });
    this.mainResolved = resolved;
    return this.main;
  }

  async send(input: UserInput[]): Promise<void> {
    if (this.busy) throw new Error("agent is busy");
    this.setBusy(true);
    let markDone!: () => void;
    this.turnDone = new Promise((r) => (markDone = r));
    // bind to the session the turn started in, even if the user switches mid-turn
    const sid = this.session.id;
    const text = input.find((i) => i.type === "text")?.text ?? "";
    const attachments = input.filter((i) => i.type !== "text").map((i) => (i as { path: string }).path);
    this.store.addMessage(sid, "user", text, attachments.length ? { attachments } : {});
    if (this.session.title === "New session") {
      this.store.updateSession(sid, { title: text.replace(/\s+/g, " ").slice(0, 60) || "Untitled" });
    }
    let failed = false;
    try {
      const main = await this.ensureMain();
      for await (const ev of main.send(input)) {
        const current = this.session.id === sid;
        if (ev.kind === "session" && current) this.mainResolved = { ...this.mainResolved!, model: ev.model };
        if (ev.kind === "turn-complete") {
          failed = ev.status === "failed";
          const body = ev.text || (ev.error ? `[${ev.status}] ${ev.error}` : `[${ev.status}]`);
          this.store.addMessage(sid, "assistant", body, { status: ev.status, model: this.mainResolved?.model });
          const row = this.store.getSession(sid);
          if (!failed || !row?.mainSessionId) this.store.updateSession(sid, { mainSessionId: main.sessionId, mainModel: this.mainResolved?.model ?? null });
          if (current) this.session = this.store.getSession(sid)!;
        }
        if (current) this.emit("main", ev);
      }
    } catch (e) {
      failed = true;
      const msg = String((e as Error).message ?? e);
      this.store.addMessage(sid, "system", msg);
      if (this.session.id === sid) this.emit("main", { kind: "turn-complete", text: "", status: "failed", error: msg });
    } finally {
      this.setBusy(false);
      markDone();
      // a failed turn may mean a dead process; restart (with resume) on the next turn
      if (failed || this.restartPending) await this.dropMain();
    }
  }

  async interrupt(): Promise<void> {
    this.cancelApprovals();
    await settle([this.main?.interrupt(), ...[...this.runningSubs.values()].map((s) => s.interrupt())]);
  }

  resolveApproval(id: string, ok: boolean): void {
    const res = this.approvals.get(id);
    if (!res) return;
    this.approvals.delete(id);
    res(ok);
    this.emit("approval-resolved", id);
  }

  private cancelApprovals(): void {
    for (const id of [...this.approvals.keys()]) this.resolveApproval(id, false);
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.emit("busy", b);
  }

  private askApproval({ signal, ...req }: ApprovalRequest, who: "main" | "subagent"): Promise<boolean> {
    const id = crypto.randomUUID();
    return new Promise((res) => {
      this.approvals.set(id, res);
      signal?.addEventListener("abort", () => this.resolveApproval(id, false), { once: true });
      this.emit("approval", { ...req, id, who });
    });
  }

  // --- delegation (called by the agents through the MCP bridge) ---

  private async handleTool(tool: string, args: any, role: "main" | "sub"): Promise<ToolResult> {
    switch (tool) {
      case "delegate":
        return this.delegate(args);
      case "followup":
        return this.followup(String(args.subagent_id), String(args.message));
      case "approve": {
        const ok = await this.askApproval(
          { provider: "claude", kind: args.tool_name === "Edit" || args.tool_name === "Write" ? "file-change" : "command", detail: `${args.tool_name} ${JSON.stringify(args.input).slice(0, 400)}` },
          role === "main" ? "main" : "subagent",
        );
        return { text: JSON.stringify(ok ? { behavior: "allow", updatedInput: args.input } : { behavior: "deny", message: "The user declined this action." }) };
      }
      default:
        return { text: `unknown tool ${tool}`, isError: true };
    }
  }

  private subIntent(override: { model?: string; effort?: string }): ModelIntent {
    const settings = this.settings;
    const base = settings.sub[this.session.mainProvider];
    if (!settings.allowSubOverride) return base;
    const provider: ProviderId = override.model ? (CLAUDE_FAMILIES.test(override.model) ? "claude" : "codex") : base.provider;
    return {
      provider,
      family: override.model ?? base.family,
      effort: override.effort ?? (provider === base.provider ? base.effort : settings.sub[provider === "claude" ? "codex" : "claude"].effort),
    };
  }

  private async startSub(row: Pick<SubtaskRow, "provider" | "providerSessionId">, resolved: ResolvedModel, resume: boolean): Promise<AgentSession> {
    return (await this.adapter(row.provider)).startSession({
      cwd: this.project.path,
      resolved,
      ...(resume && row.providerSessionId ? { resumeId: row.providerSessionId } : {}),
      // claude needs the bridge for permission prompts; codex approvals arrive over app-server
      mcpServers: row.provider === "claude" ? [this.bridge.mcpSpec("sub")] : [],
      instructions: subInstructions(this.session.mainProvider, this.project.path),
      approvals: this.settings.approvals,
      onApproval: (req) => this.askApproval(req, "subagent"),
    });
  }

  private async delegate(args: { task: string; files?: string[]; model?: string; effort?: string }): Promise<ToolResult> {
    const intent = this.subIntent(args);
    const resolved = await this.resolve(intent);
    if (resolved.note) this.emit("status", `subagent: ${resolved.note}`);
    const id = `sa-${crypto.randomUUID().slice(0, 8)}`;
    const session = await this.startSub({ provider: intent.provider, providerSessionId: null }, resolved, false);
    const row: SubtaskRow = {
      id,
      sessionId: this.session.id,
      provider: intent.provider,
      providerSessionId: session.sessionId,
      model: resolved.model,
      effort: resolved.effort,
      task: args.task,
      status: "running",
      result: null,
      createdAt: Date.now(),
    };
    this.store.addSubtask(row);
    this.store.updateSubtask(id, { providerSessionId: session.sessionId });
    const files = (args.files ?? []).map((f) => attachmentFor(f.startsWith("/") ? f : join(this.project.path, f)));
    return this.runSub(row, session, [{ type: "text", text: args.task }, ...files]);
  }

  private async followup(id: string, message: string): Promise<ToolResult> {
    if (this.runningSubs.has(id)) return { text: `subagent ${id} is still working`, isError: true };
    const row = this.store.getSubtask(id);
    if (!row?.providerSessionId) return { text: `no subagent ${id}`, isError: true };
    const placeholder = { interrupt: async () => {}, close: async () => {} } as AgentSession;
    this.runningSubs.set(id, placeholder); // reserve before awaiting so a concurrent followup is refused
    let session: AgentSession;
    try {
      session = await this.startSub(row, { provider: row.provider, model: row.model, effort: row.effort }, true);
    } catch (e) {
      this.runningSubs.delete(id);
      return { text: `could not resume ${id}: ${(e as Error).message}`, isError: true };
    }
    return this.runSub({ ...row, task: message }, session, [{ type: "text", text: message }]);
  }

  /** Run one subagent turn, then close it; followup resumes from the stored provider session id. */
  private async runSub(row: SubtaskRow, session: AgentSession, input: UserInput[]): Promise<ToolResult> {
    this.runningSubs.set(row.id, session);
    const visible = () => this.session.id === row.sessionId;
    if (visible()) this.emit("sub-start", { ...row, status: "running" });
    let final: AgentEvent & { kind: "turn-complete" } = { kind: "turn-complete", text: "", status: "failed", error: "no result" };
    try {
      for await (const ev of session.send(input)) {
        if (visible()) this.emit("sub", row.id, ev);
        if (ev.kind === "turn-complete") final = ev;
      }
    } catch (e) {
      final = { kind: "turn-complete", text: "", status: "failed", error: String((e as Error).message ?? e) };
    } finally {
      this.runningSubs.delete(row.id);
      await session.close().catch(() => {});
    }
    const done: SubtaskRow = { ...row, status: final.status, result: final.text, providerSessionId: session.sessionId };
    this.store.updateSubtask(row.id, { status: final.status, result: final.text, providerSessionId: session.sessionId });
    this.store.addMessage(row.sessionId, "subagent", final.text || final.error || final.status, {
      subtaskId: row.id,
      provider: row.provider,
      model: row.model,
      status: final.status,
    });
    if (visible()) this.emit("sub-end", done);
    const head = `subagent_id: ${row.id} (${row.provider} ${row.model}, ${final.status})`;
    if (final.status === "failed") return { text: `${head}\nerror: ${final.error ?? "unknown"}\n\n${final.text}`, isError: true };
    return { text: `${head}\n\n${final.text}` };
  }

  // --- lifecycle ---

  private async dropMain(): Promise<void> {
    if (this.busy) {
      this.restartPending = true; // applied when the current turn ends
      return;
    }
    this.restartPending = false;
    const m = this.main;
    this.main = undefined;
    await m?.close().catch(() => {});
  }

  /** Stop everything tied to the current session; waits briefly for an in-flight turn to wind down. */
  private async closeAgents(): Promise<void> {
    if (this.busy) {
      await this.interrupt();
      await Promise.race([this.turnDone, Bun.sleep(5000)]);
    }
    this.cancelApprovals();
    const all = [this.main, ...this.runningSubs.values()];
    this.main = undefined;
    this.runningSubs.clear();
    await settle(all.map((s) => s?.close?.()));
  }

  async shutdown(): Promise<void> {
    await this.closeAgents().catch(() => {});
    for (const a of this.adapters.values()) await (await a.catch(() => undefined))?.dispose().catch(() => {});
    this.bridge.stop();
  }
}
