'use strict';

// Names for hub sessions that joined through a hook, which only knows the
// session id. Optional per-agent lookups in files the apps already keep; an
// agent without one simply shows the title it gave in hub_hello (or none).
//
//   claude  the desktop app's session metadata (title per cliSessionId)
//   codex   ~/.codex/session_index.jsonl (thread_name per id)
//
// Each source is re-read only when its files change.

const fs = require('fs');
const os = require('os');
const path = require('path');

function claudeTitles(dir) {
  const out = new Map();
  const walk = (d, depth) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (typeof j.title !== 'string' || !j.title) continue;
          for (const id of [j.cliSessionId, ...(Array.isArray(j.priorCliSessionIds) ? j.priorCliSessionIds : [])]) if (typeof id === 'string') out.set(id, j.title);
        } catch {}
      }
    }
  };
  walk(dir, 0);
  return out;
}

function codexTitles(file) {
  const out = new Map();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    try { const d = JSON.parse(line); if (d.id && d.thread_name) out.set(d.id, d.thread_name); } catch {}
  }
  return out;
}

// Newest change time in a folder tree two levels down (cheap enough per call).
function stamp(target, depth = 2) {
  let st; try { st = fs.statSync(target); } catch { return 0; }
  if (!st.isDirectory() || depth === 0) return st.mtimeMs;
  let m = st.mtimeMs;
  try { for (const e of fs.readdirSync(target)) m = Math.max(m, stamp(path.join(target, e), depth - 1)); } catch {}
  return m;
}

class Titles {
  constructor({ home = os.homedir(), claudeDir = null, codexIndex = null } = {}) {
    if (!claudeDir) {
      const { desktopSessionsDir } = require('../accounts');
      claudeDir = desktopSessionsDir(process.env, home, process.platform);
    }
    this.sources = {
      claude: { target: claudeDir, read: () => claudeTitles(claudeDir), at: -1, map: new Map() },
      codex: { target: codexIndex || path.join(home, '.codex', 'session_index.jsonl'), read: () => codexTitles(codexIndex || path.join(home, '.codex', 'session_index.jsonl')), at: -1, map: new Map(), depth: 0 },
    };
  }

  title(agent, session) {
    const src = this.sources[agent];
    if (!src) return null;
    const at = stamp(src.target, src.depth ?? 2);
    if (at !== src.at) { src.at = at; src.map = src.read(); }
    return src.map.get(session) || null;
  }
}

module.exports = { Titles };
