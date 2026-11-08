// How a finished turn ended (src/outcome.js): failed requests, and turns that
// ended waiting on you. Isolated logs only.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { newSession, applyClaude, applyCodex } = require('../src/parsers');
const { claudeOutcome, codexOutcome, apiReason, retryTime, lead, leadFailure, isQuestion } = require('../src/outcome');
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

test('a turn the desktop app calls blocked waits on you; it is not a failure', (t) => {
  const s = watcherFor(t, [prompt('push it', 5000), reply('u2', 'Auth is in progress.', 4000)],
    { status_category: 'blocked', status_detail: 'GitHub auth incomplete', needs_action: 'Enter the code', summarizes_uuid: 'u2' });
  assert.equal(s.status, 'waiting');
  assert.equal(s.activity, 'Enter the code');
  assert.deepEqual({ ...s.outcome }, { kind: 'needs', detail: 'GitHub auth incomplete', action: 'Enter the code', source: 'desktop', sure: true });
});

test('a failed or errored desktop summary is a failure', (t) => {
  const s = watcherFor(t, [prompt('push it', 5000), reply('u2', 'Done.', 4000)],
    { status_category: 'failed', status_detail: 'push rejected', needs_action: 'pull first', summarizes_uuid: 'u2' });
  assert.equal(s.status, 'done');
  assert.deepEqual({ ...s.outcome }, { kind: 'failed', detail: 'push rejected', action: 'pull first', source: 'desktop', sure: true });
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

// ------------------------------------------------------------ Claude rules

const wrapUp = (uuid, input, ms) => ({ type: 'assistant', uuid, timestamp: at(ms), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'mcp__ccd_turn__wrap_up', input }] } });
const apiError = (uuid, code, text, ms) => ({ type: 'assistant', uuid, timestamp: at(ms), isApiErrorMessage: true, error: code,
  message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] } });
const retry = (n, ms) => ({ type: 'system', subtype: 'api_error', timestamp: at(ms), level: 'error', retryAttempt: n, maxRetries: 10,
  error: { message: 'Connection error.', formatted: "Can't reach the API server" } });
const claude = (lines, summary) => {
  const s = newSession('claude', 'x', '/f');
  for (const d of lines) applyClaude(s, d);
  return { s, o: claudeOutcome(s, summary || null) };
};

test('API retries keep the session working; only the final API error fails the turn', () => {
  const { s, o } = claude([prompt('deploy', 9000), retry(1, 8000), retry(2, 7000)]);
  assert.equal(s.status, 'thinking');
  assert.equal(s.activity, 'API 재시도 중 (2/10)');
  assert.equal(o, null);
  const ok = claude([prompt('deploy', 9000), retry(1, 8000), reply('u2', 'Deployed.', 7000)]);
  assert.equal(ok.o, null, 'a retry that recovers leaves nothing behind');
  const bad = claude([prompt('deploy', 9000), retry(9, 8000), apiError('u2', 'server_error', "API Error: Can't reach the API server (ENOTFOUND)", 7000)]);
  assert.equal(bad.s.status, 'error');
  assert.deepEqual(bad.o, { kind: 'failed', detail: '연결 실패로 중단', action: '네트워크 확인 후 다시 보내기', source: 'log', sure: true });
});

test('API error codes get short reasons and next steps', () => {
  assert.equal(claude([prompt('x', 3000), apiError('u', 'authentication_failed', 'Failed to authenticate: OAuth session expired', 2000)]).o.detail, '로그인 만료');
  assert.equal(claude([prompt('x', 3000), apiError('u', 'invalid_request', "API Error: Opus's safeguards flagged this session", 2000)]).o.detail, '요청이 거절됨');
  assert.equal(claude([prompt('x', 3000), apiError('u', 'invalid_request', 'API Error: Prompt is too long', 2000)]).o.action, '/compact 또는 새 세션');
  assert.equal(apiReason('rate_limit', 'API Error: Rate limit reached').detail, '사용량 한도 도달');
  assert.equal(apiReason('server_overloaded', 'Selected model is at capacity.').detail, '서버 과부하');
});

