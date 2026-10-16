import type { Subprocess } from "bun";
import { readLines } from "../../core/queue.ts";

type Json = any;
type NotificationHandler = (method: string, params: Json) => void;
type ServerRequestHandler = (method: string, params: Json, requestId: string | number) => Promise<Json>;

/** Pseudo-notification broadcast to subscribers when the app-server process dies. */
export const EXIT_METHOD = "$syzygy/exit";

/** JSON-RPC (newline-delimited, no "jsonrpc" field) client for `codex app-server`. */
export class CodexRpc {
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private listeners = new Set<NotificationHandler>();
  private stderrTail: string[] = [];
  exited = false;
  onServerRequest: ServerRequestHandler = async (method) => {
    throw new Error(`unhandled server request ${method}`);
  };

  constructor(args: string[] = []) {
    this.proc = Bun.spawn(["codex", "app-server", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const stdoutDone = this.pump();
    this.pumpStderr();
    this.proc.exited.then(async (code) => {
      await stdoutDone; // deliver everything already written before reporting the exit
      this.exited = true;
      const message = `codex app-server exited (${code}): ${this.stderrTail.join("\n")}`;
      for (const p of this.pending.values()) p.reject(new Error(message));
      this.pending.clear();
      for (const fn of this.listeners) fn(EXIT_METHOD, { message });
    });
  }

  static async connect(): Promise<CodexRpc> {
    const rpc = new CodexRpc();
    await rpc.request("initialize", { clientInfo: { name: "syzygy", title: "Syzygy", version: "0.1.0" }, capabilities: null });
    rpc.notify("initialized");
    return rpc;
  }

  request<T = Json>(method: string, params?: Json): Promise<T> {
    if (this.exited) return Promise.reject(new Error("codex app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Json): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  subscribe(fn: NotificationHandler): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async close(): Promise<void> {
    if (!this.exited) {
      this.proc.stdin.end();
      this.proc.kill();
    }
    await this.proc.exited;
  }

  private write(msg: Json): void {
    if (this.exited) return;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
      this.proc.stdin.flush();
    } catch {
      // process is going away; the exit handler reports it
    }
  }

  private async pump(): Promise<void> {
    for await (const line of readLines(this.proc.stdout)) {
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.method) {
        this.handleServerRequest(msg);
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message ?? "rpc error"} (${msg.error.code})`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg.method, msg.params);
      }
    }
  }

  private async pumpStderr(): Promise<void> {
    for await (const line of readLines(this.proc.stderr)) {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    }
  }

  private async handleServerRequest(msg: Json): Promise<void> {
    try {
      this.write({ id: msg.id, result: await this.onServerRequest(msg.method, msg.params, msg.id) });
    } catch (e) {
      this.write({ id: msg.id, error: { code: -32601, message: String((e as Error).message ?? e) } });
    }
  }
}
