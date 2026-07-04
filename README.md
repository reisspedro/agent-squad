# 🤝 agent-squad

**Run multiple coding-agent CLIs in parallel — one command, N independent agents, zero conflicts.**

Not a chat. A *fan-out*: every agent receives the task at the same time, works independently
(each coder isolated in its own **git worktree**), and you review/integrate at the end.

Works today with **Claude Code** (`claude -p`), **Codex** (`codex exec`) and **Grok CLI**.
Single file, zero dependencies, Node 18+.

```
npm i    # nothing to install — it's one file
node squad.mjs ideas "what's the biggest coupling risk in this codebase?"
node squad.mjs code tasks.json --worktree
```

## Why

- **Divergence is the value.** Three different models attack the same question independently
  (no groupthink, no shared session). You synthesize.
- **Parallel coding without collisions.** Each task runs in an isolated git worktree on its
  own branch. Overlapping file claims are rejected *before* any tokens are spent.
- **Trustable in automation.** Any failed/empty task → `exit 1`. Out-of-scope edits are
  flagged in the summary.

## Mode 1 — `ideas` (divergent brainstorming, read-only)

```bash
node squad.mjs ideas "your question"
node squad.mjs ideas "your question" --only codex,grok
node squad.mjs ideas "review this data" --files src/router.js,metrics.json
cat report.txt | node squad.mjs ideas "what stands out?" --files -
```

The same question goes to all agents simultaneously. Answers land in
`.squad/<id>/summary.md` plus one `.out.md` per agent.

`--files a.js,b.js` injects file **content** into Grok's prompt (its CLI is unstable when
reading files itself on long prompts, so the squad reads for it — with per-file and total
caps). `-` injects stdin. Claude and Codex explore the repo on their own.

## Mode 2 — `code` (simultaneous coding, isolated)

```bash
node squad.mjs code tasks.json --worktree
node squad.mjs code tasks.json --dry-run   # show the plan, execute nothing
```

`tasks.json`:

```json
{
  "tasks": [
    { "agent": "codex",  "title": "parser tests", "prompt": "Write test/x.test.mjs covering the parser error cases.", "files": ["test/x.test.mjs"] },
    { "agent": "grok",   "title": "module docs",  "prompt": "Write docs/x.md explaining the module.",                 "files": ["docs/x.md"] },
    { "agent": "claude", "title": "core",         "prompt": "Implement src/x.js against the agreed interface.",       "files": ["src/x.js"] }
  ]
}
```

- `agent`: `claude` | `codex` | `grok`
- `files` (optional, recommended): what the task MAY touch. Two tasks claiming the same file
  → abort (they're not independent). In worktree mode, edits outside the allowlist are
  flagged in `summary.md`.
- `worktree`: per-task override of the `--worktree` flag.

**Golden rule: one unit = one owner.** If two tasks need the same file, they're one task.

### The review loop (you are the integrator)

1. Decompose the work into independent units; define interfaces *before* dispatching.
2. `node squad.mjs code tasks.json --worktree`
3. For each worktree: `git -C <worktree> diff` → read what the agent reported → run your build.
4. Integrate only what passes review. `git worktree remove <path>` when done.

Nothing merges itself. The squad parallelizes work — judgment stays with you.

## Output layout

```
.squad/<timestamp>/
  <agent>-<n>.in.txt    # exact prompt each agent received
  <agent>-<n>.out.md    # full answer/report per agent
  <agent>-<n>.err.log   # stderr (diagnostics)
  summary.md            # consolidated summary + review checklist
  wt-<agent>-<n>/       # worktrees (code mode)
```

Add `.squad/` to your `.gitignore`.

## Requirements & config

| Agent | CLI on PATH | Notes |
|---|---|---|
| `claude` | [Claude Code](https://claude.com/claude-code) (`claude`) | prompt via stdin |
| `codex` | Codex CLI (`codex`) | answer captured via `-o` |
| `grok` | Grok CLI | binary path override: env `GROK_EXE` |

- Windows: uses Git Bash automatically (override with env `SQUAD_BASH`). Linux/macOS: `/bin/bash`.
- `code` mode runs agents with their permission-bypass flags — **only use it in repos you
  trust, and always review the diffs.**

## What this is NOT

- Not a turn-by-turn chat between models — divergence beats consensus for brainstorming.
- Not "auto-merge my code" — you decompose, you review, you integrate.
- Not a speedup of any single model — it's doing 3 things in the time of 1.

---

*"Truly, truly, I say to you, unless a grain of wheat falls into the earth and dies, it remains alone; but if it dies, it bears much fruit."* — John 12:24

MIT © Pedro Reis
