import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isAgent, UserError, type Agent, type Unit } from "./types.ts";

export const home = () => process.env.HOME || homedir();
export const tildify = (p: string) => (p === home() || p.startsWith(home() + "/") ? "~" + p.slice(home().length) : p);
const expand = (p: string) => (p === "~" || p.startsWith("~/") ? home() + p.slice(1) : p);
const dataHome = () => process.env.XDG_DATA_HOME || join(home(), ".local", "share");

export const configPath = () =>
  process.env.TRAWL_CONFIG || join(process.env.XDG_CONFIG_HOME || join(home(), ".config"), "trawl", "config.json");
export const indexPath = () => process.env.TRAWL_INDEX || join(dataHome(), "trawl", "index.db");

export interface Source {
  agent: Agent;
  path: string;
}

// What must exist under a root for it to hold that agent's history.
const MARKER: Record<Agent, string> = { claude: "projects", codex: "sessions", opencode: "" };

/** Agent homes listed in the config file, plus the usual places unless `"autodiscover": false`. */
export function sources(): Source[] {
  let config: { autodiscover?: boolean; sources?: { agent: unknown; path: string }[] } = {};
  if (existsSync(configPath())) {
    try {
      config = JSON.parse(readFileSync(configPath(), "utf8"));
    } catch (e) {
      throw new UserError(`${configPath()}: ${(e as Error).message}`);
    }
  }
  const wanted: [unknown, string | undefined, boolean][] = (config.sources ?? []).map((s) => [s.agent, s.path, true]);
  if (config.autodiscover !== false) {
    const h = home();
    wanted.push(["claude", process.env.CLAUDE_CONFIG_DIR, false], ["claude", join(h, ".claude"), false]);
    wanted.push(["codex", process.env.CODEX_HOME, false], ["codex", join(h, ".codex"), false]);
    // Extra homes such as ~/.claude2 or ~/.codex-work, used for other accounts.
    for (const name of readdirSync(h).sort()) {
      const m = /^\.(claude|codex)./.exec(name);
      if (m) wanted.push([m[1], join(h, name), false]);
    }
    wanted.push(["opencode", join(dataHome(), "opencode", "opencode.db"), false]);
  }

  const out: Source[] = [];
  const seen = new Set<string>();
  for (const [agent, raw, configured] of wanted) {
    if (!raw) continue;
    if (!isAgent(agent)) throw new UserError(`${configPath()}: unknown agent ${JSON.stringify(agent)}`);
    const path = resolve(expand(raw));
    if (!existsSync(join(path, MARKER[agent]))) {
      if (configured) process.stderr.write(`trawl: no ${agent} history at ${raw}\n`);
      continue;
    }
    const key = agent + realpathSync(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ agent, path });
  }
  return out;
}

/**
 * Real paths of files under `dir` whose relative path passes `keep`. Real paths
 * make a transcript reached through a linked folder (say ~/.claude2/projects/x
 * pointing into ~/.claude) count once.
 */
export function files(dir: string, keep: (rel: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter(keep).map((f) => realpathSync(join(dir, f)));
}

export function fileUnit(agent: Agent, home: string, key: string): Unit {
  const st = statSync(key);
  return { key, agent, home, mtime: Math.floor(st.mtimeMs), size: st.size };
}

/** JSON objects from a JSONL file, parsing only lines that pass `keep`. */
export function* jsonl(path: string, keep: (line: string) => boolean = () => true): Generator<any> {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line || !keep(line)) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object") yield o;
    } catch {}
  }
}
