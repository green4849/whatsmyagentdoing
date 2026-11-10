'use strict';

// Optional adapter for agents with lifecycle hooks (Claude Code, Codex, and
// any agent using the same hook shape: JSON on stdin with session_id, cwd and
// hook_event_name). With it a session joins the hub on its own and sees notes
// at turn boundaries; without it the agent uses the MCP tools by itself.
//
//   SessionStart      join the hub; tell the agent its address; hand over waiting notes
//   UserPromptSubmit  start a turn; hand over waiting notes
//   Stop              notes arrived during the turn: keep going (at most twice in 10 minutes)
//
// Output follows the hook format both apps read: additionalContext for the
// first two, { decision: "block", reason } to keep a turn going.

const { address } = require('./store');
const { render } = require('./deliver');
const { ancestors } = require('./identity');

// Codex turns a Stop "block" into a new prompt (which fires UserPromptSubmit
// again), so the cap counts continuations over time, not per turn.
const MAX_BLOCKS = 2;
const BLOCK_WINDOW = 10 * 60000;

function context(event, text) {
  return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) : '';
}

// Returns what the hook prints on stdout ('' for nothing).
function handle(store, agent, input, { lineage = () => ancestors(process.ppid) } = {}) {
  let d;
  try { d = JSON.parse(input); } catch { return ''; }
  if (!d || typeof d.session_id !== 'string') return '';
  const event = d.hook_event_name || d.hookEventName || '';
  let me;
  const join = () => {
    const row = store.register({ agent, session: d.session_id, cwd: d.cwd || null, ancestors: lineage(), via: 'hook' });
    me = { agent: row.agent, session: row.session };
    return row;
  };
  try {
    if (event === 'SessionStart') {
      join();
      const notes = store.unread(me, { take: true });
      const intro = `[로컬 허브] 이 세션의 허브 주소는 ${address(me)} 입니다. 다른 에이전트(다른 앱 포함)에게 일을 넘기거나 받을 때 hub_who, hub_send, hub_inbox 도구를 쓰세요.`;
      return context(event, [intro, render(store, notes)].filter(Boolean).join('\n\n'));
    }
    if (event === 'UserPromptSubmit') {
      me = { agent, session: d.session_id };
      if (!store.session(me)) join();
      store.setTurn(me, { ...store.turn(me), startedAt: store.now() });
      store.setStatus(me, { state: 'working' });
      return context(event, render(store, store.unread(me, { take: true })));
    }
    if (event === 'Stop') {
      me = { agent, session: d.session_id };
      if (!store.session(me)) return '';
      const turn = store.turn(me);
      const recent = (turn.blockedAt || []).filter((t) => store.now() - t < BLOCK_WINDOW);
      const notes = recent.length < MAX_BLOCKS ? store.unread(me, { take: true }) : [];
      if (notes.length) {
        store.setTurn(me, { ...turn, blockedAt: [...recent, store.now()] });
        return JSON.stringify({ decision: 'block', reason: render(store, notes) });
      }
      store.setStatus(me, { state: 'done' });
      return '';
    }
  } catch { /* a hub problem must never break the agent's turn */ }
  return '';
}

module.exports = { handle, MAX_BLOCKS, BLOCK_WINDOW };
