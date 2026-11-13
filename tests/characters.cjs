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

test('a model can carry its own name-tag colour', () => {
  const { chars } = setup({
    folders: { '/w': 'blob.glb', '/c': 'cat.glb', '/m': 'me.glb' },
    colors: { 'blob.glb': '#F6B8C8', 'cat.glb': 'pink', 'me.glb': '#fff', '../x.glb': '#000000' },
  });
  chars.refresh();
  assert.equal(chars.resolve({ cwd: '/w' }).color, '#f6b8c8', 'valid #rrggbb, lower-cased');
  assert.equal('color' in chars.resolve({ cwd: '/c' }), false, 'named colours are ignored');
  assert.equal('color' in chars.resolve({ cwd: '/m' }), false, 'short hex is ignored');
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

// ---- Editing from the page: GET/POST /api/characters.

async function withApi(config, run) {
  const { dir, chars } = setup(config);
  const watcher = { sessions: () => [
    { agent: 'claude', id: 'aaaa1111-2222', cwd: '/w/p', status: 'done', lastEventAt: Date.now() },
    { agent: 'claude', id: 'bbbb3333-4444', cwd: '/w/q', status: 'done', lastEventAt: Date.now() },
  ], on() {} };
  const server = createServer(watcher, { characters: chars });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const call = (method, p, body, headers = {}) => new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method,
      headers: { host: 'localhost', ...headers } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; });
      res.on('end', () => ok({ status: res.statusCode, body: t ? (() => { try { return JSON.parse(t); } catch { return t; } })() : null }));
    });
    req.on('error', fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const post = (body, headers = { 'x-whatsmyagentdoing': 'characters' }) => call('POST', '/api/characters', body, headers);
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'characters.json'), 'utf8'));
  try { await run({ dir, chars, post, get: () => call('GET', '/api/characters'), read, watcher }); } finally { server.close(); }
}

test('the picker lists models and rules, and writes need the custom header', async () => {
  await withApi({ folders: { '/w': 'blob.glb' }, colors: { 'blob.glb': '#aabbcc' } }, async ({ post, get, read }) => {
    const list = (await get()).body;
    assert.deepEqual(list.models.map((m) => m.name), ['blob.glb', 'cat.glb', 'me.glb']);
    assert.equal(list.models[0].color, '#aabbcc');
    assert.equal(list.rules.folders[0].model, 'blob.glb');
    const before = JSON.stringify(read());
    assert.equal((await post({ op: 'assign', scope: 'session', key: 'aaaa1111', model: 'cat.glb' }, {})).status, 403, 'no header');
    assert.equal((await post({ op: 'assign', scope: 'session', key: 'aaaa1111', model: 'cat.glb' }, { 'x-whatsmyagentdoing': 'project' })).status, 403, 'wrong header');
    assert.equal(JSON.stringify(read()), before, 'nothing written');
  });
});

test('bad models, keys and bodies are refused without touching the file', async () => {
  await withApi({ folders: { '/w': 'blob.glb' } }, async ({ post, read }) => {
    const before = JSON.stringify(read());
    for (const body of [
      { op: 'assign', scope: 'session', key: 'aaaa1111', model: '../secret.json' },
      { op: 'assign', scope: 'session', key: 'aaaa1111', model: 'missing.glb' },
      { op: 'assign', scope: 'folder', key: '', model: 'cat.glb' },
      { op: 'assign', scope: 'folder', key: 'x'.repeat(1001), model: 'cat.glb' },
      { op: 'assign', scope: 'galaxy', key: 'x', model: 'cat.glb' },
      { op: 'assign', scope: 'folder', key: '/w', model: 'cat.glb', clearSessions: 'nope' },
      { op: 'color', model: 'cat.glb', color: 'red' },
      { op: 'color', model: 'missing.glb', color: '#112233' },
      { op: 'nothing' },
    ]) {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.body.error);
    }
    assert.equal((await post(null)).status, 400);
    assert.equal(JSON.stringify(read()), before);
  });
});

