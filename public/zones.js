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

  // ---- talking: sessions that exchanged hub notes lately gather and face each other.
  const TALK_MS = 5 * 60000;

  // Groups (sorted keys, two or more) of the given sessions linked by a note
  // within TALK_MS, as connected groups: A↔B and B↔C make one group of three.
  function talkGroups(sessions, now, windowMs = TALK_MS) {
    const keys = new Set(sessions.map((s) => s.key));
    const adj = new Map();
    const link = (a, b) => {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b);
      adj.get(b).add(a);
    };
    for (const s of sessions) {
      for (const n of (s.hub && s.hub.notes) || []) {
        if (!n || !n.with || n.with === s.key || !keys.has(n.with)) continue;
        if (!(now - n.at <= windowMs && n.at - now < 60000)) continue;
        link(s.key, n.with);
      }
    }
    const seen = new Set();
    const groups = [];
    for (const k of [...adj.keys()].sort()) {
      if (seen.has(k)) continue;
      const g = [];
      const stack = [k];
      seen.add(k);
      while (stack.length) {
        const x = stack.pop();
        g.push(x);
        for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); stack.push(y); }
      }
      if (g.length > 1) groups.push(g.sort());
    }
    return groups;
  }

  // Where n members stand around (cx, cy). A pair lines up along x = -y, which
  // runs across the screen in both views (the camera looks along x = y), so
  // neither hides behind the other.
  function talkSlots(n, cx, cy) {
    const r = n === 2 ? 0.5 : 0.45 + 0.13 * n;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 4 + (2 * Math.PI * i) / n;
      out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return out;
  }

  const api = { ZONES, STAY_MS, HOLD_MS, TALK_MS, zoneOf, step, failed, talkGroups, talkSlots };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OfficeZones = api;
})(typeof window !== 'undefined' ? window : this);
