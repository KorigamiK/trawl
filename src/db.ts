import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { claude } from "./agents/claude.ts";
import { codex } from "./agents/codex.ts";
import { opencode } from "./agents/opencode.ts";
import { tildify, type Source } from "./sources.ts";
import type { Adapter, Agent, Fragment, Unit } from "./types.ts";

const ADAPTERS: Record<Agent, Adapter> = { claude, codex, opencode };

// Bump to rebuild existing indexes after a schema change.
const VERSION = 1;

const SCHEMA = `
CREATE TABLE sessions (pk INTEGER PRIMARY KEY, agent TEXT, id TEXT, home TEXT, title TEXT, cwd TEXT,
  subagent INTEGER, started INTEGER, updated INTEGER, first_prompt TEXT, messages INTEGER, UNIQUE (agent, id));
CREATE TABLE units (key TEXT PRIMARY KEY, agent TEXT, session_id TEXT, mtime INTEGER, size INTEGER);
CREATE INDEX units_session ON units (agent, session_id);
CREATE TABLE messages (pk INTEGER PRIMARY KEY, session INTEGER, seq INTEGER, role TEXT, ts INTEGER, text TEXT);
CREATE INDEX messages_session ON messages (session, seq);
CREATE VIRTUAL TABLE fts USING fts5 (text, content = 'messages', content_rowid = 'pk',
  tokenize = 'porter unicode61 remove_diacritics 2');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO fts (rowid, text) VALUES (new.pk, new.text);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO fts (fts, rowid, text) VALUES ('delete', old.pk, old.text);
END;`;

export function openIndex(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version !== VERSION) {
    db.transaction(() => {
      for (const t of ["fts", "messages", "units", "sessions"]) db.run(`DROP TABLE IF EXISTS ${t}`);
      db.run(SCHEMA);
      db.run(`PRAGMA user_version = ${VERSION}`);
    })();
  }
  return db;
}

/** Combines what all units of one session say about it. */
function merge(fragments: Fragment[]): Fragment {
  fragments.sort((a, b) => (a.updated ?? 0) - (b.updated ?? 0));
  const seen = new Set<string>();
  const messages = fragments
    .flatMap((f) => f.messages)
    .filter((m) => !seen.has(`${m.role}\0${m.ts}\0${m.text}`) && !!seen.add(`${m.role}\0${m.ts}\0${m.text}`))
    .sort((a, b) => a.ts - b.ts);
  return {
    ...fragments.at(-1)!,
    title: fragments.findLast((f) => f.title)?.title,
    cwd: fragments.find((f) => f.cwd)?.cwd,
    subagent: fragments.some((f) => f.subagent),
    started: Math.min(...fragments.map((f) => f.started ?? Infinity)),
    messages,
  };
}

/**
 * Brings the index in line with the sources. Only units whose mtime or size
 * changed are parsed, plus the other units of the sessions they belong to.
 * Returns warnings about units that could not be read.
 */
export function update(db: Database, sources: Source[]): string[] {
  const warnings: string[] = [];
  const current = new Map<string, Unit>();
  for (const s of sources) {
    try {
      for (const u of ADAPTERS[s.agent].units(s.path)) if (!current.has(u.key)) current.set(u.key, u);
    } catch (e) {
      warnings.push(`${tildify(s.path)}: ${(e as Error).message}`);
    }
  }
  type Known = Unit & { session_id: string | null };
  const known = new Map((db.query("SELECT * FROM units").all() as Known[]).map((u) => [u.key, u]));
  const changed = [...current.values()].filter((u) => known.get(u.key)?.mtime !== u.mtime || known.get(u.key)?.size !== u.size);
  const removed = [...known.values()].filter((u) => !current.has(u.key));
  if (!changed.length && !removed.length) return warnings;

  const parsed = new Map<string, Fragment | null>();
  const parse = (u: Unit) => {
    if (!parsed.has(u.key)) {
      try {
        parsed.set(u.key, ADAPTERS[u.agent].parse(u));
      } catch (e) {
        warnings.push(`${tildify(u.key)}: ${(e as Error).message}`);
        parsed.set(u.key, null);
      }
    }
    return parsed.get(u.key)!;
  };

  const touched = new Set<string>();
  for (const u of changed) {
    const f = parse(u);
    if (f) touched.add(`${f.agent}\0${f.id}`);
  }
  for (const u of [...changed, ...removed]) {
    const old = known.get(u.key)?.session_id;
    if (old) touched.add(`${u.agent}\0${old}`);
  }
  const titles = new Map<string, string>();
  for (const s of sources) for (const [id, t] of ADAPTERS[s.agent].titles?.(s.path) ?? []) titles.set(`${s.agent}\0${id}`, t);

  const insertSession = db.query(
    "INSERT INTO sessions (agent, id, home, title, cwd, subagent, started, updated, first_prompt, messages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMessage = db.query("INSERT INTO messages (session, seq, role, ts, text) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const u of removed) db.query("DELETE FROM units WHERE key = ?").run(u.key);
    for (const u of changed) {
      db.query("INSERT OR REPLACE INTO units VALUES (?, ?, ?, ?, ?)").run(u.key, u.agent, parse(u)?.id ?? null, u.mtime, u.size);
    }
    for (const key of touched) {
      const [agent, id] = key.split("\0") as [Agent, string];
      const keys = db.query("SELECT key FROM units WHERE agent = ? AND session_id = ?").all(agent, id) as { key: string }[];
      const fragments = keys.map((k) => parse(current.get(k.key)!)).filter((f): f is Fragment => f?.id === id);
      db.query("DELETE FROM messages WHERE session IN (SELECT pk FROM sessions WHERE agent = ? AND id = ?)").run(agent, id);
      db.query("DELETE FROM sessions WHERE agent = ? AND id = ?").run(agent, id);
      if (!fragments.length) continue;
      const s = merge(fragments);
      const firstPrompt = s.messages.find((m) => m.role === "user")?.text.slice(0, 300) ?? null;
      const started = Number.isFinite(s.started) ? s.started! : null;
      const { lastInsertRowid } = insertSession.run(
        agent, id, s.home, titles.get(key) ?? s.title ?? null, s.cwd ?? null, s.subagent ? 1 : 0, started, s.updated ?? null, firstPrompt, s.messages.length,
      );
      s.messages.forEach((m, seq) => insertMessage.run(lastInsertRowid, seq, m.role, m.ts, m.text));
    }
  })();
  return warnings;
}
