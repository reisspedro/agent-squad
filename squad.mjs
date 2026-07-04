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
//   node squad.mjs ideas "your question"  [--only codex,grok] [--files a.js,b.js]
//   node squad.mjs code  tasks.json       [--worktree] [--dry-run]
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
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = process.cwd();
const GROK_EXE = process.env.GROK_EXE || join(homedir(), '.grok', 'bin', 'grok.exe');

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

// Grok as a CRITIC with pre-injected context — NOT a repo reader. Its agent build tends to
// blow up on read_file with long prompts (tool_output_error). Fix: self-contained prompt via
// --prompt-file + tools trimmed to the minimum (--no-memory/--no-plan/--no-subagents/
// --max-turns 1) + one degraded retry. Do NOT use --disallowed-tools read_file: it breaks the
// agent (search_replace requires a Read tool). File context, when needed, is injected by the
// squad — Grok doesn't read.
const GROK_NOISE = (l) => !l.includes('MCP server') && !l.toLowerCase().includes('discord') && !l.includes('program not found');
function runGrokDirect(pFile, oFile, eFile, { cwd, code }, attempt = 0) {
  return new Promise((resolve) => {
    const args = ['--disable-web-search', '--no-memory', '--no-plan', '--no-subagents', '--max-turns', '1',
      ...(code ? ['--always-approve'] : []), '--prompt-file', pFile];
    const child = spawn(GROK_EXE, args, { cwd: cwd || ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', async (codeNum) => {
      const clean = out.split('\n').filter(GROK_NOISE).join('\n').trim();
      const toolErr = /tool_error|tool_output_error|read_file|Agent building failed/.test(err);
      if ((!clean || toolErr) && attempt === 0) {
        // degraded (not blind) retry: shorter, self-contained prompt, once.
        const base = readFileSync(pFile, 'utf8').slice(0, 6000);
        const rFile = pFile.replace(/\.txt$/, '.retry.txt');
        writeFileSync(rFile, `${base}\n\n[RETRY] Answer ONLY from the context above. Do NOT read files, do NOT use tools.`, 'utf8');
        return resolve(await runGrokDirect(rFile, oFile, eFile, { cwd, code }, 1));
      }
      writeFileSync(oFile, clean, 'utf8');
      writeFileSync(eFile, err, 'utf8');
      resolve({ ok: codeNum === 0 && !!clean, code: codeNum, retried: attempt > 0 });
    });
    child.on('error', (e) => { writeFileSync(oFile, '', 'utf8'); writeFileSync(eFile, String(e), 'utf8'); resolve({ ok: false, err: String(e) }); });
  });
}

function runBash(cmd, cwd, timeoutMs = 600000) {
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
  const ctx = task.agent === 'grok' ? (task.grokCtx || '') : '';
  writeFileSync(pFile, `${head}${grokNote}\n\nTASK: ${task.prompt}${ctx}`, 'utf8');

  const t0 = Date.now();
  process.stdout.write(`  ⏳ ${a.label} — ${task.title || task.prompt.slice(0, 40)}…\n`);
  let res;
  if (a.direct) {
    // Grok: pass the prompt FILE (--prompt-file preserves structure, avoids quoting/argv limits).
    res = await runGrokDirect(pFile, oFile, eFile, { cwd, code });
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
  const stray = task.files ? touched.filter((f) => !task.files.includes(f)) : [];

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
  return { flags, only, files };
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

// Pre-flight validation: valid agents + file overlap between tasks.
function validateTasks(tasks) {
  const errors = [];
  tasks.forEach((t, i) => { if (!AGENTS[t.agent]) errors.push(`task #${i + 1}: unknown agent "${t.agent}" (use claude|codex|grok)`); });
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i].files || [], b = tasks[j].files || [];
      const overlap = a.filter((f) => b.includes(f));
      if (overlap.length) errors.push(`tasks #${i + 1} and #${j + 1} both claim: ${overlap.join(', ')} — not independent`);
    }
  }
  return errors;
}

(async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const { flags, only, files } = parseFlags(rest);
  const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = join(ROOT, '.squad', id);

  if (mode === 'ideas') {
    // Excludes flags AND their values from the question.
    const flagValueIdx = new Set();
    rest.forEach((a, i) => { if (a === '--only' || a === '--files') flagValueIdx.add(i + 1); });
    const question = rest.filter((a, i) => !a.startsWith('--') && !flagValueIdx.has(i)).join(' ').trim();
    if (!question) { console.error('usage: node squad.mjs ideas "question" [--only codex,grok] [--files a.js,b.js]'); process.exit(1); }
    const agents = (only || Object.keys(AGENTS)).filter((n) => AGENTS[n]);
    if (!agents.length) { console.error('usage: no valid agent in --only'); process.exit(1); }

    // Injected context for Grok: --files and/or stdin (`-` in the list).
    let stdinText = '';
    if (files?.includes('-')) {
      try { stdinText = readFileSync(0, 'utf8'); } catch { stdinText = ''; }
    }
    const grokCtx = buildInjectedContext(files, stdinText);

    mkdirSync(dir, { recursive: true });
    console.log(`\n💡 Squad IDEAS ${id} — ${agents.join(', ')}${grokCtx ? `  (ctx injected into Grok: ${grokCtx.length} chars)` : ''}\n❓ ${question}\n`);
    const results = await Promise.all(agents.map((agent, i) => runOne({ agent, title: 'idea', prompt: question, grokCtx }, i, dir, { code: false })));
    const md = `# 💡 Squad ideas ${id}\n\n**Question:** ${question}\n\n` + results.map((r) => `## ${r.label}\n\n${r.text}\n`).join('\n');
    writeFileSync(join(dir, 'summary.md'), md, 'utf8');
    console.log(`\n${results.map((r) => `\x1b[1m${r.label}\x1b[0m\n${r.text}\n`).join('\n')}`);
    console.log(`✅ .squad/${id}/summary.md`);
    if (results.some((r) => !r.ok)) process.exit(1);
    return;
  }

  if (mode === 'code') {
    const specPath = rest.find((a) => !a.startsWith('--'));
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

    const verrs = validateTasks(tasks);
    console.log(`\n🛠️  Squad CODE ${id} — ${tasks.length} tasks\n`);
    tasks.forEach((t) => console.log(`  • [${t.agent}] ${t.title || t.prompt.slice(0, 50)}${t.worktree ? '  (worktree)' : ''}${t.files ? '  files: ' + t.files.join(',') : ''}`));
    if (verrs.length) { console.error(`\n❌ Validation failed:\n  - ${verrs.join('\n  - ')}`); process.exit(1); }
    if (flags.has('--dry-run')) { console.log('\n(dry-run: nothing executed)'); return; }

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

  console.error('usage: node squad.mjs <ideas|code> ...');
  process.exit(1);
})();
