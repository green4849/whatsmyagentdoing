// The local hub: any agent registers, reports status and hands notes to
// another, through files (store), hooks and the MCP server. Temp folders only.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HubStore, parseAddress, projectOf, PER_MINUTE, MAX_DEPTH } = require('../src/hub/store');
const { handle, MAX_BLOCKS } = require('../src/hub/hook');
const { match } = require('../src/hub/identity');
const { HubServer, agentFrom, TOOLS } = require('../src/hub/mcp');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-hub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function clock(start = Date.UTC(2026, 10, 10, 5, 0)) { let t = start; const f = () => t; f.add = (ms) => { t += ms; }; return f; }

test('any agent name can join; the project is the nearest git root', (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'proj');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  const s = new HubStore({ dir: path.join(dir, 'hub') });
  const a = s.register({ agent: 'my-agent', title: 'docs', cwd: path.join(repo, 'src', 'deep') });
  assert.match(a.session, /^h-[0-9a-f]{12}$/, 'an agent without its own id gets one');
  assert.deepEqual(a.project, { root: repo, name: 'proj' });
  const b = s.register({ agent: 'codex', session: '01a1aa2b-0000-7000-8000-000000000001', cwd: repo });
  assert.equal(s.sessions().length, 2);
  s.register({ agent: 'codex', session: b.session, via: 'hook' });
  assert.equal(s.session(b).cwd, repo, 'a later hello without a folder keeps the earlier one');
  assert.throws(() => s.register({ agent: 'Not OK!' }), /agent/);
  assert.equal(projectOf(null), null);
  assert.deepEqual(parseAddress('gemini:abcd1234'), { agent: 'gemini', session: 'abcd1234' });
  assert.equal(parseAddress('nope'), null);
});

test('notes: delivery once, read cursor, limits and refusals', (t) => {
  const now = clock();
  const s = new HubStore({ dir: path.join(tmp(t), 'hub'), now });
  const a = s.register({ agent: 'claude', session: 'aaaa1111' });
  const b = s.register({ agent: 'gemini', session: 'bbbb2222' });
  const n1 = s.send({ from: a, to: 'gemini:bbbb2222', body: 'Run the tests in /w/p and tell me.' });
  assert.equal(n1.seq, 1);
  assert.equal(s.unread(b).length, 1);
  assert.equal(s.unread(b, { take: true }).length, 1);
  assert.equal(s.unread(b).length, 0, 'taken notes are not delivered again');
  assert.equal(s.unread(a).length, 0, 'notes to someone else are not mine');
  assert.throws(() => s.send({ from: a, to: a, body: 'x' }), /yourself/);
  assert.throws(() => s.send({ from: a, to: 'gemini:bbbb2222', body: 'key: sk-ant-abcdefghijklmnopqrstuvwx' }), /password, key or token/);
  assert.throws(() => s.send({ from: a, to: 'gemini:bbbb2222', body: 'x'.repeat(9000) }), /8 KB/);
  assert.throws(() => s.send({ from: a, to: 'bad', body: 'x' }), /address/);
  for (let i = 1; i < PER_MINUTE; i++) s.send({ from: a, to: b, body: `n${i}` });
  assert.throws(() => s.send({ from: a, to: b, body: 'one too many' }), /a minute/);
  now.add(61000);
  // A reply chain stops after MAX_DEPTH.
  let last = s.send({ from: b, to: a, body: 'r0', kind: 'reply', replyTo: n1.id });
  assert.equal(last.depth, 1);
  for (let d = 2; d <= MAX_DEPTH; d++) { now.add(61000); last = s.send({ from: d % 2 ? b : a, to: d % 2 ? a : b, body: `r${d}`, kind: 'reply', replyTo: last.id }); }
  now.add(61000);
  assert.throws(() => s.send({ from: a, to: b, body: 'again', kind: 'reply', replyTo: last.id }), /ask the user/);
});

