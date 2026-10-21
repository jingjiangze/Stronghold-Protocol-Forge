// shared/modSurface.js — 包（服务端模块）可选挂载点的**运行时真源** + 机器可读表面表（MOD-SURFACE B 层）。
//
// 为什么单独一份而不从 shared/workshop.js 取：那份 schema 文件来自 Forge 0.19 合入，在本树里还与
// `shared/diy.js`（requiredUnitForms）等 0.3.1 文件存在断链（休眠代码）。运行时装载（server/modModules.js）
// 只需要这一份闭枚举，不该把整份 schema 拖进 import 链。
//
// 「引擎面」的清单本身：
//   * boot / shutdown —— 进程生命周期（server/index.js 在 listen 之后 / close 之前调用）
//   * healthz         —— /healthz 的只读标量字段（server/http/routes.js 合并到 modHealth）
//   * matchClass      —— 进程级 MatchClass 包装（唯一能碰对局的挂载点，要求 combat: true）
//   * metrics         —— 只读指标快照（server/hostMetrics.js）
//   * route           —— 只读动态端点（路径强制 /mod/<包id>/…，server/http/routeMount.js）
//   * lane            —— 包自己的 WebSocket 通道（server/modLanes.js + http/wsLanes.js）
//   * matchKinds      —— 对局种类声明（数据面，不是分派表；`host.matchKinds()` 只读）
//
// `MOD_SURFACE` 是那张**机器可读表**：每一格钉死「面 → 宿主方法 → 实现文件 → 文档」。
// `test/modSurface.test.js` 用它做守卫：uses 闭枚举里每多一个挂载点而表里没跟上，测试就红
// （与 Forge 的 docs/MOD-SURFACE.md + shared/modSurface.js 同一范式）。
//
// 刻意**不登记**：`callBudget`（Forge 的每局每插件调用次数上限）。它的计数点在 `kits/` 的逐单位回调与
// battle hooks 上，本树不跑 kits、没有对应计费点；登记一个不生效的字段就是「说了不算」——那正是
// MOD-SURFACE 存在的意义所反对的。要用它，先有运行时计费，再登记。

/** 服务端模块允许声明的挂载点（闭枚举）。 */
export const SERVER_MODULE_USES = Object.freeze(['boot', 'shutdown', 'matchClass', 'healthz', 'metrics', 'route', 'lane']);

/** 一个模块允许声明的接收通道名（`server.modules[].channels`）。 */
export const PACK_CHANNEL_RE = /^[a-z][a-z0-9_-]{0,63}$/;

// ---- matchKinds（DESIGN §28.54）：声明与协商面，不是分派表 --------------------------------
// 与 Forge 同一套判据：id 形如包通道；seats 是 1..12 的整数区间；label ≤60 字符；最多 4 种；
// 按 id 排序（书写顺序不得改变摘要）；空数组比不写更糟（拒绝）。
// 「一个没人读的种类」是静默失败 ⇒ 必须由某个 `uses` 含 `matchClass` 的模块执行（见 modHostAdapter）。

export const MATCH_KIND_FIELDS = Object.freeze(['id', 'seats', 'label']);
export const MATCH_KIND_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const MAX_PACK_MATCH_KINDS = 4;
export const MATCH_KIND_SEATS_MAX = 12;

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 校验 `plugin.json.matchKinds`（也接受 `engine.matchKinds`）。
 * @param {unknown} raw
 * @returns {{ ok: true, decl: ReadonlyArray<object> } | { ok: false, code: string, reason: string }}
 */
