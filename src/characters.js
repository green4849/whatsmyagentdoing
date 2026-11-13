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
// An optional top-level "colors" gives each model its name-tag colour, whoever
// wears it: { "colors": { "mascot.glb": "#f6b8c8" } }.
// Both files are re-read when they change; the server only ever serves plain
// .glb file names from the models folder.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.glb$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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
    this.colors = new Map(); // model file name -> #rrggbb name-tag colour
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
      const colors = obj.colors && typeof obj.colors === 'object' && !Array.isArray(obj.colors) ? obj.colors : {};
      this.colors = new Map(Object.entries(colors)
        .filter(([k, v]) => MODEL_NAME.test(k) && typeof v === 'string' && HEX_COLOR.test(v))
        .map(([k, v]) => [k, v.toLowerCase()]));
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

  // The rule a session falls under: [via, key, spec] with via 'session', 'folder' or 'account'.
  match(s) {
    const id = String(s.id || '').toLowerCase();
    const cwd = s.cwd ? normPath(s.cwd) : '';
    const account = String(s.account && s.account.id || '').toLowerCase();
    let hit = id && this.rules.sessions.find(([k]) => id.startsWith(k));
    if (hit) return ['session', ...hit];
    hit = cwd && this.rules.folders.find(([k]) => cwd === k || cwd.startsWith(k === '/' ? '/' : `${k}/`));
    if (hit) return ['folder', ...hit];
    hit = account && this.rules.accounts.find(([k]) => account.startsWith(k) || k.startsWith(account));
    return hit ? ['account', ...hit] : null;
  }

  // { via, model } for the page's "Character" row: which kind of rule picked the model.
  rule(s) {
    const hit = this.match(s);
    if (!hit || this.versions.get(hit[2].model) == null) return null;
    return { via: hit[0], model: hit[2].model };
  }

  // { url, turn?, height?, color? } for a session view, or null for the stock characters.
  resolve(s) {
    const hit = this.match(s);
    if (!hit) return null;
    const { model, ...rest } = hit[2];
    const v = this.versions.get(model);
    if (v == null) return null;
    const color = this.colors.get(model);
    return { url: `/characters/${encodeURIComponent(model)}?v=${v}`, ...rest, ...(color ? { color } : {}) };
  }

  // Absolute path of a model the page asked for, or null.
  modelFile(name) {
    if (!MODEL_NAME.test(name)) return null;
    const file = path.join(this.models, name);
    return path.dirname(file) === this.models && fs.existsSync(file) ? file : null;
  }

  // ---- Editing from the page. characters.json stays the single source of truth;
  // these read it fresh, change one thing, and write it back (temp file + rename,
  // after keeping the previous copy as characters.json.bak).

  // What the page's picker shows: every model file, its name-tag colour, and the rules.
  listing() {
    this.refresh();
    let names = [];
    try { names = fs.readdirSync(this.models).filter((n) => MODEL_NAME.test(n)).sort(); } catch { /* no models folder yet */ }
    // Keys come back as the server reads them (folders as absolute paths), so the page can compare them to a session's folder.
    const show = ([key, s]) => ({ key, ...s });
    return {
      models: names.filter((n) => this.modelFile(n)).map((name) => ({ name, color: this.colors.get(name) || null })),
      rules: { folders: this.rules.folders.map(show), accounts: this.rules.accounts.map(show), sessions: this.rules.sessions.map(show) },
    };
  }

  readConfig() {
    let text = null;
    try { text = fs.readFileSync(this.file, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (text === null) return {};
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error(`characters.json is not valid JSON (${e.message}); fix it by hand first`); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('characters.json must hold an object');
    return obj;
  }

  writeConfig(obj) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    this.stamp = null; // read it again on the next refresh, even within the same millisecond
  }

  // Give a session, folder or account a model, or take its rule away when model is null.
  // scope 'session': key is the session id (rules keep its first 12 characters);
  // scope 'folder': key is the folder path; scope 'account': key is the account id.
  // clearSessions: ids of sessions whose own rule should go too (so a folder change reaches them).
  assign({ scope, key, model, clearSessions = [] }) {
    if (!['session', 'folder', 'account'].includes(scope)) throw new Error('unknown scope');
    if (typeof key !== 'string' || !key.trim() || key.length > 1000) throw new Error('bad key');
    if (model !== null && !(typeof model === 'string' && MODEL_NAME.test(model) && this.modelFile(model))) throw new Error('unknown model');
    if (!Array.isArray(clearSessions) || clearSessions.length > 200 || clearSessions.some((x) => typeof x !== 'string' || x.length > 200)) throw new Error('bad clearSessions');
    const obj = this.readConfig();
    const section = { session: 'sessions', folder: 'folders', account: 'accounts' }[scope];
    const map = obj[section] && typeof obj[section] === 'object' && !Array.isArray(obj[section]) ? obj[section] : {};
    // Which existing entries are this key (a folder can be written as ~/x, /Users/…/x or with a trailing slash).
    const id = key.trim().toLowerCase();
    const same = Object.keys(map).filter((k) => (scope === 'folder' ? normPath(k.trim()) === normPath(key.trim())
      : scope === 'session' ? id.startsWith(k.trim().toLowerCase()) && k.trim().length >= 6 : k.trim().toLowerCase() === id));
    const prev = same.length ? map[same[0]] : null;
    for (const k of same) delete map[k];
    if (model !== null) {
      let newKey = key.trim();
      if (scope === 'session') newKey = id.slice(0, 12);
      else if (scope === 'account') newKey = id;
      else if (same.length) newKey = same[0];
      else {
        const home = os.homedir().replace(/\\/g, '/');
        const p = normPath(newKey);
        newKey = p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
      }
      // Turn and height belong to the model they were tuned for.
      const keep = prev && typeof prev === 'object' && prev.model === model ? prev : null;
      map[newKey] = keep || model;
    }
    for (const sid of clearSessions) {
      const lower = String(sid).trim().toLowerCase();
      if (!lower) continue;
      const smap = obj.sessions && typeof obj.sessions === 'object' ? obj.sessions : null;
      if (!smap || smap === map) continue;
      for (const k of Object.keys(smap)) if (lower.startsWith(k.trim().toLowerCase()) && k.trim().length >= 6) delete smap[k];
    }
    obj[section] = map;
    if (!Object.keys(map).length) delete obj[section];
    this.writeConfig(obj);
    return this.listing();
  }

  // A model's name-tag colour (#rrggbb), or null to go back to the account's.
  setColor(model, color) {
    if (!(typeof model === 'string' && MODEL_NAME.test(model) && this.modelFile(model))) throw new Error('unknown model');
    if (color !== null && !(typeof color === 'string' && HEX_COLOR.test(color))) throw new Error('bad colour');
    const obj = this.readConfig();
    const colors = obj.colors && typeof obj.colors === 'object' && !Array.isArray(obj.colors) ? obj.colors : {};
    if (color === null) delete colors[model]; else colors[model] = color.toLowerCase();
    obj.colors = colors;
    if (!Object.keys(colors).length) delete obj.colors;
    this.writeConfig(obj);
    return this.listing();
  }
}

let shared = null;
const characters = () => (shared ||= new Characters());

module.exports = { Characters, characters, MODEL_NAME };
