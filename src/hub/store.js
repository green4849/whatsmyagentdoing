'use strict';

// The local hub: one folder on this Mac where any coding agent can say who it
// is, what it is working on, and hand work to another agent. It is not tied
// to an agent: Claude Code, Codex, Gemini CLI or anything that can run an MCP
// server connects the same way (hub/mcp.js), and agents with hooks can also
// join without being asked (hub/hook.js). No daemon: each session runs its own
// small process and they meet in files.
//
//   sessions.jsonl   a line per hello: { agent, session, title, cwd, project, ancestors, via, at }
//   messages.jsonl   a line per note, append only: { seq, id, at, from, to, kind, replyTo, depth, body }
//   status/<key>.json   what a session says it is doing: { state, activity, at }
//   read/<key>.json     { seq } — the last note this session has seen
//   turn/<key>.json     { startedAt, blocks } — for the end-of-turn hook
//
// An address is "<agent>:<session>", e.g. "codex:01a1aa2b-…" or
// "my-agent:h-3f9c…". Nothing here leaves this machine.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AGENT = /^[a-z][a-z0-9-]{1,31}$/;
const SESSION_ID = /^[A-Za-z0-9_.-]{4,128}$/;
const KINDS = new Set(['task', 'reply', 'note']);
const STATES = new Set(['working', 'waiting', 'done', 'failed', 'idle']);
const MAX_BODY = 8 * 1024;
const KEEP_MS = 7 * 86400e3;
const PER_MINUTE = 5;     // notes from one session to another
const MAX_DEPTH = 10;     // reply chain length

// Things that look like credentials; a note with one is refused.
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,}|(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S{6,})/i;

const dirOf = (env = process.env) => env.WMAD_HUB_DIR || path.join(os.homedir(), '.whatsmyagentdoing', 'hub');

function parseAddress(a) {
  const m = String(a || '').trim().match(/^([a-z][a-z0-9-]{1,31}):(.+)$/);
  if (!m || !SESSION_ID.test(m[2])) return null;
  return { agent: m[1], session: m[2] };
}
const address = (x) => `${x.agent}:${x.session}`;
const keyOf = (x) => `${x.agent}-${x.session}`;

// The project a folder belongs to: the nearest parent with .git, else the folder.
function projectOf(cwd) {
  if (!cwd) return null;
  const dir = path.resolve(String(cwd));
  for (let d = dir; ; d = path.dirname(d)) {
    try { if (fs.existsSync(path.join(d, '.git'))) return { root: d, name: path.basename(d) }; } catch {}
    if (path.dirname(d) === d) break;
  }
  return { root: dir, name: path.basename(dir) };
}

const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

class HubStore {
  constructor({ dir = dirOf(), now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
    this.messagesFile = path.join(dir, 'messages.jsonl');
    this.sessionsFile = path.join(dir, 'sessions.jsonl');
  }

  ensure() {
    for (const d of ['', 'read', 'turn', 'status']) fs.mkdirSync(path.join(this.dir, d), { recursive: true, mode: 0o700 });
  }

  // A short exclusive section across processes: an O_EXCL lock file, stale after 10 s.
  locked(fn) {
    this.ensure();
    const lock = path.join(this.dir, '.lock');
    const until = Date.now() + 5000;
    for (;;) {
      try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.unlinkSync(lock); continue; } } catch { continue; }
        if (Date.now() > until) throw new Error('hub: mailbox is busy, try again');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
  }

