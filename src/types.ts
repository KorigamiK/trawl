export const AGENTS = ["claude", "codex", "opencode"] as const;
export type Agent = (typeof AGENTS)[number];
export const isAgent = (a: unknown): a is Agent => AGENTS.includes(a as Agent);

export interface Message {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

/** What one unit says about a session. A session can span several units. */
export interface Fragment {
  agent: Agent;
  id: string;
  home: string;
  title?: string;
  cwd?: string;
  subagent: boolean;
  started?: number;
  updated?: number;
  messages: Message[];
}

/** Something whose changes are cheap to detect: a transcript file, or a database row. */
export interface Unit {
  key: string;
  agent: Agent;
  home: string;
  mtime: number;
  size: number;
}

export interface Adapter {
  units(root: string): Unit[];
  parse(unit: Unit): Fragment | null;
  /** Titles stored outside the transcripts, by session id. */
  titles?(root: string): Map<string, string>;
}

export interface Session {
  pk: number;
  agent: Agent;
  id: string;
  home: string;
  title: string | null;
  cwd: string | null;
  subagent: number;
  started: number | null;
  updated: number | null;
  first_prompt: string | null;
  messages: number;
}

export class UserError extends Error {}
