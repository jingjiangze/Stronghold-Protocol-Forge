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
import { RECORD_MAPS } from '../../shared/plugins/dataUtils.js';
import { deepFreeze } from '../data.js';

/** 0.3.0 里 `class` 的闭集（shared/plugins/manifest.js CLASSES）；这里只用到这四个。 */
const FORGE_CLASS = Object.freeze({ content: 0, cosmetic: 1, ui: 2, trusted: 3 });

/**
 * 能表达成「引擎格式整条记录」的表（与 shared/plugins/recordsSchema.js 的 forge:1 分支枚举**逐字一致**）。
 * 表外的（`variants` 是**轴定义**不是记录表；`dsl` 是规格）不在这里发 —— 发了只会得到 PLUGIN_RECORD_TYPE。
 */
const FORGE_RECORD_TABLES = Object.freeze(['chess','enemies','waves','stages','modes','items','bands','garrisons','effects','choices','tokens','bonds']);

/**
 * Forge 的内容表是 `{ "<id>": record }` 映射；0.3.0 要求 `{ records: 1, entries: [...] }`。
 * 这一步把前者翻成后者 —— **补上各表的 id 字段**（`RECORD_MAPS` 的第二个元素），值取自映射的键。
 *
 * 只做形状转换，不做语义判断：记录本身写得对不对由 0.3.0 的 `expandRecords` / `validateData` 判
 * （它们会给出带 `PLUGIN_*` 码的问题，比我们自己另写一份校验更可信）。
 *
 * @returns {{ documents: Record<string, any>, files: Record<string,string>, hash: string, skipped: string[] }}
 */
export function buildContent(pack) {
  const documents = {};
  const files = {};
  const skipped = [];
  const tables = Array.isArray(pack.manifest.content) ? pack.manifest.content : [];
  for (const table of tables) {
    if (!WORKSHOP_CONTENT_FILES.includes(table)) continue;
    if (!FORGE_RECORD_TABLES.includes(table)) { skipped.push(`${table}.json: 不是记录表（轴/规格），不按记录发送`); continue; }
    const rel = `${table}.json`;
    const abs = path.join(pack.dir, rel);
    let doc;
    try {
      const bytes = fs.readFileSync(abs);
      files[rel] = sha256Hex(bytes);
      doc = JSON.parse(bytes.toString('utf8'));
    } catch (e) {
      skipped.push(`${rel}: ${e && e.message ? e.message : e}`);
      continue;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) { skipped.push(`${rel}: 不是 { id: record } 映射`); continue; }
    const idField = RECORD_MAPS[table] ? RECORD_MAPS[table][1] : 'id';
    const entries = [];
    for (const [key, rec] of Object.entries(doc)) {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { skipped.push(`${rel}.${key}: 不是记录对象`); continue; }
      // 表键就是 id（Forge 侧的 ID_FIELD_BY_FILE 也钉着这一点）；缺字段时补上，已有则尊重记录自己写的值
      // 0.3.0 的 schema 用 forge:1 这一支接引擎格式整条记录（见 shared/plugins/recordsSchema.js）；
      // replace 只有在包显式 overrides 了这个 id 时才置 true —— 否则 forgeRecord 会拒绝覆盖已有记录。
      const replace = Object.prototype.hasOwnProperty.call(pack.manifest.overrides || {}, key);
      entries.push({ file: table, id: key, forge: 1, record: rec[idField] === undefined ? { ...rec, [idField]: key } : rec, ...(replace ? { replace: true } : {}) });
    }
    documents[rel] = { records: 1, entries };
  }
  return { documents, files, hash: sha256Hex(Buffer.from(JSON.stringify(files))), skipped };
}

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
  // parts.data.files 必须与**实际发出去的 documents** 逐项一致：列了却没发，contentSet 会读到 undefined 并抛
  // （实测 PLUGIN_CONTENT_FORMAT: Cannot read properties of undefined (reading 'patch')）。
  const tables = (Array.isArray(m.content) ? m.content : []).filter((f) => WORKSHOP_CONTENT_FILES.includes(f) && FORGE_RECORD_TABLES.includes(f));
  const payloads = serverPayloads(m);
  const hasUi = !!(m.client && (m.client.panels || m.client.screens || m.client.styles));
  // ⚠ 空数组/空对象是 truthy：Forge 的归一化会给很多包填 `skins: []`，直接用 `||` 会把**没有素材**的包
  // 误判成 cosmetic（实测 18 个包被误分类）。所以逐项判「非空」。
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : (v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v));
  const hasAssets = nonEmpty(m.assets) || nonEmpty(m.art) || nonEmpty(m.skins) || nonEmpty(m.voices);

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
    // 0.3.0 的 contentSet 只收 scope 含 room 的插件（服务端对局内容）；工坊包天然是房间级内容
    scope: ['room'],
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

  // 内容快照：0.3.0 的 contentSet 从 plugin.content.documents[rel] 读，形状必须是 records:1/entries
  const built = buildContent(pack);
  const content = built.skipped.length && !Object.keys(built.documents).length
    ? null
    : deepFreeze({ documents: built.documents, files: built.files, hash: built.hash });

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
    ...(content ? { content } : {}),
    ...(built.skipped.length ? { contentSkipped: built.skipped } : {}),
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
