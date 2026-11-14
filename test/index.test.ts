import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openIndex, update } from "../src/db.ts";
import { find, recent, search, toMatch, transcript } from "../src/search.ts";
import { sources } from "../src/sources.ts";
import * as fx from "./helpers.ts";

const CODEX_ID = "019f0000-0000-7000-8000-00000000c0de";
const CLAUDE_ID = "11111111-aaaa-4bbb-8ccc-000000000001";

let h: ReturnType<typeof fx.fakeHome>;
let db: Database;
const index = () => update(db, sources());
const ids = (query: string, filters = {}) => search(db, query, { limit: 10, ...filters }).results.map((r) => r.session.agent);

beforeEach(() => {
  h = fx.fakeHome();
  db = openIndex(join(h.root, "index.db"));
  fx.claude.write(h.root, ".claude", CLAUDE_ID, [
    fx.claude.user("Draft a migration plan for moving the billing service off cron", "2026-10-08T05:30:00Z"),
    fx.claude.assistant("Move one job at a time and keep a full rollback path.", "2026-10-08T05:31:00Z"),
  ]);
  fx.claude.write(h.root, ".claude2", "22222222-aaaa-4bbb-8ccc-000000000002", [
    fx.claude.user("Fix the flaky login test", "2026-09-01T10:00:00Z"),
  ]);
  fx.codex.write(h.root, ".codex", `rollout-a-${CODEX_ID}.jsonl`, [
    fx.codex.meta(CODEX_ID, "2026-09-24T07:16:00Z"),
    fx.codex.message("user", "Compare caching strategies for the API and the datasets each benchmark needs", "2026-09-24T07:16:01Z"),
    fx.codex.message("assistant", "Redis needs warm keys; the replay dataset has real traffic.", "2026-09-24T07:20:00Z"),
  ]);
  // The same Codex thread continued in a second file.
  fx.codex.write(h.root, ".codex", `rollout-b-${CODEX_ID}_019f1111-0000-7000-8000-000000000000.jsonl`, [
    fx.codex.meta(CODEX_ID, "2026-09-27T09:25:00Z"),
    fx.codex.message("user", "Which tool turns a trace into a flame graph?", "2026-09-27T09:25:01Z"),
  ]);
  // A second Codex home sharing the first one's sessions.
  mkdirSync(join(h.root, ".codex2"));
  symlinkSync(join(h.root, ".codex", "sessions"), join(h.root, ".codex2", "sessions"));
  fx.writeOpencode(join(h.root, ".local", "share", "opencode", "opencode.db"), [
    {
      id: "ses_abc123",
      title: "Dataset request",
      dir: "/work/perf",
      parts: [{ role: "user", text: "write an access request for the TraceBench dataset", at: Date.parse("2026-10-06T17:07:00Z") }],
    },
  ]);
  expect(index()).toEqual([]);
});

afterEach(() => {
  db.close();
  h.done();
});

test("discovers every agent home", () => {
  expect(sources().map((s) => [s.agent, s.path.slice(h.root.length)])).toEqual([
    ["claude", "/.claude"],
    ["codex", "/.codex"],
    ["claude", "/.claude2"],
    ["codex", "/.codex2"],
    ["opencode", "/.local/share/opencode/opencode.db"],
  ]);
});

test("discovers OpenCode channel databases and relative or absolute OPENCODE_DB overrides", () => {
  const data = join(h.root, "xdg-data");
  process.env.XDG_DATA_HOME = data;
  const dir = join(data, "opencode");
  mkdirSync(dir, { recursive: true });
  for (const name of ["opencode.db", "opencode-preview.db", "custom.db", "opencode-preview.db-wal"]) writeFileSync(join(dir, name), "");
  mkdirSync(join(dir, "opencode-directory.db"));
  symlinkSync(join(dir, "opencode.db"), join(dir, "opencode-linked.db"));
  process.env.OPENCODE_DB = "custom.db";
  const paths = () => sources().filter((s) => s.agent === "opencode").map((s) => s.path);
  expect(paths()).toEqual([join(dir, "custom.db"), join(dir, "opencode.db"), join(dir, "opencode-preview.db")]);
  const external = join(h.root, "external.db");
  writeFileSync(external, "");
  process.env.OPENCODE_DB = external;
  expect(paths()).toEqual([external, join(dir, "opencode.db"), join(dir, "opencode-preview.db")]);
  process.env.OPENCODE_DB = ":memory:";
  expect(paths()).toEqual([join(dir, "opencode.db"), join(dir, "opencode-preview.db")]);
});