test('a reply that opens by saying it could not do the request fails, marked as a guess', () => {
  // The desktop app's wrap-up comes before the closing message.
  const { o } = claude([prompt('시연판 배포해 줘', 5000), wrapUp('u2', { blocked: true, ask: '터미널에서 명령을 실행해 주세요' }, 4500),
    toolResult('ok', false, 4200), reply('u3', '**아직 배포하지 못했습니다.** 빌드에 저장소 코드 실행이 필요합니다.', 4000)]);
  assert.deepEqual(o, { kind: 'failed', detail: '아직 배포하지 못했습니다.', action: '터미널에서 명령을 실행해 주세요', source: 'reply', sure: false });
});

test('caveats, explanations, answers to questions and later sentences are not failures', () => {
  const none = (p, text) => claude([prompt(p, 5000), reply('u2', text, 4000)]).o;
  assert.equal(none('테스트 고쳐 줘', '실패한 테스트를 고쳤습니다. 이제 모두 통과합니다.'), null);
  assert.equal(none('배포해 줘', '배포했어요. 확인하지 못한 것: 실제 휴대폰.'), null);
  assert.equal(none('배포해 줘', 'CV PDF는 확인하지 못했어요.'), null);
  assert.equal(none('오디오만으로 평가돼?', '오디오 파일만 있으면 평가할 수 없어요.'), null);
  assert.equal(none('배포해 줘', '배포했습니다. 다만 캐시 갱신은 하지 못했어요.'), null);
  assert.equal(none('make the change', 'Done. I could not verify it on a real phone.'), null);
});

test('a wrap-up marked blocked without a failure waits on you', (t) => {
  const { o } = claude([prompt('PDF 만들어 줘', 5000), wrapUp('u2', { blocked: true, ask: '1쪽으로 줄일까요?' }, 4500),
    toolResult('ok', false, 4200), reply('u3', 'v6 PDF를 2쪽으로 만들었습니다.', 4000)]);
  assert.deepEqual(o, { kind: 'needs', detail: '1쪽으로 줄일까요?', action: '1쪽으로 줄일까요?', source: 'log', sure: true });
  assert.equal(claude([prompt('x', 5000), wrapUp('u2', { recap: 'ok' }, 4500), toolResult('ok', false, 4200), reply('u3', 'Done.', 4000)]).o, null);
});

test('a new prompt clears the last turn; stopped turns and subagents are left alone', () => {
  const s = newSession('claude', 'x', '/f');
  for (const d of [prompt('deploy', 9000), apiError('u2', 'server_error', 'API Error: Connection lost', 8000), prompt('again', 7000)]) applyClaude(s, d);
  assert.equal(claudeOutcome(s, null), null);
  assert.equal(s._apiError, null);
  const stopped = claude([prompt('x', 5000), reply('u2', '배포하지 못했습니다.', 4000), { type: 'user', timestamp: at(3000), message: { content: '[Request interrupted by user]' } }]);
  assert.equal(stopped.o, null);
  const sub = newSession('claude', 'x', '/f');
  sub.subagent = true;
  for (const d of [prompt('x', 5000), reply('u2', '배포하지 못했습니다.', 4000)]) applyClaude(sub, d);
  assert.equal(claudeOutcome(sub, null), null);
});

