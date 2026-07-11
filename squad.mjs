#!/usr/bin/env node
// squad.mjs — PARALLEL execution of multiple coding-agent CLIs (Claude Code, Codex, Grok).
// "Each of you should use whatever gift you have received to serve others." — 1 Peter 4:10
//
// Not a chat. A fan-out: every agent gets the task at the same time, works independently,
// and you review/integrate at the end.
//   ideas: divergent parallel brainstorming (read-only)
//   code:  simultaneous coding; with --worktree each coder gets an isolated git worktree (zero conflicts)
//
// Usage:
//   node squad.mjs ideas  "your question"  [--only codex,grok] [--files a.js,b.js]
//   node squad.mjs code   tasks.json       [--worktree] [--dry-run]
//   node squad.mjs review [ref] --goal "what the change should do"
//                         [--verify "cmd1;;cmd2"] [--author claude] [--allow-truncate]
//
// review: parallel CODE REVIEW of a real diff — closes the loop "code → test → have the
//   squad check the result". No ref = uncommitted changes (git diff HEAD, NEW untracked
//   files included); plain ref = that commit's diff (ref^!); ranges (a..b) work.
//   --goal is REQUIRED: without declared intent, review degenerates into style opinions —
//   the point is checking the diff did WHAT WAS ASKED. --verify runs deterministic
//   commands (build/tests) BEFORE the reviewers and injects exit codes + output tails.
//   Oversized diffs ABORT with a per-file map (silent truncation hides regressions)
//   unless --allow-truncate. --author excludes the agent that wrote the code (an author
//   should not review itself). Each reviewer returns a fixed format: verdict
//   (APPROVE|CHANGE) + findings [bug|risk|style] with confidence + out-of-scope section.
//
// --files (ideas mode): files whose CONTENT is injected into the GROK prompt (Grok's CLI
//   breaks on read_file with long prompts, so the squad reads for it). Claude and Codex
//   explore the repo themselves. Use `-` in the list to inject stdin (e.g. piped metrics).
//
// tasks.json: { "tasks": [ { "agent":"codex", "title":"...", "prompt":"...", "worktree":true,
//                            "files":["src/x.js"] }, ... ] }
//   files (optional): files the task MAY touch. Used to detect overlap between tasks and to
//                     flag out-of-scope edits (worktree mode).
//
// Each task is an INDEPENDENT, fresh call (no shared session) — parallel tasks must not
// inherit context from each other.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = process.cwd();
const GROK_EXE = process.env.GROK_EXE ||
  (process.platform === 'win32' ? join(homedir(), '.grok', 'bin', 'grok.exe') : 'grok');