test("discovers Codex homes with only archived sessions", () => {
  const archived = join(h.root, ".codex-archive", "archived_sessions");
  fx.writeJsonl(join(archived, "rollout-archive.jsonl"), [
    fx.codex.meta("archived-thread", "2026-10-01T00:00:00Z"),
    fx.codex.message("user", "archived conversation", "2026-10-01T00:00:01Z"),
  ]);
  expect(index()).toEqual([]);
  expect(find(db, "archived-thread").home).toBe(join(h.root, ".codex-archive"));
});

test("OpenCode indexing preserves seq and notices message edits and deletions without session updates", () => {
  const path = fx.writeOpencodeV2(join(h.root, "projected.db"), [{ id: "ses_incremental", messages: [
    { id: "user", type: "user", seq: 1, at: 2000, data: { text: "incremental question" } },
    { id: "assistant", type: "assistant", seq: 3, at: 1000, data: { content: [{ type: "text", text: "initial answer" }] } },
  ] }]);
  const source = [{ agent: "opencode" as const, path }];
  expect(update(db, source)).toEqual([]);
  expect(transcript(db, find(db, "ses_incremental")).map((m) => m.role)).toEqual(["user", "assistant"]);
  const writer = new Database(path);
  try {
    writer.query("UPDATE session_message SET data = ?, time_updated = 4000 WHERE id = 'assistant'")
      .run(JSON.stringify({ content: [{ type: "text", text: "streamed replacement" }] }));
    expect(update(db, source)).toEqual([]);
    expect(ids("streamed replacement")).toEqual(["opencode"]);
    expect(ids("initial answer")).toEqual([]);
    writer.run("DELETE FROM session_message WHERE id = 'user'");
    expect(update(db, source)).toEqual([]);
    expect(ids("incremental question")).toEqual([]);
    expect(find(db, "ses_incremental").messages).toBe(1);
  } finally {
    writer.close();
  }
});

test("OpenCode indexing notices edits and deletions in separate assistant part rows", () => {
  const path = fx.writeOpencodeV2(join(h.root, "part-updates.db"), [{ id: "ses_part_updates", messages: [
    { id: "assistant", type: "assistant", seq: 1, at: 1000, data: { content: [] }, parts: [
      { type: "text", text: "first paragraph" }, { type: "text", text: "second paragraph" },
    ] },
  ] }], { partRows: true });
  const source = [{ agent: "opencode" as const, path }];
  expect(update(db, source)).toEqual([]);
  const writer = new Database(path);
  try {
    writer.query("UPDATE session_part SET data = ?, time_updated = 2000 WHERE ordinal = 0")
      .run(JSON.stringify({ type: "text", text: "updated paragraph" }));
    expect(update(db, source)).toEqual([]);
    expect(ids("updated paragraph")).toEqual(["opencode"]);
    expect(ids("first paragraph")).toEqual([]);
    writer.run("DELETE FROM session_part WHERE ordinal = 1");
    expect(update(db, source)).toEqual([]);
    expect(ids("second paragraph")).toEqual([]);
    expect(ids("updated paragraph")).toEqual(["opencode"]);
  } finally {
    writer.close();
  }
});

