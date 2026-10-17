// server/forge/compose.js —— **把 Forge 工坊包合成成 0.3.0 认识的 `Plugin` 记录**。
//
// 这是整条移植路线的关键一格：不建第二条装载链，而是让包以插件的形状进入 0.3.0 已有的
// `plugins[]` 数组，于是 `contentSet` / `cs` / `room.setPlugins` / `consent` / `contentReady`
// 全部原样适用 —— 「这一局跑什么」仍然只有一份答案。
//
// 分工写清楚（免得后来的人以为这里也在跑代码）：
//   * 本文件只做**读盘 + 归一化 + 合成**，纯数据，不 import 任何包内代码；
//   * 包里的 `kits/` 与 `server.*` 载荷由阶段 3 的 `server/forge/host.js` 按房间选中集合调用。
//
// 映射规则（每条都由 test/forgeCompose.test.js 钉住）：
//   内容表 content: ['chess','items']      → manifest.parts.data.files = ['chess.json','items.json']
//   assets / art / skins / voices          → class 升到 cosmetic，parts.assets / 声明 assets.add|override
//   client.panels / screens / styles       → class 升到 ui，entry.client + slots
//   server.modules / battle / meta / room  → class 升到 trusted，permissions 加 trusted.server
//   其它均无代码面                          → class content

import fs from 'node:fs';
import path from 'node:path';

import { normalizePackManifest, PACK_FIELDS, WORKSHOP_CONTENT_FILES } from '../../shared/forge/workshop.js';
import { sha256Hex, modManifestDigest } from '../../shared/forge/modIdentity.js';
import { listPackFiles } from './packFiles.js';

/** 0.3.0 里 `class` 的闭集（shared/plugins/manifest.js CLASSES）；这里只用到这四个。 */
const FORGE_CLASS = Object.freeze({ content: 0, cosmetic: 1, ui: 2, trusted: 3 });

/** 这个包声明了哪些**服务端代码**载荷（决定是否落到 `trusted` 档）。 */
export function serverPayloads(manifest) {
  const s = manifest && typeof manifest === 'object' ? manifest.server : null;
  if (!s || typeof s !== 'object') return [];
  const out = [];
  for (const key of ['modules', 'battle', 'meta', 'room']) {
    const v = s[key];
    if (Array.isArray(v) ? v.length > 0 : !!v) out.push(key);
  }
  return out;
}

/**
 * 读一个工坊包目录：`{ id, dir, manifest, files, hash, errors }`。
 * 失败**不抛**（与 0.3.0 的 `scanPlugins` 同一纪律：坏包记一条具名问题，不影响其它包）。
 */
export function readForgePack(dir, { id = path.basename(dir) } = {}) {
  const manifestPath = path.join(dir, 'pack.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { id, dir, errors: [{ code: 'FORGE_BAD_MANIFEST', reason: `pack.json 缺失或不是合法 JSON：${e && e.message ? e.message : e}` }] };
  }
  const hasAssets = fs.existsSync(path.join(dir, 'assets'));
  const checked = normalizePackManifest(raw, id, { hasAssets });
  if (!checked.ok) return { id, dir, errors: [{ code: checked.error, reason: checked.detail }] };

  let paths;
  try {
    paths = listPackFiles(dir);
  } catch (e) {
    return { id, dir, errors: [{ code: 'FORGE_UNREADABLE', reason: `包目录读不了：${e && e.message ? e.message : e}` }] };
  }
  const files = [];
  for (const rel of paths) {
    try {
      const bytes = fs.readFileSync(path.join(dir, ...rel.split('/')));
      files.push({ path: rel, bytes: bytes.length, hash: sha256Hex(bytes) });
    } catch (e) {
      return { id, dir, errors: [{ code: 'FORGE_UNREADABLE', reason: `${rel} 读不了：${e && e.message ? e.message : e}` }] };
    }
  }
  // 身份：包目录**每一个普通文件**的 [path, sha256]，排序后哈希（与 Forge 侧 identifyPack 同一口径）。
  // ⚠ 与 0.2.6 那条线的哈希**不承诺相等**：那边还把合成路径 `assets.container.sha256` 也算进去。
  // 这里刻意不加——两条线的身份各用各的名字空间，混用会让"同一份字节两个身份"。
  const hash = modManifestDigest(files.map((f) => ({ path: f.path, hash: f.hash })));
  return { id, dir, manifest: checked.pack, raw, files, hash, errors: [] };
}

