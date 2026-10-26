// server/plugins/engineOverlay.js — a plugin that replaces files of the engine itself ("shadow root").
//
// Why: some workshop packs are not data or UI, they are a fork of the engine (a mod that rewrites Match, the sim or
// the lobby). The plugin system cannot express that — a plugin folder is read-only content, and every path it may
// serve is its own (/p/<id>/…), never `server/` or `shared/`. Rather than merging such a fork into the source tree
// by hand, this module builds a SECOND install root on top of the real one:
//
//   .shadow/
//     server/   real directory: a link to every engine file, plus the plugin's replacements
//     shared/   (same)
//     public/   (same)
//     <other>   a link to the engine's entry (data/, plugins/, node_modules/ …)
//
// and the server is started from `.shadow/server/index.js`. Every path the engine derives comes from
// `import.meta.url` (`http/config.js` ROOT, `match/host/childHost.js` INSTALL_ROOT), so a shadow root is picked up
// with no code change: the match host forks inside it too, and `plugins/` is a link back to the real folder, so the
// plugin that built the overlay is still the same plugin.
//
// Who may: one plugin, named explicitly by the owner in `plugins/config.json`:
//
//   { "overlay": "<plugin id>" }
//
// It must be `class: "trusted"` (a plugin that may run server code) and list what it replaces:
//
//   "code": { "engine": ["server/lobby.js", "shared/hesx.js", …] }
//
// The list is explicit on purpose: a recursive copy of the plugin folder would silently overwrite files nobody
// reviewed. Nothing is enabled by default, `SP_OVERLAY=off` turns the whole thing off, and deleting `.shadow/` (or
// clearing `overlay`) returns the next start to the untouched engine.
//
// (i18n-ignore-file: the refusals here are owner-facing diagnostics, 中文 · English, as server/mods/import.js.)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

/** The shadow root built inside the install root. */
export const OVERLAY_DIR = '.shadow';
/** The build stamp inside it: which plugin, which files, when. */
export const OVERLAY_STAMP = '.overlay.json';
/** The directories an overlay may touch. Everything else is linked whole. */
export const OVERLAY_DIRS = Object.freeze(['server', 'shared', 'public']);
/** The env var the child process sees, so it does not spawn itself again. */
export const OVERLAY_ACTIVE = 'SP_OVERLAY_ACTIVE';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** A path inside the install root, or null (no absolute paths, no `..`, no empty segments). */
export function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return null;
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return null;
  const parts = norm.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  if (!OVERLAY_DIRS.includes(parts[0])) return null;
  return parts.join('/');
}

/**
 * Which plugin (if any) is asked to be the engine overlay.
 * @param {{ root: string, pluginsDir: string }} opts
 * @returns {{ id: string, dir: string, files: string[], why?: undefined } | { why: string } | null}
 */
export function resolveEngineOverlay({ root, pluginsDir }) {
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'config.json'), 'utf8')); } catch { return null; }
  const id = isObj(config) && typeof config.overlay === 'string' ? config.overlay.trim() : '';
  if (!id) return null;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) return { why: `overlay: "${id}" is not a plugin id` };
  const dir = path.join(pluginsDir, id);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch {
    return { why: `overlay: ${id} has no readable plugin.json` };
  }
  if (manifest?.class !== 'trusted') return { why: `overlay: ${id} is ${manifest?.class || 'not a plugin'}, not a trusted one` };
  const list = manifest?.code?.engine;
  if (!Array.isArray(list) || !list.length) return { why: `overlay: ${id} declares no code.engine` };
  const files = [];
  for (const raw of list) {
    const rel = safeRel(raw);
    if (!rel) return { why: `overlay: ${id} names "${String(raw).slice(0, 80)}" — only paths under ${OVERLAY_DIRS.join('/')}/ are allowed` };
    const src = path.join(dir, 'engine', ...rel.split('/'));
    if (!fs.existsSync(src)) return { why: `overlay: ${id} declares ${rel} but engine/${rel} does not exist` };
    files.push(rel);
  }
  return { id, dir: path.join(dir, 'engine'), files };
}

