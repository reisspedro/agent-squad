---
name: agent-squad
description: PARALLEL execution of multiple coding-agent CLIs (Claude Code, Codex, Grok, or any headless agent CLI) for simultaneous coding, divergent idea generation, and parallel code review of real diffs. Use when a task can be split into independent pieces touched at the same time, when you want several divergent takes at once, or when you want a diff audited against its declared intent by reviewers that did not write it. Fan-out, not chat — dispatch all agents together, each coder isolated in a git worktree (zero conflicts), review and integrate at the end. Includes a benchmark protocol to measure your agents and assign roles by evidence.
---

# Agent Squad — simultaneous coding + parallel ideas

Philosophy: **decompose → dispatch in parallel → isolate → review → integrate.**

This file is self-contained on purpose: drop it into any agent's skill/instructions
directory and it works. The only external piece is the runner (`squad.mjs`, one file,
zero deps) — or replace the runner with whatever dispatch mechanism your stack has.

## When to use (and when NOT to)

| Situation | Squad? | Mode |
|---|---|---|
| Task splittable into independent pieces (distinct files/modules) | ✅ | `code` |
| Want 2-3 divergent takes/angles at once | ✅ | `ideas` |
| A diff needs auditing against its declared intent, by non-authors | ✅ | `review` |
| Task needs shared context / a single file | ❌ | do it solo or sequentially |
| Small surgical change | ❌ | do it directly |
| Large refactor touching everything | ❌ | serial, one agent |

**Rule:** if the parts are not independent, it is not squad work. Parallelizing coupled
things creates conflicts and rework — worse than solo.

## Roles: assign by evidence, not by vibes

A squad works best when each agent has a **default lane** matched to its measured
strengths. Typical lanes (map them to YOUR agents after benchmarking — see below):

- **Leader / integrator** — decomposes, defines contracts, reviews every diff, merges,
  owns product coherence and the long-term memory of the project. Exactly one leader.
- **Precision implementer** — core logic, tests, edge cases, security-sensitive code,
  and *precision reviews* (finds exactly the defects that exist, no padding).
- **Creative critic** — UI/UX, divergent exploration, adversarial critique, tradeoff
  discussions. The agent you want disagreeing with you.

Mixed task pipeline: **leader defines the contract → implementer builds the core →
critic finishes interface/UX** — three sequential handoffs, each against the contract.

Don't guess the lanes: **benchmark your agents** (see [BENCHMARK.md](BENCHMARK.md)) and
re-run the benchmark when models change. Specialization guides allocation; it must
never become a permanent monopoly.

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

## Review discipline (battle-tested rules)

- **Cross-review is mandatory** when a change touches protected/sacred files (auth,
  schema, prompts, security modules — define your list), or spans multiple files beyond
  ~80 changed lines. Optional for isolated UI, copy, or trivial fixes with tests.
- **Precision rule for reviewers:** at most ONE finding per root defect. If your findings
  exceed ~1.2× the actual defect count, rewrite the review before delivering. Recall
  without precision is noise the leader has to clean up.
- **Blind when judging quality:** when agents evaluate each other's work, anonymize the
  candidates and drop self-scores. Models grade their own output generously.
- **Objective beats jury:** anything executable (tests, harnesses, builds) outranks
  subjective scoring. Run the code; argue only about what can't run.

## Ideas mode

```
node squad.mjs ideas "question" [--only codex,grok] [--files a.js,b.js]
```

Same question to all agents in parallel; collect divergent answers; synthesize yourself.
Preserve divergence — the value is in the different angles, not consensus.
`--files` injects file content into the prompt of agents that can't read the repo; `-` = stdin.

## Review mode (parallel code review of a real diff)

```
node squad.mjs review [ref] --goal "what the change should do" \
  [--verify "npm test;;npm run build"] [--author claude] [--allow-truncate]
```

Closes the loop **code → test → have the squad check the result**. Rules that make it
an audit instead of an opinion:

- **`--goal` is required.** Reviewers check the diff did what was asked — and report
  scope creep / unaccomplished intent in a dedicated *Out of scope* section.
- **`--verify` runs deterministic commands first** and injects exit codes + tails into
  the reviewers' context. Failed verification forces a CHANGE verdict.
- **The author never reviews itself** — exclude it with `--author <agent>`.
- New untracked files are included in working-tree reviews; oversized diffs abort with a
  per-file map instead of silently truncating (a cut mid-file hides the regression).
- Fixed format per reviewer: Verdict (APPROVE|CHANGE) · Findings
  (`[bug|risk|style] (confidence) file:snippet`) · Out of scope · What I'd do differently.
- **Findings are input, not authority**: verify every claim against the code before
  acting on it. Reviewers hallucinate line numbers too.

## Adapting to your agents

Any CLI with a **headless mode** (prompt in, text out, non-interactive) fits. The
extension point is the `AGENTS` table at the top of `squad.mjs`: each entry is a small
adapter that receives the prompt as a FILE path (never interpolated into the shell) and
writes stdout/stderr to files. Add your agent there — local models (Ollama), other
vendor CLIs, or an HTTP wrapper script all work the same way. Prompts-as-files is the
contract: it avoids quoting bugs, argv limits, and injection.

If an agent cannot read your repo (sandboxed, remote, or unstable file access), treat it
as a **context-injected critic**: pass the evidence in the prompt (`--files`), never ask
it to explore. A wrong-but-confident exploration is worse than a scoped answer.

## Non-negotiables

- The leader reviews and integrates everything. Nothing merges without review + clean build.
- One unit = one owner. Nobody touches another unit's files.
- `--worktree` for real simultaneous coding. Without it, only parallelize tasks that touch
  provably distinct files.
- Subordinate agents never commit — the leader commits after review, so authorship and
  accountability stay auditable.
