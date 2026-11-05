# Forge 兼容边界

**结论：Forge 兼容已经做到位了**（审计 2026-10-19/20 实测），不需要为「兼容 Forge」再做架构改动。
剩下的是**把兼容产物接进托管仓库**（那是 mod 仓的事，不是管理器的事）。

## 1. 接受的形态

| 输入 | 是否接受 | 证据 |
|---|---|---|
| zip，根有 `pack.json` | ✅ | `forgeImport.js:1089` `if (!files.has('pack.json')) fail(...)` |
| zip，一层包裹目录内有 `pack.json` | ✅ | `forgeImport.js:544` `stripWrapper()` |
| 目录，含 `pack.json` | ✅ | `forgeImport.js:3200` `else if (st.isDirectory()) files = readUntrustedDir(abs);` |
| zip，是插件包（`plugin.json`） | ✅（走另一条） | `install.js:535` |
| 两者皆无 | ❌ 拒绝 | `import.js:41` |

## 2. 产出形态

`importForge()` 把每个 product 落成一个**标准 manifest-2 插件目录** `plugins/<id>/`：
写 `PLUGIN_MANIFEST`（即 `plugin.json`）→ 数据与素材 → 顶层 `IMPORT-REPORT.md`；
再由 `commitProducts` 把 `stage/<id>` 改名为 `plugins/<id>`。

**与手写插件完全同一形态**——这是关键：Forge 包导入后不需要任何特殊对待，
后续装载、启用、列表展示走的是同一条 `contentSet → room.setPlugins` 链。

证据：
- `server/plugins/forgeImport.js:3162` — `fs.writeFileSync(path.join(dir, PLUGIN_MANIFEST), ...)`
- `server/plugins/forgeImport.js:361` — `fs.renameSync(path.join(stage, p.id), dest);`
- `server/plugins/forgeImport.js:355` — `const dest = path.join(parent, p.id);`（parent = pluginsDir）

## 3. 版本兼容（2026-10-21 新增）

`pack.json` 的 `gameVersion` / `game` / `api` 过去只在 `forgeImport.js:1205` 的已知字段白名单里被静默跳过，
产物的 `app` / `api` 又由 `manifestCommon()` 硬写（`forgeImport.js:2801`）。现在 `shared/plugins/compat.js`
会读这三项并给出结构化判定；Forge 包仍然由 `importForge` 转换，判定只进报告，不改变导入行为。

| status | 含义 | 出口 |
|---|---|---|
| `supported` | 声明范围覆盖当前版本 | `IMPORT-REPORT.md` 的「兼容」行与「兼容性」节；`/mod/upload`、`/mod/fetch`、`tools/mod.mjs check` 返回的 `compat` |
| `convertible` | 声明范围不覆盖，但导入器会按现有映射转换 | 同上，附 `reasons`（`GAME_RANGE_MISMATCH` / `API_RANGE_MISMATCH` / `USES_NEWER_SURFACE`） |
| `incompatible` | manifest 2 插件的 `api` 超出本安装，或 `app` 不覆盖（启用会被拒绝） | 同上 |
| `unknown` | 没有声明，或声明不是可解析的版本范围 | 同上（`NO_GAME_RANGE` / `BAD_GAME_RANGE` / `NO_APP_RANGE`） |

实测语料（mod 仓 75 个去重 id，2026-10-21）：`supported` 18 / `convertible` 37 / `unknown` 20。
其中 4 个包声明了旧版本却使用 `server.modules`（duel-mode、watch-lineup、node-metrics-healthz、test-sim），
会额外得到 `USES_NEWER_SURFACE`；`mod-xie` 未声明版本，只记录使用新字段。

**它不做什么**：不改写 pack、不拒绝旧包、不把 `convertible` 当成失败。`convertible` 的含义是
「装得上，玩法完整性需要验收」；`incompatible` 只用于 manifest 2 插件的启用门。

## 4. 「兼容的 forge mod 加入 mod 仓库」——已具备 vs 仍缺

### 已可直接复用
- `tools/mod.mjs pack`：把作者目录打成**确定性 zip**，字节稳定，可 pin SHA-256。
- `importForge` 的 `dryRun`：只出报告不落盘，可作 CI 预检（`forgeImport.js:3231`）。
- 双语报告 markdown：既是 `check` 输出，也是 `/mod/upload` 的 JSON 字段。
- 转换产物与手写插件同形态，落 `plugins/<id>/` 即用。

### 仍缺（属于托管仓库要补的）
- **没有「mod 仓库」概念**：现有代码只负责「导入到本机 `plugins/`」，没有登记、索引、commit 步骤。
- 无**版本语义**：只有 `force` 覆盖，没有语义化版本与取代关系。
- **字段级转换测试已在，且由引擎仓 CI 全量执行**：`test/plugins/forgeImport.test.js` 覆盖 operators / chess / skills / voices 映射，
  `test/plugins/install.test.js` 覆盖 fetchHttps 与 ZIP 安全；引擎仓 `ci.yml` 的 "Unit & integration tests" 跑
  `node --test "test/**/*.test.js"`，这些用例被削弱会红。
  （`manager-integrity.yml` 在**规格仓**，只比对 `reference/` 与引擎仓的字节一致性；MAP 里列了哪些文件就只比哪些，
  它是镜像闸门，不是测试闸门。）

## 5. 测试覆盖（2026-10-21 补测后）

跑法：`npm run test` = `node --test "test/**/*.test.js" "test/e2e/coop.e2e.mjs" "plugins/_template/**/*.test.js"`，
引擎仓 `ci.yml` 的 "Unit & integration tests" 一步就是它。