/** A fingerprint of the current overlay input: the plugin's files and the engine's top-level shape. */
export function overlayHash({ root, overlay }) {
  const h = createHash('sha256');
  h.update(overlay.id);
  h.update('\0');
  for (const rel of [...overlay.files].sort()) {
    h.update(rel);
    h.update('\0');
    try { h.update(sha(fs.readFileSync(path.join(overlay.dir, ...rel.split('/'))))); } catch { h.update('missing'); }
    h.update('\0');
  }
  try { h.update(String(fs.statSync(root).mtimeMs)); } catch { /* the root is gone; the build will fail loudly */ }
  return h.digest('hex');
}

/** Is `.shadow/` already the build of this exact plugin input? */
export function shadowCurrent({ root, overlay }) {
  const stampPath = path.join(root, OVERLAY_DIR, OVERLAY_STAMP);
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    return stamp.plugin === overlay.id && stamp.hash === overlayHash({ root, overlay });
  } catch { return false; }
}

/**
 * Link `src` at `dst`; a directory that cannot be symbolically linked (no privilege on Windows) becomes a junction,
 * and a file that cannot be linked is copied. Returns 'link' | 'junction' | 'copy'.
 */
function linkOrCopy(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    try { fs.symlinkSync(src, dst, 'dir'); return 'link'; } catch { /* try a junction */ }
    fs.symlinkSync(src, dst, 'junction');
    return 'junction';
  }
  try { fs.symlinkSync(src, dst, 'file'); return 'link'; } catch { fs.copyFileSync(src, dst); return 'copy'; }
}

/**
 * Create the folder an overlay file lives in, inside the shadow root only.
 *
 * A level that is still a link to the engine's folder (nothing above it was touched yet) becomes a REAL folder whose
 * children are links to the same files — that is what lets one file (`public/css/screens/x.css`) be replaced while
 * every sibling stays the engine's.
 */
function ensureDir(base, relDir, srcBase) {
  let cur = base;
  let src = srcBase;
  for (const part of relDir.split('/').filter(Boolean)) {
    cur = path.join(cur, part);
    src = path.join(src, part);
    const st = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (!st) { fs.mkdirSync(cur); continue; }
    if (st.isDirectory()) continue;
    if (st.isSymbolicLink()) {
      fs.rmSync(cur, { force: true });
      fs.mkdirSync(cur);
      if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
        for (const child of fs.readdirSync(src)) linkOrCopy(path.join(src, child), path.join(cur, child));
      }
      continue;
    }
    throw new Error(`${cur} is not a directory`);
  }
  return cur;
}

/**
 * Build (or rebuild) `.shadow/` for one overlay. Idempotent: an unchanged input is left alone.
 * @param {{ root: string, overlay: { id: string, dir: string, files: string[] }, force?: boolean }} opts
 * @returns {{ dir: string, built: boolean, files: number, links: number, copies: number }}
 */
