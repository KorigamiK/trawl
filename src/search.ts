import type { Database } from "bun:sqlite";
import { UserError, type Agent, type Session } from "./types.ts";

export interface Filters {
  agents?: Agent[];
  /** Substring of the working directory. */
  project?: string;
  since?: number;
  subagents?: boolean;
  /** Session ids to leave out, e.g. the conversation trawl is run from. */
  exclude?: string[];
  limit: number;
}

export interface Result {
  session: Session;
  hits: number;
  /** Best-matching snippets, matched terms wrapped in \x01 … \x02. */
  snippets: { role: string; text: string }[];
}

/**
 * Turns a query into FTS5 syntax: words are all required, "quoted text" is a
 * phrase, -word excludes, word* is a prefix, and OR between words is kept.
 */
export function toMatch(query: string): string {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const [, neg, quoted, word] of query.matchAll(/(-?)(?:"([^"]*)"?|(\S+))/g)) {
    let term = quoted ?? word!;
    if (quoted === undefined && term === "OR" && !neg) {
      if (include.length && include.at(-1) !== "OR") include.push("OR");
      continue;
    }
    const prefix = quoted === undefined && term.length > 1 && term.endsWith("*");
    if (prefix) term = term.slice(0, -1);
    if (!/[\p{L}\p{N}]/u.test(term)) continue;
    (neg ? exclude : include).push(`"${term.replaceAll('"', '""')}"${prefix ? "*" : ""}`);
  }
  while (["OR", undefined].includes(include.at(-1)) && include.length) include.pop();
  if (!include.length) throw new UserError("The query needs at least one word to look for.");
  return exclude.length ? `(${include.join(" ")}) NOT (${exclude.join(" OR ")})` : include.join(" ");
}

function where(f: Filters, params: (string | number)[]): string {
  const sql = [f.subagents ? "1" : "s.subagent = 0"];
  const add = (clause: string, ...values: (string | number)[]) => (sql.push(clause), params.push(...values));
  if (f.agents?.length) add(`s.agent IN (${f.agents.map(() => "?")})`, ...f.agents);
  if (f.exclude?.length) add(`s.id NOT IN (${f.exclude.map(() => "?")})`, ...f.exclude);
  if (f.project) add("s.cwd LIKE ?", `%${f.project}%`);
  if (f.since) add("s.updated >= ?", f.since);
  return sql.join(" AND ");
}

/** Conversations ranked by their three best-matching messages. */
export function search(db: Database, query: string, f: Filters): { total: number; results: Result[] } {
  const params: (string | number)[] = [toMatch(query)];
  const rows = db
    .query(
      `SELECT m.session, m.role, bm25(fts) AS rank, snippet(fts, 0, char(1), char(2), '…', 16) AS text
         FROM fts JOIN messages m ON m.pk = fts.rowid JOIN sessions s ON s.pk = m.session
        WHERE fts MATCH ? AND ${where(f, params)} ORDER BY rank LIMIT 5000`,
    )
    .all(...params) as { session: number; role: string; rank: number; text: string }[];

  const groups = new Map<number, { score: number; hits: number; snippets: Result["snippets"] }>();
  for (const r of rows) {
    const g = groups.get(r.session) ?? { score: 0, hits: 0, snippets: [] };
    groups.set(r.session, g);
    g.hits++;
    if (g.snippets.length < 3) {
      g.score += r.rank;
      g.snippets.push({ role: r.role, text: r.text });
    }
  }
  const ranked = [...groups].sort(([, a], [, b]) => a.score - b.score).slice(0, f.limit);
  const results = ranked.map(([pk, g]) => ({
    session: db.query("SELECT * FROM sessions WHERE pk = ?").get(pk) as Session,
    hits: g.hits,
    snippets: g.snippets,
  }));
  return { total: groups.size, results };
}

export function recent(db: Database, f: Filters): Session[] {
  const params: (string | number)[] = [];
  const sql = `SELECT * FROM sessions s WHERE ${where(f, params)} ORDER BY updated DESC LIMIT ?`;
  return db.query(sql).all(...params, f.limit) as Session[];
}

/** A session by full id or unique prefix. */
export function find(db: Database, ref: string): Session {
  const rows = db.query("SELECT * FROM sessions WHERE id = ?1 OR id GLOB ?2 LIMIT 6").all(ref, `${ref.replace(/[*?[]/g, "")}*`) as Session[];
  // Subagent threads often share a prefix with their parent; prefer the parent.
  const best = rows.filter((r) => r.id === ref).concat(rows.length === 1 ? rows : rows.filter((r) => !r.subagent));
  if (best.length === 1 || best[0]?.id === ref) return best[0]!;
  if (!rows.length) throw new UserError(`No conversation id starts with "${ref}".`);
  throw new UserError(`"${ref}" matches several conversations:\n${rows.map((r) => `  ${r.agent} ${r.id}`).join("\n")}`);
}

/** Messages of a session; with a query, only matching ones and `context` neighbours each side. */
export function transcript(db: Database, s: Session, query?: string, context = 1) {
  const messages = db.query("SELECT seq, role, ts, text FROM messages WHERE session = ? ORDER BY seq").all(s.pk) as {
    seq: number;
    role: string;
    ts: number;
    text: string;
  }[];
  if (!query) return messages;
  const hits = new Map(
    (
      db
        .query(
          `SELECT m.seq, highlight(fts, 0, char(1), char(2)) AS text FROM fts JOIN messages m ON m.pk = fts.rowid
            WHERE fts MATCH ? AND m.session = ?`,
        )
        .all(toMatch(query), s.pk) as { seq: number; text: string }[]
    ).map((h) => [h.seq, h.text]),
  );
  return messages
    .filter((m) => [...hits.keys()].some((seq) => Math.abs(seq - m.seq) <= context))
    .map((m) => ({ ...m, text: hits.get(m.seq) ?? m.text }));
}
