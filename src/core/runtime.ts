import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Per-process 0700 directory for the bridge socket and files holding tokens. */
export const RUNTIME_DIR = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `syzygy-${process.getuid?.() ?? "u"}-${process.pid}`);

export function ensureRuntimeDir(): string {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  chmodSync(RUNTIME_DIR, 0o700);
  return RUNTIME_DIR;
}

/** Write a file only the current user can read; returns its path. */
export function writePrivate(name: string, content: string): string {
  const p = join(ensureRuntimeDir(), name);
  writeFileSync(p, content, { mode: 0o600 });
  return p;
}

export function removeRuntimeDir(): void {
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
}
