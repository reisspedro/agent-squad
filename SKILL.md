---
name: agent-squad
description: PARALLEL execution of multiple coding-agent CLIs (Claude Code, Codex, Grok) for simultaneous coding and divergent idea generation. Use when a task can be split into independent pieces touched at the same time, or when you want several divergent takes at once. Fan-out, not chat — dispatch all agents together, each coder isolated in a git worktree (zero conflicts), review and integrate at the end.
---

# Agent Squad — simultaneous coding + parallel ideas

Philosophy: **decompose → dispatch in parallel → isolate → review → integrate.**

## When to use (and when NOT to)

| Situation | Squad? | Mode |
|---|---|---|
| Task splittable into independent pieces (distinct files/modules) | ✅ | `code` |
| Want 2-3 divergent takes/angles at once | ✅ | `ideas` |
| Task needs shared context / a single file | ❌ | do it solo or sequentially |
| Small surgical change | ❌ | do it directly |
| Large refactor touching everything | ❌ | serial, one agent |

**Rule:** if the parts are not independent, it is not squad work. Parallelizing coupled
things creates conflicts and rework — worse than solo.

## Protocol (what the leader does)

1. **Decompose.** Split into N independent units. For each: agent, clear goal, and the files
   it MAY touch (no overlap). Two units touching the same file → merge them into one.
2. **Contract first.** If the parts integrate later (modules importing each other), DEFINE
   the interface (signatures, formats) BEFORE dispatching. Each agent codes against it.
3. **Dispatch.** `node squad.mjs code tasks.json --worktree` — everyone runs at once; each
   coder in its own git worktree (shared `.git`, isolated working dir).
4. **Review.** Read EVERY diff (`git -C <worktree> diff`), run the build, only then integrate.
5. **Integrate & clean.** Bring approved changes to the main tree, resolve edges, clean
   build, remove worktrees.

## Ideas mode

```
node squad.mjs ideas "question" [--only codex,grok] [--files a.js,b.js]
```

Same question to all agents in parallel; collect divergent answers; synthesize yourself.
Preserve divergence — the value is in the different angles, not consensus.
`--files` injects file content into Grok's prompt (it doesn't read the repo); `-` = stdin.

## Non-negotiables

- The leader reviews and integrates everything. Nothing merges without review + clean build.
- One unit = one owner. Nobody touches another unit's files.
- `--worktree` for real simultaneous coding. Without it, only parallelize tasks that touch
  provably distinct files.
