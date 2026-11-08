// Office filters: ?account=, ?folder= and ?agent= (no real logs are read).
const assert = require('node:assert/strict');
const test = require('node:test');
const { snapshot, matchFolder } = require('../src/server');

test('folder filters match a folder name or the end of its path', () => {
  const cwd = '/Users/me/Drive/26-2/음성학회';
  assert.equal(matchFolder([], cwd), true, 'no filter shows everything');
  assert.equal(matchFolder([], null), true);
  assert.equal(matchFolder(['음성학회'], cwd), true);
  assert.equal(matchFolder(['26-2/음성학회'], cwd), true);
  assert.equal(matchFolder(['/users/me/drive/26-2/음성학회'], cwd), true, 'a full path works (lower-cased by the parser)');
  assert.equal(matchFolder(['6-2/음성학회'], cwd), false, 'path endings match whole folder names only');
  assert.equal(matchFolder(['음성'], cwd), false, 'no partial names');
  assert.equal(matchFolder(['other', '음성학회'], cwd), true, 'any of several folders');
  assert.equal(matchFolder(['cv_v3'], 'C:\\work\\CV_v3\\'), true, 'Windows paths and trailing slashes');
  assert.equal(matchFolder(['음성학회'], null), false, 'sessions without a folder are left out');
});

test('snapshots combine account, folder and agent filters', () => {
  const now = Date.now();
  const base = { status: 'done', lastEventAt: now - 1000 };
  const watcher = { sessions: () => [
    { ...base, agent: 'claude', id: 'a', cwd: '/w/CV_v3', account: { id: 'aaaa1111', label: 'Max' } },
    { ...base, agent: 'claude', id: 'b', cwd: '/w/talks/음성학회', account: { id: 'bbbb2222', label: 'Personal' } },
    { ...base, agent: 'codex', id: 'c', cwd: '/w/CV_v3' },
    { ...base, agent: 'codex', id: 'd', cwd: '/w/other' },
  ] };
  const ids = (f, opts = {}) => snapshot(watcher, opts, f).sessions.map((s) => s.id).sort();
  assert.deepEqual(ids({ folder: 'CV_v3' }), ['a', 'c']);
  assert.deepEqual(ids({ folder: 'cv_v3, 음성학회' }), ['a', 'b', 'c']);
  assert.deepEqual(ids({ agent: 'codex' }), ['c', 'd'], 'Codex sessions can have an office of their own');
  assert.deepEqual(ids({ agent: 'codex', folder: 'CV_v3' }), ['c']);
  assert.deepEqual(ids({ account: 'Max', folder: 'CV_v3' }), ['a']);
  assert.deepEqual(ids(undefined, { folder: 'other' }), ['d'], '--folder is the default');
  assert.deepEqual(ids({}, { folder: 'other' }), ['a', 'b', 'c', 'd'], 'an empty ?folder= shows everyone');
  assert.deepEqual(ids('Personal', { agent: 'claude' }), ['b'], 'a plain account keeps the other defaults');
  const snap = snapshot(watcher, {}, { folder: 'CV_v3', agent: 'codex' });
  assert.deepEqual([snap.folder, snap.agent], [['cv_v3'], ['codex']]);
});
