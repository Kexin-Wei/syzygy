import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ModelIntent, ProviderId } from "../core/types.ts";

export const DATA_DIR = process.env.SYZYGY_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "syzygy");

export interface Project {
  id: number;
  path: string;
  name: string;
  createdAt: number;
}

export interface SessionRow {
  id: string;
  projectId: number;
  title: string;
  mainProvider: ProviderId;
  mainSessionId: string | null;
  mainModel: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = "user" | "assistant" | "subagent" | "system";

export interface MessageRow {
  id: number;
  sessionId: string;
  role: MessageRole;
  text: string;
  meta: Record<string, unknown>;
  createdAt: number;
}

export interface SubtaskRow {
  id: string;
  sessionId: string;
  provider: ProviderId;
  providerSessionId: string | null;
  model: string;
  effort: string;
  task: string;
  status: "running" | "completed" | "failed" | "interrupted";
  result: string | null;
  createdAt: number;
}

export interface Settings {
  mainProvider: ProviderId;
  /** intent used when a provider is the main agent */
  main: Record<ProviderId, ModelIntent>;
  /** subagent intent, keyed by the main agent's provider */
  sub: Record<ProviderId, ModelIntent>;
  /** let the main agent override subagent model/effort per call */
  allowSubOverride: boolean;
  approvals: "ask" | "auto";
}

export const DEFAULT_SETTINGS: Settings = {
  mainProvider: "codex",
  main: {
    codex: { provider: "codex", family: "sol", effort: "low" },
    claude: { provider: "claude", family: "opus", effort: "medium" },
  },
  sub: {
    codex: { provider: "claude", family: "opus", effort: "medium" },
    claude: { provider: "codex", family: "sol", effort: "low" },
  },
  allowSubOverride: true,
  approvals: "ask",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, main_provider TEXT NOT NULL, main_session_id TEXT, main_model TEXT,
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL, text TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  provider TEXT NOT NULL, provider_session_id TEXT, model TEXT NOT NULL, effort TEXT NOT NULL,
  task TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage (provider TEXT NOT NULL, tokens INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id, updated_at);
`;

const now = () => Date.now();

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    main: { ...base.main, ...patch.main },
    sub: { ...base.sub, ...patch.sub },
  };
}

export class Store {
  readonly db: Database;

  constructor(path = join(DATA_DIR, "syzygy.db")) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  // --- settings: global, then per-project overrides ---

  globalSettings(): Settings {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get("settings");
    return mergeSettings(DEFAULT_SETTINGS, row ? JSON.parse(row.value) : {});
  }

  saveGlobalSettings(s: Settings): void {
    this.db.query("INSERT INTO kv (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
  }

  projectSettings(projectId: number): Settings {
    const row = this.db.query<{ settings: string }, [number]>("SELECT settings FROM projects WHERE id = ?").get(projectId);
    return mergeSettings(this.globalSettings(), row ? JSON.parse(row.settings) : {});
  }

  saveProjectSettings(projectId: number, patch: Partial<Settings>): void {
    const row = this.db.query<{ settings: string }, [number]>("SELECT settings FROM projects WHERE id = ?").get(projectId);
    const merged = { ...(row ? JSON.parse(row.settings) : {}), ...patch };
    this.db.query("UPDATE projects SET settings = ? WHERE id = ?").run(JSON.stringify(merged), projectId);
  }

  // --- token usage ---

  addUsage(provider: ProviderId, tokens: number, at = now()): void {
    this.db.query("INSERT INTO usage (provider, tokens, at) VALUES (?, ?, ?)").run(provider, tokens, at);
  }

  /** Tokens per provider since `since` (ms epoch), across all projects and sessions. */
  usageSince(since: number): Record<ProviderId, number> {
    const out: Record<ProviderId, number> = { codex: 0, claude: 0 };
    for (const r of this.db.query<{ provider: ProviderId; n: number }, [number]>("SELECT provider, SUM(tokens) AS n FROM usage WHERE at >= ? GROUP BY provider").all(since)) {
      out[r.provider] = r.n;
    }
    return out;
  }

  // --- projects ---

  openProject(path: string): Project {
    const abs = resolve(path);
    this.db.query("INSERT INTO projects (path, name, created_at) VALUES (?, ?, ?) ON CONFLICT(path) DO NOTHING").run(abs, basename(abs) || abs, now());
    return this.db.query<Project, [string]>("SELECT id, path, name, created_at AS createdAt FROM projects WHERE path = ?").get(abs)!;
  }

  listProjects(): Project[] {
    return this.db
      .query<Project, []>(
        `SELECT p.id, p.path, p.name, p.created_at AS createdAt FROM projects p
         LEFT JOIN sessions s ON s.project_id = p.id
         GROUP BY p.id ORDER BY MAX(COALESCE(s.updated_at, p.created_at)) DESC`,
      )
      .all();
  }

  // --- sessions ---

  createSession(projectId: number, mainProvider: ProviderId, title = "New session"): SessionRow {
    const id = crypto.randomUUID();
    const t = now();
    this.db
      .query("INSERT INTO sessions (id, project_id, title, main_provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, projectId, title, mainProvider, t, t);
    return this.getSession(id)!;
  }

  getSession(id: string): SessionRow | null {
    const r = this.db.query<any, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return r ? toSession(r) : null;
  }

  listSessions(projectId: number, archived = false): SessionRow[] {
    return this.db
      .query<any, [number, number]>("SELECT * FROM sessions WHERE project_id = ? AND archived = ? ORDER BY updated_at DESC")
      .all(projectId, archived ? 1 : 0)
      .map(toSession);
  }

  updateSession(id: string, patch: Partial<Pick<SessionRow, "title" | "mainSessionId" | "mainModel" | "archived">>): void {
    const cols: Record<string, string> = { title: "title", mainSessionId: "main_session_id", mainModel: "main_model", archived: "archived" };
    const sets: string[] = ["updated_at = ?"];
    const vals: (string | number | null)[] = [now()];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${cols[k]} = ?`);
      vals.push(typeof v === "boolean" ? Number(v) : (v as string | null));
    }
    this.db.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  // --- transcript (display copy; the provider keeps the real context) ---

  addMessage(sessionId: string, role: MessageRole, text: string, meta: Record<string, unknown> = {}): void {
    this.db.query("INSERT INTO messages (session_id, role, text, meta, created_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, role, text, JSON.stringify(meta), now());
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), sessionId);
  }

  messages(sessionId: string): MessageRow[] {
    return this.db
      .query<any, [string]>("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
      .all(sessionId)
      .map((r) => ({ id: r.id, sessionId: r.session_id, role: r.role, text: r.text, meta: JSON.parse(r.meta), createdAt: r.created_at }));
  }

  // --- subtasks ---

  addSubtask(s: Omit<SubtaskRow, "createdAt" | "result" | "providerSessionId">): void {
    this.db
      .query("INSERT INTO subtasks (id, session_id, provider, model, effort, task, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.id, s.sessionId, s.provider, s.model, s.effort, s.task, s.status, now());
  }

  updateSubtask(id: string, patch: Partial<Pick<SubtaskRow, "status" | "result" | "providerSessionId">>): void {
    const cols: Record<string, string> = { status: "status", result: "result", providerSessionId: "provider_session_id" };
    const entries = Object.entries(patch);
    if (!entries.length) return;
    this.db.query(`UPDATE subtasks SET ${entries.map(([k]) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`).run(...entries.map(([, v]) => v as string | null), id);
  }

  getSubtask(id: string): SubtaskRow | null {
    const r = this.db.query<any, [string]>("SELECT * FROM subtasks WHERE id = ?").get(id);
    return r
      ? { id: r.id, sessionId: r.session_id, provider: r.provider, providerSessionId: r.provider_session_id, model: r.model, effort: r.effort, task: r.task, status: r.status, result: r.result, createdAt: r.created_at }
      : null;
  }
}

function toSession(r: any): SessionRow {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    mainProvider: r.main_provider,
    mainSessionId: r.main_session_id,
    mainModel: r.main_model,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
