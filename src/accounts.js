'use strict';

// Which Claude account ran each Claude Code session.
//
// Transcripts under ~/.claude/projects carry no account information, and the
// Claude desktop app writes every signed-in account's Code sessions there. The
// app does keep one metadata file per session under
//   <app data>/claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json
// whose cliSessionId (and priorCliSessionIds) are the transcript file names.
// That file layout is the app's own and undocumented: when it is missing or
// changes, sessions simply have no account.
//
// Labels come from WMAD_ACCOUNT_LABELS, either inline JSON or a path to a JSON
// file, mapping an account UUID (or any prefix of it) to a display name:
//   {"aaaa1111": "Max", "bbbb2222": "Personal"}
// Keep that mapping out of the repository.

const fs = require('fs');
const os = require('os');
const path = require('path');

function desktopSessionsDir(env = process.env, home = os.homedir(), platform = process.platform) {
  if (env.WMAD_DESKTOP_SESSIONS_DIR) return env.WMAD_DESKTOP_SESSIONS_DIR;
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return path.join(base, 'Claude', 'claude-code-sessions');
}

function readLabels(raw) {
  if (!raw) return [];
  let text = String(raw).trim();
  if (!text.startsWith('{')) {
    try { text = fs.readFileSync(text, 'utf8'); } catch (e) { throw new Error(`WMAD_ACCOUNT_LABELS: cannot read ${raw}: ${e.message}`); }
  }
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('WMAD_ACCOUNT_LABELS must be a JSON object of {"<account uuid or prefix>": "<label>"}'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('WMAD_ACCOUNT_LABELS must be a JSON object');
  return Object.entries(obj)
    .filter(([k, v]) => k && typeof v === 'string' && v.trim())
    .map(([k, v]) => [k.toLowerCase(), v.trim()])
    // Longest prefix first, so a more specific entry wins.
    .sort((a, b) => b[0].length - a[0].length);
}

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

class AccountIndex {
  constructor({ dir = desktopSessionsDir(), labels = process.env.WMAD_ACCOUNT_LABELS } = {}) {
    this.dir = dir;
    this.labels = readLabels(labels);
    this.files = new Map();    // metadata file -> { mtime, size, account, ids }
    this.bySession = new Map(); // transcript id -> account uuid
  }

  label(uuid) {
    const id = uuid.toLowerCase();
    const hit = this.labels.find(([prefix]) => id.startsWith(prefix));
    return hit ? hit[1] : id.slice(0, 8);
  }

  // Rescans the metadata files; returns true when the mapping changed.
  refresh() {
    const seen = new Set();
    let changed = false;
    for (const account of list(this.dir)) {
      if (!account.isDirectory() || !UUID_DIR.test(account.name)) continue;
      const adir = path.join(this.dir, account.name);
      for (const org of list(adir)) {
        if (!org.isDirectory()) continue;
        const odir = path.join(adir, org.name);
        for (const f of list(odir)) {
          if (!f.isFile() || !/^local_.*\.json$/.test(f.name)) continue;
          const file = path.join(odir, f.name);
          seen.add(file);
          let st;
          try { st = fs.statSync(file); } catch { continue; }
          const old = this.files.get(file);
          if (old && old.mtime === st.mtimeMs && old.size === st.size) continue;
          let ids = [];
          try {
            const d = JSON.parse(fs.readFileSync(file, 'utf8'));
            ids = [d.cliSessionId, ...(Array.isArray(d.priorCliSessionIds) ? d.priorCliSessionIds : [])]
              .filter((x) => typeof x === 'string' && x);
          } catch { /* half-written; picked up on the next scan */ }
          this.files.set(file, { mtime: st.mtimeMs, size: st.size, account: account.name.toLowerCase(), ids });
          changed = true;
        }
      }
    }
    for (const file of this.files.keys()) {
      if (!seen.has(file)) { this.files.delete(file); changed = true; }
    }
    if (changed) {
      this.bySession.clear();
      for (const { account, ids } of this.files.values()) for (const id of ids) this.bySession.set(id, account);
    }
    return changed;
  }

  // { id, label } for a transcript id, or null when no desktop session names it.
  lookup(sessionId) {
    const account = sessionId && this.bySession.get(sessionId);
    return account ? { id: account.slice(0, 8), label: this.label(account) } : null;
  }
}

function list(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// ?account=<label | uuid prefix | none>; none matches sessions with no known account.
function matchAccount(filter, account) {
  if (!filter) return true;
  const f = String(filter).trim().toLowerCase();
  if (!f) return true;
  if (f === 'none') return !account;
  if (!account) return false;
  // account.id is the UUID's first 8 characters; a longer filter is compared on those.
  return account.label.toLowerCase() === f || (f.length >= 4 && account.id.startsWith(f.slice(0, 8)));
}

module.exports = { AccountIndex, desktopSessionsDir, readLabels, matchAccount };
