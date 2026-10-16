import type { Server } from "bun";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureRuntimeDir, removeRuntimeDir } from "./runtime.ts";
import type { McpServerSpec } from "./types.ts";

export type ToolHandler = (tool: string, args: any, role: string) => Promise<{ text: string; isError?: boolean }>;

const MCP_ENTRY = join(import.meta.dir, "../mcp/server.ts");

/**
 * Unix-socket HTTP endpoint the per-agent MCP servers call back into.
 * One token per role so a subagent's MCP server cannot reach the delegate
 * tools. This is not a hard boundary: agents run as the same OS user, so a
 * subagent shell could read the main MCP server's environment from /proc.
 */
export class Bridge {
  readonly sockPath: string;
  private server: Server<undefined>;
  private tokens = new Map<string, string>();

  constructor(private handler: ToolHandler) {
    this.sockPath = join(ensureRuntimeDir(), "bridge.sock");
    rmSync(this.sockPath, { force: true });
    for (const role of ["main", "sub"]) this.tokens.set(crypto.randomUUID(), role);
    this.server = Bun.serve({
      unix: this.sockPath,
      fetch: (req, server) => {
        server.timeout(req, 0); // delegate calls block until the subagent finishes
        return this.fetch(req);
      },
    });
    chmodSync(this.sockPath, 0o600);
  }

  /** MCP server spec to attach to an agent session. */
  mcpSpec(role: "main" | "sub"): McpServerSpec {
    const token = [...this.tokens].find(([, r]) => r === role)![0];
    return {
      name: "syzygy",
      command: process.execPath,
      args: [MCP_ENTRY],
      env: { SYZYGY_SOCK: this.sockPath, SYZYGY_TOKEN: token, SYZYGY_ROLE: role },
    };
  }

  private async fetch(req: Request): Promise<Response> {
    const role = this.tokens.get(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (!role) return new Response("unauthorized", { status: 401 });
    if (req.method !== "POST" || new URL(req.url).pathname !== "/tool") return new Response("not found", { status: 404 });
    const { tool, args } = (await req.json()) as { tool: string; args: unknown };
    if (role === "sub" && tool !== "approve") return Response.json({ text: `tool ${tool} not available to subagents`, isError: true });
    try {
      return Response.json(await this.handler(tool, args, role));
    } catch (e) {
      return Response.json({ text: String((e as Error).message ?? e), isError: true });
    }
  }

  stop(): void {
    this.server.stop(true);
    removeRuntimeDir();
  }
}
