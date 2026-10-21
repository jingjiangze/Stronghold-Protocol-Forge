// tools/upstream-conflict.mjs — 只读的「与官方上游冲突」检查（可复跑）。
//
// 用途：在同步上游 / 升级基线之前，回答两个问题：
//   1. **标识符撞名**：我们引入的引擎面标识符（挂载点、表面 id、宿主方法）在上游树里是否已经存在？
//      撞名 = 未来合并时的语义冲突（比文本冲突更难发现）。
//   2. **文件重叠**：我们改过的文件在上游树里是否存在（存在 ⇒ 未来同步要过三路合并）。
//
// 用法：
//   node tools/upstream-conflict.mjs --upstream <上游检出目录> [--ours <本仓根>]
// 退出码：0 = 无撞名；1 = 有撞名（可接 CI）；2 = 用法错误。
//
// 只读：不写文件、不联网、不执行上游代码；跳过大目录（.git / node_modules / public/assets）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVER_MODULE_USES, MOD_SURFACE } from '../shared/modSurface.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'public', 'var', 'dist', 'build', '.cache']);
const SKIP_EXT = /\.(png|jpe?g|webp|gif|mp3|ogg|wav|bin|skel|atlas|zip|gz)$/i;

/** 我们改过 / 新增的引擎面文件（与 docs/ENGINE-SURFACE.md §5 同步）。 */
export const ENGINE_SURFACE_FILES = Object.freeze([
  'server/modModules.js',
  'server/modHostAdapter.js',
  'server/hostMetrics.js',
  'server/modLanes.js',
  'server/http/routeMount.js',
  'server/http/wsLanes.js',
  'shared/modSurface.js',
  'server/index.js',
  'server/lobby.js',
  'server/http/routes.js',
  'server/http/websocket.js',
  'shared/protocol.js',
  'docs/ENGINE-SURFACE.md',
  'docs/MOD-SURFACE.md',
  'test/modSurface.test.js',
]);

/** 我们引入的标识符（撞名会让未来合并产生语义冲突）。 */
export function ourIdentifiers() {
  // 只查**我们自造的可辨识名**：常量名、文件级抽象名、带点号的表面 id。
  // 不查 `io` / `healthz` / `route` / `lane` 这类通用词（上游本来就有 /healthz、io 也会出现在
  // "version"、"action" 里）——那只会把误报淹没真结果。
  const ids = new Set([
    'SERVER_MODULE_USES', 'MOD_SURFACE', 'PACK_CHANNEL_RE', 'PACK_MSG_LIMITS',
    'modHostAdapter', 'modModules', 'modSurface', 'modLanes',
    'server.modules', 'pack.msg',
  ]);
  for (const row of MOD_SURFACE) ids.add(row.id);
  return [...ids].sort();
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(full); continue; }
    if (!e.isFile() || SKIP_EXT.test(e.name)) continue;
    yield full;
  }
}

/** 上游树里出现的我们的标识符。 @returns {Array<{ id: string, file: string }>} */
export function identifierHits(upstreamDir) {
  const ids = ourIdentifiers();
  const hits = [];
  for (const file of walk(upstreamDir)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const id of ids) {
      // 精确子串足够：这些名字都是我们自己造的、带点号的复合词，误报率极低
      if (text.includes(id)) hits.push({ id, file: path.relative(upstreamDir, file).split(path.sep).join('/') });
    }
  }
  return hits;
}

/** 我们的文件在上游树里是否存在。 */
export function filePresence(upstreamDir, files = ENGINE_SURFACE_FILES) {
  return files.map((rel) => ({ file: rel, upstream: fs.existsSync(path.join(upstreamDir, rel)) }));
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const upstream = arg('--upstream');
  if (!upstream) { console.error('usage: node tools/upstream-conflict.mjs --upstream <upstream-dir> [--ours <dir>]'); return 2; }
  if (!fs.existsSync(upstream)) { console.error(`upstream dir not found: ${upstream}`); return 2; }
  const ours = arg('--ours') || ROOT;
  const hits = identifierHits(upstream);
  const files = filePresence(upstream);
  console.log(`ours: ${ours}`);
  console.log(`upstream: ${path.resolve(upstream)}`);
  console.log(`identifiers checked: ${ourIdentifiers().length}`);
  if (hits.length) {
    console.log('IDENTIFIER COLLISIONS:');
    for (const h of hits) console.log(`  ${h.id}  <-  ${h.file}`);
  } else {
    console.log('IDENTIFIER COLLISIONS: none');
  }
  const present = files.filter((f) => f.upstream).map((f) => f.file);
  console.log(`engine-surface files present upstream: ${present.length}/${files.length}${present.length ? ' (三路合并面)' : ''}`);
  for (const f of present) console.log(`  exists: ${f}`);
  return hits.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
