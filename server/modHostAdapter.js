// server/modHostAdapter.js — 把管理器的插件清单（plugin.json）读成服务端模块载荷（引擎面）。
//
// 为什么需要这一层：引擎的 `server/modModules.js` 期望的是**工坊包**形状
// （`{ id, dir, hash, server: { modules }, matchKinds }`），而当前管理器的装载单位是**插件**
// （`plugin.json` manifest 2）。本文件只做「读原始清单 → 形状转换 → 最小判据」，
// 不 import 包内代码、不写盘、不缓存。真正 import 模块的只有 `loadServerModules`。
//
// 接受两种声明位置（都不与现有 `entry.server`（trusted 插件入口）冲突）：
//   * `plugin.json.server.modules`           —— 与 Forge pack.json 同形，便于适配层直搬；
//   * `plugin.json.engine.server.modules`    —— 命名空间化写法，给未来 manifest 3 留位。
// `uses` 的取值必须落在引擎的闭枚举里（`shared/workshop.js` 的 SERVER_MODULE_USES）。
// `entry` 必须是包内 `server/*.mjs`（相对路径，无 `..`）——与工坊包的判据同一条。
//
// 读不到的清单、形状不对的模块一律**跳过并点名**（log.warn），不让一个坏包拖垮启动。
// 装载失败（import 抛错 / registerServer 缺失）由 `loadServerModules` 返回 errors，调用方按
// 「一条用不了的声明拒绝整个包」处理。

import fs from 'node:fs';
import path from 'node:path';

import { SERVER_MODULE_USES, PACK_CHANNEL_RE } from '../shared/modSurface.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** 模块 id：小写字母/数字/`-`/`_`，2–32；与工坊包的判据同形。 */
const MODULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 一条 `server/` 下的包内相对 `.mjs` 路径（无空段、无 `.`/`..`、无反斜杠）。 */
function validEntry(rel) {
  if (typeof rel !== 'string' || !rel.startsWith('server/') || !rel.endsWith('.mjs')) return false;
  if (rel.includes('\\')) return false;
  return rel.split('/').every((s) => s && s !== '.' && s !== '..');
}

/** 归一一条模块声明；不合法返回 null（调用方点名）。 */
function normalizeModule(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const id = typeof m.id === 'string' && MODULE_ID_RE.test(m.id) ? m.id : null;
  const entry = validEntry(m.entry) ? m.entry : null;
  const uses = Array.isArray(m.uses) ? m.uses.filter((u) => typeof u === 'string') : [];
  if (!id || !entry || !uses.length) return null;
  if (uses.some((u) => !SERVER_MODULE_USES.includes(u))) return null;
  const channels = Array.isArray(m.channels)
    ? m.channels.filter((c) => typeof c === 'string' && PACK_CHANNEL_RE.test(c))
    : null;
  const lane = m.lane && typeof m.lane === 'object' && typeof m.lane.path === 'string'
    ? { path: m.lane.path, ...(typeof m.lane.summary === 'string' ? { summary: m.lane.summary } : {}) }
    : null;
  return {
    id,
    entry,
    uses,
    ...(m.write === true ? { write: true } : {}),
    ...(channels && channels.length ? { channels } : {}),
    ...(lane ? { lane } : {}),
  };
}

/**
 * @param {{ registry?: { plugins?: () => Array<any> }, pluginsDir?: string, log?: object }} deps
 * @returns {Array<{ id: string, dir: string, hash: string, server: { modules: Array<any> }, matchKinds: any }}>}
 */
export function pluginModulePacks({ registry = null, pluginsDir = '', log = noopLog } = {}) {
  const out = [];
  let plugins = [];
  try { plugins = registry && typeof registry.plugins === 'function' ? registry.plugins() : []; } catch { plugins = []; }
  for (const p of plugins) {
    if (!p || p.status !== 'loaded' || typeof p.id !== 'string' || !p.id) continue;
    const dir = typeof p.dir === 'string' && p.dir ? p.dir : path.join(pluginsDir, p.id);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch { continue; }
    const block = raw && raw.engine && raw.engine.server ? raw.engine.server : raw && raw.server;
    if (!block || !Array.isArray(block.modules) || !block.modules.length) continue;
    const modules = [];
    for (const m of block.modules) {
      const mod = normalizeModule(m);
      if (!mod) { log.warn?.(`[mods] ${p.id}: server.modules entry refused (id/entry/uses/channels shape)`); continue; }
      modules.push(mod);
    }
    if (!modules.length) continue;
    const hash = String(p.lockHash || (p.script && p.script.lockHash) || p.hash || '');
    const matchKinds = Array.isArray(raw.matchKinds) ? raw.matchKinds : null;
    out.push({ id: p.id, dir, hash, server: { modules }, matchKinds });
  }
  return out;
}