function findBash() {
  const cands = [
    process.env.SQUAD_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    '/bin/bash',
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  return 'bash';
}
const BASH = findBash();

// Adapters. Each one receives argv directly (no shell string → no injection/fragile quoting).
// The prompt always goes through a FILE (pFile) that the agent reads — never interpolated.
const AGENTS = {
  claude: {
    label: 'Claude Code',
    // claude -p reads the prompt from stdin (piped from file). No $(...), no fragile quotes.
    spawn: ({ pFile, oFile, eFile, code, cwd }) => ({
      cmd: `claude -p ${code ? '--dangerously-skip-permissions ' : ''}< ${sh(pFile)} > ${sh(oFile)} 2> ${sh(eFile)}`,
      bash: true, cwd,
    }),
  },
  codex: {
    label: 'Codex',
    // codex reads the prompt FILE (avoids $(cat) breaking on backticks/quotes); -o captures
    // the LAST agent message only — so the instruction demands the full answer inline.
    spawn: ({ pFile, oFile, eFile, code, cwd }) => ({
      cmd: `codex exec ${code ? '--dangerously-bypass-approvals-and-sandbox ' : ''}-o ${sh(oFile)} ` +
        `"Read the file ${pFile} and execute the task. ${code ? 'Do the work and say what you touched at the end.' : 'Answer the COMPLETE analysis directly in your FINAL MESSAGE — do not write it to a separate file, do not end with just a meta-summary. The last message must contain the entire answer.'}" ` +
        `< /dev/null > /dev/null 2> ${sh(eFile)}`,
      bash: true, cwd,
    }),
  },
  grok: { label: 'Grok', direct: true },
};

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Availability checks — fail early and readable instead of a confusing shell error later.
function cmdPath(bin) {
  const r = spawnSync(BASH, ['-c', `command -v ${sh(bin)}`], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}
function agentPath(name) {
  if (name === 'grok') {
    if (/[\\/]/.test(GROK_EXE)) return existsSync(GROK_EXE) ? GROK_EXE : null;
    return cmdPath(GROK_EXE);
  }
  return cmdPath(name);
}

// Grok as a CRITIC with pre-injected context — NOT a repo reader. Its agent build tends to
// blow up on read_file with long prompts (tool_output_error). Fix: self-contained prompt via
// --prompt-file + tools trimmed to the minimum (--no-memory/--no-plan/--no-subagents/
// --max-turns 1) + one degraded retry. Do NOT use --disallowed-tools read_file: it breaks the
// agent (search_replace requires a Read tool). File context, when needed, is injected by the
// squad — Grok doesn't read.
const GROK_NOISE = (l) => !l.includes('MCP server') && !l.toLowerCase().includes('discord') && !l.includes('program not found');
function runGrokDirect(pFile, oFile, eFile, { cwd, code, noDegradedRetry }, attempt = 0) {
  return new Promise((resolve) => {
    const args = ['--disable-web-search', '--no-memory', '--no-plan', '--no-subagents', '--max-turns', '1',
      ...(code ? ['--always-approve'] : []), '--prompt-file', pFile];
    const child = spawn(GROK_EXE, args, { cwd: cwd || ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const killer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', async (codeNum) => {
      clearTimeout(killer);
      const clean = out.split('\n').filter(GROK_NOISE).join('\n').trim();
      const toolErr = /tool_error|tool_output_error|read_file|Agent building failed/.test(err);
      if ((!clean || toolErr) && attempt === 0 && !noDegradedRetry) {
        // degraded (not blind) retry: shorter, self-contained prompt, once.
        // Review mode NEVER takes this path (noDegradedRetry): approving after reading
        // 6k of a 60k diff would be a lie — failing visibly is safer.
        const base = readFileSync(pFile, 'utf8').slice(0, 6000);
        const rFile = pFile.replace(/\.txt$/, '.retry.txt');
        writeFileSync(rFile, `${base}\n\n[RETRY] Answer ONLY from the context above. Do NOT read files, do NOT use tools.`, 'utf8');
        return resolve(await runGrokDirect(rFile, oFile, eFile, { cwd, code }, 1));
      }
      writeFileSync(oFile, clean, 'utf8');
      writeFileSync(eFile, err, 'utf8');
      resolve({ ok: codeNum === 0 && !!clean, code: codeNum, retried: attempt > 0 });
    });
    child.on('error', (e) => { clearTimeout(killer); writeFileSync(oFile, '', 'utf8'); writeFileSync(eFile, String(e), 'utf8'); resolve({ ok: false, err: String(e) }); });
  });
}

let TIMEOUT_MS = Number(process.env.SQUAD_TIMEOUT_MS) || 600000;

function runBash(cmd, cwd, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(BASH, ['-c', cmd], { cwd: cwd || ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, err: 'timeout' }); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, err: String(e) }); });
  });
}

