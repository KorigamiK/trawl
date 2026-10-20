#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { openIndex, update } from "./db.ts";
import { find, recent, search, transcript, type Filters } from "./search.ts";
import { configPath, home, indexPath, sources, tildify } from "./sources.ts";
import { AGENTS, isAgent, UserError, type Agent, type Session } from "./types.ts";

const HELP = `trawl ${pkg.version}: search your Claude Code, Codex and opencode conversations, locally.

  trawl <query>             conversations matching query, best first
  trawl show <id> [query]   a conversation, or only the parts matching query
  trawl list                recent conversations
  trawl resume <id>         the command that reopens a conversation
  trawl sources             where trawl reads from

  -a, --agent <name>        ${AGENTS.join(", ")} (repeatable)
  -p, --project <text>      working directory contains text
  -s, --since <when>        12h, 7d, 2w, 3m, 1y or a date
  -n, --limit <n>           number of results (default 10, list 20)
  -C, --context <n>         messages around each match in show (default 1)
      --subagents           include subagent sessions
      --json                machine-readable output

Queries: words are all required, "exact phrase", -exclude, prefix*, this OR that.
Config: ${tildify(configPath())}
`;

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const [bold, dim, yellow, blue] = ["1", "2", "33", "34"].map(paint) as ((s: string) => string)[];
const agentColor: Record<Agent, (s: string) => string> = { claude: paint("35"), codex: paint("36"), opencode: paint("32") };
const mark = (s: string) => (color ? s.replaceAll("\x01", "\x1b[1;33m").replaceAll("\x02", "\x1b[0m") : unmark(s));
const unmark = (s: string) => s.replace(/[\x01\x02]/g, "");

const print = (s = ""): void => void process.stdout.write(s + "\n");
const json = (value: unknown) => print(JSON.stringify(value, null, 2));
const flat = (s: string) => s.replace(/<\/?[\w-]+>/g, " ").replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);

/** Cuts text containing match markers, closing a highlight the cut left open. */
function cutMarked(s: string, n: number): string {
  const short = cut(s, n);
  return short.lastIndexOf("\x01") > short.lastIndexOf("\x02") ? short + "\x02" : short;
}
const time = (ms: number | null) => (ms ? new Date(ms).toLocaleString("sv-SE").slice(0, 16) : "");
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

function ago(ms: number | null): string {
  const s = (Date.now() - (ms ?? 0)) / 1000;
  const units = [["y", 31_536_000], ["mo", 2_592_000], ["w", 604_800], ["d", 86_400], ["h", 3_600], ["m", 60]] as const;
  for (const [unit, n] of units) if (s >= n) return `${Math.floor(s / n)}${unit} ago`;
  return "just now";
}

function since(when: string): number {
  const rel = /^(\d+)([hdwmy])$/.exec(when);
  const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 2_592_000_000, y: 31_536_000_000 };
  const t = rel ? Date.now() - Number(rel[1]) * unit[rel[2] as keyof typeof unit] : Date.parse(when);
  if (Number.isNaN(t)) throw new UserError(`--since takes 12h, 7d, 2w, 3m, 1y or a date, not "${when}"`);
  return t;
}

// Codex ids are UUIDv7, whose first 12 hex digits are a timestamp.
const shortId = (s: Session) => s.id.slice(0, { claude: 8, codex: 13, opencode: 16 }[s.agent]);
const title = (s: Session) => flat(s.title || s.first_prompt || "") || "(untitled)";

/** Title, then the opening prompt, which is often what people remember. */
function heading(s: Session, width: number): string {
  const t = cut(title(s), width);
  const room = width - t.length - 3;
  return bold(t) + (s.title && s.first_prompt && room > 12 ? dim(` — ${cut(flat(s.first_prompt), room)}`) : "");
}