### 这一轮补上的（此前零覆盖）

| 文件 | 覆盖 |
|---|---|
| `test/mods/http.test.js` | `/mod` 页面与 `status.json` 的读、写方法 405；`/mod/upload`：跨站 403、错钥匙 403、无钥匙 403、body 超限 413、非 zip 400、正确钥匙 200、二次上传 EXISTS 400、`force=1` 覆盖 200；`/mod/fetch`：跨站 403、错钥匙 403、非 JSON 400、缺 url 400、sha256 格式 400、非 https 目标 400（且一次 fetch 都没发）、摘要不符 400、下载到的不是 zip 400、正确摘要 200；公开地址与非本地 Host 一律 404 |
| `test/mods/plugin-import.test.js` | `importArchive` 的 `kind === 'plugin'` 整条：dryRun 不写盘、成功安装、第二次 EXISTS、`force` 覆盖（旧目录进 `_replaced`）、坏 manifest 的 CHECK、`app` 越界判 `incompatible` 但仍装、`api` 越界判 `incompatible` 且被 CHECK 拒绝、**`<id>/plugin.json` 外层目录包也认成 plugin 且 verdict 照常读出** |
| `test/plugins/install-branches.test.js` | `installPluginBytes` 的 SIZE（`maxBytes`）、`expectedId` 不符、CHECK（坏 class）、无 `pluginsDir`、`plugins/_incoming` 是符号链接 |

`test/mods/import.test.js` 的 6 个用例不动 —— 它同时是规格仓 `reference/` 的镜像文件，改它会连带 MAP。

### 仍然缺

- **`readPluginZip` 的坏 zip 分支**仍无样本：中央目录损坏、加密条目、数据描述符、非普通文件、重名、
  坏目录项、不支持的压缩方法、本地头与中央头不一致、截断、解压尺寸不符、CRC 不符。
  现有用例覆盖到的是：非 zip、条目数、单文件解压上限、符号链接、大小写折叠、本地 ZIP64。
- `installPluginBytes` 的「末次 rename 失败」与 `movePluginAside` 的重名重试：要注入文件系统错误，尚未做。
- `importArchive` 的「抛出的是非 `InstallError`」归一分支：没有稳定构造手法。
- `/mod` 的 inbox 自动导入只有函数级用例（`startInbox`），没有 HTTP 侧。

### 补测时发现、已一并修掉的两个缺陷（2026-10-21）

1. **`sniffArchive` 只认 zip 根的 `plugin.json`。**
   （`<id>/pack.json` 一直是好的——`readUntrustedZip` 内部已过 `stripWrapper`，那条规则只认 `pack.json`。）
   `tools/plugin.mjs pack --zip` 打的插件包是 `<id>/plugin.json`（`server/plugins/pack.js`，`zipPlugin` 写 `${id}/${rel}`），
   于是 `/mod/upload` 把管理器自己打的插件包判成 `unknown` 拒绝；而 `installPluginBytes` 自己是接受这层外层目录的。
   **修法**：`server/mods/import.js` 新增 `stripPluginWrapper()` —— 单层唯一目录、且其下有 `plugin.json` 才拆。
   拆完的 `files` 同时供 `sniffArchive` 判类与 `importArchive` 读 manifest 算 `compat`；
   只判类不拆的话，这种包会「装得上但 `compat` 恒为 `null`」。
   边界：两层嵌套（`a/b/plugin.json`）仍判 `unknown`，这是这条规则有意不碰的。
2. **`/mod/status.json` 的 `inbox` 字段被覆盖。**
   计数改名 `inboxCount`，`inbox` 保留为路径；同时把计数改成数**管理器真正监听的收件目录**
   （原来数的是 `dirname(pluginsDir)/mod-inbox`，与 `inboxDir` 不一致时数的是另一个目录）。

两条都在测试里钉住了：`plugin-import.test.js` 有 wrapped 包用例（含 dryRun 的 verdict），
`http.test.js` 断言 `inbox` 是路径、`inboxCount` 是数字或 `null`。
`server/mods/import.js` 与 `server/mods/index.js` 都在规格仓的镜像 MAP 内，`reference/` 已同步。
## 6. 实战案例：versus（2V2 对抗，trusted + modes + meta.code）

`versus` 0.1.0 是第一个走完管理器全链路的 **trusted 类玩法插件**：

| 面 | 用法 | 证据 |
|---|---|---|
| `modes` part | `mode_x_versus_2v2`（base `mode_multi_normal`，14 回合） | `data/modes.json` |
| `meta.code` entry | `global:versus-mode`（R14 公告钩子） | `server/meta.js` |
| `trusted.server` entry | `host/noop.js` | `entry.server` |
| settings | `teamSize` / `confrontTargetSeconds` / `rosterMs` | `plugin.json` settings 块 |
| lock + pin | `tools/plugin.mjs pack` → sha256 pin | `plugin.lock.json` + `plugins/config.json` |
| 兼容判定 | `packCompatibility({gameVersion:'0.3.x'})` → `supported` | `shared/plugins/compat.js` |
| 服务器装载 | `/plugins/index.json` → `status: "loaded"`, `class: "trusted"` | 本机实测 |

这条链验证了管理器对「带自定义模式的完整玩法插件」的装载能力：modes 进 content set、meta 钩子进对局、settings 暴露在管理面板、lock+pin 走 trusted 信任链。

⚠ versus 的对抗期核心（confront 状态机、共享血量、Boss 池）在引擎侧 `gpt/versus-constants` 分支，尚未合并 master；当前插件装载后模式可选但对抗逻辑不生效。
