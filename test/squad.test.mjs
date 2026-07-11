import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

const root = process.cwd();
const tmpDirs = [];

function runSquad(args) {
  return spawnSync('node', ['squad.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function makeTasksFile(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'squad-test-'));
  tmpDirs.push(dir);
  const file = join(dir, 'tasks.json');
  writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  return file;
}

afterEach(() => {
  while (tmpDirs.length) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

test('usage without arguments exits 1 and lists subcommands', () => {
  const result = runSquad([]);
  const text = output(result);

  assert.equal(result.status, 1);
  assert.match(text, /ideas/i);
  assert.match(text, /code/i);
  assert.match(text, /review/i);
  assert.match(text, /doctor/i);
});

test('review without --goal exits 1 and explains why intent is required', () => {
  const result = runSquad(['review']);
  const text = output(result);

  assert.equal(result.status, 1);
  assert.match(text, /--goal/);
  assert.match(text, /intent/i);
});

test('review with --goal but a clean tree exits 1 with empty-diff message', () => {
  // Fresh throwaway git repo: never dispatches real agents, regardless of the state of
  // the checkout running the tests.
  const dir = mkdtempSync(join(tmpdir(), 'squad-review-'));
  tmpDirs.push(dir);
  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);

  const result = spawnSync('node', [join(root, 'squad.mjs'), 'review', '--goal', 'test intent'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const text = output(result);

  assert.equal(result.status, 1);
  assert.match(text, /empty diff|nothing to review/i);
});

test('doctor exits 0 and reports agent availability', () => {
  const result = runSquad(['doctor']);
  const text = output(result);

  assert.equal(result.status, 0);
  assert.match(text, /^.*claude.*(?:found|not found).*$/im);
  assert.match(text, /^.*codex.*(?:found|not found).*$/im);
  assert.match(text, /^.*grok.*(?:found|not found).*$/im);
});

test('code dry-run prints the task title without executing agents', () => {
  const specPath = makeTasksFile({
    tasks: [
      { agent: 'codex', title: 't', prompt: 'p', files: ['README.md'] },
    ],
  });

  const result = runSquad(['code', specPath, '--dry-run']);
  const text = output(result);

  assert.equal(result.status, 0);
  assert.match(text, /t/);
  assert.match(text, /\(dry-run/i);
});

test('unknown task agent fails with valid agents in the error', () => {
  const specPath = makeTasksFile({
    tasks: [
      { agent: 'gpt', title: 't', prompt: 'p', files: ['README.md'] },
    ],
  });

  const result = runSquad(['code', specPath, '--dry-run']);
  const text = output(result);

  assert.equal(result.status, 1);
  assert.match(text, /valid agents|claude\|codex\|grok|claude.*codex.*grok/i);
});

test('overlap validation normalizes task file paths before comparing', () => {
  const specPath = makeTasksFile({
    tasks: [
      { agent: 'codex', title: 'a', prompt: 'p', files: ['src/a.js'] },
      { agent: 'claude', title: 'b', prompt: 'p', files: ['./src/a.js'] },
    ],
  });

  const result = runSquad(['code', specPath, '--dry-run']);
  const text = output(result);

  assert.equal(result.status, 1);
  assert.match(text, /overlap|both claim|conflict/i);
});

test('tasks.example.json is valid and works in code dry-run', () => {
  const example = JSON.parse(readFileSync(join(root, 'tasks.example.json'), 'utf8'));

  assert.ok(Array.isArray(example.tasks));
  assert.ok(example.tasks.length > 0);

  const result = runSquad(['code', 'tasks.example.json', '--dry-run']);

  assert.equal(result.status, 0);
});
