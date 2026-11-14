import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import type { Adapter, Message } from "../types.ts";

const handles = new Map<string, Database>();

function open(path: string): Database {
  let db = handles.get(path);
  if (db) return db;
  try {
    db = new Database(path, { readonly: true });
    db.query("SELECT name FROM sqlite_master LIMIT 1").get();
  } catch (e) {
    // Read-only connections can't create the -shm file of a WAL database while
    // opencode is closed. With no -wal file every change is in the main file,
    // so reading it as immutable is exact and writes nothing.
    if (existsSync(path + "-wal")) throw e;
    db?.close();
    db = new Database(`file:${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}?immutable=1`, { readonly: true });
  }
  handles.set(path, db);
  return db;
}

interface Store {
  session: string;
  message: string;
  part?: string;
  where: string;
  projected: boolean;
}

/** Detect the schema rather than the installed CLI version: databases can contain both generations. */
function stores(db: Database): Store[] {
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
  const v2 = tables.has("session_v2");
  const projected = tables.has("session_message");
  const out: Store[] = [];
  if (projected && (v2 || tables.has("session"))) {
    out.push({
      session: v2 ? "session_v2" : "session",
      message: "session_message",
      part: tables.has("session_part") ? "session_part" : undefined,
      where: v2 ? "1" : "EXISTS (SELECT 1 FROM session_message WHERE session_id = s.id)",
      projected: true,
    });
  }
  if (tables.has("session") && tables.has("message") && tables.has("part")) {
    const where = out.length === 0 ? "1" : v2
      ? "NOT EXISTS (SELECT 1 FROM session_v2 WHERE id = s.id)"
      : "NOT EXISTS (SELECT 1 FROM session_message WHERE session_id = s.id)";
    out.push({
      session: "session", message: "message", part: "part", projected: false, where,
    });
  }
  if (!out.length) throw new Error("No supported OpenCode session tables found");
  return out;
}

function projectedMessages(db: Database, store: Store, id: string): Message[] {
  // Extract only text in SQLite to avoid loading tool results and provider state into memory.
  const rows = db.query(`
    SELECT m.id, m.type AS role, m.time_created AS ts,
      CASE WHEN m.type = 'user' THEN json_extract(m.data, '$.text') ELSE
        (SELECT group_concat(text, char(10) || char(10)) FROM (
          SELECT json_extract(j.value, '$.text') AS text FROM json_each(m.data, '$.content') j
           WHERE json_extract(j.value, '$.type') = 'text'
             AND json_extract(j.value, '$.synthetic') IS NOT 1 AND json_extract(j.value, '$.ignored') IS NOT 1
           ORDER BY CAST(j.key AS INTEGER)
        )) END AS text
      FROM session_message m WHERE m.session_id = ? AND m.type IN ('user', 'assistant')
       AND json_extract(m.data, '$.synthetic') IS NOT 1 AND json_extract(m.data, '$.ignored') IS NOT 1
     ORDER BY m.seq, m.id
  `).all(id) as (Message & { id: string })[];
  const parts = new Map<string, string[]>();
  if (store.part) {
    const rows = db.query(`
      SELECT message_id, json_extract(data, '$.text') AS text FROM session_part
       WHERE session_id = ? AND type = 'text'
         AND json_extract(data, '$.synthetic') IS NOT 1 AND json_extract(data, '$.ignored') IS NOT 1
       ORDER BY message_id, ordinal
    `).all(id) as { message_id: string; text: string | null }[];
    for (const row of rows) {
      if (typeof row.text !== "string" || !row.text.trim()) continue;
      const texts = parts.get(row.message_id) ?? [];
      texts.push(row.text.trim());
      parts.set(row.message_id, texts);
    }
  }
  // OpenCode hydrates stored parts before any trailing inline content (history.ts: withParts).
  return rows.map((m) => ({
    role: m.role, ts: m.ts,
    text: [...(m.role === "assistant" ? parts.get(m.id) ?? [] : []), typeof m.text === "string" ? m.text.trim() : ""].filter(Boolean).join("\n\n"),
  })).filter((m) => m.text);
}

/** SQLite v1 parts, v2 projected messages, and v2 assistant part rows. Each session is one unit. */
export const opencode: Adapter = {
  units(root) {
    const path = realpathSync(root);
    const db = open(path);
    return stores(db).flatMap((store) => {
      const children = [store.message, store.part].filter((t): t is string => Boolean(t));
      const times = children.map((t) => `coalesce((SELECT max(time_updated) FROM ${t} WHERE session_id = s.id), 0)`);
      const counts = children.map((t) => `(SELECT count(*) FROM ${t} WHERE session_id = s.id)`);
      // Counts detect deletions; the low bit detects migration even when timestamps match.
      const rows = db.query(`SELECT s.id, max(s.time_updated, ${times.join(", ")}) AS t,
        (${counts.join(" + ")}) * 2 + ${store.projected ? 1 : 0} AS n FROM ${store.session} s WHERE ${store.where}`)
        .all() as { id: string; t: number; n: number }[];
      return rows.map((r) => ({ key: `${path}#${r.id}`, agent: "opencode" as const, home: root, mtime: r.t, size: r.n }));
    });
  },

  parse(unit) {
    const cut = unit.key.lastIndexOf("#");
    const db = open(unit.key.slice(0, cut));
    const id = unit.key.slice(cut + 1);
    let s: any;
    const store = stores(db).find((store) => {
      s = db.query(`SELECT * FROM ${store.session} s WHERE s.id = ? AND ${store.where}`).get(id);
      return Boolean(s);
    });
    if (!store || !s) return null;
    const messages = store.projected ? projectedMessages(db, store, id) : (
      db
        .query(
          `SELECT json_extract(m.data, '$.role') AS role, json_extract(p.data, '$.text') AS text, p.time_created AS ts
             FROM part p JOIN message m ON m.id = p.message_id
            WHERE p.session_id = ? AND json_extract(p.data, '$.type') = 'text'
              AND json_extract(p.data, '$.synthetic') IS NOT 1 AND json_extract(p.data, '$.ignored') IS NOT 1
            ORDER BY p.time_created, p.id`,
        )
        .all(id) as Message[]
    )
      .map((m) => ({ ...m, text: m.text?.trim() ?? "" }))
      .filter((m) => m.text && (m.role === "user" || m.role === "assistant"));
    if (!messages.length) return null;
    return {
      agent: "opencode",
      id,
      home: unit.home,
      title: s.title,
      cwd: s.directory,
      subagent: Boolean(s.parent_id),
      started: s.time_created,
      updated: s.time_updated,
      messages,
    };
  },
};