test("OpenCode incremental indexing switches to a migrated copy with identical timestamps", () => {
  const path = join(h.root, ".local", "share", "opencode", "opencode.db");
  fx.writeOpencodeV2(path, [{ id: "ses_abc123", messages: [
    { id: "migrated", type: "user", seq: 1, at: Date.parse("2026-10-06T17:07:00Z"), data: { text: "migrated conversation" } },
  ] }]);
  expect(index()).toEqual([]);
  expect(ids("tracebench")).toEqual([]);
  expect(ids("migrated conversation")).toEqual(["opencode"]);
  expect(db.query("SELECT count(*) AS n FROM units WHERE session_id = 'ses_abc123'").get()).toEqual({ n: 1 });
});

test("older indexes rebuild automatically for parser changes", () => {
  db.run("PRAGMA user_version = 1");
  db.close();
  db = openIndex(join(h.root, "index.db"));
  expect(db.query("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  expect(index()).toEqual([]);
  expect(ids("tracebench")).toEqual(["opencode"]);
});

test("a project folder linked into another home is read once", () => {
  symlinkSync(join(h.root, ".claude", "projects", "-work-app"), join(h.root, ".claude2", "projects", "-linked"));
  index();
  expect(find(db, CLAUDE_ID).home).toBe(join(h.root, ".claude"));
  expect(db.query("SELECT count(*) AS n FROM units WHERE session_id = ?").get(CLAUDE_ID)).toEqual({ n: 1 });
});

test("a thread split across files is one conversation", () => {
  const s = find(db, CODEX_ID.slice(0, 13));
  expect([s.messages, s.started, s.home]).toEqual([3, Date.parse("2026-09-24T07:16:00Z"), join(h.root, ".codex")]);
  expect(find(db, "22222222").home).toBe(join(h.root, ".claude2"));
});

test("updates follow the files", () => {
  fx.claude.write(h.root, ".claude", CLAUDE_ID, [fx.claude.user("Also mention the rollback document", "2026-10-09T05:30:00Z")]);
  index();
  expect(ids("rollback document")).toEqual(["claude"]);
  expect(ids("flaky")).toEqual(["claude"]);
  rmSync(join(h.root, ".claude2"), { recursive: true });
  index();
  expect(ids("flaky")).toEqual([]);
});

test("search: stemming, filters, phrases, exclusions", () => {
  expect(ids("billing migration")).toEqual(["claude"]);
  expect(search(db, "billing migration", { limit: 10 }).results[0]!.snippets[0]!.text).toContain("\x01billing\x02");
  expect(ids("dataset").sort()).toEqual(["codex", "opencode"]);
  expect(ids("dataset", { agents: ["opencode"] })).toEqual(["opencode"]);
  expect(ids("dataset", { project: "perf" })).toEqual(["opencode"]);
  expect(ids("dataset", { since: Date.parse("2026-10-01") })).toEqual(["opencode"]);
  expect(ids('"full rollback"')).toEqual(["claude"]);
  expect(ids('"rollback full"')).toEqual([]);
  expect(ids("dataset -tracebench")).toEqual(["codex"]);
  expect(ids("flaky OR rollback").length).toBe(2);
  expect(ids("billing migration", { exclude: [CLAUDE_ID] })).toEqual([]);
});

test("show with a query keeps matches and their neighbours", () => {
  const s = find(db, CODEX_ID);
  expect(transcript(db, s, "flame", 0).map((m) => m.seq)).toEqual([2]);
  expect(transcript(db, s, "flame", 1).map((m) => m.seq)).toEqual([1, 2]);
  expect(transcript(db, s).length).toBe(3);
});

test("recent, ids and queries", () => {
  expect(recent(db, { limit: 2 }).map((s) => s.agent)).toEqual(["claude", "opencode"]);
  expect(find(db, "ses_abc").agent).toBe("opencode");
  expect(() => find(db, "nope")).toThrow(/No conversation/);
  expect(toMatch('c++ "rollback plan" data* -redis')).toBe('("c++" "rollback plan" "data"*) NOT ("redis")');
  expect(toMatch("OR a OR OR b OR")).toBe('"a" OR "b"');
  expect(() => toMatch("-- !!")).toThrow();
});