export function parseMatchKinds(raw) {
  const bad = (code, reason) => ({ ok: false, code, reason });
  if (!Array.isArray(raw)) return bad('MATCHKINDS_BAD_SHAPE', 'matchKinds must be an array of { id, seats?, label? }');
  if (!raw.length) return bad('MATCHKINDS_EMPTY', 'matchKinds must declare at least one kind (drop the key instead of sending [])');
  if (raw.length > MAX_PACK_MATCH_KINDS) return bad('MATCHKINDS_TOO_MANY', `matchKinds: at most ${MAX_PACK_MATCH_KINDS} kinds per pack (got ${raw.length})`);
  const out = [];
  const seen = new Set();
  for (const [i, kind] of raw.entries()) {
    if (!isPlain(kind)) return bad('MATCHKINDS_BAD_SHAPE', `matchKinds[${i}] must be an object: { id, seats?: { min, max }, label? }`);
    for (const key of Object.keys(kind)) {
      if (!MATCH_KIND_FIELDS.includes(key)) return bad('MATCHKINDS_UNKNOWN_FIELD', `matchKinds[${i}]: "${key}" is not a kind field (${MATCH_KIND_FIELDS.join(', ')})`);
    }
    if (typeof kind.id !== 'string' || !MATCH_KIND_ID_RE.test(kind.id)) {
      return bad('MATCHKINDS_BAD_ID', `matchKinds[${i}].id: "${String(kind.id)}" is not a valid kind id (^[a-z][a-z0-9_-]{0,63}$)`);
    }
    if (seen.has(kind.id)) return bad('MATCHKINDS_DUPLICATE_ID', `matchKinds: "${kind.id}" is declared twice (one id, one kind)`);
    seen.add(kind.id);
    const clean = { id: kind.id };
    if (kind.seats !== undefined) {
      if (!isPlain(kind.seats)) return bad('MATCHKINDS_BAD_SEATS', `matchKinds["${kind.id}"].seats must be { min, max } (integers from 1 to ${MATCH_KIND_SEATS_MAX})`);
      for (const key of Object.keys(kind.seats)) {
        if (key !== 'min' && key !== 'max') return bad('MATCHKINDS_BAD_SEATS', `matchKinds["${kind.id}"].seats: "${key}" is not a seat bound (min, max)`);
      }
      for (const name of ['min', 'max']) {
        const v = kind.seats[name];
        if (!Number.isInteger(v) || v < 1 || v > MATCH_KIND_SEATS_MAX) {
          return bad('MATCHKINDS_BAD_SEATS', `matchKinds["${kind.id}"].seats.${name} must be an integer from 1 to ${MATCH_KIND_SEATS_MAX}, got ${String(v)}`);
        }
      }
      if (kind.seats.min > kind.seats.max) return bad('MATCHKINDS_BAD_SEATS', `matchKinds["${kind.id}"].seats: min ${kind.seats.min} is larger than max ${kind.seats.max}`);
      clean.seats = { min: kind.seats.min, max: kind.seats.max };
    }
    if (kind.label !== undefined) {
      if (typeof kind.label !== 'string' || !kind.label.trim() || kind.label.length > 60) {
        return bad('MATCHKINDS_BAD_LABEL', `matchKinds["${kind.id}"].label must be a non-empty string of at most 60 characters`);
      }
      clean.label = kind.label.trim();
    }
    out.push(clean);
  }
  // 按 id 排序：书写顺序不得改变归一化清单（否则「同一份摘要」可以被绕过）。
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, decl: Object.freeze(out.map((k) => Object.freeze({ ...k, ...(k.seats ? { seats: Object.freeze({ ...k.seats }) } : {}) }))) };
}

/**
 * 表面表：id → 宿主方法 → 实现文件 → 文档。
 * 带 `use` 的行必须与 `SERVER_MODULE_USES` 一一对应（守卫测试钉死）。
 * @type {ReadonlyArray<{ id: string, use?: string, host?: string, file: string, doc: string }>}
 */
export const MOD_SURFACE = Object.freeze([
  { id: 'server.modules', host: 'moduleHost', file: 'server/modModules.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'server.modules.write', host: 'io', file: 'server/modModules.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'server.modules.boot', use: 'boot', host: 'onBoot', file: 'server/modModules.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'server.modules.shutdown', use: 'shutdown', host: 'onShutdown', file: 'server/modModules.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'server.modules.healthz', use: 'healthz', host: 'healthz', file: 'server/modModules.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'server.modules.matchClass', use: 'matchClass', host: 'matchClass', file: 'server/modModules.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'server.modules.metrics', use: 'metrics', host: 'metrics', file: 'server/modModules.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'server.modules.route', use: 'route', host: 'route', file: 'server/modModules.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'server.modules.lane', use: 'lane', host: 'lane', file: 'server/modModules.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'matchKinds', host: 'matchKinds', file: 'server/modModules.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'pack.msg', host: 'packMsg', file: 'server/lobby.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'pack.msg.channels', file: 'shared/modSurface.js', doc: 'docs/MOD-SURFACE.md' },
]);
