import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { claude, cleanUser as cleanClaude } from "../src/agents/claude.ts";
import { codex, cleanUser as cleanCodex } from "../src/agents/codex.ts";
import { opencode } from "../src/agents/opencode.ts";
import { fileUnit } from "../src/sources.ts";
import * as fx from "./helpers.ts";

let h: ReturnType<typeof fx.fakeHome>;
beforeEach(() => (h = fx.fakeHome()));
afterEach(() => h.done());

const said = (f: { messages: { role: string; text: string }[] } | null) => f?.messages.map((m) => [m.role, m.text]);

test("claude: keeps what was said, drops harness noise", () => {
  const path = fx.claude.write(h.root, ".claude", "abc", [
    fx.claude.user("<local-command-caveat>Caveat</local-command-caveat>", "2026-10-01T10:00:00Z"),
    fx.claude.user("hidden", "2026-10-01T10:00:01Z", { isMeta: true }),
    fx.claude.user([{ type: "text", text: "<system-reminder>x</system-reminder>How do I split this migration into steps?" }], "2026-10-01T10:00:02Z"),
    fx.claude.toolResult("2026-10-01T10:00:03Z"),
    fx.claude.assistant("Start with the read path.", "2026-10-01T10:00:04Z"),
    fx.claude.title("Migration steps"),
  ]);
  const f = claude.parse(fileUnit("claude", h.root, path))!;
  expect([f.id, f.title, f.cwd]).toEqual(["abc", "Migration steps", "/work/app"]);
  expect(said(f)).toEqual([
    ["user", "How do I split this migration into steps?"],
    ["assistant", "Start with the read path."],
  ]);
  expect(f.started).toBe(Date.parse("2026-10-01T10:00:00Z"));
});

test("claude: slash commands survive only with arguments", () => {
  expect(cleanClaude("<command-name>/model</command-name><command-message>model</command-message>")).toBe("");
  expect(cleanClaude("<command-message>loop</command-message><command-name>/loop</command-name><command-args>5m check</command-args>")).toBe(
    "/loop 5m check",
  );
});

test("codex: drops injected context, keeps the conversation and question answers", () => {
  const path = fx.codex.write(h.root, ".codex", "rollout-x.jsonl", [
    fx.codex.meta("019f0000-0000-7000-8000-000000000001", "2026-10-01T09:00:00Z"),
    fx.codex.message("developer", "<permissions>rules</permissions>", "2026-10-01T09:00:00Z"),
    fx.codex.message("user", "# AGENTS.md instructions for /work/api\n\nbe nice", "2026-10-01T09:00:00Z"),
    fx.codex.message("user", "<environment_context>\n<cwd>/work/api</cwd>\n</environment_context>", "2026-10-01T09:00:00Z"),
    fx.codex.message("user", "Which datasets suit a cache benchmark?", "2026-10-01T09:00:01Z"),
    fx.codex.message("assistant", "The replay dataset has real traffic.", "2026-10-01T09:00:02Z"),
    fx.codex.event("user_message", "Which datasets suit a cache benchmark?", "2026-10-01T09:00:01Z"),
  ]);
  const f = codex.parse(fileUnit("codex", h.root, path))!;
  expect([f.id, f.cwd, f.subagent]).toEqual(["019f0000-0000-7000-8000-000000000001", "/work/api", false]);
  expect(said(f)).toEqual([
    ["user", "Which datasets suit a cache benchmark?"],
    ["assistant", "The replay dataset has real traffic."],
  ]);
  const reply = '<send_user_message_question_reply>[{"question":"Which workspace?","answer":"the team one"}]</send_user_message_question_reply>';
  expect(cleanCodex(reply)).toBe("> Which workspace?\nthe team one");
  expect(cleanCodex("<b>bold</b> is not context")).toBe("<b>bold</b> is not context");
});

test("codex: old event-only rollouts, subagents and thread names", () => {
  const old = fx.codex.write(h.root, ".codex", "rollout-old.jsonl", [
    fx.codex.meta("019f0000-0000-7000-8000-000000000002", "2026-10-01T09:00:00Z", { source: { subagent: { other: "guardian" } } }),
    fx.codex.event("user_message", "old question", "2026-10-01T09:00:01Z"),
    fx.codex.event("agent_message", "old answer", "2026-10-01T09:00:02Z"),
  ]);
  const f = codex.parse(fileUnit("codex", h.root, old))!;
  expect(said(f)?.map(([, t]) => t)).toEqual(["old question", "old answer"]);
  expect(f.subagent).toBe(true);

  fx.writeJsonl(join(h.root, ".codex", "session_index.jsonl"), [
    { id: "a", thread_name: "Old name" },
    { id: "a", thread_name: "New name" },
  ]);
  expect(codex.titles!(join(h.root, ".codex")).get("a")).toBe("New name");
});

