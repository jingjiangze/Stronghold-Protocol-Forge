// server/mods/assetPacks.js — the mod manager's asset layers: operator skins and the official battle effects.
//
// Why these are not plugins: a cosmetic plugin may only name files inside its own folder — an absolute URL is
// refused by shared/plugins/visual.js (readAssetOverlay) and prepareVisualDoc, and server/http/static.js serves
// only `/p/<id>/<hash8>/<path>`. The official skin and effect files live on the asset CDN and are reached the same
// way as every other official file: a `/assets/…` path with no local file is 302'd by server/http/asset-jump.js to
// the current mirror. So the mod manager manages the two *manifests* the client reads:
//
//   * skins — data/assets.json's top-level `skins` (the release manifest's shape) rewritten into
//     data/local-assets.json `chars[charId].skins[skinId]`, the local-art layer mergeLocalChars merges into the
//     served /data/assets.json (docs/ASSETS.md "Official operator art"). No artwork is downloaded.
//   * effects — data/local-fx.json, the file list public/js/render/vfx/available.js fetches. The prefabs, textures
//     and meshes themselves stay on the CDN.
//
// Neither layer is per room: both files are server-wide, like the official assets. A skin is drawn only when a
// player picks it; the effect layer keeps its own setting and falls back to the procedural fx.
//
//   node tools/mod.mjs assets status
//   node tools/mod.mjs assets skins-sync [--dry-run] [--force]
//   node tools/mod.mjs assets skins-clear
//   node tools/mod.mjs assets fx-install [--url=…] [--verify=6] [--dry-run]
//   node tools/mod.mjs assets fx-verify  [--samples=6]
//
// The HTTP surface lives in server/mods/index.js (`/mod/assets/…`); the /mod page has the same buttons.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ASSETS_FILE = 'assets.json';
export const LOCAL_ASSETS_FILE = 'local-assets.json';
export const FX_FILE = 'local-fx.json';
export const LEDGER_FILE = 'mod-assets.json';
/** The manifest the CDN publishes for the extracted official effects (downcdn docs/official-effects.md). */
export const DEFAULT_FX_URL = 'https://speedcdn.jiangjiangze.icu/assets/local/fx/local-fx.json';
export const DEFAULT_FX_BASE = 'https://speedcdn.jiangjiangze.icu';
export const SKIN_SOURCE = 'data/assets.json#skins';
export const FX_GROUPS = Object.freeze(['fx', 'fx/prefabs', 'fx/tex', 'fx/mesh']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
// The same shape mergeLocalChars accepts (server/plugins/artReferences.js), so a written entry is never ignored.
const CHAR_ID = /^char_[0-9]+_[a-z0-9]+$/;
const MAX_PATH = 512;

/** A root-relative art path the asset layer can serve (`/assets/skins/…`, `/assets/local/fx/…`). */
export function isAssetPath(v) {
  if (typeof v !== 'string' || !v.startsWith('/assets/') || v.length > MAX_PATH) return false;
  if (/[\\\u0000-\u001f?#]/.test(v)) return false;
  return v.slice(1).split('/').every((s) => s && s !== '.' && s !== '..');
}

/** Stable JSON (sorted keys) for "the same entry" comparisons. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (!isObj(v)) return JSON.stringify(v);
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * One top-level `skins[skinId]` record as a `chars[charId].skins[skinId]` entry (docs/SKINS.md's shape):
 * `{ name, group, avatar, avatarE2, portrait, portraitE2, illust, spine }`. The release manifest writes the
 * illustration as `illustration` and the series as `brand`; both names are accepted.
 * @param {any} rec
 * @returns {{ charId: string, entry: any } | null}
 */
export function skinEntry(rec) {
  if (!isObj(rec)) return null;
  const charId = str(rec.charId);
  const name = str(rec.name);
  if (!CHAR_ID.test(charId) || !name) return null;
  /** @type {any} */
  const entry = { name };
  const group = str(rec.brand) || str(rec.group);
  if (group) entry.group = group;
  const pics = { avatar: 'avatar', avatarE2: 'avatarE2', portrait: 'portrait', portraitE2: 'portraitE2', illust: 'illustration' };
  for (const [to, from] of Object.entries(pics)) {
    const v = str(rec[from]) || (to === 'illust' ? str(rec.illust) : '');
    if (isAssetPath(v)) entry[to] = v;
  }
  const spine = spineEntry(rec.spine);
  if (spine) entry.spine = spine;
  return Object.keys(entry).length > 1 ? { charId, entry } : null;
}

/** A Spine model as the client reads it: front required, back optional, every member inside `/assets/`. */
function spineEntry(sp) {
  if (!isObj(sp)) return null;
  /** @type {any} */
  const out = {};
  for (const side of ['front', 'back']) {
    const m = sp[side];
    if (!isObj(m)) continue;
    const skel = str(m.skel);
    const atlas = str(m.atlas);
    if (!isAssetPath(skel) || !isAssetPath(atlas) || !skel.endsWith('.skel')) continue;
    const model = clone(m);
    model.skel = skel;
    model.atlas = atlas;
    if (Array.isArray(model.textures)) {
      const pages = model.textures.filter(isAssetPath);
      if (pages.length) model.textures = pages;
      else delete model.textures;
    }
    out[side] = model;
  }
  return out.front ? out : null;
}

/**
 * What a sync would write, computed from the two manifests alone.
 * @param {{ assets?: any, local?: any }} input
 * @returns {{ sourceCount: number, writes: any[], conflicts: any[], same: any[], skipped: any[] }}
 */
export function planSkins({ assets, local } = {}) {
  const source = isObj(assets?.skins) ? assets.skins : {};
  const localChars = isObj(local?.chars) ? local.chars : {};
  /** @type {{ sourceCount: number, writes: any[], conflicts: any[], same: any[], skipped: any[] }} */
  const plan = { sourceCount: Object.keys(source).length, writes: [], conflicts: [], same: [], skipped: [] };
  for (const [skinId, rec] of Object.entries(source)) {
    const made = skinEntry(rec);
    if (!made) { plan.skipped.push({ skinId, reason: 'not a skin record with charId, name and /assets/ paths' }); continue; }
    const existing = isObj(localChars[made.charId]?.skins) ? localChars[made.charId].skins[skinId] : undefined;
    if (existing === undefined) plan.writes.push({ skinId, ...made });
    else if (stable(existing) === stable(made.entry)) plan.same.push({ skinId, charId: made.charId });
    else plan.conflicts.push({ skinId, ...made });
  }
  return plan;
}

/**
 * Apply writes to a copy of data/local-assets.json. Other keys, groups and operator records are kept; an entry
 * the plan does not name is never touched.
 * @param {any} local
 * @param {{ skins?: any[] }} writes
 * @returns {any}
 */
export function applySkinWrites(local, writes = []) {
  const next = clone(isObj(local) ? local : { version: 1, source: 'local-client', groups: {} });
  if (!isObj(next.chars)) next.chars = {};
  for (const w of writes) {
    const charId = str(w?.charId);
    const skinId = str(w?.skinId);
    if (!CHAR_ID.test(charId) || !skinId || !isObj(w?.entry)) continue;
    if (!isObj(next.chars[charId])) next.chars[charId] = {};
    if (!isObj(next.chars[charId].skins)) next.chars[charId].skins = {};
    next.chars[charId].skins[skinId] = clone(w.entry);
  }
  return next;
}

/** How many skin entries the local layer holds (for the "removed" count of a clear). */
function countSkins(local) {
  let n = 0;
  for (const rec of Object.values(isObj(local?.chars) ? local.chars : {})) {
    if (isObj(rec?.skins)) n += Object.keys(rec.skins).length;
  }
  return n;
}

/** Remove only the skin ids a previous sync recorded in the ledger; leave every other local skin alone. */
export function clearSkinWrites(local, ids = []) {
  const next = clone(isObj(local) ? local : { version: 1, source: 'local-client', groups: {} });
  if (!isObj(next.chars)) return next;
  const drop = new Set(ids.map(str).filter(Boolean));
  for (const [charId, rec] of Object.entries(next.chars)) {
    if (!isObj(rec) || !isObj(rec.skins)) continue;
    for (const id of Object.keys(rec.skins)) if (drop.has(id)) delete rec.skins[id];
    if (!Object.keys(rec.skins).length) delete rec.skins;
    if (!Object.keys(rec).length) delete next.chars[charId];
  }
  return next;
}

/** The status the /mod page and `assets status` print. */
export function skinsStatus({ assets, local, ledger } = {}) {
  const source = isObj(assets?.skins) ? assets.skins : {};
  const localChars = isObj(local?.chars) ? local.chars : {};
  const missing = [];
  const chars = new Set();
  for (const [skinId, rec] of Object.entries(source)) {
    const charId = str(rec?.charId);
    if (isObj(localChars[charId]?.skins) && Object.hasOwn(localChars[charId].skins, skinId)) {
      chars.add(charId);
    } else missing.push(skinId);
  }
  let extra = 0;
  for (const rec of Object.values(localChars)) {
    if (!isObj(rec?.skins)) continue;
    for (const id of Object.keys(rec.skins)) if (!Object.hasOwn(source, id)) extra++;
  }
  return {
    source: SKIN_SOURCE,
    sourceCount: Object.keys(source).length,
    present: Object.keys(source).length - missing.length,
    missing: missing.length,
    extra,
    chars: chars.size,
    syncedAt: str(ledger?.skins?.syncedAt) || null,
    missingIds: missing.slice(0, 20),
  };
}

/** Check a data/local-fx.json document against what public/js/render/vfx/library.js reads. */
export function readFxManifest(doc) {
  const problems = [];
  const note = (s) => { if (problems.length < 20) problems.push(s); };
  if (!isObj(doc)) return { ok: false, problems: ['not a JSON object'], counts: {}, version: null, source: null };
  const groups = isObj(doc.groups) ? doc.groups : null;
  if (!groups) return { ok: false, problems: ['no groups object'], counts: {}, version: doc.version ?? null, source: str(doc.source) || null };
  const counts = {};
  for (const g of FX_GROUPS) counts[g] = isObj(groups[g]) ? Object.keys(groups[g]).length : 0;
  if (!counts['fx/prefabs']) note('groups[fx/prefabs] is empty — the client would keep the effect layer off (fxAvailable() = false)');
  for (const g of ['fx/prefabs', 'fx/tex', 'fx/mesh']) {
    const entries = isObj(groups[g]) ? groups[g] : {};
    let bad = 0;
    let upper = 0;
    for (const [key, e] of Object.entries(entries)) {
      if (!isObj(e) || !isAssetPath(e.path)) bad++;
      if (key !== key.toLowerCase()) upper++;
    }
    if (bad) note(`${g}: ${bad} entries without a /assets/ path`);
    if (upper) note(`${g}: ${upper} keys are not lower case (the client lower-cases lookups)`);
  }
  const tex = isObj(groups['fx/tex']) ? groups['fx/tex'] : {};
  const noSize = Object.values(tex).filter((e) => !isObj(e) || !Number.isFinite(e.w) || !Number.isFinite(e.h)).length;
  if (noSize) note(`fx/tex: ${noSize} entries without w/h`);
  const hard = problems.some((p) => p.includes('without a /assets/ path') || p.includes('no groups'));
  return {
    ok: counts['fx/prefabs'] > 0 && !hard,
    problems,
    counts,
    version: doc.version ?? null,
    source: str(doc.source) || null,
  };
}

/** The listed files a verify pass samples: the two shared indexes first, then one of each group. */
export function fxSamplePaths(doc, n = 6) {
  const groups = isObj(doc?.groups) ? doc.groups : {};
  const out = [];
  const seen = new Set();
  const add = (group, key) => {
    const e = isObj(groups[group]) ? groups[group][key] : undefined;
    const p = isObj(e) ? str(e.path) : '';
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push({ group, key, path: p });
  };
  for (const key of ['index', 'textures']) add('fx', key);
  for (const g of ['fx/prefabs', 'fx/tex', 'fx/mesh']) {
    const keys = isObj(groups[g]) ? Object.keys(groups[g]).sort() : [];
    if (keys.length) add(g, keys[0]);
  }
  for (const g of ['fx/prefabs', 'fx/tex', 'fx/mesh']) {
    const keys = isObj(groups[g]) ? Object.keys(groups[g]).sort() : [];
    for (const key of keys) {
      if (out.length >= n) break;
      add(g, key);
    }
    if (out.length >= n) break;
  }
  return out.slice(0, n);
}

/** Absolute URL of a listed file (the manifest normally writes root-relative paths). */
export function fxUrl(p, base = DEFAULT_FX_BASE) {
  const s = str(p);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `${String(base || DEFAULT_FX_BASE).replace(/\/+$/, '')}${s.startsWith('/') ? '' : '/'}${s}`;
}

/**
 * Fetch a few listed files (HEAD, then a one-byte GET when HEAD is not allowed) and report each answer.
 * @param {{ doc: any, base?: string, samples?: number, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export async function verifyFxManifest({ doc, base = DEFAULT_FX_BASE, samples = 6, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'NO_FETCH', rows: [] };
  const rows = [];
  for (const s of fxSamplePaths(doc, Math.max(1, samples))) {
    const url = fxUrl(s.path, base);
    const row = { ...s, url, status: null, ok: false, bytes: null };
    try {
      let res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 405 || res.status === 501) {
        res = await fetchImpl(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(timeoutMs) });
      }
      row.status = res.status;
      row.ok = res.ok || res.status === 206;
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len)) row.bytes = len;
    } catch (e) {
      row.error = String(e?.message || e).slice(0, 200);
    }
    rows.push(row);
  }
  return { ok: rows.length > 0 && rows.every((r) => r.ok), rows };
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function writeJsonAtomic(file, doc, { backup = true } = {}) {
  const body = `${JSON.stringify(doc)}\n`;
  if (backup) await fs.copyFile(file, `${file}.bak`).catch(() => {});
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, file);
  return body.length;
}

async function readLedger(dataDir) {
  const doc = await readJson(path.join(dataDir, LEDGER_FILE));
  return isObj(doc) ? doc : { version: 1 };
}

async function writeLedger(dataDir, patch) {
  const file = path.join(dataDir, LEDGER_FILE);
  const now = await readLedger(dataDir);
  const next = { ...now, version: 1, ...patch };
  await writeJsonAtomic(file, next, { backup: false });
  return next;
}

/** status of both layers, for `assets status` and GET /mod/assets/status.json. */
export async function assetStatus({ dataDir }) {
  const [assets, local, fx, ledger] = await Promise.all([
    readJson(path.join(dataDir, ASSETS_FILE)),
    readJson(path.join(dataDir, LOCAL_ASSETS_FILE)),
    readJson(path.join(dataDir, FX_FILE)),
    readLedger(dataDir),
  ]);
  const fxCheck = readFxManifest(fx);
  return {
    ok: true,
    skins: skinsStatus({ assets, local, ledger }),
    fx: {
      present: fx !== null,
      ok: fxCheck.ok,
      counts: fxCheck.counts,
      version: fxCheck.version,
      source: fxCheck.source,
      problems: fxCheck.problems,
      installedAt: str(ledger?.fx?.installedAt) || null,
      url: str(ledger?.fx?.url) || null,
      sha256: str(ledger?.fx?.sha256) || null,
    },
    dataDir,
  };
}

/**
 * data/assets.json `skins` → data/local-assets.json `chars[].skins[]`. Ids already written by an earlier sync
 * are left as they are unless `force` (a record that differs is reported as a conflict).
 * @param {{ dataDir: string, dryRun?: boolean, force?: boolean }} opts
 */
export async function syncSkins({ dataDir, dryRun = false, force = false } = {}) {
  const assetsFile = path.join(dataDir, ASSETS_FILE);
  const localFile = path.join(dataDir, LOCAL_ASSETS_FILE);
  const [assets, local, ledger] = await Promise.all([readJson(assetsFile), readJson(localFile), readLedger(dataDir)]);
  if (!isObj(assets)) return { ok: false, error: 'NO_ASSETS', detail: `${ASSETS_FILE} is missing or unreadable` };
  const plan = planSkins({ assets, local });
  const writes = force ? [...plan.writes, ...plan.conflicts] : [...plan.writes];
  const summary = {
    ok: true,
    dryRun: !!dryRun,
    source: SKIN_SOURCE,
    sourceCount: plan.sourceCount,
    added: plan.writes.length,
    overwritten: force ? plan.conflicts.length : 0,
    conflicts: plan.conflicts.length,
    unchanged: plan.same.length,
    skipped: plan.skipped.length,
    skippedRows: plan.skipped.slice(0, 20),
    wrote: writes.length,
    localFile,
  };
  if (!writes.length || dryRun) return summary;
  const next = applySkinWrites(local, writes);
  summary.bytes = await writeJsonAtomic(localFile, next);
  const previous = Array.isArray(ledger?.skins?.ids) ? ledger.skins.ids.map(str).filter(Boolean) : [];
  await writeLedger(dataDir, {
    skins: {
      source: SKIN_SOURCE,
      syncedAt: new Date().toISOString(),
      ids: [...new Set([...previous, ...writes.map((w) => w.skinId)])],
      count: writes.length,
    },
  });
  return summary;
}

/** Remove the skins an earlier `skins-sync` wrote (tracked in data/mod-assets.json). */
export async function clearSkins({ dataDir, dryRun = false } = {}) {
  const ledger = await readLedger(dataDir);
  const ids = Array.isArray(ledger?.skins?.ids) ? ledger.skins.ids.map(str).filter(Boolean) : [];
  const localFile = path.join(dataDir, LOCAL_ASSETS_FILE);
  const local = await readJson(localFile);
  if (!ids.length) return { ok: true, dryRun: !!dryRun, removed: 0, requested: 0, ids: [], localFile };
  const next = clearSkinWrites(local, ids);
  const summary = { ok: true, dryRun: !!dryRun, removed: Math.max(0, countSkins(local) - countSkins(next)), requested: ids.length, ids: ids.slice(0, 20), localFile };
  if (dryRun) return summary;
  summary.bytes = await writeJsonAtomic(localFile, next);
  await writeLedger(dataDir, { skins: { source: SKIN_SOURCE, syncedAt: new Date().toISOString(), ids: [], count: 0 } });
  return summary;
}

/**
 * Replace data/local-fx.json with a manifest fetched from an https URL (the CDN publishes one). The files the
 * manifest names are not downloaded: /assets/local/fx/** goes through asset-jump like the rest of the official art.
 * @param {{ dataDir: string, url?: string, dryRun?: boolean, verify?: number, base?: string, fetchImpl?: typeof fetch }} opts
 */
export async function installFx({ dataDir, url = DEFAULT_FX_URL, dryRun = false, verify = 0, base = DEFAULT_FX_BASE, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'NO_FETCH' };
  if (!/^https:\/\//i.test(str(url))) return { ok: false, error: 'URL', detail: 'an https URL is required' };
  const MAX_MANIFEST = 32 * 1024 * 1024;
  let body;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return { ok: false, error: 'HTTP', detail: `HTTP ${res.status} ${url}` };
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > MAX_MANIFEST) return { ok: false, error: 'SIZE', detail: `${len} bytes` };
    body = await res.text();
    if (body.length > MAX_MANIFEST) return { ok: false, error: 'SIZE', detail: `${body.length} bytes` };
  } catch (e) {
    return { ok: false, error: 'DOWNLOAD', detail: String(e?.message || e).slice(0, 300) };
  }
  let doc;
  try { doc = JSON.parse(body); } catch (e) { return { ok: false, error: 'JSON', detail: String(e?.message || e).slice(0, 200) }; }
  const check = readFxManifest(doc);
  if (!check.ok) return { ok: false, error: 'FX_MANIFEST', detail: check.problems, counts: check.counts };
  const summary = {
    ok: true,
    dryRun: !!dryRun,
    url,
    bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
    counts: check.counts,
    problems: check.problems,
    wrote: false,
  };
  if (dryRun) return summary;
  summary.bytes = await writeJsonAtomic(path.join(dataDir, FX_FILE), doc);
  summary.wrote = true;
  await writeLedger(dataDir, {
    fx: { url, installedAt: new Date().toISOString(), sha256: summary.sha256, counts: check.counts },
  });
  if (verify > 0) summary.verify = await verifyFxManifest({ doc, base, samples: verify, fetchImpl });
  return summary;
}

/** Verify the installed data/local-fx.json (or one passed in) against `base`. */
export async function verifyFx({ dataDir, doc = null, samples = 6, base = DEFAULT_FX_BASE, fetchImpl = globalThis.fetch } = {}) {
  const manifest = doc || await readJson(path.join(dataDir, FX_FILE));
  if (!isObj(manifest)) return { ok: false, error: 'NO_FX', detail: `${FX_FILE} is missing or unreadable`, rows: [] };
  return verifyFxManifest({ doc: manifest, base, samples, fetchImpl });
}

export { readFxManifest as checkFxManifest };