  readLines(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* half-written line */ }
    }
    return out;
  }

  writeJson(file, value) {
    this.ensure();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

  // ------------------------------------------------------------ sessions

  // "I am here": from an agent's hello tool call or a session-start hook.
  // An agent that does not know its own session id gets one.
  register({ agent, session = null, title = null, cwd = null, ancestors = [], via = 'mcp' }) {
    agent = String(agent || '').toLowerCase();
    if (!AGENT.test(agent)) throw new Error('hub: agent must be a short lowercase name like "codex" or "gemini"');
    if (session != null && !SESSION_ID.test(String(session))) throw new Error('hub: bad session id');
    const row = {
      agent, session: session ? String(session) : `h-${crypto.randomBytes(6).toString('hex')}`,
      title: title ? cut(title, 80) : null, cwd: cwd ? String(cwd) : null, project: projectOf(cwd),
      ancestors: (ancestors || []).filter(Number.isInteger).slice(0, 12), via, at: this.now(),
    };
    // Keep what an earlier hello said when a hook re-registers without it.
    const prev = this.session(row);
    if (prev) {
      if (!row.title) row.title = prev.title;
      if (!row.cwd) { row.cwd = prev.cwd; row.project = prev.project; }
      if (!row.ancestors.length) row.ancestors = prev.ancestors || [];
    }
    this.locked(() => fs.appendFileSync(this.sessionsFile, JSON.stringify(row) + '\n', { mode: 0o600 }));
    return row;
  }

  // Latest registration per session, newest first, with its own status report.
  sessions() {
    const by = new Map();
    for (const r of this.readLines(this.sessionsFile)) {
      if (!r || !AGENT.test(r.agent || '') || !SESSION_ID.test(r.session || '')) continue;
      const prev = by.get(address(r));
      if (!prev || r.at >= prev.at) by.set(address(r), r);
    }
    return [...by.values()].map((r) => ({ ...r, status: this.status(r) })).sort((a, b) => b.at - a.at);
  }

  session(me) { return this.sessions().find((r) => address(r) === address(me)) || null; }

  // ------------------------------------------------------------ status

  // What a session says it is doing; the dashboard uses it for agents it has no log reader for.
  setStatus(me, { state, activity = null }) {
    if (!STATES.has(state)) throw new Error(`hub: state must be one of ${[...STATES].join(', ')}`);
    const row = { state, activity: activity ? cut(activity, 120) : null, at: this.now() };
    this.writeJson(path.join(this.dir, 'status', `${keyOf(me)}.json`), row);
    return row;
  }

  status(me) { return this.readJson(path.join(this.dir, 'status', `${keyOf(me)}.json`), null); }

  // ------------------------------------------------------------ notes

  messages() { return this.readLines(this.messagesFile); }

  send({ from, to, body, kind = 'task', replyTo = null }) {
    const f = typeof from === 'string' ? parseAddress(from) : from;
    const t = typeof to === 'string' ? parseAddress(to) : to;
    if (!f) throw new Error('hub: unknown sender; say hello first');
    if (!t) throw new Error('hub: "to" must be an address like codex:<session> (see hub_who)');
    if (address(f) === address(t)) throw new Error('hub: cannot send a note to yourself');
    if (!KINDS.has(kind)) throw new Error('hub: kind must be task, reply or note');
    body = String(body || '').trim();
    if (!body) throw new Error('hub: empty note');
    if (Buffer.byteLength(body) > MAX_BODY) throw new Error(`hub: note is over ${MAX_BODY / 1024} KB; put long material in a file and send its path`);
    if (SECRET.test(body)) throw new Error('hub: the note looks like it contains a password, key or token; leave it out');
    return this.locked(() => {
      const all = this.prune(this.messages());
      const now = this.now();
      const recent = all.filter((m) => address(m.from) === address(f) && address(m.to) === address(t) && now - m.at < 60000);
      if (recent.length >= PER_MINUTE) throw new Error(`hub: at most ${PER_MINUTE} notes a minute to one session`);
      let depth = 0;
      if (replyTo) {
        const parent = all.find((m) => m.id === replyTo);
        if (!parent) throw new Error('hub: reply_to names no note');
        depth = (parent.depth || 0) + 1;
        if (depth > MAX_DEPTH) throw new Error(`hub: reply chain is over ${MAX_DEPTH} notes; ask the user before going on`);
      }
      const last = this.readJson(path.join(this.dir, 'seq.json'), { seq: 0 }).seq || 0;
      const seq = Math.max(last, all.length ? all[all.length - 1].seq : 0) + 1;
      const note = { seq, id: crypto.randomBytes(6).toString('hex'), at: now, from: f, to: t, kind, replyTo: replyTo || null, depth, body };
      fs.appendFileSync(this.messagesFile, JSON.stringify(note) + '\n', { mode: 0o600 });
      this.writeJson(path.join(this.dir, 'seq.json'), { seq });
      return note;
    });
  }

  // Drops notes older than a week (rewrites the file; seq numbers keep counting).
  prune(all) {
    const cutoff = this.now() - KEEP_MS;
    if (!all.length || all[0].at >= cutoff) return all;
    const keep = all.filter((m) => m.at >= cutoff);
    fs.writeFileSync(this.messagesFile, keep.map((m) => JSON.stringify(m) + '\n').join(''), { mode: 0o600 });
    return keep;
  }

  // Notes to `me` not seen yet; with take, marks them seen.
  unread(me, { take = false } = {}) {
    const file = path.join(this.dir, 'read', `${keyOf(me)}.json`);
    const seen = this.readJson(file, { seq: 0 }).seq || 0;
    const mine = this.messages().filter((m) => m.seq > seen && address(m.to) === address(me));
    if (take && mine.length) this.writeJson(file, { seq: mine[mine.length - 1].seq });
    return mine;
  }

  // ------------------------------------------------------------ turns (end-of-turn hook)

  turn(me) { return this.readJson(path.join(this.dir, 'turn', `${keyOf(me)}.json`), { startedAt: 0, blocks: 0 }); }
  setTurn(me, t) { this.writeJson(path.join(this.dir, 'turn', `${keyOf(me)}.json`), t); }
}

module.exports = { HubStore, parseAddress, address, keyOf, projectOf, dirOf, SECRET, MAX_BODY, PER_MINUTE, MAX_DEPTH, STATES };
