// shared/modSurface.js — 包（服务端模块）可选挂载点的**运行时真源** + 机器可读表面表（MOD-SURFACE B 层）。
//
// 为什么单独一份而不从 shared/workshop.js 取：那份 schema 文件来自 Forge 0.19 合入，在本树里还与
// `shared/diy.js`（requiredUnitForms）等 0.3.1 文件存在断链（休眠代码）。运行时装载（server/modModules.js）
// 只需要这一份闭枚举，不该把整份 schema 拖进 import 链。
// 取值必须与 `shared/workshop.js` 的 `SERVER_MODULE_USES` 逐字一致；本树已含 lane。
//
// 「引擎面」的清单本身：
//   * boot / shutdown —— 进程生命周期（server/index.js 在 listen 之后 / close 之前调用）
//   * healthz         —— /healthz 的只读标量字段（server/http/routes.js 合并到 modHealth）
//   * matchClass      —— 进程级 MatchClass 包装（唯一能碰对局的挂载点，要求 combat: true）
//   * metrics         —— 只读指标快照（server/hostMetrics.js）
//   * route           —— 只读动态端点（路径强制 /mod/<包id>/…，server/http/routeMount.js）
//   * lane            —— 包自己的 WebSocket 通道（server/modLanes.js + http/wsLanes.js）
//
// `MOD_SURFACE` 是那张**机器可读表**：每一格钉死「面 → 宿主方法 → 实现文件 → 文档」。
// `test/modSurface.test.js` 用它做守卫：uses 闭枚举里每多一个挂载点而表里没跟上，测试就红
// （与 Forge 的 docs/MOD-SURFACE.md + shared/modSurface.js 同一范式）。

/** 服务端模块允许声明的挂载点（闭枚举）。 */
export const SERVER_MODULE_USES = Object.freeze(['boot', 'shutdown', 'matchClass', 'healthz', 'metrics', 'route', 'lane']);

/** 一个模块允许声明的接收通道名（`server.modules[].channels`）。 */
export const PACK_CHANNEL_RE = /^[a-z][a-z0-9_-]{0,63}$/;

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
  { id: 'pack.msg', host: 'packMsg', file: 'server/lobby.js', doc: 'docs/MOD-SURFACE.md' },
  { id: 'pack.msg.channels', file: 'shared/modSurface.js', doc: 'docs/MOD-SURFACE.md' },
]);
