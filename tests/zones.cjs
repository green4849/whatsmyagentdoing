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