test("opencode: text parts only, subagents flagged", () => {
  const db = fx.writeOpencode(join(h.root, "opencode.db"), [
    {
      id: "ses_a",
      title: "Dataset request message",
      dir: "/work/perf",
      parts: [
        { role: "user", text: "write a request for the dataset", at: 1000 },
        { role: "user", text: "attached file", synthetic: true, at: 1001 },
        { role: "user", text: "ignored text", ignored: true, at: 1001 },
        { role: "assistant", type: "tool", text: "tool output", at: 1002 },
        { role: "assistant", text: "Here it is.", at: 1003 },
      ],
    },
    { id: "ses_b", parent: "ses_a", title: "explore", dir: "/work/perf", parts: [{ role: "user", text: "look", at: 2000 }] },
  ]);
  const [a, b] = opencode.units(db).map((u) => opencode.parse(u)!);
  expect([a!.title, a!.subagent, b!.subagent]).toEqual(["Dataset request message", false, true]);
  expect(said(a!)).toEqual([
    ["user", "write a request for the dataset"],
    ["assistant", "Here it is."],
  ]);
});

test("opencode: v2-only databases use the type column, seq order, and inline text", () => {
  const path = fx.writeOpencodeV2(join(h.root, "v2.db"), [{
    id: "ses_v2", title: "Current conversation", messages: [
      { id: "new_user", type: "user", seq: 1, at: 2000, data: { text: "  current question  ", files: [{ text: "attachment noise" }] } },
      { id: "system", type: "system", seq: 2, at: 2001, data: { text: "system noise" } },
      { id: "synthetic", type: "synthetic", seq: 3, at: 2002, data: { text: "injected noise" } },
      { id: "compact", type: "compaction", seq: 4, at: 2003, data: { summary: "summary noise" } },
      { id: "new_assistant", type: "assistant", seq: 9, at: 1000, data: { content: [
        { type: "reasoning", text: "reasoning noise" },
        { type: "text", text: "first answer" },
        { type: "tool", text: "tool noise", state: { content: [{ type: "text", text: "result noise" }] } },
        { type: "text", text: "second answer" },
        { type: "text", text: "ignored noise", ignored: true },
      ] } },
    ],
  }, { id: "ses_child", parent: "ses_v2", messages: [
    { id: "child", type: "user", seq: 1, at: 3000, data: { text: "child task" } },
  ] }]);
  const units = opencode.units(path);
  const f = opencode.parse(units.find((u) => u.key.endsWith("#ses_v2"))!)!;
  expect([f.title, f.cwd, f.subagent]).toEqual(["Current conversation", "/work/v2", false]);
  expect(said(f)).toEqual([["user", "current question"], ["assistant", "first answer\n\nsecond answer"]]);
  expect(opencode.parse(units.find((u) => u.key.endsWith("#ses_child"))!)!.subagent).toBe(true);
});

test("opencode: assistant part rows precede trailing inline content", () => {
  const path = fx.writeOpencodeV2(join(h.root, "parts.db"), [{ id: "ses_parts", messages: [
    { id: "split", type: "assistant", seq: 1, at: 1000, data: { content: [] }, parts: [
      { type: "text", text: "first part" },
      { type: "reasoning", text: "hidden reasoning" },
      { type: "tool", text: "hidden tool output" },
      { type: "text", text: "second part" },
      { type: "text", text: "hidden synthetic", synthetic: true },
      { type: "text", text: "hidden ignored", ignored: true },
    ] },
    { id: "mixed", type: "assistant", seq: 2, at: 1001, data: { content: [{ type: "text", text: "inline tail" }] }, parts: [
      { type: "text", text: "stored part" },
    ] },
  ] }], { partRows: true });
  expect(said(opencode.parse(opencode.units(path)[0]!))).toEqual([
    ["assistant", "first part\n\nsecond part"], ["assistant", "stored part\n\ninline tail"],
  ]);
});

test("opencode: migrated sessions prefer v2 while legacy-only sessions survive", () => {
  const path = fx.writeOpencode(join(h.root, "mixed.db"), [
    { id: "ses_shared", title: "Old title", dir: "/work/old", parts: [{ role: "user", text: "stale text", at: 1000 }] },
    { id: "ses_legacy", title: "Legacy", dir: "/work/old", parts: [{ role: "user", text: "legacy question", at: 1000 }] },
    { id: "ses_empty", title: "Stale", dir: "/work/old", parts: [{ role: "user", text: "deleted in v2", at: 1000 }] },
  ]);
  fx.writeOpencodeV2(path, [
    { id: "ses_shared", title: "New title", messages: [{ id: "current", type: "user", seq: 1, at: 1000, data: { text: "current text" } }] },
    { id: "ses_empty", messages: [] },
  ]);
  const units = opencode.units(path);
  expect(units).toHaveLength(3);
  const fragments = units.map((u) => opencode.parse(u));
  expect(fragments.find((f) => f?.id === "ses_shared")?.title).toBe("New title");
  expect(fragments.flatMap((f) => f?.messages.map((m) => m.text) ?? []).sort()).toEqual(["current text", "legacy question"]);
});

test("opencode: early v2 projections using the session table", () => {
  const path = fx.writeOpencodeV2(join(h.root, "early.db"), [{ id: "ses_early", messages: [
    { id: "early", type: "user", seq: 1, at: 1000, data: { text: "early v2 question" } },
  ] }], { sessionTable: "session" });
  expect(said(opencode.parse(opencode.units(path)[0]!))).toEqual([["user", "early v2 question"]]);
});
