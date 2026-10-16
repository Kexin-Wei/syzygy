import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared project memory, read by both agents. Each CLI also keeps loading its
 * own native memory (AGENTS.md, CLAUDE.md, auto-memory); this file is what
 * both should know regardless of which one is main.
 */
export function memoryPath(projectPath: string): string {
  return join(projectPath, ".syzygy", "MEMORY.md");
}

export function readMemory(projectPath: string): string {
  const p = memoryPath(projectPath);
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

export function appendMemory(projectPath: string, note: string): string {
  const p = memoryPath(projectPath);
  mkdirSync(join(projectPath, ".syzygy"), { recursive: true });
  if (!existsSync(p)) appendFileSync(p, "# Project memory (Syzygy)\n\nShared by the main agent and subagents.\n\n");
  appendFileSync(p, `- ${note.trim().replace(/\n+/g, " ")}\n`);
  return p;
}

export function memoryBlock(projectPath: string): string {
  const mem = readMemory(projectPath);
  return mem ? `\n\n<project_memory path="${memoryPath(projectPath)}">\n${mem}\n</project_memory>` : "";
}
