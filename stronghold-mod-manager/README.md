# stronghold-mod-manager — MOD 管理器的规格与闸门仓库

**这不是一个可直接 `npm start` 的服务。** 它是 MOD 管理器的**规格、来源镜像与 CI 闸门**仓库；
可运行的产物由 `jingjiangze/Stronghold-Protocol-Forge`（`master`，当前 0.3.2）用
`tools/package.mjs --lite` 产出。

## 为什么这么拆

审计（2026-10-19/20）实测出的三条硬事实决定了这个形状：

1. **管理器对引擎是运行时深依赖。** 以管理器自有 6 个文件为根做 import 闭包 = **112 个文件**
   （server 61 / shared 39 / tools 9 / public 2 / test 1），其中 `server/plugins/forgeImport.js`
   单文件 214,566 字节、自身 import 23 个相对路径。把它 vendor 过来等于 vendor 半个引擎，
   且 vendored 拷贝必然腐烂。

2. **但它对上游的真实接缝只有 3 个文件。** `git diff c9d804f4 HEAD --name-only`（c9d804f4 = 上游 0.3.2）
   → 12 个文件、1278 insertions / 7 deletions，其中与上游同路径的只有：
   `server/http/routes.js`(+2)、`server/index.js`(+6)、`server/plugins/forgeImport.js`(+10)。
   其余 9 个是纯新增，路径上游根本没有，永不冲突。

3. **上游本体零反向依赖管理器。** `gh api repos/sganggs/Stronghold-Protocol/contents/server/mods` → 404。
   即：把管理器整个拿掉，引擎照常跑。

⇒ 结论：管理器**保持嵌在引擎薄壳内**（thin fork + `mirror-upstream.yml` 自动同步），
本仓库只承载「规格 + 来源镜像 + 闸门」，不承担运行。

## 仓库内容

| 路径 | 作用 |
|---|---|
| `README.md` | 本文件：架构、边界、为什么这么拆 |
| `SPEC.md` | 管理器规格（三个入口、一条装载链、安全三道门） |
| `FORGE-COMPAT.md` | Forge 兼容边界：接受什么、产出什么、拒绝什么 |
| `reference/` | 管理器自有 6 个文件的**来源镜像**（只读参照，非运行副本） |
| `.github/workflows/manager-integrity.yml` | 闸门：与引擎仓的镜像一致性 + 文档不脱节 |

## 三个入口，一条装载链

```
zip ──┬─ 有 pack.json   → importForge()        （Forge 包 → 普通插件目录）
      ├─ 有 plugin.json → installPluginBytes() （插件 zip → 校验 → 暂存 → 改名）
      └─ 都没有         → 拒绝 PLUGIN_INSTALL_ZIP
```

三个入口都汇到同一个 `importArchive()`：
- `GET /mod` 页面 → `/mod/upload`、`/mod/fetch`
- `node tools/mod.mjs …` → `import` / `check` / `pack` / `list` / `watch`
- `mod-inbox/` 目录 → 丢 zip 进去即装

**导入 ≠ 启用。** 导入只调 `registry.rescan()`，让插件出现在列表里；启用由房间自己
`room.setPlugins` 决定。装进来的插件不会自动进任何房间，也不会进 `plugins/config.json` 的 `default`。

## 安全三道门

| 门 | 判据 | 位置 |
|---|---|---|
| 网络位置 | 只放行本机/局域网 + Host 是本地名，否则 **404**（不暴露存在性） | `server/studio/gate.js:115` |
| 写钥匙 | `plugins/.studio-key`（128 位 base64url），`timingSafeEqual` 常量时间比较 | `server/studio/key.js:53` |
| 抓取地址 | 仅 https、端口 443、拒绝私网/带凭据、≤5 跳重定向、60s 超时 | `server/plugins/install.js:267,34` |
| 同源 | `Sec-Fetch-Site` ∈ {same-origin, none}；`Origin` host 必须等于 `Host` | `server/mods/index.js:93` |

## 相关仓库

- `jingjiangze/Stronghold-Protocol-Forge` — 引擎 + 管理器本体（产品线分支 `master`）
- `jingjiangze/Stronghold-Protocol-Forge-Mods` — 既有的 mod 托管仓（fork，含 `mods/`、`site/`）
- `sganggs/Stronghold-Protocol` — 游戏本体上游（管理器的祖先，merge-base `b3deebda`）
