// Failed turns: a refused last tool call, or the desktop app's own "blocked"
// summary for the latest turn. Isolated logs only.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { newSession, applyClaude } = require('../src/parsers');
const { AccountIndex } = require('../src/accounts');

const ACCOUNT = 'aaaa1111-0000-4000-8000-000000000001';
const ORG = 'cccc3333-0000-4000-8000-000000000003';
const at = (ms) => new Date(Date.now() - ms).toISOString();
const prompt = (text, ms) => ({ type: 'user', timestamp: at(ms), cwd: '/w/p', message: { role: 'user', content: text } });
const toolUse = (uuid, ms) => ({ type: 'assistant', uuid, timestamp: at(ms), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf build' } }] } });
const toolResult = (text, isError, ms) => ({ type: 'user', timestamp: at(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: isError, content: text }] } });
const reply = (uuid, text, ms) => ({ type: 'assistant', uuid, timestamp: at(ms), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-outcome-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a refused last tool call is remembered until the next prompt', () => {
  const s = newSession('claude', 'x', '/f');
  for (const d of [prompt('clean the build', 9000), toolUse('u1', 8000),
    toolResult('Permission for this action was denied by the auto mode classifier.', true, 7000), reply('u2', "I couldn't delete it.", 6000)]) applyClaude(s, d);
  assert.equal(s.status, 'done');
  assert.match(s._lastToolDenied, /denied/);
  assert.equal(s._lastAssistantUuid, 'u2');
  applyClaude(s, toolResult('ok', false, 5000));
  assert.equal(s._lastToolDenied, null, 'a later successful tool call clears it');
  applyClaude(s, toolResult('Permission denied', true, 4000));
  applyClaude(s, prompt('try again', 3000));
  assert.equal(s._lastToolDenied, null, 'a new prompt clears it');
  applyClaude(s, toolResult('cat: no such file', true, 2000));
  assert.equal(s._lastToolDenied, null, 'ordinary tool errors are not refusals');
});

test('the desktop app summary of the last turn is read per session', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, ACCOUNT, ORG, 'local_one.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ cliSessionId: 'sess-a', priorCliSessionIds: ['sess-old'],
    postTurnSummary: { status_category: 'blocked', status_detail: 'GitHub auth incomplete', needs_action: 'Enter the code', summarizes_uuid: 'u2' } }));
  const idx = new AccountIndex({ dir, labels: '' });
  idx.refresh();
  assert.deepEqual(idx.summary('sess-a'), { category: 'blocked', detail: 'GitHub auth incomplete', action: 'Enter the code', forUuid: 'u2' });
  assert.equal(idx.summary('sess-old'), null, 'only the current transcript gets the summary');
});

function watcherFor(t, lines, summary) {
  const root = tmp(t);
  const log = path.join(root, '.claude/projects/-w-p/sess-a.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (summary) {
    const file = path.join(root, 'Library/Application Support/Claude/claude-code-sessions', ACCOUNT, ORG, 'local_one.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cliSessionId: 'sess-a', postTurnSummary: summary }));
  }
  const watcherPath = path.join(__dirname, '../src/watcher.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(watcherPath, 'utf8'), {
    module: mod, exports: mod.exports, Buffer, Date, console, setInterval, clearInterval, __dirname: path.dirname(watcherPath),
    process: { env: {}, pid: process.pid, platform: 'darwin', execPath: process.execPath },
    require: (name) => name === 'os' ? { homedir: () => root } : createRequire(watcherPath)(name),
  }, { filename: watcherPath });
  const w = new mod.exports.Watcher();
  w.tick();
  return w.sessions().find((s) => s.id === 'sess-a');
}

test('a turn the desktop app calls blocked is a failed outcome, with its reason', (t) => {
  const s = watcherFor(t, [prompt('push it', 5000), reply('u2', 'Auth is not finished.', 4000)],
    { status_category: 'blocked', status_detail: 'GitHub auth incomplete', needs_action: 'Enter the code', summarizes_uuid: 'u2' });
  assert.deepEqual({ ...s.outcome }, { kind: 'failed', detail: 'GitHub auth incomplete', action: 'Enter the code', source: 'desktop' });
});

test('a completed summary, or one for an older turn, is not a failure', (t) => {
  assert.equal(watcherFor(t, [prompt('do it', 5000), reply('u2', 'Done.', 4000)],
    { status_category: 'completed', status_detail: 'ok', summarizes_uuid: 'u2' }).outcome, null);
  assert.equal(watcherFor(t, [prompt('do it', 5000), reply('u3', 'Done.', 4000)],
    { status_category: 'blocked', status_detail: 'old', summarizes_uuid: 'u2' }).outcome, null, 'summary of an earlier turn');
});

test('a turn that ends right after a refused tool call failed; one still running did not', (t) => {
  const done = watcherFor(t, [prompt('clean', 9000), toolUse('u1', 8000), toolResult('Permission for this action was denied.', true, 7000), reply('u2', 'Blocked.', 6000)]);
  assert.equal(done.outcome.kind, 'failed');
  assert.equal(done.outcome.source, 'log');
  const running = watcherFor(t, [prompt('clean', 9000), toolUse('u1', 8000), toolResult('Permission for this action was denied.', true, 7000)]);
  assert.equal(running.outcome, null);
});
