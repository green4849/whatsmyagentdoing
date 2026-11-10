'use strict';

// Which session is this process working for? An MCP server or a hook is
// started by the agent's own process, so the two share a parent: a hook
// records its process ancestors when the session starts, and the MCP server
// looks for a registration that shares its nearest ones. When that is not
// unique (one app process hosting several sessions), the agent says hello
// itself, or passes its address.

const { execFileSync } = require('child_process');
const { address } = require('./store');

// [pid, parent, grandparent, …] up to (not including) launchd / init.
function ancestors(pid = process.ppid, table = null) {
  const parent = table || processTable();
  const out = [];
  for (let p = pid, i = 0; p > 1 && i < 12; i++) {
    out.push(p);
    const next = parent.get(p);
    if (!next || next === p) break;
    p = next;
  }
  return out;
}

function processTable() {
  const map = new Map();
  try {
    const text = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 });
    for (const line of text.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) map.set(pid, ppid);
    }
  } catch { /* no ps (Windows): identity falls back to hello */ }
  return map;
}

// The registration sharing this process's parent or grandparent; null when
// none or more than one session matches at the nearest level.
function match(sessions, mine, depth = 2) {
  for (const pid of mine.slice(0, depth)) {
    const hits = sessions.filter((s) => Array.isArray(s.ancestors) && s.ancestors.includes(pid));
    const unique = new Map(hits.map((s) => [address(s), s]));
    if (unique.size === 1) return [...unique.values()][0];
    if (unique.size > 1) return null;
  }
  return null;
}

module.exports = { ancestors, processTable, match };
