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
// file, mapping an account UUID (or any prefix of it) to a display name, or to
// a name and a #rrggbb colour for its name tags:
//   {"aaaa1111": "Max", "bbbb2222": {"label": "Personal", "color": "#3b82f6"}}
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
    .map(([k, v]) => [k, typeof v === 'string' ? { label: v } : v])
    .filter(([k, v]) => k && v && typeof v.label === 'string' && v.label.trim())
    .map(([k, v]) => [k.toLowerCase(), { label: v.label.trim(), ...(validColor(v.color) ? { color: v.color.toLowerCase() } : {}) }])
    // Longest prefix first, so a more specific entry wins.
    .sort((a, b) => b[0].length - a[0].length);
}

const validColor = (c) => typeof c === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(c);

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

class AccountIndex {
  constructor({ dir = desktopSessionsDir(), labels = process.env.WMAD_ACCOUNT_LABELS } = {}) {
    this.dir = dir;
    this.labels = readLabels(labels);
    this.files = new Map();    // metadata file -> { mtime, size, account, ids }
    this.bySession = new Map(); // transcript id -> account uuid
    this.summaries = new Map(); // current transcript id -> the app's summary of its last turn
  }

  // { label, color? } for an account uuid; unlabelled accounts show their short id.
  label(uuid) {
    const id = uuid.toLowerCase();
    const hit = this.labels.find(([prefix]) => id.startsWith(prefix));
    return hit ? hit[1] : { label: id.slice(0, 8) };
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
          let ids = [], summary = null;
          try {
            const d = JSON.parse(fs.readFileSync(file, 'utf8'));
            ids = [d.cliSessionId, ...(Array.isArray(d.priorCliSessionIds) ? d.priorCliSessionIds : [])]
              .filter((x) => typeof x === 'string' && x);
            summary = turnSummary(d);
          } catch { /* half-written; picked up on the next scan */ }
          this.files.set(file, { mtime: st.mtimeMs, size: st.size, account: account.name.toLowerCase(), ids, summary });
          changed = true;
        }
      }
    }
    for (const file of this.files.keys()) {
      if (!seen.has(file)) { this.files.delete(file); changed = true; }
    }
    if (changed) {
      this.bySession.clear();
      this.summaries.clear();
      for (const { account, ids, summary } of this.files.values()) {
        for (const id of ids) this.bySession.set(id, account);
        if (summary && ids[0]) this.summaries.set(ids[0], summary);
      }
    }
    return changed;
  }

  // The desktop app's own verdict on a session's last turn, written when the
  // turn ends: { category: 'completed' | 'review_ready' | 'blocked' | ..., detail,
  // action, forUuid } (forUuid is the assistant message it summarises).
  summary(sessionId) {
    return (sessionId && this.summaries.get(sessionId)) || null;
  }

  // { id, label, color? } for a transcript id, or null when no desktop session names it.
  lookup(sessionId) {
    const account = sessionId && this.bySession.get(sessionId);
    return account ? { id: account.slice(0, 8), ...this.label(account) } : null;
  }
}

function turnSummary(d) {
  const p = d && d.postTurnSummary;
  if (!p || typeof p !== 'object' || typeof p.status_category !== 'string') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return { category: p.status_category, detail: str(p.status_detail, 200), action: str(p.needs_action, 200),
    forUuid: str(p.summarizes_uuid || d.postTurnSummaryFor, 80) };
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

module.exports = { AccountIndex, desktopSessionsDir, readLabels, matchAccount, validColor };
