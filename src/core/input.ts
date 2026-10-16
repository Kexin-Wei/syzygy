import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
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

/** Complete the trailing @token in `text`; returns the new text or null. */
export function completePath(text: string, cwd: string): { text: string; options: string[] } | null {
  const m = text.match(/@(\S*)$/);
  if (!m) return null;
  const partial = m[1] ?? "";
  const abs = expand(partial || "./", cwd);
  const dir = partial.endsWith("/") || partial === "" ? abs : dirname(abs);
  const prefix = partial.endsWith("/") || partial === "" ? "" : abs.slice(dir.length + 1);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(prefix) && (prefix.startsWith(".") || !n.startsWith(".")));
  } catch {
    return null;
  }
  if (!names.length) return null;
  let common = names[0]!;
  for (const n of names) while (!n.startsWith(common)) common = common.slice(0, -1);
  const base = partial.endsWith("/") || partial === "" ? partial : partial.slice(0, partial.length - prefix.length);
  let completed = base + common;
  if (names.length === 1) {
    try {
      if (statSync(join(dir, common)).isDirectory()) completed += "/";
    } catch {}
  }
  return { text: text.slice(0, text.length - partial.length) + completed, options: names.length > 1 ? names.slice(0, 20) : [] };
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
