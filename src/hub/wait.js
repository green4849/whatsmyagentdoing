'use strict';

// Wait until another session ends a turn, so the caller can take over the
// work. Any agent works: one with hooks reports "done" from its Stop hook,
// one without reports it with hub_status. Used by `hub.js wait <address>`,
// typically run in the background by the session that hands work over.

const { parseAddress, address } = require('./store');

const ENDED = new Set(['done', 'failed', 'idle']);

// Resolves { ended: true, session, status } once the session reports a turn
// end newer than `since`, or { ended: false } after timeoutMs.
async function waitForTurnEnd(store, who, { since = Date.now(), timeoutMs = 3 * 3600e3, poll = 2000, now = () => Date.now() } = {}) {
  const a = typeof who === 'string' ? parseAddress(who) : who;
  if (!a) throw new Error('hub: address must look like claude:<session> or codex:<session>');
  const until = now() + timeoutMs;
  for (;;) {
    const st = store.status(a);
    if (st && ENDED.has(st.state) && st.at > since) return { ended: true, session: store.session(a), status: st };
    if (now() >= until) return { ended: false, session: store.session(a), status: st };
    await new Promise((r) => setTimeout(r, poll));
  }
}

// One line for the person or agent that was waiting.
function describe(result, who) {
  const s = result.session;
  const name = s && s.title ? `“${s.title}”` : who;
  if (!result.ended) return `${name}: 아직 턴이 끝나지 않았습니다(시간 초과).`;
  const t = new Date(result.status.at);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return `${name} (${s ? address(s) : who}) 턴 종료: ${result.status.state} · ${hhmm}${s && s.cwd ? ` · ${s.cwd}` : ''}`;
}

module.exports = { waitForTurnEnd, describe, ENDED };
