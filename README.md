# trawl

Search every conversation you've had with Claude Code, Codex and opencode, entirely on your machine.

You remember *what* you worked out with an agent, but not which agent, which project or which config home it was in. trawl indexes all of them and gets you back to the conversation.

```console
$ trawl flaky login test
 1. Fix flaky login test — the login test fails about one run in five on CI…  claude 3d ago · 4 matches
    cd ~/code/webapp && claude --resume 6f1c2a9e-3b7d-4e8a-9c41-2d5e8f0a7b13
    you     …the login test fails about one run in five on CI, only on Linux…
    claude  …the test races the session cookie; wait for the redirect before asserting…

$ trawl show 6f1c2a9e cookie    # only the matching messages, with context
```

Every result, `trawl list` entry and `trawl show` ends with the command that reopens the conversation in its agent (`claude --resume`, `codex resume` or `opencode -s`), run from the right directory and config home.

## Install

Needs [Bun](https://bun.sh) 1.2+. No other dependencies.

```sh
bun add -g github:KorigamiK/trawl
```

`bun run build` makes a standalone `dist/trawl` binary.

## Usage

```
trawl <query>             conversations matching query, best first
trawl show <id> [query]   a conversation, or only the parts matching query
trawl list                recent conversations
trawl resume <id>         the command that reopens a conversation
trawl sources             where trawl reads from

-a, --agent <name>        claude, codex, opencode (repeatable)
-p, --project <text>      working directory contains text
-s, --since <when>        12h, 7d, 2w, 3m, 1y or a date
-n, --limit <n>           number of results (default 10, list 20)
-C, --context <n>         messages around each match in show (default 1)
    --subagents           include subagent sessions
    --json                machine-readable output
```

Queries: words are all required and stemmed, `"exact phrase"`, `-exclude`, `prefix*`, `this OR that`. Ids can be shortened to any unique prefix.

## Agent skill

`skills/trawl/SKILL.md` teaches your agents to find and read earlier conversations with trawl (`--json` output, and inside Claude Code the current conversation is left out). Install it with `bunx skills add KorigamiK/trawl`, or link the folder into your agent's skills directory:

```sh
ln -s "$PWD/skills/trawl" ~/.agents/skills/trawl   # or ~/.claude/skills/trawl
```

## Where it looks

| Agent | Default locations |
| --- | --- |
| Claude Code | `~/.claude`, `$CLAUDE_CONFIG_DIR`, other `~/.claude*` homes |
| Codex | `~/.codex`, `$CODEX_HOME`, other `~/.codex*` homes |
| opencode | `~/.local/share/opencode/opencode.db` |

Add other locations in `~/.config/trawl/config.json`:

```json
{
  "autodiscover": true,
  "sources": [
    { "agent": "claude", "path": "~/work/claude-home" },
    { "agent": "codex", "path": "/Volumes/backup/.codex" },
    { "agent": "opencode", "path": "~/other/opencode.db" }
  ]
}
```

Set `"autodiscover": false` to read only the listed sources.

Only what you and the agent wrote is indexed. Injected context, tool calls and their output, and reasoning are skipped.

## Privacy

trawl makes no network requests and never writes to agent files. The index lives at `~/.local/share/trawl/index.db` (override with `$TRAWL_INDEX`). It contains your conversation text, so treat it like the transcripts. It is updated incrementally before every command, and conversations disappear from it when their transcripts are deleted.

## Development

```sh
bun install
bun test
bun run typecheck
```

Each agent is one file in `src/agents/` that lists units cheaply and parses one into messages. Tests use synthetic transcripts only.

## License

MIT
