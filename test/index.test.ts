import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
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
