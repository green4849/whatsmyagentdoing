// Project pages: your own steps, memo and images per side-panel folder.
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Projects, slugOf, summarize } = require('../src/projects');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-projects-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('folders get a readable, distinct page folder', () => {
  assert.match(slugOf('/Users/me/Documents/치이카와 마을'), /^치이카와-마을-[0-9a-f]{8}$/u);
  assert.notEqual(slugOf('/a/site'), slugOf('/b/site'), 'same name, different folders');
  assert.equal(slugOf('/a/site'), slugOf('/a/site'));
  assert.match(slugOf('codex:'), /^codex-[0-9a-f]{8}$/, 'sessions without a folder');
  assert.match(slugOf('/../..'), /^project-[0-9a-f]{8}$/, 'nothing to name it after');
});

test('a page saves only what it can show, and reads back', (t) => {
  const p = new Projects({ dir: tmp(t) });
  const empty = p.get('/w/app');
  assert.deepEqual([empty.steps, empty.memo, empty.updatedAt], [[], '', null]);
  p.save('/w/app', {
    steps: [{ id: 'a', title: '기획', state: 'done' }, { title: '구현', state: 'doing', extra: 'x' }, { title: '배포', state: 'weird' }],
    memo: '<p>hi</p>',
    junk: 1,
  });
  const page = p.get('/w/app');
  assert.equal(page.key, '/w/app');
  assert.deepEqual(page.steps.map((s) => [s.title, s.state]), [['기획', 'done'], ['구현', 'doing'], ['배포', 'todo']]);
  assert.equal(page.steps[1].id, 's1', 'missing ids are filled in');
  assert.equal(page.steps[1].extra, undefined);
  assert.equal(page.junk, undefined);
  assert.equal(page.memo, '<p>hi</p>');
  assert.ok(page.updatedAt > 0);
});

test('summaries say where each project stands', (t) => {
  const p = new Projects({ dir: tmp(t) });
  p.save('/w/a', { steps: [{ title: 'one', state: 'done' }, { title: 'two', state: 'doing' }, { title: 'three' }] });
  p.save('/w/b', { steps: [{ title: 'x', state: 'done' }], memo: '<p> </p>' });
  p.save('/w/c', { memo: '<p>just notes</p>' });
  const all = p.summaries();
  assert.deepEqual(Object.keys(all).sort(), ['/w/a', '/w/b', '/w/c']);
  assert.deepEqual([all['/w/a'].done, all['/w/a'].total, all['/w/a'].current], [1, 3, 'two']);
  assert.deepEqual([all['/w/b'].done, all['/w/b'].total, all['/w/b'].current, all['/w/b'].memo], [1, 1, null, false]);
  assert.equal(all['/w/c'].memo, true);
  assert.equal(summarize({ steps: [{ title: 'a', state: 'todo' }] }).current, 'a', 'with nothing in progress, the next step');
});

test('images: only real image types, stored per project, served by exact name', (t) => {
  const p = new Projects({ dir: tmp(t) });
  const src = p.addImage('/w/a', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const m = src.match(/^\/projects\/([^/]+)\/images\/([a-z0-9]+\.png)$/);
  assert.ok(m, src);
  assert.equal(decodeURIComponent(m[1]), slugOf('/w/a'));
  assert.ok(p.imageFile(decodeURIComponent(m[1]), m[2]));
  assert.throws(() => p.addImage('/w/a', 'text/html', Buffer.from('<script>')));
  assert.throws(() => p.addImage('/w/a', 'image/svg+xml', Buffer.from('<svg/>')), 'no SVG: it can carry script');
  assert.equal(p.imageFile('..', m[2]), null);
  assert.equal(p.imageFile(decodeURIComponent(m[1]), '../page.json'), null);
});

test('HTTP: read, save (guarded) and images', async (t) => {
  const dir = tmp(t);
  const { createServer } = require('../src/server');
  const watcher = new EventEmitter();
  watcher.sessions = () => [];
  const server = createServer(watcher, { projects: new Projects({ dir }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const call = (method, url, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const key = encodeURIComponent('/w/site');
  const page = JSON.stringify({ steps: [{ title: '시안', state: 'doing' }], memo: '<p>메모</p>' });

  assert.equal((await call('POST', `/api/project?key=${key}`, { body: page })).status, 403, 'no header, no write');
  const saved = await call('POST', `/api/project?key=${key}`, { body: page, headers: { 'x-whatsmyagentdoing': 'project' } });
  assert.equal(saved.status, 200);
  const got = JSON.parse((await call('GET', `/api/project?key=${key}`)).body);
  assert.equal(got.memo, '<p>메모</p>');
  assert.equal(got.steps[0].title, '시안');
  assert.equal(JSON.parse((await call('GET', '/api/projects')).body)['/w/site'].current, '시안');
  assert.equal((await call('GET', '/api/project')).status, 400, 'a key is required');

  const img = await call('POST', `/api/project/image?key=${key}`, { body: Buffer.from([1, 2, 3]), headers: { 'x-whatsmyagentdoing': 'project', 'content-type': 'image/jpeg' } });
  const { src } = JSON.parse(img.body);
  const back = await call('GET', src);
  assert.equal(back.status, 200);
  assert.equal(back.type, 'image/jpeg');
  assert.deepEqual([...back.body], [1, 2, 3]);
  assert.equal((await call('POST', `/api/project/image?key=${key}`, { body: 'x', headers: { 'content-type': 'image/png' } })).status, 403);
  assert.equal((await call('GET', '/projects/x/images/../../page.json')).status, 404);
});
