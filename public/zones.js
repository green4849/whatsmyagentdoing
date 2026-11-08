// Activity zones: what an agent is doing decides which part of the room it
// works in (scene stations / office desks tagged with `zone`). Plain script in
// the page (window.OfficeZones) and a CommonJS module for the tests.
(function (root) {
  'use strict';

  // run       – commands, tests, builds
  // write     – editing files
  // research  – reading, searching, the web and the browser
  // delegate  – sub-agents
  // think     – thinking or writing its reply
  // attention – blocked on you, or the request failed
  const ZONES = ['run', 'write', 'research', 'delegate', 'think', 'attention'];

  const STAY_MS = 10000; // the same activity for this long before moving …
  const HOLD_MS = 20000; // … and never sooner than this after the last move

  const RUN = /^(bash|powershell|shell|exec|exec_command|local_shell|run_terminal_cmd|run_command|terminal|run_in_terminal|run_shell_command|container\.exec|unified_exec)$/i;
  const WRITE = /^(edit|write|multiedit|notebookedit|apply_patch|patch|create|write_file|edit_file|replace|str_replace|str_replace_editor|insert|create_file|update_file)$/i;
  const RESEARCH = /^(read|grep|glob|ls|webfetch|websearch|web_search|web_fetch|fetch|search|find|view|view_image|read_file|read_many_files|list_directory|glob_search|codebase_search|toolsearch|google_web_search|open_page)$/i;
  const DELEGATE = /^(subagent|task|agent|spawn_agent|send_input|wait_agent)$/i;

  function failed(s) {
    return s.status === 'error' || !!(s.outcome && s.outcome.kind === 'failed');
  }

  // Which zone a session belongs in right now (null: not working).
  function zoneOf(s) {
    if (!s) return null;
    if (s.status === 'waiting' || failed(s)) return 'attention';
    if (s.status === 'thinking' || s.status === 'typing') return 'think';
    if (s.status !== 'tool') return null;
    const a = String(s.activity || '').trim();
    // MCP tools are described as "server · tool"; browsers read and search
    if (/·/.test(a)) {
      const [server, tool = ''] = a.split('·').map((x) => x.trim().toLowerCase());
      if (/terminal|shell/.test(server) || /run_in_terminal|exec/.test(tool)) return 'run';
      return 'research';
    }
    const head = a.split(/[\s:“"(]/)[0];
    if (RUN.test(head)) return 'run';
    if (WRITE.test(head)) return 'write';
    if (DELEGATE.test(head)) return 'delegate';
    if (RESEARCH.test(head)) return 'research';
    if (/^Asking you/i.test(a)) return 'attention';
    return 'think';
  }

  // Hysteresis so agents don't hop between zones every few seconds:
  // a new activity must last STAY_MS, and moves are at least HOLD_MS apart.
  // Attention moves at once. Returns the (possibly updated) state.
  function step(state, observed, now) {
    if (!observed) return state;
    if (!state) return { zone: observed, cand: null, candSince: 0, movedAt: now };
    if (observed === state.zone) return state.cand ? { ...state, cand: null, candSince: 0 } : state;
    if (observed === 'attention') return { zone: observed, cand: null, candSince: 0, movedAt: now };
    const next = state.cand === observed ? state : { ...state, cand: observed, candSince: now };
    if (now - next.candSince >= STAY_MS && now - next.movedAt >= HOLD_MS) {
      return { zone: observed, cand: null, candSince: 0, movedAt: now };
    }
    return next;
  }

  const api = { ZONES, STAY_MS, HOLD_MS, zoneOf, step, failed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OfficeZones = api;
})(typeof window !== 'undefined' ? window : this);
