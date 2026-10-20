import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import type { Adapter, Message } from "../types.ts";

const handles = new Map<string, Database>();

function open(path: string): Database {
  let db = handles.get(path);
  if (db) return db;
  try {
    db = new Database(path, { readonly: true });
    db.query("SELECT 1 FROM session LIMIT 1").get();
  } catch (e) {
    // Read-only connections can't create the -shm file of a WAL database while
    // opencode is closed. With no -wal file every change is in the main file,
    // so reading it as immutable is exact and writes nothing.
    if (existsSync(path + "-wal")) throw e;
    db = new Database(`file:${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}?immutable=1`, { readonly: true });
  }
  handles.set(path, db);
  return db;
}

/** opencode 1.x keeps everything in `opencode.db`; each session row is one unit. */
export const opencode: Adapter = {
  units(root) {
    const db = realpathSync(root);
    const rows = open(db).query("SELECT id, time_updated AS t FROM session").all() as { id: string; t: number }[];
    return rows.map((r) => ({ key: `${db}#${r.id}`, agent: "opencode", home: root, mtime: r.t, size: 0 }));
  },

  parse(unit) {
    const cut = unit.key.lastIndexOf("#");
    const db = open(unit.key.slice(0, cut));
    const id = unit.key.slice(cut + 1);
    const s = db.query("SELECT * FROM session WHERE id = ?").get(id) as any;
    const messages = (
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
    if (!s || !messages.length) return null;
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
