# 上游冲突审计（2026-10-21）

> 对象：`gpt/engine-surface`（引擎面 + lane + MOD-SURFACE 守卫） vs 官方上游 `sganggs/Stronghold-Protocol`。
> 可复跑：`node tools/upstream-conflict.mjs --upstream <上游检出目录>`（只读；退出码 1 = 有撞名）。

## 基线

| 侧 | 引用 | 版本/日期 | 说明 |
|---|---|---|---|
| 上游 master | `c9d804f4` | 0.3.1（package.json），2026-10-18 | 已发布的稳定线 |
| 上游 dev | `23dfa3d7` | 0.3.2 开发线，2026-10-19 | master 之后 130 个文件变化 |
| 本分支基线 | `fe35b05e`（`feat/mota-coop-upstream`） | 0.3.1 + 管理器（squash 后的发布树） | 远端发布分支 HEAD |
| 本分支 | `55213aa2`（`gpt/engine-surface`） | = 基线 + 引擎面 + lane + 守卫 | 2 个提交 |

## 结论

### 1. 上游 master：内容已并入基线，无冲突

- 逐文件比对 `c9d804f4` vs `fe35b05e`：我们改过的 5 个既有文件里，
  `server/http/websocket.js`、`server/lobby.js`、`shared/protocol.js` **逐字节相同**；
  `server/index.js`、`server/http/routes.js` 的差异**只有管理器自己的 `mods` 行**（`createMods`、`/mod` 路由参数），
  上游没有我们基线缺少的代码。
- 我们新增的 10 个文件（`server/modModules.js`、`modHostAdapter.js`、`hostMetrics.js`、`modLanes.js`、
  `http/routeMount.js`、`http/wsLanes.js`、`shared/modSurface.js`、`docs/ENGINE-SURFACE.md`、
  `docs/MOD-SURFACE.md`、`test/modSurface.test.js`）在上游 master **不存在** — 无命名/路径冲突。

### 2. 上游 dev（0.3.2 开发线）：只与 `server/index.js` 重叠，hunk 不相邻

- `master..dev` 改动 130 个文件（新增 `server/match/{botStrategies,externalConfig,externalAI,botStrategyContract,aiPlan,aiDigest}.js`、
  `server/ai/*`、`server/sim/*` 若干、CSS/i18n/文档等）。
- 与我们的文件集**唯一重叠：`server/index.js`**。dev 的两个 hunk：
  ① 第 38 行附近加 `botStrategies` / `externalConfig` 的 import；
  ② `startServer` 开头加 `SP_BOT_STRATEGY` 校验块（约第 96 行）。
  我们的插入点：imports 在 `createMods` 之后（约第 61 行）、模块装载在 `roomSets` 之后（约第 127 行）、
  `actualPort` 之后 boot（约第 200+ 行）——**区域不相邻**，三路合并预计干净。
- dev 的 `docs/PLUGINS.md` / `shared/plugins/manifest.js` **没有**新增 `server` / `engine` / `modules` / `pack.msg` 面
  → 与我们 `plugin.json.server.modules` 的语义不冲突。
- dev 未改动 `shared/protocol.js` / `server/lobby.js` / `server/http/websocket.js` / `server/http/routes.js`。

### 3. 标识符撞名：0

`tools/upstream-conflict.mjs` 对 dev 全树检查 19 个自造标识符
（`SERVER_MODULE_USES`、`MOD_SURFACE`、`PACK_CHANNEL_RE`、`PACK_MSG_LIMITS`、`modHostAdapter`、`modModules`、
`modSurface`、`modLanes`、`server.modules`、`pack.msg`、以及各表面 id）：
`IDENTIFIER COLLISIONS: none`。

## 风险与待决

- **dev 是未发布开发线**：是否把 0.3.2 dev 合进发布线是产品决策，本次**未合并**（合并会带入 130 个文件、
  8 个 golden 场景重算、外部 AI/bot 策略等）。若要合，建议单开 `gpt/upstream-0.3.2` 分支并先跑
  `node tools/upstream-conflict.mjs` + 全量 CI。
- 上游 `dev` 的 `server/match/*` 改动与我们的 `matchClass` 包装**运行期**可能交互（dev 改了 `Match` 的
  prep/settle/phase）；一旦合并，需真房间回归（`matchClass` 包装在 dev 的 Match 上仍成立）。
- 上游仓库的 `master` 目前 package.json 仍写 0.3.1，而 dev 自称 0.3.2 — 以 dev 分支内容为准判断版本面。

## 复跑命令

```bash
# 1) 取上游两个分支（只读）
git -c http.proxy=http://127.0.0.1:7897 fetch sganggs master dev --depth=100

# 2) 逐文件比对（示例：我们改过的既有文件）
for f in server/index.js server/lobby.js server/http/routes.js shared/protocol.js; do
  git diff --quiet c9d804f4 fe35b05e -- "$f" && echo "SAME $f" || echo "DIFF $f"
done

# 3) 标识符撞名 + 三路合并面（需要上游工作树）
git worktree add --detach /tmp/up-dev sganggs/dev
node tools/upstream-conflict.mjs --upstream /tmp/up-dev
```