test('assigning by session, folder and account takes effect and keeps other keys', async () => {
  await withApi({ folders: { '/w': 'blob.glb' }, other: { keep: true } }, async ({ post, read, chars, watcher }) => {
    const model = (s) => { chars.refresh(); const c = chars.resolve(s); return c && c.url.split('?')[0].slice('/characters/'.length); };
    const a = watcher.sessions()[0];
    assert.equal(model(a), 'blob.glb');
    assert.equal((await post({ op: 'assign', scope: 'session', key: a.id, model: 'cat.glb' })).status, 200);
    assert.deepEqual(read().sessions, { 'aaaa1111-222': 'cat.glb' }, 'session ids are kept to 12 characters');
    assert.equal(model(a), 'cat.glb', 'session beats folder');
    assert.deepEqual(read().other, { keep: true }, 'unknown keys survive');
    assert.equal((await post({ op: 'assign', scope: 'account', key: 'AA11', model: 'me.glb' })).status, 200);
    assert.deepEqual(read().accounts, { aa11: 'me.glb' });
    // Taking a rule away: the session falls back to its folder.
    assert.equal((await post({ op: 'assign', scope: 'session', key: a.id, model: null })).status, 200);
    assert.equal(read().sessions, undefined, 'an emptied section is dropped');
    assert.equal(model(a), 'blob.glb');
  });
});

test('a folder change can clear the sessions that were set by hand, and keeps turn and height for the same model', async () => {
  const home = os.homedir();
  await withApi({
    folders: { [`~/proj/`]: { model: 'cat.glb', turn: 180, height: 1.2 } },
    sessions: { aaaa1111: 'me.glb', bbbb3333: 'me.glb' },
  }, async ({ post, read, chars, watcher }) => {
    const cwd = path.join(home, 'proj', 'x');
    const [a, b] = watcher.sessions().map((s) => ({ ...s, cwd }));
    chars.refresh();
    assert.equal(chars.rule(a).via, 'session');
    // Same model again: the tuned turn/height stay, under the key as it was written.
    assert.equal((await post({ op: 'assign', scope: 'folder', key: path.join(home, 'proj'), model: 'cat.glb' })).status, 200);
    assert.deepEqual(read().folders, { '~/proj/': { model: 'cat.glb', turn: 180, height: 1.2 } });
    // Another model drops them, and clearSessions lets the folder reach a hand-set session.
    assert.equal((await post({ op: 'assign', scope: 'folder', key: path.join(home, 'proj'), model: 'blob.glb', clearSessions: [a.id] })).status, 200);
    assert.deepEqual(read().folders, { '~/proj/': 'blob.glb' });
    assert.deepEqual(read().sessions, { bbbb3333: 'me.glb' });
    chars.refresh();
    assert.deepEqual(chars.rule(a), { via: 'folder', model: 'blob.glb' });
    assert.deepEqual(chars.rule(b), { via: 'session', model: 'me.glb' });
  });
});

test('colours are set and reset per model, the old file is kept as .bak, and a broken file is not overwritten', async () => {
  await withApi({ folders: { '/w': 'blob.glb' } }, async ({ dir, post, read }) => {
    assert.equal((await post({ op: 'color', model: 'blob.glb', color: '#F6B8C8' })).status, 200);
    assert.deepEqual(read().colors, { 'blob.glb': '#f6b8c8' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'characters.json.bak'), 'utf8')), { folders: { '/w': 'blob.glb' } });
    assert.equal((await post({ op: 'color', model: 'blob.glb', color: null })).status, 200);
    assert.equal(read().colors, undefined);
    fs.writeFileSync(path.join(dir, 'characters.json'), '{ not json');
    const r = await post({ op: 'assign', scope: 'folder', key: '/w', model: 'cat.glb' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not valid JSON/);
    assert.equal(fs.readFileSync(path.join(dir, 'characters.json'), 'utf8'), '{ not json');
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp files left');
  });
});

test('with no characters.json yet, the first assignment creates it', async () => {
  await withApi(null, async ({ dir, post, read }) => {
    assert.equal(fs.existsSync(path.join(dir, 'characters.json')), false);
    assert.equal((await post({ op: 'assign', scope: 'account', key: 'abc123', model: 'cat.glb' })).status, 200);
    assert.deepEqual(read(), { accounts: { abc123: 'cat.glb' } });
  });
});
