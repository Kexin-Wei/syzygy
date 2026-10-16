// Stdio MCP server launched by codex/claude as a child process. It owns no
// state: every tool call is forwarded to the Syzygy core over a unix socket.
// Env: SYZYGY_SOCK, SYZYGY_TOKEN, SYZYGY_ROLE ("main" | "sub").
import { readLines } from "../core/queue.ts";

const SOCK = process.env.SYZYGY_SOCK!;
const TOKEN = process.env.SYZYGY_TOKEN!;
const ROLE = process.env.SYZYGY_ROLE ?? "main";

const APPROVE_TOOL = {
  name: "approve",
  description: "Permission prompt handler used by the host. Do not call directly.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"],
  },
};

const MAIN_TOOLS = [
  {
    name: "delegate",
    description:
      "Hand a self-contained task to the subagent (another coding agent working in the same project directory). " +
      "Blocks until the subagent finishes and returns its final report plus a subagent_id for follow-ups. " +
      "Write the task so it can be done without this conversation's context: goal, relevant files, constraints, and what to report back.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complete instructions for the subagent." },
        files: { type: "array", items: { type: "string" }, description: "Paths (files, folders, or images) to attach." },
        model: { type: "string", description: "Optional model family or id override, e.g. 'opus', 'sonnet', 'sol'." },
        effort: { type: "string", description: "Optional effort override: low, medium, high, xhigh, max." },
      },
      required: ["task"],
    },
  },
  {
    name: "followup",
    description: "Send a follow-up message to a subagent from an earlier delegate call; it keeps its context. Blocks until it replies.",
    inputSchema: {
      type: "object",
      properties: { subagent_id: { type: "string" }, message: { type: "string" } },
      required: ["subagent_id", "message"],
    },
  },
];

const tools = ROLE === "main" ? [...MAIN_TOOLS, APPROVE_TOOL] : [APPROVE_TOOL];

async function callCore(tool: string, args: unknown): Promise<{ text: string; isError?: boolean }> {
  const res = await fetch("http://syzygy/tool", {
    unix: SOCK,
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
    timeout: false,
  } as RequestInit);
  if (!res.ok) return { text: `syzygy core error ${res.status}: ${await res.text()}`, isError: true };
  return (await res.json()) as { text: string; isError?: boolean };
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled) need no reply
  try {
    let result: unknown;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "syzygy", version: "0.1.0" },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools };
        break;
      case "tools/call": {
        const r = await callCore(params.name, params.arguments ?? {});
        result = { content: [{ type: "text", text: r.text }], isError: !!r.isError };
        break;
      }
      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
        return;
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e as Error).message ?? e) } });
  }
}

for await (const line of readLines(Bun.stdin.stream())) {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  // tool calls can block for minutes; handle concurrently
  void handle(msg);
}
