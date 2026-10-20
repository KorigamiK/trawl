import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ENV = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TRAWL_INDEX", "TRAWL_CONFIG"];

/** A throwaway HOME with the environment pointed at it. */
export function fakeHome() {
  const root = mkdtempSync(join(tmpdir(), "trawl-test-"));
  const saved = ENV.map((k) => [k, process.env[k]] as const);
  for (const k of ENV) delete process.env[k];
  process.env.HOME = root;
  return {
    root,
    done() {
      for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeJsonl(path: string, lines: unknown[]): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

export const claude = {
  user: (content: unknown, timestamp: string, extra = {}) => ({ type: "user", timestamp, cwd: "/work/app", message: { content }, ...extra }),
  assistant: (text: string, timestamp: string) => ({ type: "assistant", timestamp, message: { content: [{ type: "text", text }] } }),
  toolResult: (timestamp: string) => ({ type: "user", timestamp, message: { content: [{ type: "tool_result", content: "tool output" }] } }),
  title: (aiTitle: string) => ({ type: "ai-title", aiTitle }),
  write: (home: string, dir: string, id: string, lines: unknown[]) => writeJsonl(join(home, dir, "projects", "-work-app", `${id}.jsonl`), lines),
};

export const codex = {
  meta: (id: string, timestamp: string, extra = {}) => ({ timestamp, type: "session_meta", payload: { id, timestamp, cwd: "/work/api", ...extra } }),
  message: (role: string, text: string, timestamp: string) => ({
    timestamp,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] },
  }),
  event: (type: string, message: string, timestamp: string) => ({ timestamp, type: "event_msg", payload: { type, message } }),
  write: (home: string, dir: string, name: string, lines: unknown[]) => writeJsonl(join(home, dir, "sessions", "2026", "10", "01", name), lines),
};

type Part = { role: string; text: string; at: number; type?: string; synthetic?: boolean };

export function writeOpencode(path: string, sessions: { id: string; title: string; dir: string; parent?: string; parts: Part[] }[]) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run("CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)");
  db.run("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
  db.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  let n = 0;
  for (const s of sessions) {
    db.query("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)").run(s.id, s.parent ?? null, s.dir, s.title, s.parts[0]!.at, s.parts.at(-1)!.at);
    for (const p of s.parts) {
      db.query("INSERT INTO message VALUES (?, ?, ?)").run(`m${++n}`, s.id, JSON.stringify({ role: p.role }));
      const data = JSON.stringify({ type: p.type ?? "text", text: p.text, ...(p.synthetic && { synthetic: true }) });
      db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(`p${n}`, `m${n}`, s.id, p.at, data);
    }
  }
  db.close();
  return path;
}
