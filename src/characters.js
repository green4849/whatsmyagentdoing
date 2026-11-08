'use strict';

// Custom 3D characters, picked per folder, account or session.
//
// Models live outside the repository, in ~/.whatsmyagentdoing/models/*.glb,
// and ~/.whatsmyagentdoing/characters.json says who wears which:
//   {
//     "folders":  { "~/Documents/work": "mascot.glb" },
//     "accounts": { "118d2a10": { "model": "cat.glb", "turn": 180, "height": 1.1 } },
//     "sessions": { "3f2a9c": "mascot.glb" }
//   }
// A folder matches its own sessions and every session under it (the deepest
// folder wins); accounts and sessions match by id prefix. Session beats
// folder beats account. "turn" rotates a model that faces the wrong way
// (degrees), "height" scales it against the stock characters (1 = same).
// Both files are re-read when they change; the server only ever serves plain
// .glb file names from the models folder.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.glb$/;

function baseDir(env = process.env) {
  return env.WMAD_CHARACTERS_DIR || path.join(os.homedir(), '.whatsmyagentdoing');
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);
const normPath = (p) => path.resolve(expandHome(String(p))).replace(/\\/g, '/').replace(/\/+$/, '');

function spec(v) {
  const o = typeof v === 'string' ? { model: v } : v;
  if (!o || typeof o !== 'object' || typeof o.model !== 'string' || !MODEL_NAME.test(o.model)) return null;
  const out = { model: o.model };
  if (Number.isFinite(o.turn)) out.turn = o.turn % 360;
  if (Number.isFinite(o.height) && o.height >= 0.3 && o.height <= 3) out.height = o.height;
  return out;
}

const entries = (obj, key) => Object.entries(obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {})
  .map(([k, v]) => [key(k), spec(v)])
  .filter(([k, v]) => k && v)
  .sort((a, b) => b[0].length - a[0].length); // most specific first

class Characters {
  constructor({ dir = baseDir() } = {}) {
    this.dir = dir;
    this.models = path.join(dir, 'models');
    this.file = path.join(dir, 'characters.json');
    this.stamp = null;
    this.rules = { folders: [], accounts: [], sessions: [] };
    this.versions = new Map(); // model file name -> mtime, or null when missing
    this.warned = new Set();
  }

  // Re-reads characters.json and the model files' times when anything changed.
  refresh() {
    let stamp = null;
    try { stamp = fs.statSync(this.file).mtimeMs; } catch { /* no config: no custom characters */ }
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      let obj = {};
      if (stamp !== null) {
        try { obj = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
        catch (e) { this.warn(`characters.json: ${e.message}`); }
      }
      this.rules = {
        folders: entries(obj.folders, (k) => (k.trim() ? normPath(k.trim()) : '')),
        accounts: entries(obj.accounts, (k) => k.trim().toLowerCase()),
        sessions: entries(obj.sessions, (k) => k.trim().toLowerCase()),
      };
    }
    this.versions.clear();
    for (const list of Object.values(this.rules)) {
      for (const [, s] of list) {
        if (this.versions.has(s.model)) continue;
        let v = null;
        try { v = Math.round(fs.statSync(path.join(this.models, s.model)).mtimeMs); }
        catch { this.warn(`character model not found: ${path.join(this.models, s.model)}`); }
        this.versions.set(s.model, v);
      }
    }
    return this;
  }

  warn(msg) {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    console.warn(msg);
  }

  // { url, turn?, height? } for a session view, or null for the stock characters.
  resolve(s) {
    const id = String(s.id || '').toLowerCase();
    const cwd = s.cwd ? normPath(s.cwd) : '';
    const account = String(s.account && s.account.id || '').toLowerCase();
    const hit = (id && this.rules.sessions.find(([k]) => id.startsWith(k)))
      || (cwd && this.rules.folders.find(([k]) => cwd === k || cwd.startsWith(k === '/' ? '/' : `${k}/`)))
      || (account && this.rules.accounts.find(([k]) => account.startsWith(k) || k.startsWith(account)));
    if (!hit) return null;
    const { model, ...rest } = hit[1];
    const v = this.versions.get(model);
    if (v == null) return null;
    return { url: `/characters/${encodeURIComponent(model)}?v=${v}`, ...rest };
  }

  // Absolute path of a model the page asked for, or null.
  modelFile(name) {
    if (!MODEL_NAME.test(name)) return null;
    const file = path.join(this.models, name);
    return path.dirname(file) === this.models && fs.existsSync(file) ? file : null;
  }
}

let shared = null;
const characters = () => (shared ||= new Characters());

module.exports = { Characters, characters, MODEL_NAME };
