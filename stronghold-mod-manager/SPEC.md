# MOD 管理器规格（0.3.2 底座）

本文件是**规格真源**。实现在 `jingjiangze/Stronghold-Protocol-Forge` 的 `master` 分支（当前 0.3.2）；
本仓的 `reference/` 只是镜像。两者不一致时以引擎仓为准，并由 `manager-integrity.yml` 报红。

## 1. 唯一分派点

```js
// server/mods/import.js
sniffArchive(buffer)   // 只读 zip 中央目录，从不落盘 → { kind: 'pack'|'plugin'|'unknown', files }
importArchive(buffer, { root, pluginsDir, dataDir, vanilla, force, dryRun })
```

`kind === 'unknown'` 一律拒绝，返回 `PLUGIN_INSTALL_ZIP`，**不猜测**。

## 2. 三条导入路径

| 输入 | 去向 | 产出 |
|---|---|---|
| 含 `pack.json` | `server/plugins/forgeImport.js` 的 `importForge()` | `plugins/<id>/` 普通插件目录（含 `plugin.json`） |
| 含 `plugin.json` | `server/plugins/install.js` 的 `installPluginBytes()` | `plugins/<id>/` |
| 两者皆无 | 拒绝 | `{ ok:false, error:'PLUGIN_INSTALL_ZIP' }` |

`pack.json` 允许在根，**或**在一层包裹目录内（`stripWrapper`，`forgeImport.js:544`）。

## 3. 拒绝码（引擎侧，CI 判据应对齐）

| 码 | 含义 |
|---|---|
| `PLUGIN_INSTALL_ZIP` | 布局非法 / 无 `plugin.json` / 包裹目录不是 plugin id / expectedId 不匹配 |
| `PLUGIN_INSTALL_SIZE` | 超过 `PLUGIN_LIMITS.pluginBytes` |
| `PLUGIN_INSTALL_CHECK` | `checkPluginFolder` 报出问题 |
| `PLUGIN_INSTALL_EXISTS` | 目标 `plugins/<id>` 已存在且未 `force` |

**上限：`PLUGIN_LIMITS.pluginBytes = 200 * 1024 * 1024`（200 MiB）**，出处 `shared/plugins/manifest.js:76`。

## 3.1 兼容判定（2026-10-21）

`importArchive()` 的返回值新增 `compat`：Forge 包由 `shared/plugins/compat.js` 的 `packCompatibility()` 读
`pack.json` 的 `gameVersion` / `game` / `api`；插件包由 `pluginCompatibility()` 读 `plugin.json` 的 `app` / `api`。

| status | 含义 |
|---|---|
| `supported` | 声明范围覆盖当前版本 |
| `convertible` | 声明范围不覆盖，但导入器会转换（附 `reasons`） |
| `incompatible` | manifest 2 的 `api` 超出本安装，或 `app` 不覆盖（启用会被拒绝） |
| `unknown` | 未声明或声明不可解析 |

`compat` 同时写进 `IMPORT-REPORT.md` 的「兼容」行与「兼容性」节；`/mod/upload`、`/mod/fetch`、`tools/mod.mjs check`
的 JSON 返回值也带这个字段。判定不改变导入行为：Forge 包仍然转换，`convertible` 不是失败。

## 4. 三个入口

- **页面**：`GET /mod`（自包含 HTML，内联脚本/样式，CSP 友好）；读不需钥匙，写需 `X-SP-Mod`。
- **CLI**：`node tools/mod.mjs import|check|pack|list|watch`。
  `pack` 产出**确定性 zip**（条目按名排序 + DOS 时间戳 1980-01-01），同目录两次打包字节相同。
- **收件目录**：`mod-inbox/`，debounce `fs.watch`，装完移到 `_done/`，拒绝移到 `_failed/` 并写 `.reason.txt`。

## 5. 装载链（导入之后）

```
plugins/<id>/ → contentSet → room.setPlugins → consent → contentReady
```

导入完成后调一次 `registry.rescan()`（`server/mods/index.js:130,159`），让新插件立刻出现在列表。
**没有任何代码在导入时启用插件**——启用是房间的决定（`server/lobby.js:898` 的 `room.setPlugins`）。

## 6. 安全门（逐条，见 README 表）

不可协商的三条：
1. 位置门不满足 → **404**（不是 403，不暴露 `/mod` 存在）。
2. 写操作必须带钥匙，且 `Sec-Fetch-Site` / `Origin` 同源通过。
3. 从网址抓取只认公开 https（443、无凭据、非私网），且受大小/超时/重定向限制。

## 7. CI 判据（mod 入库闸门的最小集）

```
J1  sniffArchive.kind ∈ {pack, plugin}
J2  node tools/mod.mjs check <zip>  退出码 0（等价 dryRun.ok && wrote === false）
J3  重算 sha256 == PR 声明值
J4  zip 字节数 <= 200 MiB（PLUGIN_LIMITS.pluginBytes）
J5  索引条目数 == mods/ 下 mod.zip 数（防「改了 zip 不改索引」）
```

J1–J4 全部无需 secret、无需网络，可在 `pull_request` 事件里纯 GitHub Actions 判完。
**一条都没跑到也算红**（照搬既有 `selftest.yml` 的口径）。