// Creates an isolated worktree. CHECKS the git result — on failure returns {error}
// (never silently runs in the wrong directory).
function addWorktree(dir, id, agent, i) {
  const path = join(dir, `wt-${agent}-${i}`);
  const branch = `squad/${id.slice(-6)}-${agent}-${i}`;
  const r = spawnSync(BASH, ['-c', `git worktree add -B ${sh(branch)} ${sh(path)} HEAD`], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return { error: (r.stderr || r.stdout || `git worktree add failed (status ${r.status})`).trim() };
  return { path, branch };
}

async function runOne(task, i, dir, { code }) {
  const a = AGENTS[task.agent];
  const tag = `${task.agent}-${i}`;
  const pFile = join(dir, `${tag}.in.txt`);
  const oFile = join(dir, `${tag}.out.md`);
  const eFile = join(dir, `${tag}.err.log`);

  let cwd = ROOT, wt = null;
  if (code && task.worktree) {
    wt = addWorktree(dir, dir.split(/[\\/]/).pop(), task.agent, i);
    if (wt.error) {
      console.log(`  ✗ ${a.label} — worktree failed: ${wt.error}`);
      return { ...task, i, label: a.label, text: `*(worktree failed: ${wt.error})*`, ok: false, secs: 0 };
    }
    cwd = wt.path;
  }

  const head = code
    ? `You are ${a.label}, a coding agent in a parallel squad. Surgical work, only the files of your task` +
      (task.files ? ` (allowed: ${task.files.join(', ')})` : '') + `. ` +
      (wt ? `You are in an isolated worktree (${cwd}); edit here. ` : '') + `Say what you touched at the end.`
    : `You are ${a.label}. Answer objectively and honestly, with real tradeoffs. No fluff.`;
  // Grok is a critic with pre-injected context — it must not try to read files.
  const grokNote = task.agent === 'grok'
    ? `\n\nIMPORTANT (Grok): do NOT read files or use tools — answer only from the context in this prompt. If code context is missing, say what is missing instead of trying to read.`
    : '';
  const ctx = task.agent === 'grok' ? (task.grokCtx || task.ctx || '') : (task.ctx || '');
  writeFileSync(pFile, `${head}${grokNote}\n\nTASK: ${task.prompt}${ctx}`, 'utf8');

  const t0 = Date.now();
  process.stdout.write(`  ⏳ ${a.label} — ${task.title || task.prompt.slice(0, 40)}…\n`);
  let res;
  if (a.direct) {
    // Grok: pass the prompt FILE (--prompt-file preserves structure, avoids quoting/argv limits).
    res = await runGrokDirect(pFile, oFile, eFile, { cwd, code, noDegradedRetry: task.noDegradedRetry });
  } else {
    const s = a.spawn({ pFile, oFile, eFile, code, cwd });
    res = await runBash(s.cmd, s.cwd);
  }

  const out = existsSync(oFile) ? readFileSync(oFile, 'utf8').trim() : '';
  const errSnippet = existsSync(eFile) ? readFileSync(eFile, 'utf8').trim().split('\n').slice(-3).join(' ').slice(0, 200) : '';
  const ok = res.ok && !!out;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  // Worktree mode: which files did the agent actually touch? Flags out-of-scope edits.
  let touched = [];
  if (wt && !wt.error) {
    const d = spawnSync(BASH, ['-c', `git -C ${sh(cwd)} status --porcelain`], { cwd: ROOT, encoding: 'utf8' });
    touched = (d.stdout || '').split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
  }
  const normRel = (f) => {
    let p = f.replace(/\\/g, '/').replace(/^\.\//, '');
    if (process.platform === 'win32' || process.platform === 'darwin') p = p.toLowerCase();
    return p;
  };
  const allowed = (task.files || []).map(normRel);
  const stray = task.files ? touched.filter((f) => !allowed.includes(normRel(f))) : [];

  console.log(`  ${ok ? '✓' : '✗'} ${a.label} (${secs}s${wt ? ', wt-' + task.agent + '-' + i : ''})` +
    (ok ? '' : ` — ${res.err || res.code || 'empty output'}${errSnippet ? ' | ' + errSnippet : ''}`) +
    (stray.length ? `  ⚠️ outside allowlist: ${stray.join(', ')}` : ''));

  return { ...task, i, label: a.label, text: out || `*(no answer: ${res.err || res.code}; stderr: ${errSnippet})*`,
    ok, secs, worktreePath: wt?.path, branch: wt?.branch, touched, stray };
}

function parseFlags(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const only = flags.has('--only') ? argv[argv.indexOf('--only') + 1]?.split(',').map((s) => s.trim()) : null;
  const files = flags.has('--files') ? argv[argv.indexOf('--files') + 1]?.split(',').map((s) => s.trim()) : null;
  let timeout = null;
  if (flags.has('--timeout')) {
    timeout = Number(argv[argv.indexOf('--timeout') + 1]);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      console.error('usage: --timeout expects a positive number of seconds');
      process.exit(1);
    }
  }
  return { flags, only, files, timeout };
}

// Builds the injected context block for Grok (which cannot read the repo).
// Per-file cap + total cap: giant prompts were the original cause of tool_output_error,
// so it degrades with a warning instead of blowing up. `-` injects stdin.
const GROK_CTX_FILE_CAP = 24000;
const GROK_CTX_TOTAL_CAP = 90000;
function buildInjectedContext(files, stdinText) {
  if (!files?.length && !stdinText) return '';
  const parts = [];
  let total = 0;
  if (stdinText) {
    const t = stdinText.slice(0, GROK_CTX_FILE_CAP);
    parts.push(`### stdin (piped data)\n\`\`\`\n${t}\n\`\`\`${stdinText.length > t.length ? '\n*(truncated)*' : ''}`);
    total += t.length;
  }
  for (const f of files ?? []) {
    if (f === '-') continue;
    if (!existsSync(f)) { parts.push(`### ${f}\n*(file not found — mention it in your answer if it matters)*`); continue; }
    let body = readFileSync(f, 'utf8');
    let note = '';
    if (body.length > GROK_CTX_FILE_CAP) { body = body.slice(0, GROK_CTX_FILE_CAP); note = '\n*(truncated at per-file cap)*'; }
    if (total + body.length > GROK_CTX_TOTAL_CAP) {
      parts.push(`### ${f}\n*(omitted — total context cap reached; mention it if it matters)*`);
      continue;
    }
    total += body.length;
    parts.push(`### ${f}\n\`\`\`\n${body}\n\`\`\`${note}`);
  }
  return `\n\n## CODE/DATA CONTEXT (injected by the squad — this is the REAL state of the repo)\n\n${parts.join('\n\n')}`;
}

// Normalizes a path claim so `src/a.js`, `./src/a.js` and `src\a.js` compare equal
// (case-insensitive on Windows/macOS, where the filesystem usually is too).
function normClaim(f) {
  let p = resolve(ROOT, f).replace(/\\/g, '/');
  if (process.platform === 'win32' || process.platform === 'darwin') p = p.toLowerCase();
  return p;
}

// Pre-flight validation: valid agents + file overlap between tasks.
function validateTasks(tasks) {
  const errors = [];
  tasks.forEach((t, i) => { if (!AGENTS[t.agent]) errors.push(`task #${i + 1}: unknown agent "${t.agent}" (use claude|codex|grok)`); });
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i].files || [], b = tasks[j].files || [];
      const bNorm = b.map(normClaim);
      const overlap = a.filter((f) => bNorm.includes(normClaim(f)));
      if (overlap.length) errors.push(`tasks #${i + 1} and #${j + 1} both claim: ${overlap.join(', ')} — not independent`);
    }
  }
  return errors;
}

