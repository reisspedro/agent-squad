# Benchmark your squad — assign roles by evidence

A protocol to measure the agents in your squad against each other and assign lanes
(leader / precision implementer / creative critic) based on results, not reputation.
Validated in production with a 3-agent squad (two full runs); takes ~30-60 min of
wall-clock time and a handful of agent calls.

## Design principles

1. **Objective beats jury.** Everything executable is graded by execution. Subjective
   work is graded by a blind jury with self-scores dropped.
2. **The organizer competes too — under the same rules.** The leader writes its answers
   *before* reading anyone else's, and locks them to disk.
3. **Fresh tasks every run.** Reused tasks measure memory, not ability.
4. **Small n is fine, humility is mandatory.** One task per category is a signal, not a
   verdict. Re-run when models change; expect rankings to move.

## The six categories

| # | Category | Task shape | Graded by |
|---|---|---|---|
| T1 | Code (algorithm) | Small pure function + 6+ tests in ONE runnable file | execution |
| T2 | Front-end | One self-contained component, a11y required, + rationale | blind jury |
| T3 | Back-end | Pure validation/planning function, all-violations semantics | execution |
| T4 | Creativity | Short creative artifact with hard constraints (banned clichés) | blind jury |
| T5 | Argumentation | Position + honest tradeoffs + concrete mitigation, word cap | blind jury |
| T6 | Review | Snippet with N planted bugs; list each with line + fix | answer key |

Write tasks that are **self-contained** (no repo access needed) so sandboxed agents
compete fairly. State explicitly that tests must be runnable (`node --test file.mjs`).

## Protocol, step by step

1. **Author the tasks** (the leader). For T6, plant the bugs deliberately and write the
   answer key BEFORE dispatching. Warn: *"precision counts as much as recall — do not
   invent bugs that don't exist."* (Models love padding their bug lists.)
2. **Dispatch to all other agents in parallel** (one `ideas`-style fan-out with the full
   task sheet).
3. **Leader answers while they work** — written and saved to disk before reading any
   other answer.
4. **Objective grading:** extract every agent's T1/T3 code and run their own tests. Then
   build an **adversarial cross-harness**: one behavioral test battery (spec-mandated
   behavior only — no unagreed conventions) run against all implementations. Edge cases
   to include: null/undefined inputs, values at boundaries, dirty types, fuzz the RNG
   contract. The harness is where "everyone passes their own tests" stops meaning much.
5. **T6 grading:** compare to the answer key. Score recall (found/planted) AND precision
   (findings per root defect — split-counting one defect into three findings costs points).
   If the leader authored the snippet, the leader is excluded from this category.
6. **Blind jury for T2/T4/T5:** bundle the three answers anonymized (A/B/C, shuffle the
   mapping between runs), send to every agent including a warning that one candidate may
   be their own. Each judge scores 0-10 + one-line justification. **Drop every judge's
   self-score.** The leader's scores are locked to disk before reading the other reviews.
7. **Aggregate:** average the surviving scores per category; average categories for the
   final ranking. Report ties honestly (a 0.07 gap is a technical win, not superiority).
8. **Consensus round:** show the aggregated table to all agents; ask for objections and
   for a concrete division-of-labor proposal. Adopt what converges.

## Traps we hit (so you don't)

- **Shell heredocs mangle escapes.** Our T6 snippet lost a `\\` in transit and gained an
  accidental extra bug — which two agents found and the author missed. Write task files
  with a proper file-write tool, not heredocs.
- **Self-tests all pass; the cross-harness discriminates.** In run 1 the organizer failed
  2/20 adversarial checks (null handling, RNG boundary) that both other agents passed.
  In run 2, everyone had learned — 23/23 triple tie. The benchmark itself raises the bar.
- **Jury noise is real.** The same creative answer got 9.8 from one judge and 8.0 from
  another. Never read a single subjective score as truth; average and note divergence.
- **Blind review punishes real context.** One answer cited a real prior decision and a
  judge marked it down as "invented evidence". Note these artifacts instead of "fixing"
  scores after the fact.
- **Models self-identify their own style.** Anonymization reduces but does not eliminate
  bias — dropping self-scores is the actual protection.

## Turning results into roles

- Wins on execution + precision review → **precision implementer** lane.
- Wins on jury categories (front/creative/argument) → **creative critic** lane.
- The leader lane is not won by benchmark: it goes to the agent with project memory and
  integration accountability. If the leader loses categories, that's information about
  *delegation*, not about leadership.
- Re-run on every model upgrade. In our runs, one CLI's model bump moved its front-end
  score from 7.25 to 9.0 — lanes drawn from stale benchmarks are just vibes with extra
  steps.
