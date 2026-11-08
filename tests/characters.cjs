// Custom characters: characters.json picks a model per session, folder or account.
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { Characters } = require('../src/characters');
const { snapshot, createServer } = require('../src/server');

function setup(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-chars-'));
  fs.mkdirSync(path.join(dir, 'models'));
  for (const m of ['blob.glb', 'cat.glb', 'me.glb']) fs.writeFileSync(path.join(dir, 'models', m), 'glTF');
  fs.writeFileSync(path.join(dir, 'secret.json'), '{}');
  if (config) fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify(config));
  return { dir, chars: new Characters({ dir }) };
}

test('session beats folder beats account, and the deepest folder wins', () => {
  const { chars } = setup({
    folders: { '/w': 'blob.glb', '/w/deep/': { model: 'cat.glb', turn: 540, height: 1.2 }, '~/home-only': 'me.glb' },
    accounts: { 'aaaa1111-2222': 'me.glb' },
    sessions: { 'abc': 'me.glb' },
  });
  chars.refresh();
  const model = (s) => { const c = chars.resolve(s); return c && c.url.split('?')[0].slice('/characters/'.length); };
  assert.equal(model({ id: 'x', cwd: '/w' }), 'blob.glb');
  assert.equal(model({ id: 'x', cwd: '/w/project' }), 'blob.glb', 'folders cover their subfolders');
  assert.equal(model({ id: 'x', cwd: '/w/deep/project' }), 'cat.glb');
  assert.equal(model({ id: 'x', cwd: '/wx' }), null, 'no partial folder names');
  assert.equal(model({ id: 'abcdef', cwd: '/w' }), 'me.glb', 'a session id prefix wins');
  assert.equal(model({ id: 'x', cwd: '/other', account: { id: 'aaaa1111' } }), 'me.glb', 'short account ids match a longer key');
  assert.equal(model({ id: 'x', cwd: path.join(os.homedir(), 'home-only', 'p') }), 'me.glb', '~ is the home folder');
  assert.equal(model({ id: 'x', cwd: null }), null);
  assert.deepEqual(Object.keys(chars.resolve({ id: 'x', cwd: '/w/deep' })).sort(), ['height', 'turn', 'url']);
  assert.equal(chars.resolve({ id: 'x', cwd: '/w/deep' }).turn, 180);
});

test('bad names, missing files and bad values are ignored', () => {
  const { chars } = setup({
    folders: { '/a': '../secret.json', '/b': 'missing.glb', '/c': { model: 'blob.glb', height: 50, turn: 'x' }, '/d': '.hidden.glb' },
  });
  const orig = console.warn; console.warn = () => {};
  try { chars.refresh(); } finally { console.warn = orig; }
  assert.equal(chars.resolve({ cwd: '/a' }), null);
  assert.equal(chars.resolve({ cwd: '/b' }), null);
  assert.deepEqual(Object.keys(chars.resolve({ cwd: '/c' })), ['url'], 'out-of-range height and non-numeric turn dropped');
  assert.equal(chars.resolve({ cwd: '/d' }), null);
  assert.equal(chars.modelFile('../secret.json'), null);
  assert.equal(chars.modelFile('missing.glb'), null);
  assert.ok(chars.modelFile('blob.glb'));
});

test('no config means stock characters, and edits are picked up', () => {
  const { dir, chars } = setup(null);
  assert.equal(chars.refresh().resolve({ cwd: '/w' }), null);
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify({ folders: { '/w': 'blob.glb' } }));
  fs.utimesSync(path.join(dir, 'characters.json'), new Date(), new Date(Date.now() + 5000));
  assert.match(chars.refresh().resolve({ cwd: '/w' }).url, /^\/characters\/blob\.glb\?v=\d+$/);
});

test('snapshots carry the character, and the server serves only model files', async () => {
  const { chars } = setup({ folders: { '/w': 'blob.glb' } });
  const watcher = { sessions: () => [
    { agent: 'claude', id: 'a', cwd: '/w/p', status: 'done', lastEventAt: Date.now() },
    { agent: 'claude', id: 'b', cwd: '/elsewhere', status: 'done', lastEventAt: Date.now() },
  ], on() {} };
  const opts = { characters: chars };
  const rows = snapshot(watcher, opts).sessions;
  assert.match(rows.find((s) => s.id === 'a').character.url, /^\/characters\/blob\.glb/);
  assert.equal(rows.find((s) => s.id === 'b').character, null);

  const server = createServer(watcher, opts);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const get = (p) => new Promise((ok, fail) => http.get({ host: '127.0.0.1', port: server.address().port, path: p,
    headers: { host: 'localhost' } }, (res) => { res.resume(); ok(res.statusCode); }).on('error', fail));
  try {
    assert.equal(await get('/characters/blob.glb'), 200);
    assert.equal(await get('/characters/..%2Fsecret.json'), 404);
    assert.equal(await get('/characters/../secret.json'), 404);
    assert.equal(await get('/characters/%2E%2E%2Fcharacters.json'), 404);
    assert.equal(await get('/characters/%E0%A4%A'), 400);
  } finally {
    server.close();
  }
});
