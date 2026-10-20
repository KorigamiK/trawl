import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fx from "./helpers.ts";

const ID = "33333333-aaaa-4bbb-8ccc-000000000003";
let h: ReturnType<typeof fx.fakeHome>;

function trawl(...args: string[]) {
  const env = { ...process.env, HOME: h.root, TRAWL_INDEX: join(h.root, "index.db"), CLAUDE_CODE_SESSION_ID: "" };
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { env });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

beforeAll(() => {
  h = fx.fakeHome();
  fx.claude.write(h.root, ".claude", ID, [
    fx.claude.user("How should I phrase the deprecation notice?", "2026-10-08T05:30:00Z"),
    fx.claude.assistant("Lead with the migration path.", "2026-10-08T05:31:00Z"),
    fx.claude.title("Deprecation notice"),
  ]);
});
afterAll(() => h.done());

test("search, show, resume", () => {
  const found = trawl("deprecation", "notice");
  expect(found.out).toContain("Deprecation notice");
  expect(found.out).not.toContain("\x1b[");
  expect(found.out).toContain(`cd /work/app && claude --resume ${ID}`);
  expect(trawl("list").out).toContain(`claude --resume ${ID}`);
  expect(trawl("show", "3333").out.trim().split("\n").at(-1)).toBe(`resume: cd /work/app && claude --resume ${ID}`);
  expect(JSON.parse(trawl("migration", "--json").out).results[0].resume).toBe(`cd /work/app && claude --resume ${ID}`);
  expect(trawl("show", "3333").out).toContain("Lead with the migration path.");
  expect(JSON.parse(trawl("show", ID, "migration", "-C", "0", "--json").out).transcript.map((m: any) => m.role)).toEqual(["assistant"]);
  expect(trawl("resume", "3333").out.trim()).toBe(`cd /work/app && claude --resume ${ID}`);
});

test("configured sources", () => {
  fx.claude.write(h.root, "work-claude", "44444444-aaaa-4bbb-8ccc-000000000004", [fx.claude.user("Work question", "2026-10-09T05:30:00Z")]);
  mkdirSync(join(h.root, ".config", "trawl"), { recursive: true });
  const config = { autodiscover: false, sources: [{ agent: "claude", path: "~/work-claude" }] };
  writeFileSync(join(h.root, ".config", "trawl", "config.json"), JSON.stringify(config));
  expect(trawl("work").out).toContain("44444444");
  expect(trawl("deprecation").out).toContain("No conversations match");
  expect(JSON.parse(trawl("sources", "--json").out).sources.map((s: any) => s.path)).toEqual([join(h.root, "work-claude")]);
});

test("errors are short", () => {
  expect(trawl("--nope").err).toContain("See trawl --help");
  expect(trawl("show", "ffff").err).toContain("No conversation");
  expect(trawl("x", "--since", "whenever").code).toBe(1);
});