test('helpers: first sentence, question prompts, retry times', () => {
  assert.equal(lead('## 결과\n**운영 배포를 시작하지 못했습니다.** 원인은'), '운영 배포를 시작하지 못했습니다.');
  assert.equal(leadFailure('운영 배포를 시작하지 못했습니다.', false), '운영 배포를 시작하지 못했습니다.');
  assert.equal(leadFailure('운영 배포를 시작하지 못했습니다.', true), null);
  assert.ok(isQuestion('이거 왜 안 돼?'));
  assert.ok(isQuestion('어떻게 하면 되나요'));
  assert.ok(!isQuestion('진행해'));
  const logged = new Date(2026, 10, 8, 16, 0).getTime();
  assert.equal(retryTime('try again at 5:03 PM.', logged), new Date(2026, 10, 8, 17, 3).getTime());
  assert.equal(retryTime('try again at 2:18 AM.', logged), new Date(2026, 10, 9, 2, 18).getTime(), 'next day');
  assert.equal(retryTime('try again at Nov 10th, 2026 1:08 PM.', logged), new Date(2026, 10, 10, 13, 8).getTime());
  const msg = 'You’ve hit your usage limit. Upgrade to Pro, or try again at 5:03 PM.';
  assert.equal(apiReason('usage_limit_exceeded', msg, logged, logged).action, '17:03 이후 다시 보내기');
  assert.equal(apiReason('usage_limit_exceeded', msg, logged, logged + 2 * 3600e3).action, '지금 다시 보낼 수 있음');
  assert.equal(apiReason('usage_limit_exceeded', 'try again at Nov 10th, 2026 1:08 PM.', logged, logged).action, '11/10 13:08 이후 다시 보내기');
});

// ------------------------------------------------------------- Codex rules

const cx = (type, payload, ms) => ({ type: 'event_msg', timestamp: at(ms), payload: { type, ...payload } });
const codex = (lines) => {
  const s = newSession('codex', 'c', '/f');
  for (const d of lines) applyCodex(s, d);
  return { s, o: codexOutcome(s) };
};

test('a Codex turn that ends on a usage limit or overload failed', () => {
  const { s, o } = codex([cx('task_started', {}, 9000), cx('user_message', { message: '관리 화면 고쳐 줘' }, 8900),
    cx('task_complete', { last_agent_message: null, error: { message: 'You’ve hit your usage limit. Try again at 5:03 PM.', codex_error_info: 'usage_limit_exceeded' } }, 8000)]);
  assert.equal(s.status, 'error');
  assert.equal(o.kind, 'failed');
  assert.equal(o.detail, '사용량 한도 도달');
  assert.match(o.action, /이후 다시 보내기|지금 다시 보낼 수 있음/);
  const busy = codex([cx('task_started', {}, 9000), cx('task_complete', { error: { message: 'Selected model is at capacity.', codex_error_info: 'server_overloaded' } }, 8000)]);
  assert.equal(busy.o.detail, '서버 과부하');
});

test('a Codex question card waits on you; an interrupted turn and a plain reply do not', () => {
  const q = codex([cx('task_started', {}, 9000), cx('user_message', { message: 'CV 사이트 만들어 줘' }, 8900),
    cx('item_completed', { item: { type: 'AgentMessage', content: [{ type: 'Text', text: '어떤 구성으로 할까요?' }], questions: [{ title: '영문 프로필로 만들까요?', options: ['예', '아니요'] }] } }, 8500),
    cx('task_complete', { last_agent_message: '어떤 구성으로 할까요?' }, 8000)]);
  assert.equal(q.o.kind, 'needs');
  assert.equal(q.o.action, '영문 프로필로 만들까요?');
  const next = codex([cx('task_started', {}, 9000), cx('item_completed', { item: { type: 'AgentMessage', content: [], questions: [{ title: 'Q?' }] } }, 8800),
    cx('task_complete', { last_agent_message: 'ok' }, 8500), cx('task_started', {}, 8000), cx('task_complete', { last_agent_message: '완료했습니다.' }, 7000)]);
  assert.equal(next.o, null, 'a new turn clears the question');
  assert.equal(codex([cx('task_started', {}, 9000), cx('turn_aborted', { reason: 'interrupted' }, 8000)]).o, null);
  const said = codex([cx('task_started', {}, 9000), cx('user_message', { message: '운영배포도 하라해' }, 8900),
    cx('task_complete', { last_agent_message: '클로드에게 운영 배포를 지시했지만 배포는 시작되지 않았습니다. 이유는' }, 8000)]);
  assert.equal(said.o.source, 'reply');
  assert.equal(said.o.sure, false);
});
