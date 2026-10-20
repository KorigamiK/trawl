import { basename, join, sep } from "node:path";
import { fileUnit, files, jsonl } from "../sources.ts";
import type { Adapter, Message } from "../types.ts";

/** Strips what Claude Code adds to user turns; returns "" for turns the person didn't type. */
export function cleanUser(raw: string): string {
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (/^<command-(name|message)>/.test(text)) {
    // Slash commands are kept only when they carry arguments.
    const name = /<command-name>(.*?)<\/command-name>/.exec(text)?.[1];
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return name && args ? `${name} ${args}` : "";
  }
  return /^(<(local-command|task-notification|bash-)|\[Request interrupted|Caveat: The messages below)/.test(text)
    ? ""
    : text;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b?.type === "text")
          .map((b) => b.text)
          .join("\n\n")
      : "";

/** `<home>/projects/<encoded cwd>/<session id>.jsonl`; subagent transcripts sit deeper and are skipped. */
export const claude: Adapter = {
  units: (root) =>
    files(join(root, "projects"), (f) => f.endsWith(".jsonl") && f.split(sep).length === 2).map((f) =>
      fileUnit("claude", root, f),
    ),

  parse(unit) {
    const messages: Message[] = [];
    let cwd: string | undefined, custom: string | undefined, generated: string | undefined;
    let started: number | undefined, updated: number | undefined;
    for (const o of jsonl(unit.key)) {
      const ts = Date.parse(o.timestamp) || 0;
      if (ts) [started, updated] = [Math.min(started ?? ts, ts), Math.max(updated ?? ts, ts)];
      cwd ??= o.cwd;
      if (o.type === "custom-title") custom = o.customTitle;
      if (o.type === "ai-title" || o.type === "summary") generated = o.aiTitle ?? o.summary;
      if (o.isSidechain) continue;
      const text =
        o.type === "user" && !o.isMeta && !o.isCompactSummary
          ? cleanUser(textOf(o.message?.content))
          : o.type === "assistant"
            ? textOf(o.message?.content).trim()
            : "";
      if (text) messages.push({ role: o.type, text, ts });
    }
    if (!messages.length) return null;
    const id = basename(unit.key, ".jsonl");
    return { agent: "claude", id, home: unit.home, title: custom ?? generated, cwd, subagent: false, started, updated, messages };
  },
};
