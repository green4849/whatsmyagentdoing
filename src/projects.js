'use strict';

// Project pages: your own notes for each folder in the side panel — the steps
// of the work and a memo with images. Kept on this Mac only, in
//   ~/.whatsmyagentdoing/projects/<name>-<hash>/page.json  and  images/
// (WMAD_PROJECTS_DIR moves it, for tests). A folder is keyed like the side
// panel groups it: its working directory, or "<agent>:" with none.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STATES = new Set(['todo', 'doing', 'done']);
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_PAGE = 1024 * 1024;        // page.json, memo included
const MAX_IMAGE = 10 * 1024 * 1024;  // one pasted or dropped image
const MAX_STEPS = 100;
const SLUG = /^[\p{L}\p{N}._-]{1,60}-[0-9a-f]{8}$/u;
const IMAGE_NAME = /^[a-z0-9]{6,32}\.(png|jpg|gif|webp)$/;

const defaultDir = (env = process.env) => env.WMAD_PROJECTS_DIR || path.join(os.homedir(), '.whatsmyagentdoing', 'projects');

// A readable, collision-free folder name for a key.
function slugOf(key) {
  const base = String(key).split(/[\\/]/).filter(Boolean).pop() || 'project';
  const clean = base.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|-+$/g, '').slice(0, 40) || 'project';
  return `${clean}-${crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 8)}`;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// Only what the page knows how to show is kept.
function cleanPage(key, page) {
  const steps = (Array.isArray(page && page.steps) ? page.steps : []).slice(0, MAX_STEPS).map((s, i) => ({
    id: str(s && s.id, 40) || `s${i}`,
    title: str(s && s.title, 200),
    note: str(s && s.note, 500),
    state: STATES.has(s && s.state) ? s.state : 'todo',
    at: Number.isFinite(s && s.at) ? s.at : null,
  }));
  return { key: String(key), steps, memo: str(page && page.memo, MAX_PAGE - 64 * 1024), updatedAt: Date.now() };
}

// Where a project stands, for its folder row: steps done, and the current one.
function summarize(page) {
  const steps = page.steps || [];
  const current = steps.find((s) => s.state === 'doing') || steps.find((s) => s.state !== 'done') || null;
  return {
    done: steps.filter((s) => s.state === 'done').length,
    total: steps.length,
    current: current ? current.title : null,
    memo: !!(page.memo && page.memo.replace(/<[^>]*>/g, '').trim()),
    updatedAt: page.updatedAt || null,
  };
}

class Projects {
  constructor({ dir = defaultDir() } = {}) {
    this.dir = dir;
  }

  pageFile(key) { return path.join(this.dir, slugOf(key), 'page.json'); }

  get(key) {
    try {
      const page = JSON.parse(fs.readFileSync(this.pageFile(key), 'utf8'));
      if (page && page.key === String(key)) return { ...page, slug: slugOf(key) };
    } catch {}
    return { key: String(key), steps: [], memo: '', updatedAt: null, slug: slugOf(key) };
  }

  save(key, page) {
    const clean = cleanPage(key, page);
    const file = this.pageFile(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 1));
    fs.renameSync(tmp, file);
    return { ...clean, slug: slugOf(key) };
  }

  // key -> summary, for every project that has a page.
  summaries() {
    const out = {};
    let dirs = [];
    try { dirs = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return out; }
    for (const d of dirs) {
      if (!d.isDirectory() || !SLUG.test(d.name)) continue;
      try {
        const page = JSON.parse(fs.readFileSync(path.join(this.dir, d.name, 'page.json'), 'utf8'));
        if (page && typeof page.key === 'string' && slugOf(page.key) === d.name) out[page.key] = summarize(page);
      } catch {}
    }
    return out;
  }

  // Stores an image for a project's memo; returns the URL the page links to.
  addImage(key, type, buf) {
    const ext = IMAGE_TYPES[String(type).split(';')[0].trim().toLowerCase()];
    if (!ext) throw new Error('not an image this page can show');
    if (!buf || !buf.length || buf.length > MAX_IMAGE) throw new Error('image too large');
    const slug = slugOf(key);
    const dir = path.join(this.dir, slug, 'images');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    return `/projects/${encodeURIComponent(slug)}/images/${name}`;
  }

  // The file behind /projects/<slug>/images/<name>, or null.
  imageFile(slug, name) {
    if (!SLUG.test(slug) || !IMAGE_NAME.test(name)) return null;
    const file = path.join(this.dir, slug, 'images', name);
    return fs.existsSync(file) ? { file, type: IMAGE_MIME[path.extname(name)] } : null;
  }
}

module.exports = { Projects, slugOf, cleanPage, summarize, MAX_PAGE, MAX_IMAGE };
