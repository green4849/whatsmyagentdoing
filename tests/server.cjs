// Each case owns a child process so an uncaught request error fails the test.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

for (const scenario of ['assets', 'scenes', 'guards']) {
  test(`HTTP ${scenario}: malformed paths and resource boundaries`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-server-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/server.cjs'), scenario, home], {
      env: { ...process.env, HOME: home, USERPROFILE: home, WMAD_NO_UPDATE_CHECK: '1' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}

test('silent active sessions are flagged as stuck, with minutes, until they time out to idle', () => {
  const { snapshot } = require('../src/server');
  const now = Date.now(), min = 60_000;
  const s = (key, status, ago) => ({ agent: 'claude', id: key, status, lastEventAt: now - ago, cwd: '/w' });
  const rows = snapshot({ sessions: () => [s('a', 'tool', 9 * min), s('b', 'tool', 12 * min), s('c', 'thinking', 9 * min),
    s('d', 'thinking', 20 * min), s('e', 'waiting', 30 * min), s('f', 'tool', 50 * min)] }, { privacy: false }).sessions;
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by.a.stuck, 0);
  assert.equal(by.b.stuck, 12);
  assert.equal(by.c.stuck, 9);
  assert.equal(by.d.status, 'idle'); assert.equal(by.d.stuck, 0);
  assert.equal(by.e.stuck, 0, 'waiting for you is not stuck');
  assert.equal(by.f.status, 'idle'); assert.equal(by.f.stuck, 0);
});

test('private mode keeps how a turn ended but drops its words', () => {
  const { snapshot } = require('../src/server');
  const now = Date.now();
  const s = (id, status, outcome, activity) => ({ agent: 'claude', id, status, outcome, activity, lastEventAt: now - 1000, cwd: '/w' });
  const rows = snapshot({ sessions: () => [
    s('a', 'done', { kind: 'failed', detail: '아직 배포하지 못했습니다.', action: '답변 확인', source: 'reply', sure: false }),
    s('b', 'waiting', { kind: 'needs', detail: '1쪽으로 줄일까요?', action: '1쪽으로 줄일까요?', source: 'log', sure: true }, '1쪽으로 줄일까요?'),
    s('c', 'waiting', null, 'Bash: rm -rf build')] }, { privacy: true }).sessions;
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.deepEqual(by.a.outcome, { kind: 'failed', detail: null, action: null, source: 'reply', sure: false });
  assert.equal(by.b.outcome.kind, 'needs');
  assert.equal(by.b.activity, null, 'the question is conversation text');
  assert.equal(by.c.activity, 'Bash', 'a tool name stays');
});
