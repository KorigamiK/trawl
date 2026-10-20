import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileUnit, files, jsonl } from "../sources.ts";
import type { Adapter, Message } from "../types.ts";

/** Strips context Codex injects as user messages; keeps answers to the agent's questions. */
export function cleanUser(raw: string): string {
  const text = raw.trim();
  const reply = /^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/.exec(text);
  if (reply) {
    try {
      return JSON.parse(reply[1]!).map((q: any) => `> ${q.question}\n${q.answer}`).join("\n\n");
    } catch {
      return reply[1]!.trim();
    }
  }
  const tag = /^<([\w-]+)[\s>]/.exec(text)?.[1];
  return text.startsWith("# AGENTS.md instructions") || (tag && text.endsWith(`</${tag}>`)) ? "" : text;
}

// Only these lines are parsed; tool calls and their often huge outputs are skipped.
const WANTED = /"(session_meta|message|user_message|agent_message)"/;

/** Rollouts at `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, titles in `<home>/session_index.jsonl`. */
export const codex: Adapter = {
  units: (root) =>
    ["sessions", "archived_sessions"]
      .flatMap((d) => files(join(root, d), (f) => basename(f).startsWith("rollout-") && f.endsWith(".jsonl")))
      .map((f) => fileUnit("codex", root, f)),

  parse(unit) {
    let meta: any;
    let updated = 0;
    const messages: Message[] = [];
    const events: Message[] = [];
    for (const o of jsonl(unit.key, (l) => WANTED.test(l))) {
      const ts = Date.parse(o.timestamp) || 0;
      updated = Math.max(updated, ts);
      const p = o.payload ?? {};
      if (o.type === "session_meta") meta ??= p;
      if (o.type === "response_item" && p.type === "message" && (p.role === "user" || p.role === "assistant")) {
        const kind = p.role === "user" ? "input_text" : "output_text";
        const text = (p.content ?? [])
          .filter((c: any) => c.type === kind)
          .map((c: any) => (p.role === "user" ? cleanUser(c.text) : c.text.trim()))
          .filter(Boolean)
          .join("\n\n");
        if (text) messages.push({ role: p.role, text, ts });
      }
      // Older rollouts carry the conversation only as events.
      if (o.type === "event_msg" && (p.type === "user_message" || p.type === "agent_message")) {
        const text = p.type === "user_message" ? cleanUser(p.message ?? "") : (p.message ?? "").trim();
        if (text) events.push({ role: p.type === "user_message" ? "user" : "assistant", text, ts });
      }
    }
    // A thread continued in another file keeps the original id in its session_meta.
    const id = meta?.id ?? /[0-9a-f]{8}-[0-9a-f-]{27}/.exec(basename(unit.key))?.[0];
    const conversation = messages.length ? messages : events;
    if (!id || !conversation.length) return null;
    return {
      agent: "codex",
      id,
      home: unit.home,
      cwd: meta?.cwd,
      subagent: Boolean(meta?.source?.subagent) || meta?.thread_source === "subagent",
      started: Date.parse(meta?.timestamp) || conversation[0]!.ts,
      updated,
      messages: conversation,
    };
  },

  titles(root) {
    const file = join(root, "session_index.jsonl");
    // Later lines are newer renames.
    return new Map(existsSync(file) ? [...jsonl(file)].map((o): [string, string] => [o.id, o.thread_name]) : []);
  },
};
