'use strict';

// Did the last finished turn do what was asked? Decided only once a turn is
// over, and only from signals that say so plainly:
//
//   failed – the request was not carried out: the turn ended on an API error
//            (sign-in, usage limit, overload, refusal, too long), on a refused
//            tool call, the desktop app's summary says it failed, or the
//            agent's reply opens by saying it could not do it (sure: false).
//   needs  – nothing failed, but it is your turn: the agent ended on a
//            question or on something only you can do (the desktop app's
//            "blocked" summary, its wrap-up marked blocked, a Codex question
//            card). Shown like a waiting session.
//
// Tool errors along the way, partial results, caveats and turns you stopped
// yourself are not outcomes: the agent usually recovers, and you already know.

const SETTLED = new Set(['done', 'interrupted', 'idle']);

// The reply's first sentence, without a heading line or markdown emphasis.
function lead(text) {
  if (!text) return null;
  const s = String(text).replace(/^\s*#+.*\n/, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const m = s.match(/^.{0,160}?[.!?。](?=\s|$)/);
  return (m ? m[0] : s.slice(0, 160)).trim();
}

// "I could not / it did not happen" as the opening statement.
const NOT_DONE = /(하지\s?못했|못\s?했|실패했|실패하였|시작되지\s?않았|반영되지\s?않았|되지\s?않았|안\s?됐|접속되지\s?않|찾지\s?못|couldn['’]t|could not|was(?:n['’]t| not) able|unable to|failed to|did not (?:succeed|work)|didn['’]t work)/i;
// Verification caveats and uncertainty are not a failed request.
const CAVEAT = /(확인하지\s?못|확인\s?못|확정하지\s?못|확정할\s?수\s?없|단정|추정|could(?:n['’]t| not) (?:verify|confirm)|not (?:verified|confirmed))/i;
// A question rather than an instruction: the answer may well be "it can't".
const QUESTION = /(\?|？|까\s*$|나요\s*$|니\s*$|어\s*$|지\s*$|인가|뭐야|뭔지|어떻게|왜\s|있어\s*$|맞아\s*$)/;

const isQuestion = (prompt) => QUESTION.test(String(prompt || '').trim());

// The opening sentence when it says the request was not done, else null.
function leadFailure(first, askedQuestion) {
  if (!first || askedQuestion) return null;
  return NOT_DONE.test(first) && !CAVEAT.test(first) ? first : null;
}

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// "try again at 5:03 PM" / "at Nov 4th, 2026 4:56 PM" -> epoch ms, read in
// local time relative to when the error was logged.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function retryTime(message, loggedAt) {
  const m = String(message || '').match(/try again at (?:([A-Za-z]{3})[a-z]* (\d{1,2})\w*,? (\d{4}),? )?(\d{1,2}):(\d{2}) ?([AP]M)/i);
  if (!m || !loggedAt) return null;
  let h = Number(m[4]) % 12;
  if (m[6].toUpperCase() === 'PM') h += 12;
  const base = new Date(loggedAt);
  const d = m[1]
    ? new Date(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2]), h, Number(m[5]))
    : new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, Number(m[5]));
  if (!m[1] && d.getTime() < loggedAt) d.setDate(d.getDate() + 1);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
// "17:03", or "11/10 13:08" when it is not today.
function when(ms, now) {
  const d = new Date(ms), n = new Date(now);
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === n.toDateString() ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

// Short Korean reason and next step for an error that ended a turn.
// code: Claude's assistant `error` field or Codex's codex_error_info.
function apiReason(code, message, loggedAt, now = Date.now()) {
  const msg = String(message || '');
  const c = String(code || '');
  if (/too long|context.?window|context_length|maximum context/i.test(msg) || /context_window/.test(c)) return { detail: '대화가 너무 김', action: '/compact 또는 새 세션' };
  if (c === 'authentication_failed' || /authenticat|log ?in again|oauth/i.test(msg)) return { detail: '로그인 만료', action: '다시 로그인 후 보내기' };
  if (c === 'usage_limit_exceeded' || c === 'rate_limit' || /usage limit|rate limit|hit your limit/i.test(msg)) {
    const at = retryTime(msg, loggedAt);
    return { detail: '사용량 한도 도달', action: !at ? '한도가 풀린 뒤 다시 보내기' : at <= now ? '지금 다시 보낼 수 있음' : `${when(at, now)} 이후 다시 보내기` };
  }
  if (c === 'server_overloaded' || /overloaded|at capacity|no capacity/i.test(msg)) return { detail: '서버 과부하', action: '잠시 후 다시 보내기' };
  if (/safeguard|usage polic|acceptable use|refus/i.test(msg)) return { detail: '요청이 거절됨', action: '요청 내용 바꿔 보내기' };
  if (c === 'billing_error' || /credit|billing|payment/i.test(msg)) return { detail: '결제·크레딧 문제', action: '계정 결제 상태 확인' };
  if (c === 'server_error' || /connection|ENOTFOUND|ECONN|network|went to sleep|reach the API/i.test(msg)) return { detail: '연결 실패로 중단', action: '네트워크 확인 후 다시 보내기' };
  return { detail: cut(msg, 40) || 'API 오류', action: '다시 보내기' };
}

const failed = (detail, action, source, sure = true) => ({ kind: 'failed', detail: detail || null, action: action || null, source, sure });
const needs = (detail, action, source) => ({ kind: 'needs', detail: detail || null, action: action || null, source, sure: true });

function apiFailure(s, now) {
  if (!s._apiError) return null;
  const r = apiReason(s._apiError.code, s._apiError.message, s._apiError.at, now);
  return failed(r.detail, r.action, 'log');
}

// summary: the desktop app's { category, detail, action, forUuid } for this session, if any.
function claudeOutcome(s, summary, now = Date.now()) {
  if (s.subagent) return null;
  if (s.status === 'error') {
    return apiFailure(s, now);
  }
  if (!SETTLED.has(s.status) || s.status === 'interrupted') return null;
  const done = s.status === 'done';
  if (done && s._refusal) return failed('요청이 거절됨', '요청 내용 바꿔 보내기', 'log');
  const own = summary && summary.forUuid && summary.forUuid === s._lastAssistantUuid ? summary : null;
  if (own && /fail|error/i.test(own.category)) return failed(own.detail, own.action, 'desktop');
  if (done && s._lastToolDenied) return failed('권한 거부로 중단', '권한 허용 후 다시 요청', 'log');
  const blocked = (own && own.category === 'blocked') || (s._wrap && s._wrap.blocked);
  const ask = (own && own.category === 'blocked' && own.action) || (s._wrap && s._wrap.ask) || null;
  const said = done && leadFailure(s._lead, s._askedQuestion);
  if (said) return failed(cut(said, 60), ask || '답변 확인', 'reply', false);
  if (done && blocked) return needs((own && own.category === 'blocked' && own.detail) || ask, ask, own && own.category === 'blocked' ? 'desktop' : 'log');
  return null;
}

function codexOutcome(s, now = Date.now()) {
  if (s.subagent) return null;
  if (s.status === 'error') {
    return apiFailure(s, now);
  }
  if (s.status !== 'done') return null;
  const said = leadFailure(s._lead, s._askedQuestion);
  if (said) return failed(cut(said, 60), '답변 확인', 'reply', false);
  if (s._question) return needs(cut(s._question, 80), cut(s._question, 80), 'log');
  return null;
}

module.exports = { claudeOutcome, codexOutcome, apiReason, retryTime, lead, leadFailure, isQuestion };
