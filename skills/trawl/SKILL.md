---
name: trawl
description: Find and read earlier conversations with coding agents (Claude Code, Codex, opencode) on this machine. Use when the user refers to a past session or chat ("the conversation where we…", "what did we decide about…", "find that chat from last week"), wants to recover an earlier answer, draft or plan, or wants to resume an old session.
license: MIT
metadata:
  source: https://github.com/KorigamiK/trawl
---

# trawl

`trawl` searches every local Claude Code, Codex and opencode transcript through a full-text index. It works offline and only reads agent files.

If `trawl` isn't on PATH, ask the user before installing it with `bun add -g github:KorigamiK/trawl`.

## Finding a conversation

1. Search with the distinctive words the user would have typed, not a general name for the topic:

   ```sh
   trawl "flaky login" test --json
   ```

   All words are required and matched by stem. Also: `"exact phrase"`, `-exclude`, `prefix*`, `a OR b`. Narrow with `-a claude|codex|opencode`, `-p <directory substring>`, `-s 7d|2w|3m|<date>`, `-n <limit>`.

2. If nothing fits, retry with fewer words, synonyms or `OR` before concluding the conversation doesn't exist. Each result has a title, the opening prompt, matching snippets and a hit count.

3. Read the best candidate, keeping only the matching parts:

   ```sh
   trawl show <id> flaky login --json
   ```

   Add `-C 2` for more surrounding messages, or drop the query to get the whole transcript.

4. Report the agent, date, project and id, quote what the user needs, and give the `resume` command from the result.

Ids accept any unique prefix. `trawl list --json` shows recent conversations, and `trawl sources` shows which agent homes are indexed. More homes can be added in `~/.config/trawl/config.json`.

## Care

Transcripts are private and may contain credentials the user pasted. Quote only what the request needs, and never send transcript content to another service.
