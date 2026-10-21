# MOD-SURFACE — 包可依赖的引擎面（机器可读表的人类版）

> 真源：`shared/modSurface.js` 的 `MOD_SURFACE`（机器可读）+ `SERVER_MODULE_USES`（闭枚举）。
> 守卫：`test/modSurface.test.js`（任何一面漂移在 CI 红，而不是运行期静默失败）。

## 声明位置

`plugin.json`（manifest 2，可选块）:

```json
{
  "server": {
    "modules": [
      { "id": "demo-core", "entry": "server/core.mjs",
        "uses": ["matchClass", "healthz", "route", "lane"],
        "write": true,
        "channels": ["watch"],
        "lane": { "path": "/demo/lane", "summary": "demo channel" } }
    ]
  }
}
```

也接受命名空间写法 `engine.server.modules`。`uses` 只能取下表列出的值。

## 表面表

| id | 宿主方法 | 实现文件 | 语义 |
|---|---|---|---|
| `server.modules` | `moduleHost(...)` | `server/modModules.js` | 模块装载器：读 `server.modules`，`registerServer(host)` |
| `server.modules.write` | `host.io` | `server/modModules.js` | `write:true` 才拿到；限定 `<state>/mod/<包id>/` |
| `server.modules.boot` | `host.onBoot(fn)` | `server/modModules.js` | listen 之后跑一次；冻结只读配置快照 |
| `server.modules.shutdown` | `host.onShutdown(fn)` | `server/modModules.js` | 停机时跑一次（失败只记日志） |
| `server.modules.healthz` | `host.healthz(fn)` | `server/modModules.js` | 合并进 `/healthz` 的 `modHealth["<包id>"]`（≤12 字段/≤2048 字符） |
| `server.modules.matchClass` | `host.matchClass(fn)` | `server/modModules.js` | 进程级包装 `MatchClass`；要求 `combat:true`；房间门控在包侧 |
| `server.modules.metrics` | `host.metrics()` | `server/modModules.js` + `server/hostMetrics.js` | 只读指标快照（uptime/rss/heap/elu/loop*） |
| `server.modules.route` | `host.route(path, fn, {cache})` | `server/modModules.js` + `server/http/routeMount.js` | 只读动态端点，强制 `/mod/<包id>/…`，GET/HEAD，JSON ≤64 KiB |
| `server.modules.lane` | `host.lane(onUpgrade)` | `server/modModules.js` + `server/modLanes.js` + `server/http/wsLanes.js` | 包自有 WebSocket 通道：精确路径、无处理器 503、不回落 `/ws` |
| `matchKinds` | `host.matchKinds()` | `server/modModules.js` + `shared/modSurface.js` | 对局种类声明（**数据面，不是分派表**）：`plugin.json.matchKinds = [{ id, seats?: {min,max}, label? }]`，最多 4 种、按 id 排序；必须有一个 `uses:["matchClass"]` 模块执行；`host.matchKinds()` 只读返回冻结清单 |
| `pack.msg` | `Match.handlePackMsg` / `Lobby.packMsg` | `server/lobby.js` | 包通道消息：先问对局（`true`=消费），否则同房转发 |
| `pack.msg.channels` | `PACK_CHANNEL_RE` | `shared/modSurface.js` | 通道名：`^[a-z][a-z0-9_-]{0,63}$`；`data` ≤4096 B |

## 不登记的面

| 面 | 为什么不做 |
|---|---|
| `callBudget` | Forge 的「每局每插件调用次数上限」：计数点在 `kits/` 的逐单位回调与 battle hooks 上。本树不跑 kits、没有对应计费点；登记一个不生效的字段就是「说了不算」。要用它，先有运行时计费，再登记。 |

## 边界

- **不碰对局**的面在进程级：`boot` / `shutdown` / `healthz` / `metrics` / `route` / `lane`。
- **唯一能碰对局的**是 `matchClass`（要求 `combat:true`）与 `pack.msg`（只在有对局时投递）。
- 模块源码在 `import()` 之前过静态扫描：禁 `process` / `globalThis` / `require` / `eval` / `new Function`
  （读进程值走 `host.metrics`，落盘走 `host.io`）。
- 干净安装（无包声明）时：`/healthz` 无 `modHealth`、无动态端点、无 lane，行为逐字节不变。

## 与插件系统的分工

| 面 | 适用 | 说明 |
|---|---|---|
| 插件（`plugin.json` manifest 2 的 `class`） | 内容/外观/脚本/UI | 沙箱、trusted pin、`script` 默认关 |
| 包（`server.modules`，本文） | 服务端逻辑 | 声明式、`uses` 闭枚举、`combat:true` 门控 |

两者可共存：同一个插件文件夹可以既有 `class` 内容面，也声明 `server.modules` 引擎面。