export function buildShadow({ root, overlay, force = false }) {
  const shadow = path.join(root, OVERLAY_DIR);
  if (!force && shadowCurrent({ root, overlay })) return { dir: shadow, built: false, files: overlay.files.length, links: 0, copies: 0 };
  fs.rmSync(shadow, { recursive: true, force: true });
  fs.mkdirSync(shadow);

  const touched = new Set(overlay.files.map((rel) => rel.split('/')[0]));
  let links = 0;
  let copies = 0;
  const counts = (how) => { if (how === 'copy') copies += 1; else links += 1; };

  // Every top-level entry of the install root: a whole link, except the folders the overlay writes into.
  for (const name of fs.readdirSync(root)) {
    if (name === OVERLAY_DIR) continue;
    const src = path.join(root, name);
    const dst = path.join(shadow, name);
    if (!touched.has(name)) { counts(linkOrCopy(src, dst)); continue; }
    // A touched folder: a real directory whose children are links, so an overlay file can replace one.
    fs.mkdirSync(dst);
    if (fs.statSync(src).isDirectory()) {
      for (const child of fs.readdirSync(src)) counts(linkOrCopy(path.join(src, child), path.join(dst, child)));
    }
  }
  // The overlay files themselves (a replaced file, or a file the engine does not have at all).
  for (const rel of overlay.files) {
    const src = path.join(overlay.dir, ...rel.split('/'));
    const parts = rel.split('/');
    const dir = ensureDir(path.join(shadow, parts[0]), parts.slice(1, -1).join('/'), path.join(root, parts[0]));
    const dst = path.join(dir, parts[parts.length - 1]);
    fs.rmSync(dst, { recursive: true, force: true });
    counts(linkOrCopy(src, dst));
  }
  fs.writeFileSync(path.join(shadow, OVERLAY_STAMP), `${JSON.stringify({
    plugin: overlay.id, hash: overlayHash({ root, overlay }), builtAt: new Date().toISOString(), files: overlay.files.length,
  }, null, 2)}\n`);
  return { dir: shadow, built: true, files: overlay.files.length, links, copies };
}

/**
 * The entry point of a finished shadow root, or null when this install should start normally.
 * `SP_OVERLAY=off` disables it; the child (`SP_OVERLAY_ACTIVE=1`) always gets null, so it cannot spawn itself.
 */
export function shadowEntry({ root, pluginsDir, env = process.env } = {}) {
  if (String(env.SP_OVERLAY || '').toLowerCase() === 'off') return null;
  if (env[OVERLAY_ACTIVE] === '1') return null;
  const overlay = resolveEngineOverlay({ root, pluginsDir });
  if (!overlay || overlay.why) return null;
  const built = buildShadow({ root, overlay });
  const entry = path.join(built.dir, 'server', 'index.js');
  return fs.existsSync(entry) ? { entry, plugin: overlay.id, built } : null;
}

/** The execArgv the shadow child needs so its symlinks are not realpath-ed back to the engine. */
export const PRESERVE_SYMLINK_FLAGS = Object.freeze(['--preserve-symlinks', '--preserve-symlinks-main']);

/** execArgv to prepend to the shadow entry (pure, so a test pins the exact form). */
export function shadowArgv() { return [...PRESERVE_SYMLINK_FLAGS]; }

/** The child's NODE_OPTIONS: inherit the parent's, then append the preserve-symlinks flags for grandchildren. */
export function shadowNodeOptions(env = process.env) {
  return [String(env.NODE_OPTIONS || '').trim(), ...PRESERVE_SYMLINK_FLAGS].filter(Boolean).join(' ');
}

/**
 * Start the shadow root as a child process and mirror its exit, so `node server/index.js` stays the one command.
 * The child gets `SP_OVERLAY_ACTIVE=1` and therefore never spawns a second one.
 *
 * `--preserve-symlinks[-main]` is load-bearing: the shadow root IS symlinks, and Node's default
 * realpath would resolve them back into the engine folder — `http/config.js` (a link) would report the
 * ENGINE's ROOT, and the whole runtime (Match, views, lobby) would silently run the untouched engine
 * while only the static files came from the overlay. The flags keep every module at its `.shadow/` path.
 * `NODE_OPTIONS` carries them into the grandchildren the child forks (the match host workers).
 * @param {{ entry: string, argv?: string[], env?: Record<string,string|undefined> }} opts
 */
export function spawnShadow({ entry, argv = process.argv.slice(2), env = process.env }) {
  const nodeOptions = shadowNodeOptions(env);
  const child = spawn(process.execPath, [...shadowArgv(), entry, ...argv], {
    stdio: 'inherit',
    env: { ...env, [OVERLAY_ACTIVE]: '1', NODE_OPTIONS: nodeOptions },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { try { child.kill(signal); } catch { /* already gone */ } });
  }
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  return child;
}
