'use strict';

// What the dashboard shows from the local hub (hub/store.js):
//   bySession  "<agent>:<id>" -> { unread, partners: [keys], notes: [{ id, dir, with, kind, at, excerpt }] }
//   notes      recent notes, oldest first: { seq, id, at, kind, from, to, excerpt } (for the flying-note motion)
//   sessions   hub members the dashboard has no log reader for, as dashboard sessions
// Read again only when one of the hub's files or folders changed.

const fs = require('fs');
const path = require('path');
const { newSession } = require('../parsers');
const { address, keyOf } = require('./store');

const RECENT_MS = 24 * 3600e3;
const PER_SESSION = 6;
const STATUS = { working: 'thinking', waiting: 'waiting', done: 'done', failed: 'error', idle: 'idle' };

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const excerpt = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > 80 ? s.slice(0, 79) + '…' : s; };

class HubView {
  // known: agents whose sessions come from their own logs (their hub rows only add notes).
  constructor(store, { known = new Set() } = {}) {
    this.store = store;
    this.known = known;
    this.stamp = '';
    this.value = { bySession: new Map(), notes: [], sessions: [] };
  }

  get(now = Date.now(), sinceMs = now - RECENT_MS) {
    const d = this.store.dir;
    const stamp = ['messages.jsonl', 'sessions.jsonl', 'read', 'status'].map((f) => mtime(path.join(d, f))).join(':') + `:${Math.floor(sinceMs / 60000)}`;
    if (stamp === this.stamp) return this.value;
    this.stamp = stamp;
    this.value = this.build(now, sinceMs);
    return this.value;
  }

  build(now, sinceMs) {
    const s = this.store;
    const members = s.sessions();
    const recent = s.messages().filter((m) => m.at >= now - RECENT_MS && m.from && m.to);
    const bySession = new Map();
    const entry = (k) => { let e = bySession.get(k); if (!e) { e = { unread: 0, partners: new Set(), notes: [] }; bySession.set(k, e); } return e; };
    const seen = new Map();
    const cursor = (a) => {
      const k = address(a);
      if (!seen.has(k)) seen.set(k, s.readJson(path.join(s.dir, 'read', `${keyOf(a)}.json`), { seq: 0 }).seq || 0);
      return seen.get(k);
    };
    for (const m of recent) {
      const from = address(m.from), to = address(m.to);
      const note = { id: m.id, kind: m.kind, at: m.at, excerpt: excerpt(m.body) };
      const a = entry(from), b = entry(to);
      a.partners.add(to); b.partners.add(from);
      a.notes.push({ ...note, dir: 'out', with: to });
      b.notes.push({ ...note, dir: 'in', with: from });
      if (m.seq > cursor(m.to)) b.unread += 1;
    }
    for (const e of bySession.values()) {
      e.partners = [...e.partners];
      e.notes = e.notes.slice(-PER_SESSION).reverse();
    }
    const notes = recent.slice(-30).map((m) => ({ seq: m.seq, id: m.id, at: m.at, kind: m.kind, from: address(m.from), to: address(m.to), excerpt: excerpt(m.body) }));

    // Agents with no log reader appear from what they report to the hub.
    const sessions = [];
    for (const r of members) {
      if (this.known.has(r.agent)) continue;
      const last = Math.max(r.at || 0, (r.status && r.status.at) || 0);
      if (last < sinceMs) continue;
      const x = newSession(r.agent, r.session, null);
      const st = r.status ? r.status.state : 'idle';
      x.status = STATUS[st] || 'idle';
      if (x.status === 'thinking' && r.status.activity) x.status = 'tool';
      x.activity = r.status ? r.status.activity : null;
      if (x.status === 'error') x.error = x.activity || null;
      x.title = r.title || null;
      x.cwd = r.cwd || null;
      x.startedAt = r.at || null;
      x.lastEventAt = last;
      x.explicitLifecycle = true;
      x.source = 'hub';
      sessions.push(x);
    }
    return { bySession, notes, sessions };
  }
}

module.exports = { HubView, RECENT_MS };