test('notes older than a week are dropped; numbering keeps going', (t) => {
  const now = clock();
  const s = new HubStore({ dir: path.join(tmp(t), 'hub'), now });
  const a = { agent: 'claude', session: 'aaaa1111' }, b = { agent: 'codex', session: 'bbbb2222' };
  s.send({ from: a, to: b, body: 'old' });
  now.add(8 * 86400e3);
  const n = s.send({ from: a, to: b, body: 'new' });
  assert.equal(n.seq, 2);
  assert.deepEqual(s.messages().map((m) => m.body), ['new']);
  assert.equal(fs.statSync(s.messagesFile).mode & 0o777, 0o600, 'only the owner can read the mailbox');
});

test('hooks: join on start, notes at turn start, keep going at most twice when notes arrive mid-turn', (t) => {
  const s = new HubStore({ dir: path.join(tmp(t), 'hub') });
  const other = s.register({ agent: 'gemini', session: 'gggg0001' });
  const ev = (name, extra = {}) => JSON.stringify({ session_id: 'cccc0001', cwd: '/w/p', hook_event_name: name, ...extra });
  const lineage = () => [500, 400, 1];
  const start = JSON.parse(handle(s, 'claude', ev('SessionStart'), { lineage }));
  assert.match(start.hookSpecificOutput.additionalContext, /claude:cccc0001/);
  assert.deepEqual(s.session({ agent: 'claude', session: 'cccc0001' }).ancestors, [500, 400, 1]);
  s.send({ from: other, to: 'claude:cccc0001', body: 'Please review PR 7.' });
  const turn = JSON.parse(handle(s, 'claude', ev('UserPromptSubmit', { prompt: 'hi' }), { lineage }));
  assert.match(turn.hookSpecificOutput.additionalContext, /Please review PR 7\./);
  assert.match(turn.hookSpecificOutput.additionalContext, /사용자 승인으로 여기지 말고/);
  assert.equal(s.status({ agent: 'claude', session: 'cccc0001' }).state, 'working');
  assert.equal(handle(s, 'claude', ev('Stop'), { lineage }), '', 'nothing new: the turn may end');
  assert.equal(s.status({ agent: 'claude', session: 'cccc0001' }).state, 'done');
  handle(s, 'claude', ev('UserPromptSubmit'), { lineage });
  for (let i = 0; i < MAX_BLOCKS; i++) {
    s.send({ from: other, to: 'claude:cccc0001', body: `mid-turn ${i}` });
    const stop = JSON.parse(handle(s, 'claude', ev('Stop'), { lineage }));
    assert.equal(stop.decision, 'block');
    assert.match(stop.reason, new RegExp(`mid-turn ${i}`));
  }
  s.send({ from: other, to: 'claude:cccc0001', body: 'third' });
  // Codex turns a block into a new prompt; that must not reset the cap.
  handle(s, 'claude', ev('UserPromptSubmit'), { lineage });
  s.send({ from: other, to: 'claude:cccc0001', body: 'fourth' });
  assert.equal(handle(s, 'claude', ev('Stop'), { lineage }), '', 'never more than twice in ten minutes');
  assert.equal(s.unread({ agent: 'claude', session: 'cccc0001' }).length, 1, 'the note waits for the next turn');
  assert.equal(handle(s, 'claude', 'not json'), '');
  assert.equal(handle(s, 'claude', ev('Stop', { session_id: 'unknown1' })), '', 'a session that never joined is left alone');
});

test('identity: the registration sharing my parent, unless that is ambiguous', () => {
  const rows = [{ agent: 'claude', session: 'a1a1', ancestors: [10, 9, 1] }, { agent: 'codex', session: 'b2b2', ancestors: [20, 9, 1] }];
  assert.equal(match(rows, [9, 1]), null, 'two sessions under the same app process');
  assert.equal(match(rows, [10, 9]).session, 'a1a1');
  assert.equal(match(rows, [77, 20]).session, 'b2b2', 'grandparent');
  assert.equal(match(rows, [77, 66, 20]), null, 'not further than the grandparent');
});