function resume(s: Session): string {
  const quote = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`);
  const path = (p: string) => (tildify(p).startsWith("~/") ? "~/" + quote(tildify(p).slice(2)) : quote(p));
  const cd = s.cwd ? `cd ${s.cwd === home() ? "~" : path(s.cwd)} && ` : "";
  const homeEnv = { claude: ["CLAUDE_CONFIG_DIR", ".claude"], codex: ["CODEX_HOME", ".codex"], opencode: null }[s.agent];
  const env = homeEnv && s.home !== join(home(), homeEnv[1]!) ? `${homeEnv[0]}=${path(s.home)} ` : "";
  const command = { claude: "claude --resume", codex: "codex resume", opencode: "opencode -s" }[s.agent];
  return `${cd}${env}${command} ${s.id}`;
}

/** A numbered conversation heading, then the full command that resumes it. */
function entry(s: Session, i: number, width: number, note = ""): void {
  print(`${dim(`${i + 1}.`.padStart(3))} ${heading(s, width - 30)}  ${agentColor[s.agent](s.agent)} ${dim(ago(s.updated) + note)}`);
  print(`    ${resume(s).replace(s.id, yellow(s.id))}`);
}

const sessionJson = (s: Session) => ({
  agent: s.agent,
  id: s.id,
  title: s.title,
  first_prompt: s.first_prompt,
  cwd: s.cwd,
  started: iso(s.started),
  updated: iso(s.updated),
  messages: s.messages,
  resume: resume(s),
});

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: "string", short: "a", multiple: true },
      project: { type: "string", short: "p" },
      since: { type: "string", short: "s" },
      limit: { type: "string", short: "n" },
      context: { type: "string", short: "C" },
      subagents: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

function count(value: string | undefined, fallback: number, flag: string): number {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 0) throw new UserError(`${flag} takes a whole number, not "${value}"`);
  return n;
}

export async function main(argv: string[]): Promise<void> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (e) {
    throw new UserError(`${(e as Error).message}. See trawl --help.`);
  }
  const { values: v, positionals } = args;
  if (v.version) return print(`trawl ${pkg.version}`);
  const [command, ...rest] = positionals;
  if (v.help || !command) return print(HELP.trimEnd());

  const agents = (v.agent ?? []).flatMap((a) => a.split(","));
  const unknown = agents.find((a) => !isAgent(a));
  if (unknown) throw new UserError(`Unknown agent "${unknown}". Choose from ${AGENTS.join(", ")}.`);
  const filters: Filters = {
    agents: agents as Agent[],
    project: v.project,
    since: v.since ? since(v.since) : undefined,
    subagents: v.subagents,
    limit: count(v.limit, command === "list" ? 20 : 10, "--limit"),
  };

  const db = openIndex(indexPath());
  const roots = sources();
  for (const warning of update(db, roots)) process.stderr.write(`trawl: skipped ${warning}\n`);
  const width = Math.min(process.stdout.columns || 100, 160);

  switch (command) {
    case "show": {
      if (!rest[0]) throw new UserError("Which conversation? For example: trawl show 6f1c2a9e");
      const s = find(db, rest[0]);
      const query = rest.slice(1).join(" ") || undefined;
      const messages = transcript(db, s, query, count(v.context, 1, "--context"));
      if (v.json) {
        return json({ ...sessionJson(s), transcript: messages.map((m) => ({ role: m.role, time: iso(m.ts), text: unmark(m.text) })) });
      }
      print(bold(title(s)));
      print(`${agentColor[s.agent](s.agent)} ${yellow(s.id)}`);
      print(dim([s.cwd && tildify(s.cwd), `${time(s.started)} → ${time(s.updated)}`, `${s.messages} messages`].filter(Boolean).join(" · ")));
      print(dim("resume: ") + resume(s));
      let prev: number | undefined;
      for (const m of messages) {
        if (prev !== undefined && m.seq > prev + 1) print(dim("\n⋯"));
        prev = m.seq;
        print(`\n${m.role === "user" ? blue(bold("you")) : agentColor[s.agent](bold(s.agent))} ${dim(time(m.ts))}`);
        print(mark(m.text));
      }
      if (query && !messages.length) print(dim("\nNo messages match."));
      // Repeated at the end, where a long transcript leaves the terminal.
      return print(`\n${dim("resume:")} ${resume(s)}`);
    }

    case "list": {
      const sessions = recent(db, filters);
      if (v.json) return json(sessions.map(sessionJson));
      return sessions.forEach((s, i) => entry(s, i, width));
    }

    case "resume": {
      if (!rest[0]) throw new UserError("Which conversation? For example: trawl resume 6f1c2a9e");
      const command = resume(find(db, rest[0]));
      return v.json ? json({ command }) : print(command);
    }

    case "sources": {
      const n = db.query("SELECT count(*) AS n FROM sessions WHERE agent = ? AND home = ? AND subagent = 0");
      const list = roots.map((r) => ({ ...r, conversations: (n.get(r.agent, r.path) as { n: number }).n }));
      if (v.json) return json({ sources: list, config: configPath(), index: indexPath() });
      const pad = Math.max(...list.map((r) => tildify(r.path).length));
      for (const r of list) print(`${r.agent.padEnd(9)} ${tildify(r.path).padEnd(pad)}  ${dim(`${r.conversations} conversations`)}`);
      return print(dim(`\nconfig ${tildify(configPath())}\nindex  ${tildify(indexPath())}`));
    }
  }

  const query = (command === "search" ? rest : positionals).join(" ");
  // Leave out the conversation trawl is being run from, if inside Claude Code.
  const current = process.env.CLAUDE_CODE_SESSION_ID;
  const { total, results } = search(db, query, { ...filters, exclude: current ? [current] : [] });
  if (v.json) {
    const snippets = (r: (typeof results)[number]) => r.snippets.map((x) => ({ role: x.role, text: unmark(flat(x.text)) }));
    return json({ total, results: results.map((r) => ({ ...sessionJson(r.session), hits: r.hits, snippets: snippets(r) })) });
  }
  if (!results.length) return print(dim(`No conversations match "${query}".`));
  results.forEach(({ session: s, hits, snippets }, i) => {
    entry(s, i, width, ` · ${hits} ${hits === 1 ? "match" : "matches"}`);
    const pad = s.agent.length;
    for (const x of snippets) {
      const who = x.role === "user" ? blue("you".padEnd(pad)) : agentColor[s.agent](s.agent);
      print(`    ${who}  ${mark(cutMarked(flat(x.text), width - 16))}`);
    }
    print();
  });
  const id = shortId(results[0]!.session);
  print(dim(`${total} ${total === 1 ? "conversation" : "conversations"}. Read one with: trawl show ${id} ${query}`));
}

if (import.meta.main) {
  process.stdout.on("error", () => process.exit(0)); // e.g. piped into head
  try {
    await main(Bun.argv.slice(2));
  } catch (e) {
    process.stderr.write(`trawl: ${e instanceof UserError ? e.message : (e as Error).stack}\n`);
    process.exit(e instanceof UserError ? 1 : 2);
  }
}
