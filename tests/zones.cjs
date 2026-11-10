// Activity zones: which zone a session's current activity maps to, and the
// hysteresis that keeps agents from hopping between zones.
const assert = require('node:assert/strict');
const test = require('node:test');
const Z = require('../public/zones');

const tool = (activity, extra = {}) => ({ status: 'tool', activity, ...extra });

test('tool calls map to zones', () => {
  assert.equal(Z.zoneOf(tool('Bash: npm test')), 'run');
  assert.equal(Z.zoneOf(tool('PowerShell: dir')), 'run');
  assert.equal(Z.zoneOf(tool('Shell: pytest -q')), 'run', 'Codex shell');
  assert.equal(Z.zoneOf(tool('Edit office.js')), 'write');
  assert.equal(Z.zoneOf(tool('Write notes.md')), 'write');
  assert.equal(Z.zoneOf(tool('NotebookEdit a.ipynb')), 'write');
  assert.equal(Z.zoneOf(tool('apply_patch')), 'write', 'Codex patch');
  assert.equal(Z.zoneOf(tool('Read server.js')), 'research');
  assert.equal(Z.zoneOf(tool('Grep TODO')), 'research');
  assert.equal(Z.zoneOf(tool('Glob **/*.js')), 'research');
  assert.equal(Z.zoneOf(tool('WebSearch “three.js fog”')), 'research');
  assert.equal(Z.zoneOf(tool('WebFetch example.com')), 'research');
  assert.equal(Z.zoneOf(tool('Claude_Browser · computer')), 'research', 'browser MCP tools');
  assert.equal(Z.zoneOf(tool('terminal · run_in_terminal')), 'run', 'terminal MCP tools');
  assert.equal(Z.zoneOf(tool('Subagent: review the diff')), 'delegate');
  assert.equal(Z.zoneOf(tool('Skill pdf')), 'think', 'anything else counts as thinking');
});

test('statuses map to zones', () => {
  assert.equal(Z.zoneOf({ status: 'thinking' }), 'think');
  assert.equal(Z.zoneOf({ status: 'typing' }), 'think');
  assert.equal(Z.zoneOf({ status: 'waiting' }), 'attention');
  assert.equal(Z.zoneOf({ status: 'error' }), 'attention');
  assert.equal(Z.zoneOf({ status: 'done', outcome: { kind: 'failed' } }), 'attention', 'a failed turn');
  assert.equal(Z.zoneOf(tool('Bash: x', { outcome: { kind: 'failed' } })), 'attention');
  assert.equal(Z.zoneOf({ status: 'done' }), null, 'done agents rest');
  assert.equal(Z.zoneOf({ status: 'idle' }), null);
  assert.equal(Z.zoneOf(null), null);
});

test('first zone is taken at once', () => {
  const s = Z.step(undefined, 'write', 1000);
  assert.equal(s.zone, 'write');
});

test('a new activity must last 10 s, and moves are 20 s apart', () => {
  let s = Z.step(undefined, 'write', 0);
  s = Z.step(s, 'run', 25000);
  assert.equal(s.zone, 'write', 'just switched: not yet');
  s = Z.step(s, 'run', 30000);
  assert.equal(s.zone, 'write', '5 s in: still not');
  s = Z.step(s, 'run', 35000);
  assert.equal(s.zone, 'run', '10 s of the same activity, 35 s since the last move');
  // back to writing right away: 10 s is not enough, it was moved only 10 s ago
  s = Z.step(s, 'write', 36000);
  s = Z.step(s, 'write', 46000);
  assert.equal(s.zone, 'run', 'held for 20 s after a move');
  s = Z.step(s, 'write', 55000);
  assert.equal(s.zone, 'write', '20 s after the move and 19 s of writing');
});

test('brief detours do not move anyone', () => {
  let s = Z.step(undefined, 'write', 0);
  for (let t = 30000; t < 60000; t += 3000) s = Z.step(s, t % 6000 ? 'research' : 'write', t);
  assert.equal(s.zone, 'write', 'flipping every few seconds never settles');
  s = Z.step(s, 'run', 60000);
  s = Z.step(s, 'write', 65000);
  s = Z.step(s, 'run', 66000);
  s = Z.step(s, 'run', 74000);
  assert.equal(s.zone, 'write', 'the 10 s count restarts when the activity changes');
});

test('attention moves at once', () => {
  let s = Z.step(undefined, 'run', 0);
  s = Z.step(s, 'attention', 1000);
  assert.equal(s.zone, 'attention');
});

test('no observation keeps the current zone', () => {
  const s = Z.step(Z.step(undefined, 'think', 0), null, 50000);
  assert.equal(s.zone, 'think');
});

// ---- talking: sessions that swapped hub notes gather
const note = (w, at, dir = 'out') => ({ id: `n${at}`, dir, with: w, kind: 'task', at });
const S = (key, notes = []) => ({ key, hub: { notes } });

test('a pair that swapped a note lately is one talk group', () => {
  const now = 1e9;
  const groups = Z.talkGroups([S('claude:a', [note('codex:b', now - 60000)]), S('codex:b', [note('claude:a', now - 60000, 'in')]), S('claude:c')], now);
  assert.deepEqual(groups, [['claude:a', 'codex:b']]);
});

test('chains join into one group, old notes and absent partners do not count', () => {
  const now = 1e9;
  const sessions = [
    S('a', [note('b', now - 1000)]),
    S('b', [note('c', now - 2000)]),
    S('c'),
    S('d', [note('e', now - Z.TALK_MS - 1)]), // too old
    S('e'),
    S('f', [note('ghost', now - 1000)]), // partner not in the room
  ];
  assert.deepEqual(Z.talkGroups(sessions, now), [['a', 'b', 'c']]);
});

test('a note with only one side present still links both when both are here', () => {
  const now = 1e9;
  // only the sender's list has the note (the other side may have it trimmed)
  assert.deepEqual(Z.talkGroups([S('x', [note('y', now - 5000)]), S('y')], now), [['x', 'y']]);
  assert.deepEqual(Z.talkGroups([S('x', [note('x', now)])], now), [], 'notes to oneself are ignored');
});

test('talk slots: a pair stands across the screen (x = -y), a group stands in a ring', () => {
  const two = Z.talkSlots(2, 5, 5);
  assert.equal(two.length, 2);
  assert.ok(Math.abs(two[0].x + two[0].y - 10) < 1e-9 && Math.abs(two[1].x + two[1].y - 10) < 1e-9, 'side by side, not one behind the other');
  assert.ok(Math.abs(Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y) - 1) < 1e-9, 'a step apart');
  const four = Z.talkSlots(4, 0, 0);
  const r = four.map((q) => Math.hypot(q.x, q.y));
  assert.ok(r.every((v) => Math.abs(v - r[0]) < 1e-9) && r[0] > 0.5, 'a ring around the middle');
});
