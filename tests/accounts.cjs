// Isolated logs only: never read the developer's actual agent history or desktop app data.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { AccountIndex, readLabels, matchAccount, desktopSessionsDir } = require('../src/accounts');
const { snapshot } = require('../src/server');

const A = 'aaaa1111-0000-4000-8000-000000000001';
const B = 'bbbb2222-0000-4000-8000-000000000002';
const ORG = 'cccc3333-0000-4000-8000-000000000003';

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function desktopSession(dir, account, name, data) {
  const file = path.join(dir, account, ORG, `local_${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

test('desktop session metadata maps current and earlier transcript ids to the account', t => {
  const dir = tmp(t);
  desktopSession(dir, A, 'one', { cliSessionId: 'sess-a2', priorCliSessionIds: ['sess-a1'] });
  const b = desktopSession(dir, B, 'two', { cliSessionId: 'sess-b1' });
  fs.writeFileSync(path.join(dir, B, ORG, 'scheduled-tasks.json'), '{}');
  fs.mkdirSync(path.join(dir, 'not-an-account', ORG), { recursive: true });
  fs.writeFileSync(path.join(dir, 'not-an-account', ORG, 'local_x.json'), JSON.stringify({ cliSessionId: 'sess-x' }));

  const idx = new AccountIndex({ dir, labels: JSON.stringify({ 'aaaa1111': 'Max', 'bbbb': 'Personal' }) });
  assert.equal(idx.refresh(), true);
  assert.equal(idx.refresh(), false, 'unchanged files are not reread');
  assert.deepEqual(idx.lookup('sess-a1'), { id: 'aaaa1111', label: 'Max' });
  assert.deepEqual(idx.lookup('sess-a2'), { id: 'aaaa1111', label: 'Max' });
  assert.deepEqual(idx.lookup('sess-b1'), { id: 'bbbb2222', label: 'Personal' });
  assert.equal(idx.lookup('sess-x'), null, 'folders that are not account ids are ignored');
  assert.equal(idx.lookup('unknown'), null);
  assert.equal(idx.lookup(undefined), null);

  fs.rmSync(b);
  assert.equal(idx.refresh(), true);
  assert.equal(idx.lookup('sess-b1'), null, 'a deleted desktop session drops its mapping');
});

test('unlabelled accounts show their short id, and broken metadata is skipped', t => {
  const dir = tmp(t);
  desktopSession(dir, B, 'ok', { cliSessionId: 'sess-b1', priorCliSessionIds: 'not a list' });
  fs.writeFileSync(path.join(dir, B, ORG, 'local_half.json'), '{"cliSessionId": "sess-');
  const idx = new AccountIndex({ dir, labels: '' });
  idx.refresh();
  assert.deepEqual(idx.lookup('sess-b1'), { id: 'bbbb2222', label: 'bbbb2222' });
  assert.equal(new AccountIndex({ dir: path.join(dir, 'missing') }).refresh(), false);
});

test('labels come from inline JSON or a file, and bad input is reported', t => {
  const dir = tmp(t);
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(file, JSON.stringify({ 'bbbb': 'Short', 'bbbb2222': 'Long', empty: ' ' }));
  assert.deepEqual(readLabels(file), [['bbbb2222', 'Long'], ['bbbb', 'Short']], 'longest prefix first; blank labels dropped');
  assert.deepEqual(readLabels(undefined), []);
  assert.throws(() => readLabels('{nope'), /WMAD_ACCOUNT_LABELS/);
  assert.throws(() => readLabels(path.join(dir, 'missing.json')), /cannot read/);
  assert.throws(() => readLabels('[1]'), /cannot read|JSON object/);
});

test('the desktop app folder follows each platform, with an override', () => {
  assert.equal(desktopSessionsDir({}, '/h', 'darwin'), '/h/Library/Application Support/Claude/claude-code-sessions');
  assert.equal(desktopSessionsDir({}, '/h', 'linux'), '/h/.config/Claude/claude-code-sessions');
  assert.equal(desktopSessionsDir({ WMAD_DESKTOP_SESSIONS_DIR: '/x' }, '/h', 'darwin'), '/x');
});

test('account filters match a label, an id prefix, or sessions without an account', () => {
  const max = { id: 'aaaa1111', label: 'Max' };
  assert.equal(matchAccount('', max), true);
  assert.equal(matchAccount(undefined, null), true);
  assert.equal(matchAccount('max', max), true);
  assert.equal(matchAccount('aaaa', max), true);
  assert.equal(matchAccount(A, max), true, 'a full uuid works too');
  assert.equal(matchAccount('11', max), false, 'very short prefixes are not ids');
  assert.equal(matchAccount('Personal', max), false);
  assert.equal(matchAccount('none', null), true);
  assert.equal(matchAccount('none', max), false);
  assert.equal(matchAccount('max', null), false);
});

test('snapshots carry the account and filter by it, including today totals', () => {
  const now = Date.now();
  const { dayKey } = require('../src/parsers');
  const base = { status: 'done', lastEventAt: now - 1000, cwd: '/w/p', daily: { day: dayKey(now), turns: 1, tokens: 10 } };
  const watcher = { sessions: () => [
    { ...base, agent: 'claude', id: 'a', account: { id: 'aaaa1111', label: 'Max' } },
    { ...base, agent: 'claude', id: 'b', account: { id: 'bbbb2222', label: 'Personal' } },
    { ...base, agent: 'codex', id: 'c' },
  ] };
  const all = snapshot(watcher, {});
  assert.deepEqual(all.sessions.map((s) => s.account?.label ?? null).sort(), ['Max', 'Personal', null].sort());
  const max = snapshot(watcher, {}, 'Max');
  assert.deepEqual(max.sessions.map((s) => s.id), ['a']);
  assert.equal(max.account, 'Max');
  assert.equal(max.summary.turns, 1, 'today totals count only the shown account');
  const def = snapshot(watcher, { account: 'personal' });
  assert.deepEqual(def.sessions.map((s) => s.id), ['b'], '--account is the default filter');
  assert.deepEqual(snapshot(watcher, { account: 'personal' }, '').sessions.length, 3, 'an empty ?account= shows everyone');
  assert.deepEqual(snapshot(watcher, {}, 'none').sessions.map((s) => s.id), ['c']);
});

test('the watcher labels Claude sessions and subagents from the desktop metadata', t => {
  const root = tmp(t);
  const line = (o) => JSON.stringify(o) + '\n';
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  const proj = path.join(root, '.claude/projects/-w-p');
  fs.mkdirSync(path.join(proj, 'sess-a/subagents'), { recursive: true });
  const user = line({ type: 'user', timestamp: at(5000), cwd: '/w/p', message: { role: 'user', content: 'hi' } });
  fs.writeFileSync(path.join(proj, 'sess-a.jsonl'), user);
  fs.writeFileSync(path.join(proj, 'sess-a/subagents/agent-1.jsonl'), user);
  fs.writeFileSync(path.join(proj, 'sess-cli.jsonl'), user);
  desktopSession(path.join(root, 'Library/Application Support/Claude/claude-code-sessions'), A, 'one', { cliSessionId: 'sess-a' });

  const watcherPath = path.join(__dirname, '../src/watcher.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(watcherPath, 'utf8'), {
    module: mod, exports: mod.exports, Buffer, Date, console, setInterval, clearInterval, __dirname: path.dirname(watcherPath),
    process: { env: { WMAD_ACCOUNT_LABELS: '{"aaaa1111":"Max"}' }, pid: process.pid, platform: 'darwin', execPath: process.execPath },
    require: (name) => name === 'os' ? { homedir: () => root } : createRequire(watcherPath)(name),
  }, { filename: watcherPath });
  const w = new mod.exports.Watcher();
  w.tick();
  const byId = Object.fromEntries(w.sessions().map((s) => [s.id, s.account]));
  assert.deepEqual(byId['sess-a'], { id: 'aaaa1111', label: 'Max' });
  assert.deepEqual(byId['agent-1'], { id: 'aaaa1111', label: 'Max' }, 'subagents inherit the parent account');
  assert.equal(byId['sess-cli'], null, 'terminal sessions have no desktop metadata');
});