/** 把一个已读出的包合成成 0.3.0 的 `Plugin` 记录。 */
export function packToPlugin(pack, { where = `workshop/${pack.id}/` } = {}) {
  const m = pack.manifest;
  const tables = (Array.isArray(m.content) ? m.content : []).filter((f) => WORKSHOP_CONTENT_FILES.includes(f));
  const payloads = serverPayloads(m);
  const hasUi = !!(m.client && (m.client.panels || m.client.screens || m.client.styles));
  const hasAssets = !!(m.assets || m.art || m.skins || m.voices);

  let klass = 'content';
  if (payloads.length) klass = 'trusted';
  else if (hasUi) klass = 'ui';
  else if (hasAssets && !tables.length) klass = 'cosmetic';
  if (FORGE_CLASS[klass] === undefined) klass = 'content';

  const parts = {};
  if (tables.length) parts.data = { files: tables.map((t) => `${t}.json`) };
  if (m.operators && Object.keys(m.operators).length) parts.operators = { inline: m.operators };
  if (m.enemies && Object.keys(m.enemies).length) parts.enemies = { inline: m.enemies };
  if (m.stages) parts.stages = { files: ['stages.json'] };
  if (hasAssets) parts.assets = { files: [] };

  const permissions = [];
  if (tables.length) permissions.push('data.add');
  if (m.overrides && Object.keys(m.overrides).length) permissions.push('data.patch');
  if (hasAssets) permissions.push('assets.add');
  if (payloads.length) permissions.push('trusted.server');

  const manifest2 = {
    manifest: 2,
    id: pack.id,
    name: m.name || pack.id,
    version: m.version || '0.0.0',
    class: klass,
    // 0.3.0 的字段名与我们不同但语义相同的那些，逐条映射；没有对应物的（variants/behaviour）留在 `forge` 里，
    // 让阶段 3 的运行时按 Forge 语义处理 —— **不假装成插件的能力**。
    permissions,
    parts,
    entry: {},
    requires: {}, optional: {}, conflicts: {},
    settings: {}, priority: 0,
    forge: {
      source: 'workshop',
      tables,
      payloads,
      overrides: m.overrides && Object.keys(m.overrides).length ? m.overrides : undefined,
      variants: m.variants,
      behaviour: m.behaviour,
      enabled: m.enabled,
      api: m.api,
      layer: m.layer,
      combat: m.combat === true || undefined,
      target: m.target,
    },
  };

  return {
    id: pack.id,
    type: 'forge-pack',
    class: klass,
    status: 'loaded',
    source: 'workshop',
    layout: 'folder',
    where,
    // `supported` 在 0.3.0 里表示"语言包视图也算它"；工坊包不是语言包，恒 false，避免污染 `/packs/index.json`
    supported: false,
    manifest: manifest2,
    files: pack.files.map((f) => ({ path: f.path, sha256: f.hash, bytes: f.bytes })),
    bytes: pack.files.reduce((n, f) => n + (f.bytes || 0), 0),
    count: pack.files.length,
    hash: pack.hash,
    dir: pack.dir,
  };
}

/** 扫一个工坊根：每个非点开头的目录当包读一遍。 */
export function scanForgePacks(root, { log = null } = {}) {
  const plugins = [];
  const skipped = [];
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return { plugins, skipped };   // 目录不存在 = 没有工坊包，与 0.3.0「没有 plugins/」同一条纪律
  }
  for (const name of names) {
    const pack = readForgePack(path.join(root, name), { id: name });
    if (pack.errors && pack.errors.length) {
      skipped.push({ where: `workshop/${name}/`, problems: pack.errors.map((e) => `${e.code}: ${e.reason}`) });
      log?.warn?.(`[forge] workshop/${name}/: ${pack.errors[0].code}: ${pack.errors[0].reason}`);
      continue;
    }
    plugins.push(packToPlugin(pack));
  }
  return { plugins, skipped };
}

export { PACK_FIELDS };