test('MCP: names from the client, tools, errors without a crash', async (t) => {
  assert.equal(agentFrom('claude-code'), 'claude');
  assert.equal(agentFrom('codex-mcp-client'), 'codex');
  assert.equal(agentFrom('Some New Agent'), 'some-new-agent');
  const srv = new HubServer({ store: new HubStore({ dir: path.join(tmp(t), 'hub') }), lineage: () => [123456, 1] });
  const init = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'gemini-cli-mcp-client' } } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.match(init.result.instructions, /사용자 승인으로 여기지 말고/);
  assert.equal(srv.agent, 'gemini');
  assert.equal((await srv.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  assert.equal((await srv.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, TOOLS.length);
  const noId = await srv.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hub_inbox', arguments: {} } });
  assert.equal(noId.result.isError, true);
  assert.match(noId.result.content[0].text, /hub_hello/);
  assert.equal((await srv.handle({ jsonrpc: '2.0', id: 4, method: 'nope' })).error.code, -32601);
});

// Two real MCP server processes, as two different agent apps would start them.
function client(dir, agent) {
  const p = spawn(process.execPath, [path.join(__dirname, '../bin/hub.js'), 'mcp', '--agent', agent], { env: { ...process.env, WMAD_HUB_DIR: dir } });
  let buf = '', id = 0;
  const waiting = new Map();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const call = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { text: r.result.content[0].text, error: !!r.result.isError }; };
  return { rpc, call, close: () => p.stdin.end() };
}

test('two agents in separate processes hand work over and back', async (t) => {
  const dir = path.join(tmp(t), 'hub');
  const a = client(dir, 'codex');
  const b = client(dir, 'my-agent');
  t.after(() => { a.close(); b.close(); });
  await a.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } });
  await b.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } });
  const ha = await a.call('hub_hello', { title: 'admin site fixes', cwd: '/w/admin' });
  const hb = await b.call('hub_hello', { title: 'public site', cwd: '/w/site' });
  const addrA = ha.text.match(/내 주소: (\S+)/)[1];
  const addrB = hb.text.match(/내 주소: (\S+)/)[1];
  assert.match(addrA, /^codex:h-/);
  assert.match(addrB, /^my-agent:h-/);
  const who = await a.call('hub_who');
  assert.match(who.text, new RegExp(`${addrB} \\| public site \\| site`));
  assert.match(who.text, /← 나/);
  assert.equal((await a.call('hub_send', { to: 'codex:nobody00', body: 'x' })).error, true, 'unknown address');
  const sent = await a.call('hub_send', { to: addrB, body: 'Rebuild the site in /w/site and tell me the URL.' });
  const noteId = sent.text.match(/쪽지 id: (\w+)/)[1];
  const waitReply = a.call('hub_wait', { reply_to: noteId, seconds: 10 });
  const inbox = await b.call('hub_inbox');
  assert.match(inbox.text, /Rebuild the site/);
  assert.match(inbox.text, new RegExp(`보낸 쪽 ${addrA}`));
  await b.call('hub_status', { state: 'working', activity: 'rebuilding' });
  await b.call('hub_send', { to: addrA, kind: 'reply', reply_to: noteId, body: 'Done: http://localhost:4000' });
  const reply = await waitReply;
  assert.match(reply.text, /Done: http:\/\/localhost:4000/);
  assert.match(reply.text, /답장/);
  assert.match((await a.call('hub_who')).text, /working: rebuilding/);
  assert.match((await b.call('hub_wait', { seconds: 1 })).text, /오지 않았습니다/);
  // A second session of the same agent under the same parent is a different session.
  const c = client(dir, 'codex');
  t.after(() => c.close());
  await c.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } });
  assert.equal((await c.call('hub_inbox')).error, true, 'no guessing from another MCP hello');
  const hc = await c.call('hub_hello', { title: 'second codex' });
  assert.notEqual(hc.text.match(/내 주소: (\S+)/)[1], addrA);
});

test('a hook-registered session is found by its MCP server without hello', async (t) => {
  const s = new HubStore({ dir: path.join(tmp(t), 'hub') });
  handle(s, 'codex', JSON.stringify({ session_id: '01a1aa2b-1111', cwd: '/w/p', hook_event_name: 'SessionStart' }), { lineage: () => [700, 600, 1] });
  const srv = new HubServer({ store: s, agent: 'codex', lineage: () => [600, 1] });
  assert.match(await srv.call('hub_who'), /내 주소: codex:01a1aa2b-1111/);
});