(async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const { flags, only, files, timeout } = parseFlags(rest);
  if (timeout) TIMEOUT_MS = timeout * 1000;
  const id = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
  const dir = join(ROOT, '.squad', id);

  if (mode === 'doctor') {
    console.log(`\n🩺 agent-squad doctor\n`);
    console.log(`  Node: ${process.version}`);
    const bashProbe = spawnSync(BASH, ['-c', 'echo ok'], { encoding: 'utf8' });
    console.log(`  Bash: ${bashProbe.stdout?.trim() === 'ok' ? BASH
      : existsSync(BASH) ? `${BASH} found but NOT RUNNABLE — check permissions/antivirus`
        : 'NOT FOUND — install Git Bash (Windows) or bash'}`);
    const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
    console.log(`  Git: ${git.status === 0 ? git.stdout.trim() + ' (worktrees ok)' : 'NOT FOUND — required for code mode'}`);
    const runnable = [];
    for (const name of Object.keys(AGENTS)) {
      const p = agentPath(name);
      if (p) runnable.push(name);
      console.log(`  ${AGENTS[name].label} (${name}): ${p ? `found ${p}` : 'not found'}`);
    }
    console.log(`\n  Runnable agents: ${runnable.join(', ') || 'none — install at least one CLI'}\n`);
    return;
  }

  if (mode === 'ideas') {
    // Excludes flags AND their values from the question.
    const flagValueIdx = new Set();
    rest.forEach((a, i) => { if (a === '--only' || a === '--files' || a === '--timeout') flagValueIdx.add(i + 1); });
    const question = rest.filter((a, i) => !a.startsWith('--') && !flagValueIdx.has(i)).join(' ').trim();
    if (!question) { console.error('usage: node squad.mjs ideas "question" [--only codex,grok] [--files a.js,b.js] [--timeout secs]'); process.exit(1); }

    let agents;
    if (only) {
      agents = only.filter((n) => AGENTS[n]);
      if (!agents.length) { console.error('usage: no valid agent in --only'); process.exit(1); }
      const missing = agents.filter((n) => !agentPath(n));
      if (missing.length) { console.error(`❌ agent CLI not found: ${missing.join(', ')} — run \`node squad.mjs doctor\``); process.exit(1); }
    } else {
      agents = Object.keys(AGENTS).filter((n) => agentPath(n));
      if (!agents.length) { console.error('❌ no agent CLIs found on this machine — run `node squad.mjs doctor`'); process.exit(1); }
    }

    // Injected context (--files and/or stdin via `-`) goes to ALL agents in ideas mode.
    let stdinText = '';
    if (files?.includes('-')) {
      try { stdinText = readFileSync(0, 'utf8'); } catch { stdinText = ''; }
    }
    const ctx = buildInjectedContext(files, stdinText);

    mkdirSync(dir, { recursive: true });
    console.log(`\n💡 Squad IDEAS ${id} — ${agents.join(', ')}${ctx ? `  (ctx injected: ${ctx.length} chars)` : ''}\n❓ ${question}\n`);
    const results = await Promise.all(agents.map((agent, i) => runOne({ agent, title: 'idea', prompt: question, ctx }, i, dir, { code: false })));
    const md = `# 💡 Squad ideas ${id}\n\n**Question:** ${question}\n\n` + results.map((r) => `## ${r.label}\n\n${r.text}\n`).join('\n');
    writeFileSync(join(dir, 'summary.md'), md, 'utf8');
    console.log(`\n${results.map((r) => `\x1b[1m${r.label}\x1b[0m\n${r.text}\n`).join('\n')}`);
    console.log(`✅ .squad/${id}/summary.md`);
    if (results.some((r) => !r.ok)) process.exit(1);
    return;
  }

  if (mode === 'code') {
    const codeFlagValueIdx = new Set();
    rest.forEach((a, i) => { if (a === '--timeout') codeFlagValueIdx.add(i + 1); });
    const specPath = rest.find((a, i) => !a.startsWith('--') && !codeFlagValueIdx.has(i));
    if (!specPath || !existsSync(specPath)) { console.error('usage: node squad.mjs code tasks.json [--worktree] [--dry-run]'); process.exit(1); }
    let spec;
    try { spec = JSON.parse(readFileSync(specPath, 'utf8')); }
    catch (e) { console.error(`usage: invalid tasks.json (${e.message})`); process.exit(1); }
    const tasks = (spec.tasks || []).map((t) => ({
      ...t,
      worktree: t.worktree ?? flags.has('--worktree'),
      // Grok doesn't read the repo in code mode either — task files are injected into its prompt.
      grokCtx: t.agent === 'grok' && t.files?.length ? buildInjectedContext(t.files, '') : '',
    }));
    if (!tasks.length) { console.error('usage: spec has no tasks.'); process.exit(1); }

    const missing = [...new Set(tasks.map((t) => t.agent))].filter((n) => AGENTS[n] && !agentPath(n));
    if (missing.length && !flags.has('--dry-run')) {
      console.error(`❌ agent CLI not found: ${missing.join(', ')} — run \`node squad.mjs doctor\``);
      process.exit(1);
    }

    const verrs = validateTasks(tasks);
    console.log(`\n🛠️  Squad CODE ${id} — ${tasks.length} tasks\n`);
    tasks.forEach((t) => console.log(`  • [${t.agent}] ${t.title || t.prompt.slice(0, 50)}${t.worktree ? '  (worktree)' : ''}${t.files ? '  files: ' + t.files.join(',') : ''}`));
    if (verrs.length) { console.error(`\n❌ Validation failed:\n  - ${verrs.join('\n  - ')}`); process.exit(1); }
    if (flags.has('--dry-run')) { console.log('\n(dry-run: nothing executed)'); return; }

    if (tasks.some((t) => t.worktree)) {
      const dirty = spawnSync(BASH, ['-c', 'git status --porcelain'], { cwd: ROOT, encoding: 'utf8' });
      if ((dirty.stdout || '').trim()) {
        console.log('  ⚠️  Working tree has uncommitted changes — worktrees branch from HEAD and will NOT see them.');
      }
    }

    mkdirSync(dir, { recursive: true });
    const results = await Promise.all(tasks.map((t, i) => runOne(t, i, dir, { code: true })));
    const statusTable = results.map((r) => `| ${r.label} | ${r.title || ''} | ${r.ok ? '✓' : '✗'} | ${r.secs}s | ${r.branch || '—'} |`).join('\n');
    const md = `# 🛠️ Squad code ${id}\n\n| Agent | Task | OK | Time | Branch |\n|---|---|---|---|---|\n${statusTable}\n\n` +
      results.map((r) => `## ${r.label} — ${r.title || ''}\n${r.branch ? `worktree: \`${r.worktreePath}\` (branch \`${r.branch}\`)\n` : ''}` +
        `${r.stray?.length ? `⚠️ touched outside allowlist: ${r.stray.join(', ')}\n` : ''}\n${r.text}\n`).join('\n') +
      `\n---\n## Review checklist\n` +
      results.filter((r) => r.worktreePath).map((r) => `- [ ] \`git -C ${r.worktreePath} diff\` → review → integrate → \`git worktree remove ${r.worktreePath}\``).join('\n');
    writeFileSync(join(dir, 'summary.md'), md, 'utf8');
    const okN = results.filter((r) => r.ok).length;
    console.log(`\n${okN === results.length ? '✅' : '⚠️'} ${okN}/${results.length} ok. Summary + checklist: .squad/${id}/summary.md`);
    if (results.some((r) => r.worktreePath)) console.log('   ⚠️  Review each worktree before integrating. Worktrees were NOT removed.');
    if (okN !== results.length) process.exit(1);
    return;
  }

  if (mode === 'review') {
    // Build the diff under review. No ref = uncommitted changes; plain ref = that commit.
    // Index-based scan: a flag value equal to the ref (e.g. --goal HEAD HEAD) must not
    // swallow the ref.
    const flagValueIdx = new Set();
    rest.forEach((a, i) => {
      if (a === '--only' || a === '--files' || a === '--goal' || a === '--verify' || a === '--author' || a === '--timeout') flagValueIdx.add(i + 1);
    });
    const ref = rest.find((a, i) => !a.startsWith('--') && !flagValueIdx.has(i));
    const diffCmd = !ref ? 'git diff HEAD' : ref.includes('..') ? `git diff ${sh(ref)}` : `git diff ${sh(ref + '^!')}`;
    const d = spawnSync(BASH, ['-c', diffCmd], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (d.status !== 0) { console.error(`usage: git diff failed — ${(d.stderr || '').trim()}`); process.exit(1); }
    let diff = (d.stdout || '').trim();

    // Intent is REQUIRED: without it, review degenerates into style opinions. The point
    // is checking the diff did what was asked — and nothing beyond it.
    const goal = flags.has('--goal') ? rest[rest.indexOf('--goal') + 1] : null;
    if (!goal) {
      console.error('usage: --goal "what the change should do" is required — without intent, review is style opinion.');
      process.exit(1);
    }

    // NEW (untracked) files are part of the change too — git diff HEAD does not see them
    // and the regression may live exactly in the new file. Working-tree mode only
    // (a commit already carries its new files in the diff). Dotfolders are tooling/session
    // artifacts, not code under review.
    let untrackedBlock = '';
    if (!ref) {
      const u = spawnSync(BASH, ['-c', 'git ls-files --others --exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
      const newFiles = (u.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
        .filter((f) => /\.(m?js|jsx|ts|tsx|css|json|md|sql|ps1|sh|html|py|go|rs|java|rb)$/i.test(f))
        .filter((f) => !f.split('/').some((seg) => seg.startsWith('.')));
      const UNTRACKED_FILE_CAP = 10000;
      const parts = [];
      for (const f of newFiles) {
        try {
          let body = readFileSync(join(ROOT, f), 'utf8');
          if (body.length > UNTRACKED_FILE_CAP) body = body.slice(0, UNTRACKED_FILE_CAP) + '\n… (truncated — large new file; ask for the rest if it matters)';
          parts.push(`### NEW FILE (untracked): ${f}\n\`\`\`\n${body}\n\`\`\``);
        } catch { /* binary/unreadable: skip */ }
      }
      if (parts.length) untrackedBlock = `\n\n## NEW FILES (untracked — also part of this change)\n\n${parts.join('\n\n')}`;
    }
    if (!diff && !untrackedBlock) { console.error(`usage: empty diff (${!ref ? 'nothing uncommitted' : ref}) — nothing to review.`); process.exit(1); }

    // Never truncate silently — cutting mid-file hides exactly the regression. Oversized
    // diffs abort with the per-file map unless --allow-truncate is explicit.
    const DIFF_CAP = 60000;
    let truncated = false;
    if (diff.length + untrackedBlock.length > DIFF_CAP) {
      if (!flags.has('--allow-truncate')) {
        const stat = spawnSync(BASH, ['-c', `${diffCmd} --stat`], { cwd: ROOT, encoding: 'utf8' });
        console.error(`usage: diff too large (${diff.length + untrackedBlock.length} chars > cap ${DIFF_CAP}).`);
        console.error('Review in pieces (smaller commit/range) or pass --allow-truncate knowing the risk.\n');
        console.error((stat.stdout || '').trim().split('\n').slice(-25).join('\n'));
        process.exit(1);
      }
      truncated = true;
      diff = diff.slice(0, Math.max(0, DIFF_CAP - untrackedBlock.length));
    }

    // Deterministic verification BEFORE the reviewers (--verify "cmd1;;cmd2"): agents get
    // exit codes + output tails. Review becomes an audit, not an opinion.
    let verifyBlock = '';
    if (flags.has('--verify')) {
      const cmds = (rest[rest.indexOf('--verify') + 1] || '').split(';;').map((s) => s.trim()).filter(Boolean);
      if (!cmds.length) { console.error('usage: --verify "npm run build;;npm test" (commands separated by ;;)'); process.exit(1); }
      const lines = [];
      for (const cmd of cmds) {
        process.stdout.write(`  🧪 verify: ${cmd}\n`);
        const r = spawnSync(BASH, ['-c', cmd], { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
        const tail = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').slice(-8).join('\n');
        lines.push(`$ ${cmd}\nexit: ${r.status}\n${tail}`);
        console.log(`     → exit ${r.status}`);
      }
      verifyBlock = `\n\n## DETERMINISTIC VERIFICATION (run by the squad BEFORE this review)\n\`\`\`\n${lines.join('\n\n')}\n\`\`\``;
    }

    // Reviewers: all available agents minus the author (an author should not review
    // itself). --only overrides everything.
    const author = flags.has('--author') ? rest[rest.indexOf('--author') + 1] : null;
    let agents;
    if (only) {
      agents = only.filter((n) => AGENTS[n]);
    } else {
      agents = Object.keys(AGENTS).filter((n) => agentPath(n)).filter((n) => n !== author);
    }
    if (!agents.length) { console.error('usage: no reviewer available (check --only/--author or run `node squad.mjs doctor`)'); process.exit(1); }
    const missing = agents.filter((n) => !agentPath(n));
    if (missing.length) { console.error(`❌ agent CLI not found: ${missing.join(', ')} — run \`node squad.mjs doctor\``); process.exit(1); }

    const reviewPrompt =
      `You are doing CODE REVIEW of a real diff (you are NOT the author; be adversarial). ` +
      `Declared goal of the change (the diff MUST accomplish this and nothing beyond it): ${goal}\n\n` +
      `Answer in EXACTLY this format:\n` +
      `## Verdict\nAPPROVE or CHANGE — 1 sentence of justification. If the deterministic verification failed, the verdict is CHANGE.\n` +
      `## Findings\n- [bug|risk|style] (confidence high|medium|low) file:snippet — problem + concrete suggestion (1 bullet per finding; if none, write "none")\n` +
      `## Out of scope\nWhat the diff did BEYOND the declared goal (scope creep) or of the goal it did NOT accomplish — or "nothing".\n` +
      `## What I would do differently\nAt most 1 item, concrete (or "nothing").\n\n` +
      `Rules: hunt regressions, bugs and contract breaks — do not request refactors outside the diff's scope; ` +
      `respect the project's conventions; quote the diff snippet in every finding.` +
      (truncated ? `\n\nWARNING: diff truncated at ${DIFF_CAP} chars (--allow-truncate) — say in the verdict if this compromised the review.` : '');
    const diffBlock = `\n\n## THE DIFF (${diffCmd})\n\`\`\`diff\n${diff}\n\`\`\`${untrackedBlock}${verifyBlock}`;

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.diff'), diff + untrackedBlock, 'utf8');
    console.log(`\n🔍 Squad REVIEW ${id} — ${agents.join(', ')} — ${diffCmd}${truncated ? ' (truncated)' : ''}\n🎯 ${goal}\n`);
    const results = await Promise.all(agents.map((agent, i) => runOne({
      agent, title: 'review', prompt: reviewPrompt, ctx: diffBlock, noDegradedRetry: true,
    }, i, dir, { code: false })));

    // Verdict table at the top of the summary (light extraction: first line after "## Verdict").
    const verdictOf = (t) => {
      const m = /##\s*Verdict\s*\n+\s*([^\n]+)/i.exec(t || '');
      return m ? m[1].trim().slice(0, 120) : '(no verdict in format)';
    };
    const table = results.map((r) => `| ${r.label} | ${r.ok ? verdictOf(r.text) : '✗ failed'} |`).join('\n');
    const md = `# 🔍 Squad review ${id}\n\n**Diff:** \`${diffCmd}\`${truncated ? ' *(truncated)*' : ''}\n**Goal:** ${goal}\n\n` +
      `| Reviewer | Verdict |\n|---|---|\n${table}\n\n` +
      results.map((r) => `## ${r.label}\n\n${r.text}\n`).join('\n');
    writeFileSync(join(dir, 'summary.md'), md, 'utf8');
    console.log(`\n${results.map((r) => `\x1b[1m${r.label}\x1b[0m\n${r.text}\n`).join('\n')}`);
    console.log(`✅ .squad/${id}/summary.md`);
    if (results.some((r) => !r.ok)) process.exit(1);
    return;
  }

  console.error('usage: node squad.mjs <ideas|code|review|doctor> ...');
  console.error('  ideas "question" [--only claude,codex,grok] [--files a.js,b.js|-] [--timeout secs]');
  console.error('  code tasks.json [--worktree] [--dry-run] [--timeout secs]');
  console.error('  review [ref] --goal "intent" [--verify "cmd1;;cmd2"] [--author claude] [--allow-truncate]');
  console.error('  doctor    # check which agent CLIs are available');
  process.exit(1);
})();
