// `syzygy doctor`: check that this machine can run Syzygy.
import { clipboardTool } from "./core/input.ts";
import { CodexRpc } from "./providers/codex/rpc.ts";

type Check = { name: string; ok: boolean | "warn"; detail: string; fix?: string };

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: (out + err).trim() };
  } catch (e) {
    return { code: 127, out: String((e as Error).message) };
  }
}

const CLAUDE_FLAGS = ["--input-format", "--output-format", "--effort", "--permission-prompt-tool", "--mcp-config", "--append-system-prompt", "--session-id"];

async function checkClaude(): Promise<Check[]> {
  if (!Bun.which("claude")) return [{ name: "claude", ok: false, detail: "not on PATH", fix: "install Claude Code: https://claude.com/claude-code" }];
  const checks: Check[] = [];
  const v = await sh(["claude", "--version"]);
  const help = (await sh(["claude", "--help"])).out;
  const missing = CLAUDE_FLAGS.filter((f) => !help.includes(f));
  checks.push({
    name: "claude",
    ok: missing.length === 0,
    detail: missing.length ? `${v.out}; missing flags: ${missing.join(" ")}` : v.out,
    ...(missing.length ? { fix: "claude update" } : {}),
  });
  const auth = await sh(["claude", "auth", "status"]);
  let loggedIn = false;
  let method = "";
  try {
    const j = JSON.parse(auth.out);
    loggedIn = !!j.loggedIn;
    method = j.authMethod ?? "";
  } catch {}
  checks.push({
    name: "claude login",
    ok: loggedIn ? (method === "claude.ai" ? true : "warn") : false,
    detail: loggedIn ? `logged in via ${method}${method === "claude.ai" ? " (subscription)" : " (not a subscription login)"}` : "not logged in",
    ...(loggedIn ? {} : { fix: "claude auth login" }),
  });
  return checks;
}

async function checkCodex(): Promise<Check[]> {
  if (!Bun.which("codex")) return [{ name: "codex", ok: false, detail: "not on PATH", fix: "install Codex CLI: https://github.com/openai/codex" }];
  const v = await sh(["codex", "--version"]);
  const checks: Check[] = [{ name: "codex", ok: true, detail: v.out }];
  const login = await sh(["codex", "login", "status"]);
  checks.push({ name: "codex login", ok: login.code === 0 && /logged in/i.test(login.out), detail: login.out.split("\n")[0] ?? "", fix: "codex login" });
  let rpc: CodexRpc | undefined;
  try {
    rpc = await Promise.race([CodexRpc.connect(), Bun.sleep(15000).then(() => Promise.reject(new Error("timed out")))]);
    const r: any = await rpc.request("model/list", {});
    const ids = r.data.filter((m: any) => !m.hidden).map((m: any) => m.id);
    checks.push({ name: "codex app-server", ok: true, detail: `${ids.length} models: ${ids.join(", ")}` });
  } catch (e) {
    checks.push({ name: "codex app-server", ok: false, detail: String((e as Error).message), fix: "codex update" });
  } finally {
    await rpc?.close().catch(() => {});
  }
  return checks;
}

export async function doctor(): Promise<number> {
  const checks: Check[] = [{ name: "bun", ok: true, detail: `${Bun.version} on ${process.platform}-${process.arch}` }];
  checks.push(...(await checkClaude()), ...(await checkCodex()));
  const clip = clipboardTool();
  checks.push({
    name: "clipboard (/paste)",
    ok: clip ? true : "warn",
    detail: clip ?? "none found; @path and drag-drop still work",
    ...(clip ? {} : { fix: process.platform === "darwin" ? "brew install pngpaste (optional)" : "install wl-clipboard or xclip" }),
  });
  for (const c of checks) {
    const mark = c.ok === true ? "✓" : c.ok === "warn" ? "!" : "✗";
    console.log(`${mark} ${c.name.padEnd(20)} ${c.detail}${c.ok !== true && c.fix ? `\n  ${"".padEnd(20)} fix: ${c.fix}` : ""}`);
  }
  const failed = checks.filter((c) => c.ok === false).length;
  console.log(failed ? `\n${failed} problem(s) found.` : "\nReady.");
  return failed ? 1 : 0;
}
