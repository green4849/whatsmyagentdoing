// Terminal / VS Code / SDK Claude sessions have no desktop-app metadata, so they
// take the account the terminal is signed in to (~/.claude.json). Isolated files only.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const DESK = 'aaaa1111-0000-4000-8000-000000000001';
const LOGIN = 'bbbb2222-0000-4000-8000-000000000002';
const ORG = 'cccc3333-0000-4000-8000-000000000003';

function setup(t, { login = LOGIN, configDir } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-login-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  // With CLAUDE_CONFIG_DIR, Claude Code keeps both projects/ and .claude.json there.
  const cfgDir = configDir ? path.join(root, configDir) : root;
  const projects = configDir ? path.join(cfgDir, 'projects') : path.join(root, '.claude/projects');
  const write = (id, entrypoint) => {
    const file = path.join(projects, '-w-p', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'user', entrypoint, timestamp: at(5000), cwd: '/w/p', message: { role: 'user', content: 'hi' } }) + '\n');
  };
  write('sess-desk', 'claude-desktop');
  write('sess-cli', 'cli');
  write('sess-vscode', 'claude-vscode');
  write('sess-old', undefined);
  const meta = path.join(root, 'Library/Application Support/Claude/claude-code-sessions', DESK, ORG, 'local_one.json');
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ cliSessionId: 'sess-desk' }));
  fs.mkdirSync(cfgDir, { recursive: true });
  if (login !== null) fs.writeFileSync(path.join(cfgDir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: login, emailAddress: 'someone@example.com' }, other: 1 }));
  const watcherPath = path.join(__dirname, '../src/watcher.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(watcherPath, 'utf8'), {
    module: mod, exports: mod.exports, Buffer, Date, console, setInterval, clearInterval, __dirname: path.dirname(watcherPath),
    process: { env: { WMAD_ACCOUNT_LABELS: JSON.stringify({ aaaa1111: 'Max', bbbb2222: '개인' }), ...(configDir ? { CLAUDE_CONFIG_DIR: cfgDir } : {}) },
      pid: process.pid, platform: 'darwin', execPath: process.execPath },
    require: (name) => name === 'os' ? { homedir: () => root } : createRequire(watcherPath)(name),
  }, { filename: watcherPath });
  const w = new mod.exports.Watcher();
  w.tick();
  const by = Object.fromEntries(w.sessions().filter((s) => s.agent === 'claude').map((s) => [s.id, s.account ? { ...s.account } : null]));
  return { by, root, w };
}

test('terminal and VS Code sessions take the signed-in account; desktop ones keep theirs', (t) => {
  const { by } = setup(t);
  assert.deepEqual(by['sess-desk'], { id: 'aaaa1111', label: 'Max' });
  assert.deepEqual(by['sess-cli'], { id: 'bbbb2222', label: '개인', viaLogin: true });
  assert.deepEqual(by['sess-vscode'], { id: 'bbbb2222', label: '개인', viaLogin: true });
  assert.equal(by['sess-old'], null, 'no entrypoint recorded: no guess');
});

test('no signed-in account means no label; CLAUDE_CONFIG_DIR is honoured', (t) => {
  assert.equal(setup(t, { login: null }).by['sess-cli'], null);
  assert.equal(setup(t, { login: 'not-a-uuid' }).by['sess-cli'], null);
  assert.deepEqual(setup(t, { configDir: 'cfg' }).by['sess-cli'], { id: 'bbbb2222', label: '개인', viaLogin: true });
});

test('switching the terminal login is picked up on the next scan', (t) => {
  const { root, w } = setup(t);
  const other = 'dddd4444-0000-4000-8000-000000000004';
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: other }, padding: 'x'.repeat(10) }));
  w.lastScan = 0;
  w.tick();
  const s = w.sessions().find((x) => x.id === 'sess-cli');
  assert.deepEqual({ ...s.account }, { id: 'dddd4444', label: 'dddd4444', viaLogin: true });
});
