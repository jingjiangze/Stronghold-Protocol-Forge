# 插件拆分与跨会话合并：审计与方案

日期：2026-10-18　对象：`feat/mota-plugin`（0.3.1 + 无损插件）

## 0. 本轮已落地的

- **红条去掉（客户端侧）**：`public/js/content.js` 的 `hasScriptConsent()` 在服主自建服务器上一律返回 true，并把它加进插件的客户端覆盖表（`client/js/content.js`，覆盖表 160 文件）。服务端另有 `SP_PLUGIN_AUTOCONSENT=1`（自动同意 + 三个闸门放行），两层都做，缺一层都会再弹。
- 插件面板里出现「模式：原版/协同共竞·标准/险境/绝境/终极」是**正确行为**——插件的 `data` 声明了 `mode_xie_*`，上游客户端据此渲染模式页签，不是 bug。

## 1. 三个会话的改动汇总（审计）

| 来源 | 内容 | 是否在当前插件树里 |
|---|---|---|
| 新经济会话（ms-work3） | 联防两档奖励 `econDefenceReward`、每回合换图 `pickRoundStage`/`pickBossStage`/`isXie`、赏金加时 `econBuyTime` | ✅ 在（composed2 就是它合成的） |
| P2P 会话 · 平台侧 | `server/platform.js`（平台握手，`POST /api/room` → 302 直连） | ❌ 不在（属 agent 线） |
| P2P 会话 · 大厅 | `room.list` 协议 + `GET /api/rooms` + `server/lobbyPush.js` 推送 | ⚠️ 只有 `lobbyPush.js` 模块与 `listRooms()` 方法；**协议与路由都没有** |
| P2P 会话 · 重连/重部署 | T0 排空、T1 房间壳持久化 | ⏸ 用户明确“先不做” |
| P2P 会话 · AI 本地代算 | `public/js/battle/rehearsal.js`、`rehearsalWorker.js`、`ai/scoringRunner.js`、`shared/scoringPolicy.mjs`/`scoringQueue.mjs` | ❌ 客户端全无（服务端有 `sim/rehearsal.js`、`match/match/rehearsal.js`） |
| P2P 会话 · 布阵库 | `SP_LINEUP_LIBRARY`、结算即上传 R2（键带日期、`.json` 白名单） | ❌ 不在 |

## 2. 为什么现在是“一个魔塔插件”

打包器把整棵合并树作为一个 `trusted` 插件（`code.match` + `code.client` + `code.data`）。这满足“源码不改、行为等价”，但把四类能力捆在一起：**任何一个出问题都会拖垮整局**，也无法按房间只开其中一项。

## 3. 拆成多个插件的方案（推荐形态）

| 插件 id | 类 | 内容 | 依赖 |
|---|---|---|---|
| `mota-core` | trusted | 模式与经济（`data/config.json` 的 `mode_xie_*`、`match/economy.js`）、对局入口 `Match` | — |
| `mota-revival` | trusted | `match/revival.js` + 结算里的复活闸门（`settle.js` 的 `revivalDefer`） | mota-core |
| `mota-p2p` | trusted | `server/platform.js` + `room.list` + `GET /api/rooms` + `lobbyPush` 接线 | — |
| `mota-ai` | trusted | 客户端 `battle/rehearsal*.js`、`ai/scoringRunner.js`、`shared/scoring*.mjs` | — |
| `mota-lineup` | trusted | `SP_LINEUP_LIBRARY` + 结算上传 | mota-ai（可选） |

拆分要补的管理器能力（当前没有）：

1. **多插件代码根合并**：现在 `code.root` 只取第一个带 `code` 的插件；需要按 `loadOrder` 叠成一层（后加载者覆盖同路径文件）。
2. **按房间启用子集**：`room.setPlugins` 已有，但内容集目前把“所有默认插件”打成一个 cs；拆开后每个插件独立 cs 片段，房间可只选 core+revival。
3. **依赖声明**：`requires`/`loadAfter` 字段已存在但未参与代码根合并，需要用它定顺序。

## 4. 跨会话合并的执行顺序（建议）

1. 先做 `mota-p2p`（最小、独立）：搬 `server/platform.js` + 协议 `room.list` + `/api/rooms` + `lobbyPush` 接线，约 300 行。
2. 再做 `mota-ai`：agent 线里它还是“未提交、无测试”，先把 `scoringPolicy`/`scoringQueue` 的测试补齐再搬。
3. 最后 `mota-lineup`：依赖 R2 白名单与日期键规则（`.json` 而非 `.jsonl`）。
4. 每搬一块，插件包各自 `plugin.lock.json` + `plugins/config.json` 的 trusted pin 都要重签。

## 5. 状态

- `IMPLEMENTED`：红条双保险（服务端自动同意 + 客户端 `hasScriptConsent` 覆盖）、CDN（speedcdn + 动态排名 + 本机素材缺失回落）、客户端覆盖 160 文件。
- `PENDING`：`econ` 在插件房间仍未出现（`modeId` 已确认 `mode_xie_normal`，卡在 match 内 `teamEconomy` 初始化）；P2P/房间列表/AI/布阵库的合并；插件拆分。
- `DEFERRED`（用户指令）：重部署与重连。
