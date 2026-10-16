import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { UserInput } from "./types.ts";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export function isImage(path: string): boolean {
  return IMAGE_EXT.test(path);
}

function expand(p: string, cwd: string): string {
  if (p.startsWith("file://")) p = decodeURIComponent(p.slice(7));
  if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export function attachmentFor(path: string): UserInput {
  return isImage(path) ? { type: "image", path } : { type: "file", path };
}

// @path, @"path with spaces", file:///uri, or a quoted/bare absolute image path (terminal drag-drop)
const TOKEN = /@"([^"]+)"|@(\S+)|(file:\/\/\S+)|'(\/[^']+)'|(?<=^|\s)(\/\S+\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi;

/** Split prompt text into text + attachments for every referenced path that exists. */
export function parseInput(text: string, cwd: string): { input: UserInput[]; attachments: string[] } {
  const attachments: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (!raw) continue;
    const p = expand(raw.replace(/[,.;:)]+$/, ""), cwd);
    if (existsSync(p) && !attachments.includes(p)) attachments.push(p);
  }
  return { input: [{ type: "text", text }, ...attachments.map(attachmentFor)], attachments };
}

/** Live suggestions for a trailing @token: each item is a replacement for `partial` (dirs end in "/"). */
export function suggestPaths(text: string, cwd: string, limit = 8): { partial: string; items: string[] } | null {
  const m = text.match(/(?:^|\s)@(\S*)$/);
  if (!m) return null;
  const partial = m[1] ?? "";
  const atDir = partial === "" || partial.endsWith("/");
  const abs = expand(partial || "./", cwd);
  const dir = atDir ? abs : dirname(abs);
  const prefix = atDir ? "" : abs.slice(dir.length + 1);
  const base = atDir ? partial : partial.slice(0, partial.length - prefix.length);
  let items: string[] = [];
  try {
    items = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.name.toLowerCase().startsWith(prefix.toLowerCase()) && (prefix.startsWith(".") || !d.name.startsWith(".")))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((d) => base + d.name + (d.isDirectory() ? "/" : ""));
  } catch {}
  // a typed name also searches the whole project, so @main finds src/main.ts
  if (!atDir && !/^[~/]|^file:/.test(partial)) {
    for (const p of rankPaths(projectPaths(cwd), partial)) if (!items.includes(p)) items.push(p);
  }
  items = items.slice(0, limit);
  return items.length ? { partial, items } : null;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", "__pycache__", ".venv", "venv"]);
const MAX_PATHS = 20000;
const pathCache = new Map<string, { at: number; paths: string[] }>();

/** Every non-hidden file and dir under `cwd` (relative, dirs end in "/"), cached briefly between keystrokes. */
export function projectPaths(cwd: string): string[] {
  const hit = pathCache.get(cwd);
  if (hit && Date.now() - hit.at < 5000) return hit.paths;
  const paths: string[] = [];
  const walk = (rel: string) => {
    let entries;
    try {
      entries = readdirSync(join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (paths.length >= MAX_PATHS) return;
      if (d.name.startsWith(".") || (d.isDirectory() && SKIP_DIRS.has(d.name))) continue;
      const p = rel + d.name;
      if (d.isDirectory()) {
        paths.push(p + "/");
        walk(p + "/");
      } else paths.push(p);
    }
  };
  walk("");
  pathCache.set(cwd, { at: Date.now(), paths });
  return paths;
}

/** Rank paths against a query: basename prefix, then path substring, then in-order fuzzy match. */
export function rankPaths(paths: string[], query: string): string[] {
  const q = query.toLowerCase();
  const scored: [number, string][] = [];
  for (const p of paths) {
    const lp = p.toLowerCase();
    const name = lp.replace(/\/$/, "").split("/").pop()!;
    let score: number;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (lp.includes(q)) score = 2;
    else {
      let i = 0;
      for (const c of lp) if (c === q[i]) i++;
      if (i < q.length) continue;
      score = 3;
    }
    scored.push([score, p]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1])).map(([, p]) => p);
}

/** Replace the trailing @partial in `text` with `item`. */
export function applySuggestion(text: string, partial: string, item: string): string {
  return text.slice(0, text.length - partial.length) + item;
}

export type ClipboardTool = "wl-paste" | "xclip" | "pngpaste" | "osascript";

/** First available clipboard tool for this platform, or null. */
export function clipboardTool(): ClipboardTool | null {
  if (process.platform === "darwin") return Bun.which("pngpaste") ? "pngpaste" : "osascript";
  if (process.env.WAYLAND_DISPLAY && Bun.which("wl-paste")) return "wl-paste";
  if (Bun.which("xclip")) return "xclip";
  return Bun.which("wl-paste") ? "wl-paste" : null;
}

/** Save the clipboard image to `dir`; returns its path. */
export async function pasteClipboardImage(dir: string): Promise<string> {
  const tool = clipboardTool();
  if (!tool) throw new Error("no clipboard tool: install wl-clipboard (Wayland) or xclip (X11)");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, crypto.randomUUID());

  if (tool === "pngpaste" || tool === "osascript") {
    const path = `${base}.png`;
    const r =
      tool === "pngpaste"
        ? await Bun.$`pngpaste ${path}`.nothrow().quiet()
        : await Bun.$`osascript -e ${`set f to open for access POSIX file "${path}" with write permission`} -e ${"write (the clipboard as «class PNGf») to f"} -e ${"close access f"}`.nothrow().quiet();
    if (r.exitCode !== 0 || !(await Bun.file(path).exists()) || Bun.file(path).size === 0) throw new Error("clipboard has no image");
    return path;
  }

  const list = tool === "wl-paste" ? Bun.$`wl-paste --list-types` : Bun.$`xclip -selection clipboard -t TARGETS -o`;
  const types = await list.nothrow().quiet();
  if (types.exitCode !== 0) throw new Error(`clipboard unavailable (${tool} failed)`);
  const type = types.stdout.toString().split("\n").map((t) => t.trim()).find((t) => t.startsWith("image/"));
  if (!type) throw new Error("clipboard has no image");
  const path = `${base}.${type.split("/")[1]!.replace("jpeg", "jpg")}`;
  const out = tool === "wl-paste" ? await Bun.$`wl-paste --type ${type}`.quiet() : await Bun.$`xclip -selection clipboard -t ${type} -o`.quiet();
  await Bun.write(path, out.stdout);
  return path;
}
